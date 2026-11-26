using System.Runtime.InteropServices;
using System.Security.Principal;

namespace ServerDesk.Agent;

// Fixtures are written at the native SDK's byte offsets, never with
// StructureToPtr or offsets computed from our C# definitions. A wrong packing
// declaration must fail before it can dereference a fabricated native pointer.
internal static class NativeFeaturesAbiTests
{
    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("Native DISM ABI regression: " + message);
    }
    internal static int RunSelfTest()
    {
        try { NativeFeaturesProviderTests.Run(); Run(); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
    internal static void Run()
    {
        int pointer = IntPtr.Size, featureSize = pointer + 4, infoSize = 4 * pointer + 12;
        Assert(Marshal.SizeOf<NativeFeatures.DismFeature>() == featureSize, "DismFeature array stride must be 12 bytes on x64.");
        Assert(Marshal.OffsetOf<NativeFeatures.DismFeature>(nameof(NativeFeatures.DismFeature.State)).ToInt32() == pointer, "feature state follows its name pointer without array padding.");
        Assert(Marshal.SizeOf<NativeFeatures.DismFeatureInfo>() == infoSize, "DismFeatureInfo must be 44 bytes on x64.");
        var offsets = new Dictionary<string, int>
        {
            [nameof(NativeFeatures.DismFeatureInfo.Name)] = 0,
            [nameof(NativeFeatures.DismFeatureInfo.State)] = pointer,
            [nameof(NativeFeatures.DismFeatureInfo.DisplayName)] = pointer + 4,
            [nameof(NativeFeatures.DismFeatureInfo.Description)] = 2 * pointer + 4,
            [nameof(NativeFeatures.DismFeatureInfo.Restart)] = 3 * pointer + 4,
            [nameof(NativeFeatures.DismFeatureInfo.Properties)] = 3 * pointer + 8,
            [nameof(NativeFeatures.DismFeatureInfo.PropertyCount)] = 4 * pointer + 8
        };
        foreach (var offset in offsets) Assert(Marshal.OffsetOf<NativeFeatures.DismFeatureInfo>(offset.Key).ToInt32() == offset.Value, offset.Key + " differs from DismAPI.h.");

        using (var fixture = new BufferFixture())
        {
            IntPtr memory = fixture.Buffer(featureSize * 2);
            Marshal.WriteIntPtr(memory, 0, fixture.Text("Feature-One")); Marshal.WriteInt32(memory, pointer, 4);
            Marshal.WriteIntPtr(memory, featureSize, fixture.Text("Feature-Two")); Marshal.WriteInt32(memory, featureSize + pointer, 0);
            var rows = NativeFeatures.ReadDismFeatures(memory, 2, CancellationToken.None, name => "Label " + name);
            Assert(rows.Count == 2 && rows[0]!["name"]!.GetValue<string>() == "Feature-One" && rows[1]!["name"]!.GetValue<string>() == "Feature-Two", "the second packed array element was read with the wrong stride.");
            Assert(rows[0]!["installed"]!.GetValue<bool>() && !rows[1]!["installed"]!.GetValue<bool>(), "packed feature state was changed.");
            Assert(rows[1]!["displayName"]!.GetValue<string>() == "Label Feature-Two", "a feature borrowed another element's label.");
            using var cancellation = new CancellationTokenSource(); cancellation.Cancel(); int reads = 0; bool cancelled = false;
            try { NativeFeatures.ReadDismFeatures(memory, 2, cancellation.Token, name => { reads++; return name; }); }
            catch (OperationCanceledException) { cancelled = true; }
            Assert(cancelled && reads == 0, "cancelled inventory dereferenced a feature or read metadata.");
        }
        Assert(NativeFeatures.ReadDismFeatures(IntPtr.Zero, 0, CancellationToken.None, _ => throw new Exception()).Count == 0, "an empty native array requires a buffer.");
        bool missing = false;
        try { NativeFeatures.ReadDismFeatures(IntPtr.Zero, 1, CancellationToken.None, name => name); }
        catch (InvalidDataException) { missing = true; }
        Assert(missing, "a missing nonempty feature buffer was accepted.");

        var labels = new NativeFeatureDisplayCache(); var now = DateTimeOffset.UtcNow; int deletes = 0, queries = 0;
        var metadata = new BufferFixture(); IntPtr info = metadata.Buffer(infoSize);
        Marshal.WriteIntPtr(info, 0, metadata.Text("Feature-One")); Marshal.WriteInt32(info, pointer, 4);
        Marshal.WriteIntPtr(info, pointer + 4, metadata.Text("Lokalisierte Funktion – Test"));
        Marshal.WriteIntPtr(info, 2 * pointer + 4, metadata.Text("Description must not become the display name."));
        Marshal.WriteInt32(info, 3 * pointer + 4, 1);
        Marshal.WriteIntPtr(info, 3 * pointer + 8, metadata.Buffer(3 * pointer)); Marshal.WriteInt32(info, 4 * pointer + 8, 1);
        var details = Marshal.PtrToStructure<NativeFeatures.DismFeatureInfo>(info);
        Assert(details.PropertyCount == 1 && details.Properties != IntPtr.Zero, "custom-property pointer/count order differs from the SDK.");
        string display = labels.Read("Feature-One", now, () => NativeFeatures.ReadDismDisplayName("Feature-One",
            (out IntPtr value) => { queries++; value = info; return 0; }, value => { Assert(value == info, "wrong feature metadata buffer released."); deletes++; metadata.Dispose(); }));
        // The callback has freed both the struct and its UTF-16 strings already.
        Assert(display == "Lokalisierte Funktion – Test" && deletes == 1 && queries == 1, "metadata was read after release, at the wrong offset, or not released exactly once.");
        Assert(labels.Read("feature-one", now.AddMinutes(1), () => throw new Exception("Borrowed native pointer reused.")) == display, "the cache did not preserve its managed string after native release.");
        metadata.Dispose();

        foreach (string? missingLabel in new string?[] { null, "", " \t\r\n", "\u2003" })
        {
            using var nullLabel = new BufferFixture();
            IntPtr buffer = nullLabel.Buffer(infoSize); int released = 0;
            if (missingLabel is not null) Marshal.WriteIntPtr(buffer, pointer + 4, nullLabel.Text(missingLabel));
            Assert(NativeFeatures.ReadDismDisplayName("Fallback", (out IntPtr value) => { value = buffer; return 0; }, _ => released++) == "Fallback" && released == 1, "a null, empty or whitespace display name does not retain its safe feature-name fallback.");
        }
        using (var failedInfo = new BufferFixture())
        {
            IntPtr buffer = failedInfo.Buffer(infoSize); int released = 0; bool failed = false;
            try { NativeFeatures.ReadDismDisplayName("Failure", (out IntPtr value) => { value = buffer; return unchecked((int)0x80070005); }, _ => released++); }
            catch (Exception error) when (error.HResult == unchecked((int)0x80070005)) { failed = true; }
            Assert(failed && released == 1, "failed native metadata reads must preserve HRESULT and release an assigned buffer.");
        }
        int nullDeletes = 0; missing = false;
        try { NativeFeatures.ReadDismDisplayName("Missing", (out IntPtr value) => { value = IntPtr.Zero; return 0; }, _ => nullDeletes++); }
        catch (InvalidDataException) { missing = true; }
        Assert(missing && nullDeletes == 0, "a successful API call with no metadata buffer must fail without deleting a null pointer.");
        Console.WriteLine("PASS native DISM ABI: packed feature stride, all feature-info offsets, UTF-16 copy before release, HRESULT cleanup, managed cache lifetime and cancellation.");
    }

    // Explicit diagnostic only: no config, credentials, portal, service, role
    // changes or feature mutations. Run from an elevated Windows terminal.
    internal static async Task<int> ProbeAsync()
    {
        try
        {
            if (!OperatingSystem.IsWindows() || RuntimeInformation.OSArchitecture != Architecture.X64) throw new PlatformNotSupportedException("The native feature probe requires x64 Windows.");
            using var identity = WindowsIdentity.GetCurrent();
            if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) throw new UnauthorizedAccessException("Run the read-only native feature probe in an elevated Windows terminal.");
            Run(); using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(3));
            for (int pass = 1; pass <= 2; pass++)
            {
                var rows = await NativeFeatures.ProbeDismAsync(timeout.Token);
                int invalidNames = rows.Count(row => string.IsNullOrWhiteSpace(row?["name"]?.GetValue<string>()));
                int invalidLabels = rows.Count(row => string.IsNullOrWhiteSpace(row?["displayName"]?.GetValue<string>()));
                string counts = $"count={rows.Count}, invalidNames={invalidNames}, invalidLabels={invalidLabels}";
                Console.WriteLine($"Native DISM online inventory {pass}/2: {counts}.");
                Assert(rows.Count > 0 && invalidNames == 0 && invalidLabels == 0, "native online inventory is empty or has invalid feature names/display names (" + counts + ").");
                Console.WriteLine($"PASS native DISM online inventory {pass}/2: {rows.Count} optional features; native buffers copied and released.");
            }
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine("Native feature probe failed: " + error); return 1; }
    }
    private sealed class BufferFixture : IDisposable
    {
        private readonly List<IntPtr> allocations = new();
        internal IntPtr Buffer(int bytes) { IntPtr value = Marshal.AllocHGlobal(bytes); allocations.Add(value); Marshal.Copy(new byte[bytes], 0, value, bytes); return value; }
        internal IntPtr Text(string text) { IntPtr value = Marshal.StringToHGlobalUni(text); allocations.Add(value); return value; }
        public void Dispose() { foreach (IntPtr value in allocations) Marshal.FreeHGlobal(value); allocations.Clear(); }
    }
}
