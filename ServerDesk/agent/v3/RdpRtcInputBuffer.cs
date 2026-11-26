using System.Security.Cryptography;

namespace ServerDesk.Agent;

// Reliable SCTP messages after CleanPath form a byte stream. Coalesce tiny
// writes into byte-sized slots so 64 one-byte writes do not exhaust one MiB.
internal sealed class RdpRtcInputBuffer : IDisposable
{
    internal const int MaximumBytes = 1_048_576;
    private sealed class Chunk(byte[] data, int length, bool boundary)
    {
        internal readonly byte[] Data = data;
        internal int Length = length;
        internal readonly bool Boundary = boundary;
    }
    private readonly object gate = new();
    private readonly LinkedList<Chunk> pending = new();
    private readonly SemaphoreSlim wake = new(0, 1);
    private int bytes;
    private bool first, disposed;
    internal int Count { get { lock (gate) return pending.Count; } }
    internal int Bytes { get { lock (gate) return bytes; } }
    internal bool Add(ReadOnlySpan<byte> message)
    {
        if (message.Length is < 1 or > RdpFrameCipher.MaximumPlainBytes) return false;
        lock (gate)
        {
            if (disposed || bytes + message.Length > MaximumBytes) return false;
            if (!first)
            {
                pending.AddLast(new Chunk(message.ToArray(), message.Length, true)); first = true;
            }
            else
            {
                int offset = 0;
                Chunk? last = pending.Last?.Value;
                int tail = last is not null && !last.Boundary ? last.Data.Length - last.Length : 0;
                if (pending.Count >= 64 && message.Length > tail) return false;
                if (last is not null && !last.Boundary && last.Length < last.Data.Length)
                {
                    int length = Math.Min(message.Length, last.Data.Length - last.Length);
                    message[..length].CopyTo(last.Data.AsSpan(last.Length)); last.Length += length; offset = length;
                }
                if (offset < message.Length)
                {
                    if (pending.Count >= 64) return false;
                    byte[] block = new byte[RdpFrameCipher.MaximumPlainBytes]; message[offset..].CopyTo(block);
                    pending.AddLast(new Chunk(block, message.Length - offset, false));
                }
            }
            bytes += message.Length;
            try { wake.Release(); } catch (SemaphoreFullException) { }
            return true;
        }
    }
    internal async Task<byte[]> ReadAsync(CancellationToken token)
    {
        while (true)
        {
            token.ThrowIfCancellationRequested();
            lock (gate)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                if (pending.First is not null)
                {
                    Chunk next = pending.First.Value; pending.RemoveFirst(); bytes -= next.Length;
                    byte[] result = next.Data.AsSpan(0, next.Length).ToArray(); CryptographicOperations.ZeroMemory(next.Data); return result;
                }
            }
            await wake.WaitAsync(token);
        }
    }
    public void Dispose()
    {
        lock (gate) { if (disposed) return; disposed = true; foreach (Chunk next in pending) CryptographicOperations.ZeroMemory(next.Data); pending.Clear(); bytes = 0; }
        // The session joins its reader before disposing this semaphore.
        wake.Dispose();
    }
}
