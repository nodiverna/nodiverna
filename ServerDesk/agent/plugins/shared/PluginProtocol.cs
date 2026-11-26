using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ServerDesk.Plugins;

// The protocol between the SYSTEM broker and an agent plugin
// (docs/agent-plugins.md, "Protocol"). This file is linked into the agent
// (agent/v3) and into every plugin project, so both sides read and write the
// same frames. UTF-8 JSON, one object per line ("\n"), over the plugin's stdin
// and stdout:
//   1. broker: {"type":"hello","protocol":1,"agentVersion":"4.16.0"}
//   2. plugin: {"type":"hello","protocol":1,"name":"dhcp","version":"1.0.0","capabilities":["dhcp-read"]}
//   3. broker: {"type":"request","id":"<guid>","operation":"dhcp-read","parameters":{}}
//   4. plugin: {"type":"result","id":"<same>","ok":true,"code":"PLUGIN_…","args":{},"message":"…","data":{…}}
// The broker closes stdin after the request; the plugin exits with code 0.
// A broker line is at most 64 KiB, a plugin line at most 2.5 MiB.
internal static class PluginProtocol
{
    internal const int Version = 1;
    internal const int MaximumBrokerLine = 65_536, MaximumPluginLine = 2_621_440;
    internal const int MaximumDataBytes = 2_097_152, MaximumArgs = 8, MaximumArgValue = 1000, MaximumMessage = 3500;
    internal const string Argument = "--plugin-host";
    private static readonly Regex NamePattern = new("^[a-z][a-z0-9-]{1,31}$", RegexOptions.CultureInvariant);
    private static readonly Regex CapabilityPattern = new("^[a-z][a-z0-9-]{1,63}$", RegexOptions.CultureInvariant);
    // A plugin's own version: X.Y.Z, or a dev build X.Y.Z-dev.<sha7> (runtime/release-version.mjs).
    private static readonly Regex VersionPattern = new(@"^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-dev\.[0-9a-f]{7})?\z", RegexOptions.CultureInvariant);
    // A minimum agent version: always X.Y.Z.
    private static readonly Regex BaseVersionPattern = new(@"^\d{1,5}\.\d{1,5}\.\d{1,5}\z", RegexOptions.CultureInvariant);
    private static readonly Regex CodePattern = new("^PLUGIN_[A-Z0-9_]{1,60}$", RegexOptions.CultureInvariant);
    private static readonly Regex ArgumentNamePattern = new("^[a-z][A-Za-z0-9]{0,31}$", RegexOptions.CultureInvariant);

    internal static bool IsName(string? value) => value is not null && NamePattern.IsMatch(value);
    internal static bool IsCapability(string? value) => value is not null && CapabilityPattern.IsMatch(value);
    internal static bool IsVersion(string? value) => value is not null && VersionPattern.IsMatch(value);
    internal static bool IsBaseVersion(string? value) => value is not null && BaseVersionPattern.IsMatch(value);
    internal static bool IsCode(string? value) => value is not null && CodePattern.IsMatch(value);

    /// <summary>Parses one line as a JSON object of the given type, else a ProtocolException.</summary>
    internal static JsonObject Parse(byte[] line, string type)
    {
        JsonObject? value;
        try { value = JsonNode.Parse(new UTF8Encoding(false, true).GetString(line)) as JsonObject; }
        catch (Exception e) when (e is System.Text.Json.JsonException or DecoderFallbackException or ArgumentException) { throw new ProtocolException("A protocol line is not a JSON object.", "invalid"); }
        if (value is null || Text(value, "type") != type) throw new ProtocolException("A protocol line has another type than " + type + ".", "invalid");
        return value;
    }

    /// <summary>Writes one object as one line. Refuses a line above `maximum` bytes.</summary>
    internal static async Task WriteLineAsync(Stream stream, JsonObject value, int maximum, CancellationToken token)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value.ToJsonString());
        if (bytes.Length > maximum || Array.IndexOf(bytes, (byte)'\n') >= 0) throw new ProtocolException("A protocol line exceeds " + maximum + " bytes.", "oversized");
        await stream.WriteAsync(bytes, token); await stream.WriteAsync(new[] { (byte)'\n' }, token); await stream.FlushAsync(token);
    }

    internal static JsonObject BrokerHello(string agentVersion) => new() { ["type"] = "hello", ["protocol"] = Version, ["agentVersion"] = agentVersion };
    internal static JsonObject PluginHello(string name, string version, IEnumerable<string> capabilities) => new() { ["type"] = "hello", ["protocol"] = Version, ["name"] = name, ["version"] = version, ["capabilities"] = new JsonArray(capabilities.Select(item => (JsonNode)JsonValue.Create(item)!).ToArray()) };
    internal static JsonObject Request(string id, string operation, JsonObject parameters) => new() { ["type"] = "request", ["id"] = id, ["operation"] = operation, ["parameters"] = parameters };
    internal static JsonObject Result(string id, bool ok, string code, IReadOnlyDictionary<string, string> args, string message, JsonObject? data)
    {
        var box = new JsonObject(); foreach (var pair in args) box[pair.Key] = pair.Value;
        var result = new JsonObject { ["type"] = "result", ["id"] = id, ["ok"] = ok, ["code"] = code, ["args"] = box, ["message"] = message };
        if (data is not null) result["data"] = data;
        return result;
    }

    /// <summary>The plugin hello as name, version and capabilities, else a ProtocolException.</summary>
    internal static (string Name, string Version, string[] Capabilities) ReadPluginHello(JsonObject hello)
    {
        if (Integer(hello, "protocol") != Version) throw new ProtocolException("The plugin speaks another protocol version.", "handshake");
        string name = Text(hello, "name"), version = Text(hello, "version");
        if (!IsName(name) || !IsVersion(version) || hello["capabilities"] is not JsonArray list || list.Count is < 1 or > 32) throw new ProtocolException("The plugin hello is not valid.", "handshake");
        var capabilities = list.Select(item => item is JsonValue value && value.TryGetValue<string>(out var text) ? text : null).ToArray();
        if (capabilities.Any(item => !IsCapability(item)) || capabilities.Distinct(StringComparer.Ordinal).Count() != capabilities.Length) throw new ProtocolException("The plugin hello has invalid capabilities.", "handshake");
        return (name, version, capabilities.Select(item => item!).ToArray());
    }

    /// <summary>A plugin result: its id must be the request id, the code PLUGIN_*, at most eight string arguments and a bounded message.</summary>
    internal static PluginResult ReadResult(JsonObject result, string requestId)
    {
        if (Text(result, "id") != requestId) throw new ProtocolException("The plugin answered another request.", "invalid");
        if (result["ok"] is not JsonValue okValue || !okValue.TryGetValue<bool>(out bool ok)) throw new ProtocolException("The plugin result has no ok flag.", "invalid");
        string code = Text(result, "code"), message = Text(result, "message");
        if (!IsCode(code) || message.Length > MaximumMessage) throw new ProtocolException("The plugin result has an invalid code or message.", "invalid");
        var args = new Dictionary<string, string>(StringComparer.Ordinal);
        if (result["args"] is JsonObject box)
        {
            if (box.Count > MaximumArgs) throw new ProtocolException("The plugin result has too many arguments.", "invalid");
            foreach (var pair in box)
            {
                if (!ArgumentNamePattern.IsMatch(pair.Key) || pair.Value is not JsonValue value || !value.TryGetValue<string>(out var text) || text.Length > MaximumArgValue) throw new ProtocolException("The plugin result has an invalid argument.", "invalid");
                args[pair.Key] = text;
            }
        }
        else if (result["args"] is not null) throw new ProtocolException("The plugin result has invalid arguments.", "invalid");
        JsonObject? data = null;
        if (result["data"] is JsonObject payload)
        {
            if (Encoding.UTF8.GetByteCount(payload.ToJsonString()) > MaximumDataBytes) throw new ProtocolException("The plugin data exceed 2 MiB.", "oversized");
            // A copy without a parent: the node of the result line cannot move into the upload
            // ("The node already has a parent", agent 4.20.0 and DNS plugin 1.0.0).
            data = payload.DeepClone().AsObject();
        }
        else if (result["data"] is not null) throw new ProtocolException("The plugin data are not an object.", "invalid");
        return new PluginResult(ok, code, args, message, data);
    }

    /// <summary>
    /// The broker's relay request of one plugin upload (kind plugin-data-upload,
    /// WorkerRelay.cs). The one builder of this envelope: the broker and the
    /// self-tests of the agent and of each plugin use it. Data that already
    /// have a parent are copied, so a node of another tree never throws here.
    /// </summary>
    internal static JsonObject UploadMessage(PluginUpload upload) => new()
    {
        ["kind"] = "plugin-data-upload", ["plugin"] = upload.Plugin, ["operation"] = upload.Operation, ["jobId"] = upload.JobId, ["collectedAt"] = upload.CollectedAt,
        ["data"] = upload.Data.Parent is null ? upload.Data : upload.Data.DeepClone(),
    };

    internal static string Text(JsonObject value, string name) => value[name] is JsonValue item && item.TryGetValue<string>(out string? text) ? text ?? "" : "";
    internal static long Integer(JsonObject value, string name) => value[name] is JsonValue item && item.TryGetValue<long>(out long number) ? number : -1;
}

/// <summary>Reads the lines of one stream through a 64 KiB buffer.</summary>
internal sealed class PluginLineReader(Stream stream)
{
    private readonly byte[] buffer = new byte[65_536];
    private int start, end;

    /// <summary>One line of at most `maximum` bytes without the "\n". Null at a clean end of stream; an end inside a line or a longer line is a ProtocolException.</summary>
    internal async Task<byte[]?> ReadLineAsync(int maximum, CancellationToken token)
    {
        using var line = new MemoryStream();
        while (true)
        {
            if (start == end)
            {
                start = 0; end = await stream.ReadAsync(buffer, token);
                if (end == 0) return line.Length == 0 ? null : throw new ProtocolException("The stream ended inside a line.", "eof");
            }
            int newline = Array.IndexOf(buffer, (byte)'\n', start, end - start), take = (newline < 0 ? end : newline) - start;
            if (line.Length + take > maximum) throw new ProtocolException("A protocol line exceeds " + maximum + " bytes.", "oversized");
            line.Write(buffer, start, take);
            if (newline >= 0) { start = newline + 1; return line.ToArray(); }
            start = end;
        }
    }
}

/// <summary>One plugin answer: ok, the PLUGIN_* code with its arguments, the English message and the optional data.</summary>
internal sealed record PluginResult(bool Ok, string Code, IReadOnlyDictionary<string, string> Args, string Message, JsonObject? Data);

/// <summary>The data of one plugin operation for the portal: the data of a job carry its id, a periodic read has none.</summary>
internal sealed record PluginUpload(string Plugin, string Operation, string? JobId, string CollectedAt, JsonObject Data);

/// <summary>A broken protocol frame. Reason: eof, oversized, invalid or handshake.</summary>
internal sealed class ProtocolException(string message, string reason) : IOException(message)
{
    internal string Reason { get; } = reason;
}
