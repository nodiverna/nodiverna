using System.Buffers.Binary;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal sealed class RdpFrameCipher : IDisposable
{
    internal const int MaximumPlainBytes = 16_384, MaximumCipherBytes = MaximumPlainBytes + 16;
    internal const long MaximumSequence = 9_007_199_254_740_991;
    private readonly string id;
    private readonly byte[] key;
    internal RdpFrameCipher(string sessionId, byte[] material)
    {
        if (!Guid.TryParseExact(sessionId, "D", out _) || material.Length != 32) throw new CryptographicException("Invalid RDP session key.");
        id = sessionId; key = material.ToArray();
    }
    internal string Encrypt(long sequence, ReadOnlySpan<byte> plain) => EncryptDirection(id, key, sequence, plain, input: false);
    internal byte[] Decrypt(long sequence, string data) => DecryptDirection(id, key, sequence, data, input: true);
    private static (byte[] Nonce, byte[] Aad) Parameters(string id, long sequence, bool input)
    {
        if (!Guid.TryParseExact(id, "D", out _) || sequence is < 1 or > MaximumSequence) throw new InvalidDataException("Invalid RDP sequence.");
        byte[] nonce = new byte[12]; Encoding.ASCII.GetBytes(input ? "CLNT" : "AGNT").CopyTo(nonce, 0);
        BinaryPrimitives.WriteUInt64BigEndian(nonce.AsSpan(4), (ulong)sequence);
        return (nonce, Encoding.UTF8.GetBytes($"ServerDesk:RDP:1:{id}:{(input ? "in" : "out")}:{sequence}"));
    }
    internal static string EncryptDirection(string id, byte[] key, long sequence, ReadOnlySpan<byte> plain, bool input)
    {
        if (key.Length != 32 || plain.Length is < 1 or > MaximumPlainBytes) throw new CryptographicException("Invalid RDP frame length.");
        var p = Parameters(id, sequence, input); byte[] output = new byte[plain.Length + 16];
        using var aes = new AesGcm(key, 16); aes.Encrypt(p.Nonce, plain, output.AsSpan(0, plain.Length), output.AsSpan(plain.Length), p.Aad);
        return Convert.ToBase64String(output);
    }
    internal static byte[] Decode(string data)
    {
        if (data.Length is < 24 or > 21_868) throw new InvalidDataException("Invalid encrypted RDP frame length.");
        byte[] wire;
        try { wire = Convert.FromBase64String(data); } catch (FormatException e) { throw new InvalidDataException("Invalid encrypted RDP frame encoding.", e); }
        if (wire.Length is < 17 or > MaximumCipherBytes || Convert.ToBase64String(wire) != data) throw new InvalidDataException("Invalid encrypted RDP frame encoding.");
        return wire;
    }
    internal static byte[] DecryptDirection(string id, byte[] key, long sequence, string data, bool input)
    {
        if (key.Length != 32) throw new CryptographicException("Invalid RDP key.");
        byte[] wire = Decode(data), plain = new byte[wire.Length - 16]; var p = Parameters(id, sequence, input);
        try { using var aes = new AesGcm(key, 16); aes.Decrypt(p.Nonce, wire.AsSpan(0, plain.Length), wire.AsSpan(plain.Length), plain, p.Aad); return plain; }
        catch { CryptographicOperations.ZeroMemory(plain); throw; }
    }
    public void Dispose() => CryptographicOperations.ZeroMemory(key);
}

// Only identical retries are accepted; consumed ciphertext is replaced by a small
// receipt, never replayed to Windows. Receipts and unacknowledged screen bytes are bounded.
internal sealed class RdpInputLedger
{
    private readonly SortedDictionary<long, byte[]> receipts = new();
    internal long Ack { get; private set; }
    internal bool Validate(long sequence, string data)
    {
        if (sequence is < 1 or > RdpFrameCipher.MaximumSequence) throw new InvalidDataException("Invalid RDP input sequence.");
        byte[] digest = SHA256.HashData(RdpFrameCipher.Decode(data));
        if (sequence <= Ack)
        {
            if (!receipts.TryGetValue(sequence, out var old) || !CryptographicOperations.FixedTimeEquals(old, digest)) throw new InvalidDataException("RDP input replay changed or is too old.");
            return false;
        }
        if (sequence != Ack + 1) throw new InvalidDataException("RDP input sequence has a gap.");
        return true;
    }
    internal void Commit(long sequence, string data)
    {
        if (!Validate(sequence, data)) return;
        receipts.Add(sequence, SHA256.HashData(RdpFrameCipher.Decode(data))); Ack = sequence;
        while (receipts.Count > 64) receipts.Remove(receipts.Keys.First());
    }
}

internal sealed class RdpFrameWindow
{
    private readonly object gate = new();
    private readonly int maximum;
    private readonly SortedDictionary<long, string> pending = new();
    private readonly SemaphoreSlim credit = new(0, 1);
    private long sequence, acknowledged, stored, highestSent;
    private bool storedSupported;
    internal int Count { get { lock (gate) return pending.Count; } }
    internal long LastSequence { get { lock (gate) return sequence; } }
    internal long Acknowledged { get { lock (gate) return acknowledged; } }
    internal long Stored { get { lock (gate) return stored; } }
    internal long HighestSent { get { lock (gate) return highestSent; } }
    internal bool HasPendingUpload { get { lock (gate) return pending.Count != 0 && pending.Keys.Last() > (storedSupported ? stored : acknowledged); } }
    internal RdpFrameWindow(int maximum = 64) { if (maximum is < 1 or > 64) throw new ArgumentOutOfRangeException(nameof(maximum)); this.maximum = maximum; }
    internal void Add(byte[] plain, RdpFrameCipher cipher)
    {
        lock (gate)
        {
            if (pending.Count >= maximum) throw new InvalidOperationException("RDP output credit exhausted.");
            long next = checked(sequence + 1); string data = cipher.Encrypt(next, plain); pending.Add(next, data); sequence = next;
        }
    }
    internal bool Acknowledge(long value, long? outputStored = null)
    {
        bool consumedAdvanced, changed;
        lock (gate)
        {
            // Only a selected upload can have reached the portal/browser. The
            // storage watermark advances dispatch, never releases browser credit.
            if (value < acknowledged || value > highestSent) throw new InvalidDataException("Invalid RDP output acknowledgement.");
            long committed = outputStored ?? value;
            if (committed < stored || committed < value || committed > highestSent || (storedSupported && outputStored is null)) throw new InvalidDataException("Invalid RDP output storage acknowledgement.");
            consumedAdvanced = value != acknowledged;
            changed = consumedAdvanced || committed != stored || (outputStored is not null && !storedSupported);
            if (outputStored is not null) storedSupported = true;
            stored = committed;
            foreach (long seq in pending.Keys.TakeWhile(seq => seq <= value).ToArray()) pending.Remove(seq);
            acknowledged = value;
        }
        if (consumedAdvanced) try { credit.Release(); } catch (SemaphoreFullException) { }
        return changed;
    }
    internal JsonArray Snapshot()
    {
        lock (gate)
        {
            // A stored frame stays immutable and retained until the browser's
            // consumed ACK. Old portals without outputStored retain first-16 retry.
            var selected = pending.Where(p => p.Key > (storedSupported ? stored : acknowledged)).Take(16).ToArray();
            if (selected.Length != 0) highestSent = Math.Max(highestSent, selected[^1].Key);
            return new JsonArray(selected.Select(p => (JsonNode)new JsonObject { ["seq"] = p.Key, ["data"] = p.Value }).ToArray());
        }
    }
    internal async Task WaitForCreditAsync(CancellationToken token)
    {
        while (true) { lock (gate) if (pending.Count < maximum) return; await credit.WaitAsync(token); }
    }
    internal void Clear() { lock (gate) pending.Clear(); try { credit.Release(); } catch (SemaphoreFullException) { } }
}

// TLS read boundaries are not RDP message boundaries. A short burst of tiny
// records should consume bytes, not one mailbox credit/database row per read.
// Keep exactly one read outstanding across a timed flush; canceling that read
// merely to flush would damage SslStream and could lose already received bytes.
internal sealed class RdpOutputCoalescer : IAsyncDisposable
{
    internal const int MaximumFlushDelayMs = 4;
    private readonly Func<Memory<byte>, CancellationToken, ValueTask<int>> read;
    private readonly CancellationTokenSource stopping;
    private readonly byte[] received = new byte[RdpFrameCipher.MaximumPlainBytes], frame = new byte[RdpFrameCipher.MaximumPlainBytes];
    private Task<int>? pending;
    private int offset, available;
    private bool ended;
    internal RdpOutputCoalescer(Func<Memory<byte>, CancellationToken, ValueTask<int>> read, CancellationToken token)
    {
        this.read = read; stopping = CancellationTokenSource.CreateLinkedTokenSource(token);
    }
    private void StartRead()
    {
        if (pending is null && !ended) pending = read(received, stopping.Token).AsTask();
    }
    private async Task CompleteReadAsync()
    {
        int count = await pending!; pending = null;
        if (count < 0 || count > received.Length) throw new InvalidDataException("Invalid local RDP stream read length.");
        offset = 0; available = count; ended = count == 0;
    }
    internal async Task<byte[]?> ReadFrameAsync()
    {
        stopping.Token.ThrowIfCancellationRequested();
        if (available == 0 && !ended) { StartRead(); await CompleteReadAsync(); }
        if (ended && available == 0) return null;
        long began = Stopwatch.GetTimestamp(); int count = 0;
        while (true)
        {
            if (available != 0)
            {
                int take = Math.Min(available, frame.Length - count);
                received.AsSpan(offset, take).CopyTo(frame.AsSpan(count)); CryptographicOperations.ZeroMemory(received.AsSpan(offset, take));
                offset += take; available -= take; count += take;
                if (count == frame.Length || ended) break;
            }
            if (ended) break;
            double remaining = MaximumFlushDelayMs - Stopwatch.GetElapsedTime(began).TotalMilliseconds;
            if (remaining <= 0) break;
            StartRead();
            if (!pending!.IsCompleted)
            {
                using var flush = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
                Task deadline = Task.Delay(TimeSpan.FromMilliseconds(remaining), flush.Token);
                Task next = await Task.WhenAny(pending, deadline);
                if (next != pending) { stopping.Token.ThrowIfCancellationRequested(); break; }
                flush.Cancel();
            }
            await CompleteReadAsync();
        }
        byte[] bytes = frame.AsSpan(0, count).ToArray(); CryptographicOperations.ZeroMemory(frame.AsSpan(0, count));
        return bytes;
    }
    public async ValueTask DisposeAsync()
    {
        stopping.Cancel();
        if (pending is not null) try { await pending; } catch { }
        CryptographicOperations.ZeroMemory(received); CryptographicOperations.ZeroMemory(frame); stopping.Dispose();
    }
}
