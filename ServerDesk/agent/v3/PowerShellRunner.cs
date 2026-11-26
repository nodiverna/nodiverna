using System.Collections;
using System.Diagnostics;
using System.Globalization;
using System.Management.Automation;
using System.Management.Automation.Host;
using System.Management.Automation.Runspaces;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.PowerShell;

namespace ServerDesk.Agent;

/// <summary>
/// PowerShell is reserved for user scripts and the interactive terminal. The service's
/// telemetry and built-in management actions use Windows APIs, not this runtime.
/// Scripts are sent through a private anonymous pipe to another instance of this EXE.
/// No executable scripts or parameter files are written to disk, and no powershell.exe
/// or pwsh installation is needed. The child has its own kill-on-close Windows job.
/// </summary>
internal static class PowerShellRunner
{
    internal const int MaximumScriptBytes = 65536;
    internal const int MaximumRequestBytes = 131072;
    internal static string Executable => Environment.ProcessPath ?? throw new InvalidOperationException("Agent executable path is unavailable.");

    internal static async Task<(int ExitCode, string Output, string Error, bool Truncated)> RunUserScriptAsync(string script, JsonObject parameters, TimeSpan timeout, CancellationToken token)
    {
        ValidateRequest(script, parameters);
        if (timeout <= TimeSpan.Zero || timeout > TimeSpan.FromHours(2)) throw new ArgumentOutOfRangeException(nameof(timeout));
        string payload = new JsonObject { ["script"] = script, ["parameters"] = parameters.DeepClone() }.ToJsonString();
        if (Encoding.UTF8.GetByteCount(payload) > MaximumRequestBytes) throw new InvalidDataException("The script and parameters exceed 128 KiB.");
        var start = new ProcessStartInfo(Executable)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = AppContext.BaseDirectory
        };
        // Framework-dependent development builds run through dotnet. Published agents
        // always invoke their own verified, local apphost executable.
        if (Path.GetFileNameWithoutExtension(Executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, Assembly.GetExecutingAssembly().GetName().Name + ".dll"));
        start.ArgumentList.Add("--script-host");
        using var process = new Process { StartInfo = start };
        if (!process.Start()) throw new InvalidOperationException("The embedded script host did not start.");
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token); limit.CancelAfter(timeout);
        // Drain even after truncation: a chatty script must not block on a full pipe.
        Task<(string Text, bool Truncated)> output = DrainAsync(process.StandardOutput, 262144, limit.Token);
        Task<(string Text, bool Truncated)> error = DrainAsync(process.StandardError, 8192, limit.Token);
        try
        {
            await process.StandardInput.WriteAsync(payload.AsMemory(), limit.Token);
            process.StandardInput.Close();
            await process.WaitForExitAsync(limit.Token);
            var stdout = await output; var stderr = await error;
            return (process.ExitCode, stdout.Text, stderr.Text, stdout.Truncated || stderr.Truncated);
        }
        catch
        {
            // Killing the root closes the child job, terminating detached descendants
            // too. Script cancellation is never retried because its effects are uncertain.
            try { if (!process.HasExited) process.Kill(true); } catch { }
            try { await process.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)); } catch { }
            await ObserveAsync(output); await ObserveAsync(error);
            if (!token.IsCancellationRequested && limit.IsCancellationRequested) throw new TimeoutException("The PowerShell script exceeded its execution deadline and its host was terminated.");
            throw;
        }
    }

    /// <summary>Called only by Program's SYSTEM-gated --script-host mode.</summary>
    internal static async Task<int> RunScriptHostAsync()
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            using var memory = new MemoryStream();
            var buffer = new byte[8192]; using Stream input = Console.OpenStandardInput();
            while (true)
            {
                int read = await input.ReadAsync(buffer);
                if (read == 0) break;
                if (memory.Length + read > MaximumRequestBytes) throw new InvalidDataException("The script request exceeds 128 KiB.");
                await memory.WriteAsync(buffer.AsMemory(0, read));
            }
            var request = JsonNode.Parse(memory.GetBuffer().AsSpan(0, checked((int)memory.Length)))!.AsObject();
            string script = request["script"]?.GetValue<string>() ?? throw new InvalidDataException("A script is required.");
            JsonObject parameters = request["parameters"]?.AsObject() ?? new JsonObject();
            ValidateRequest(script, parameters);
            return ExecuteInProcess(script, parameters, Console.Out, Console.Error);
        }
        catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }

    /// <summary>A persistent console host inside this EXE, connected to ConPTY.</summary>
    internal static int RunTerminalHost()
    {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        return ConsoleShell.Start(CreateSessionState(), "ServerDesk · PowerShell 7.6", "ServerDesk embedded PowerShell", ["-NoLogo", "-NoProfile", "-NoExit"]);
    }

    private static InitialSessionState CreateSessionState()
    {
        // CreateDefault registers compiled engine cmdlets/providers and the engine's
        // built-in type/format definitions. Unlike CreateDefault2 + module discovery,
        // this does not depend on SDK .psd1/.psm1 content beside the executable.
        InitialSessionState state = InitialSessionState.CreateDefault();
        state.ThrowOnRunspaceOpenError = true;
        if (OperatingSystem.IsWindows()) RegisterCompiledCmdlets(state, "Microsoft.Management.Infrastructure.CimCmdlets");
        state.Variables.Add(new SessionStateVariableEntry("ErrorActionPreference", ActionPreference.Stop, "Fail scripts when a command fails."));
        state.Variables.Add(new SessionStateVariableEntry("ProgressPreference", ActionPreference.SilentlyContinue, "Avoid progress output in the portal."));
        return state;
    }

    private static void RegisterCompiledCmdlets(InitialSessionState state, string assemblyName)
    {
        // CimCmdlets normally relies on a module manifest for discovery. Register
        // the shipped managed cmdlets directly, so common Windows diagnostics
        // work without a module directory beside the single-file application.
        var names = state.Commands.Select(command => command.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (Type type in Assembly.Load(assemblyName).GetExportedTypes())
        {
            if (type.IsAbstract || !typeof(Cmdlet).IsAssignableFrom(type) || type.GetCustomAttribute<CmdletAttribute>() is not { } definition) continue;
            string name = definition.VerbName + "-" + definition.NounName;
            if (names.Add(name)) state.Commands.Add(new SessionStateCmdletEntry(name, type, null));
        }
    }

    private static int ExecuteInProcess(string script, JsonObject parameters, TextWriter output, TextWriter error)
    {
        var host = new ScriptHost(output, error);
        using var runspace = RunspaceFactory.CreateRunspace(host, CreateSessionState());
        runspace.Open();
        using var powershell = PowerShell.Create(); powershell.Runspace = runspace;
        var values = new Hashtable(StringComparer.OrdinalIgnoreCase);
        foreach (var field in parameters) values.Add(field.Key, ToPowerShellValue(field.Value));
        runspace.SessionStateProxy.SetVariable("ServerDeskParameters", values);
        powershell.AddScript(script, useLocalScope: true).AddParameters(values).AddCommand("Out-String").AddParameter("Stream").AddParameter("Width", 240);
        using var results = new PSDataCollection<PSObject>();
        results.DataAdded += (_, _) => { foreach (var item in results.ReadAll()) output.WriteLine(item?.ToString()); };
        powershell.Streams.Error.DataAdded += (_, _) => { foreach (var item in powershell.Streams.Error.ReadAll()) error.WriteLine(item.ToString()); };
        // PowerShell also buffers side-channel records. The host renders them as
        // they arrive; clear the records so verbose user code cannot grow memory
        // without limit while the parent drains bounded output.
        powershell.Streams.Warning.DataAdded += (_, _) => powershell.Streams.Warning.ReadAll();
        powershell.Streams.Verbose.DataAdded += (_, _) => powershell.Streams.Verbose.ReadAll();
        powershell.Streams.Debug.DataAdded += (_, _) => powershell.Streams.Debug.ReadAll();
        powershell.Streams.Information.DataAdded += (_, _) => powershell.Streams.Information.ReadAll();
        powershell.Streams.Progress.DataAdded += (_, _) => powershell.Streams.Progress.ReadAll();
        try { powershell.Invoke<PSObject, PSObject>(null!, results, null!); }
        catch (Exception e) { error.WriteLine(e.Message); return host.ExitCode ?? 1; }
        if (host.ExitCode is int explicitCode) return explicitCode;
        if (powershell.HadErrors) return 1;
        return runspace.SessionStateProxy.GetVariable("LASTEXITCODE") is int nativeCode && nativeCode != 0 ? nativeCode : 0;
    }

    private static object? ToPowerShellValue(JsonNode? value) => value switch
    {
        null => null,
        JsonObject obj => obj.Aggregate(new Hashtable(StringComparer.OrdinalIgnoreCase), (map, pair) => { map.Add(pair.Key, ToPowerShellValue(pair.Value)); return map; }),
        JsonArray array => array.Select(ToPowerShellValue).ToArray(),
        JsonValue scalar => ToScalar(JsonSerializer.SerializeToElement(scalar)),
        _ => throw new InvalidDataException("Unsupported script parameter value.")
    };

    private static object? ToScalar(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Number when value.TryGetInt64(out long number) => number,
        JsonValueKind.Number => value.GetDouble(),
        JsonValueKind.Null => null,
        _ => throw new InvalidDataException("Unsupported script parameter value.")
    };

    private static void ValidateRequest(string script, JsonObject parameters)
    {
        int size = Encoding.UTF8.GetByteCount(script);
        if (size is < 1 or > MaximumScriptBytes || script.Contains('\0')) throw new InvalidDataException("PowerShell scripts must contain 1–65536 UTF-8 bytes without NUL characters.");
        if (parameters.Count > 100 || parameters.Any(p => string.IsNullOrWhiteSpace(p.Key) || p.Key.Length > 100)) throw new InvalidDataException("Invalid PowerShell parameter names or count.");
    }

    internal static async Task<(string Text, bool Truncated)> DrainAsync(StreamReader stream, int maximum, CancellationToken token)
    {
        var buffer = new char[4096]; var result = new StringBuilder(); bool truncated = false;
        while (true)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(), token); if (read == 0) break;
            int keep = Math.Min(read, maximum - result.Length);
            if (keep > 0) result.Append(buffer, 0, keep);
            if (keep != read) truncated = true;
        }
        // Avoid publishing a dangling high surrogate at the truncation boundary.
        if (result.Length > 0 && char.IsHighSurrogate(result[^1])) result.Length--;
        return (result.ToString(), truncated);
    }
    private static async Task ObserveAsync(Task task) { try { await task; } catch { } }

    internal static int RunSelfTests()
    {
        try
        {
            if (OperatingSystem.IsWindows())
            {
                var commands = CreateSessionState().Commands.Select(command => command.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
                foreach (string name in new[] { "Get-Service", "Get-WinEvent", "Get-CimInstance", "Invoke-CimMethod", "ConvertTo-Json" })
                    if (!commands.Contains(name)) throw new InvalidOperationException("A bundled Windows cmdlet was not registered: " + name);
            }
            using var output = new StringWriter(); using var error = new StringWriter();
            int code = ExecuteInProcess("param($Greeting,$Nested) Write-Output ($Greeting + ':' + $Nested.value); @{answer=42}|ConvertTo-Json -Compress; (Get-Process -Id $PID).Id; Get-ChildItem . | Select-Object -First 1 | Out-String", new JsonObject { ["Greeting"] = "pipe input", ["Nested"] = new JsonObject { ["value"] = 7 } }, output, error);
            if (code != 0 || !output.ToString().Contains("pipe input:7") || !output.ToString().Contains("\"answer\":42") || error.GetStringBuilder().Length > 0) throw new InvalidOperationException("Embedded cmdlets, parameters, or providers failed: " + error);
            int failure = ExecuteInProcess("throw 'expected failure'", new JsonObject(), new StringWriter(), new StringWriter());
            int explicitExit = ExecuteInProcess("exit 17", new JsonObject(), new StringWriter(), new StringWriter());
            if (failure == 0 || explicitExit != 17) throw new InvalidOperationException("Script failure/exit status was lost.");
            Console.WriteLine("Embedded PowerShell: compiled cmdlets, filesystem provider, typed parameters, output, failure, and exit status verified."); return 0;
        }
        catch (Exception e) { Console.Error.WriteLine(e); return 1; }
    }

    private sealed class ScriptHost(TextWriter output, TextWriter error) : PSHost
    {
        private readonly Guid id = Guid.NewGuid();
        private readonly PSHostUserInterface ui = new ScriptUi(output, error);
        internal int? ExitCode { get; private set; }
        public override Guid InstanceId => id;
        public override string Name => "ServerDeskScript";
        public override Version Version => new(1, 0);
        public override PSHostUserInterface UI => ui;
        public override CultureInfo CurrentCulture => CultureInfo.InvariantCulture;
        public override CultureInfo CurrentUICulture => CultureInfo.InvariantCulture;
        public override void SetShouldExit(int exitCode) => ExitCode = exitCode;
        public override void EnterNestedPrompt() => throw new InvalidOperationException("Interactive prompts require a terminal session.");
        public override void ExitNestedPrompt() { }
        public override void NotifyBeginApplication() { }
        public override void NotifyEndApplication() { }
    }
    private sealed class ScriptUi(TextWriter output, TextWriter error) : PSHostUserInterface
    {
        public override PSHostRawUserInterface RawUI => null!;
        public override string ReadLine() => throw PromptError();
        public override System.Security.SecureString ReadLineAsSecureString() => throw PromptError();
        public override Dictionary<string, PSObject> Prompt(string caption, string message, System.Collections.ObjectModel.Collection<FieldDescription> descriptions) => throw PromptError();
        public override PSCredential PromptForCredential(string caption, string message, string userName, string targetName) => throw PromptError();
        public override PSCredential PromptForCredential(string caption, string message, string userName, string targetName, PSCredentialTypes allowedCredentialTypes, PSCredentialUIOptions options) => throw PromptError();
        public override int PromptForChoice(string caption, string message, System.Collections.ObjectModel.Collection<ChoiceDescription> choices, int defaultChoice) => throw PromptError();
        public override void Write(string value) => output.Write(value);
        public override void Write(ConsoleColor foregroundColor, ConsoleColor backgroundColor, string value) => output.Write(value);
        public override void WriteLine(string value) => output.WriteLine(value);
        public override void WriteErrorLine(string value) => error.WriteLine(value);
        public override void WriteDebugLine(string message) => output.WriteLine("DEBUG: " + message);
        public override void WriteVerboseLine(string message) => output.WriteLine("VERBOSE: " + message);
        public override void WriteWarningLine(string message) => output.WriteLine("WARNING: " + message);
        public override void WriteProgress(long sourceId, ProgressRecord record) { }
        private static InvalidOperationException PromptError() => new("Interactive prompts require a terminal session.");
    }
}
