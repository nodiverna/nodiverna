using System.Net;

namespace ServerDesk.Agent;

internal static class FileTransferTransportTests
{
    internal static async Task RunAsync()
    {
        byte[] expected = Enumerable.Range(0, 262144).Select(i => (byte)i).ToArray();
        using (var http = Client(new ByteArrayContent(expected)))
        {
            byte[] result = await FileTransfers.ReadUploadChunkAsync(http, "/chunk", expected.Length, CancellationToken.None);
            if (!result.SequenceEqual(expected)) throw new Exception("A complete bounded upload chunk changed in transit.");
        }
        using (var http = Client(new ByteArrayContent([1, 2])))
            await RejectedAsync(() => FileTransfers.ReadUploadChunkAsync(http, "/chunk", 1, CancellationToken.None), "Declared oversized transfer chunk was accepted.");
        using (var http = Client(new StreamContent(new UnboundedLengthStream([1, 2]))))
            await RejectedAsync(() => FileTransfers.ReadUploadChunkAsync(http, "/chunk", 1, CancellationToken.None), "Streamed oversized transfer chunk was accepted.");
        using (var http = Client(new ByteArrayContent([1])))
            await RejectedAsync(() => FileTransfers.ReadUploadChunkAsync(http, "/chunk", 2, CancellationToken.None), "Truncated transfer chunk was accepted.");
        using (var http = Client(new StreamContent(new StalledStream())))
        {
            http.Timeout = TimeSpan.FromMilliseconds(75);
            bool cancelled = false;
            try { await FileTransfers.ReadUploadChunkAsync(http, "/chunk", 1, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(2)); }
            catch (OperationCanceledException) { cancelled = true; }
            if (!cancelled) throw new Exception("A stalled transfer body escaped its HTTP deadline.");
        }
        using (var http = Client(new StreamContent(new StalledStream())))
        using (var cancellation = new CancellationTokenSource())
        {
            var pending = FileTransfers.ReadUploadChunkAsync(http, "/chunk", 1, cancellation.Token);
            cancellation.Cancel();
            bool cancelled = false;
            try { await pending.WaitAsync(TimeSpan.FromSeconds(2)); }
            catch (OperationCanceledException) { cancelled = true; }
            if (!cancelled) throw new Exception("A stalled transfer body ignored cancellation.");
        }
        Console.WriteLine("File upload transport tests passed: complete chunks, oversized declared/streamed bodies, truncation, whole-body timeout and cancellation.");
    }
    private static HttpClient Client(HttpContent content) => new(new FixtureHandler(content)) { BaseAddress = new Uri("https://transfer.test"), Timeout = TimeSpan.FromSeconds(15) };
    private static async Task RejectedAsync(Func<Task<byte[]>> action, string message)
    {
        bool rejected = false;
        try { await action(); } catch (InvalidDataException) { rejected = true; }
        if (!rejected) throw new Exception(message);
    }
    private sealed class FixtureHandler(HttpContent content) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
    }
    private sealed class UnboundedLengthStream(byte[] bytes) : Stream
    {
        private readonly MemoryStream inner = new(bytes);
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) => inner.ReadAsync(buffer, token);
        public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, count);
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (disposing) inner.Dispose(); base.Dispose(disposing); }
    }
    private sealed class StalledStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) { await Task.Delay(Timeout.InfiniteTimeSpan, token); return 0; }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
