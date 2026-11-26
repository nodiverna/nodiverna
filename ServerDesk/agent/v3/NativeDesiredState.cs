using System.Diagnostics;
using System.Globalization;
using System.Management;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ServerDesk.Agent;

// Agent code is managed C# and ships inside the single executable. Windows DSC
// remains the genuine Windows resource engine, not an imitation compliance DSL.
// MOF is passed to its WMI provider in memory. The only Windows PowerShell use
// is compilation of explicitly approved, user-authored legacy Configurations:
// Windows DSC 1.1 cannot be compiled by the embedded PowerShell 7 SDK.
internal static class NativeDesiredState
{
    private const string Namespace = @"root\Microsoft\Windows\DesiredStateConfiguration";
    private static readonly SemaphoreSlim LcmGate = new(1, 1);
    private const int MaximumMofBytes = 1_048_576;
    private const string ReferenceConfiguration = "Local reference configuration";

    internal static async Task<JsonObject> ExecuteAsync(string root, string id, string content, JsonObject request, bool apply, TimeSpan timeout, CancellationToken token)
    {
        string engine = request["engine"]?.GetValue<string>() ?? "";
        if (engine is not ("dsc3" or "powershell-dsc" or "mof")) throw new AgentMessageException("AGENT_DSC_UNKNOWN_ENGINE");
        token.ThrowIfCancellationRequested();
        ValidateOperatingSystem();
        token.ThrowIfCancellationRequested();
        JsonObject parameters = ValidateParameters(request["parameters"]?.AsObject() ?? new JsonObject());
        JsonObject data;
        if (engine == "dsc3") data = await ExecuteDsc3Async(root, id, content, parameters, apply, token);
        else
        {
            if (engine == "mof" && parameters.Count != 0) throw new AgentMessageException("AGENT_DSC_MOF_NO_PARAMETERS");
            byte[] mof = engine == "powershell-dsc"
                ? await CompileAsync(root, id, content, request["configurationName"]?.GetValue<string>() ?? "", parameters, token)
                : [.. Encoding.UTF8.GetPreamble(), .. Encoding.UTF8.GetBytes(content)];
            try { data = await ExecuteMofAsync(root, mof, apply, timeout, token); }
            finally { CryptographicOperations.ZeroMemory(mof); }
        }
        data["engine"] = engine; data["operation"] = apply ? "apply" : "test";
        data["checkedAt"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture); data["rebootPending"] = NativeRebootStatus.Read().Pending;
        if (Encoding.UTF8.GetByteCount(data.ToJsonString()) > 131072) throw new AgentMessageException("AGENT_DSC_RESULT_TOO_LARGE");
        return data;
    }

    internal static JsonObject ValidateParameters(JsonObject parameters)
    {
        if (parameters.Count > 30) throw new AgentMessageException("AGENT_DSC_TOO_MANY_PARAMETERS");
        foreach (var parameter in parameters)
        {
            if (!Regex.IsMatch(parameter.Key, "^[A-Za-z_][A-Za-z0-9_]{0,63}$", RegexOptions.CultureInvariant)
                || new[] { "OutputPath", "ConfigurationData", "__proto__", "prototype", "constructor" }.Contains(parameter.Key, StringComparer.OrdinalIgnoreCase)) throw new AgentMessageException("AGENT_DSC_INVALID_PARAMETER");
            if (parameter.Value is not JsonValue value) throw new AgentMessageException("AGENT_DSC_SIMPLE_PARAMETERS");
            bool scalar = value.TryGetValue<bool>(out _) || value.GetValueKind() == System.Text.Json.JsonValueKind.Number && double.TryParse(value.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out double number) && double.IsFinite(number)
                || value.TryGetValue<string>(out string? text) && text.Length <= 4096 && !text.Contains('\0');
            if (!scalar) throw new AgentMessageException("AGENT_DSC_SIMPLE_PARAMETERS");
        }
        return parameters;
    }

    private static void ValidateOperatingSystem()
    {
        var operatingSystem = WindowsManagement.Query(@"root\cimv2", "SELECT Caption FROM Win32_OperatingSystem", 1).FirstOrDefault();
        string caption = operatingSystem is null ? "" : WindowsManagement.Text(operatingSystem, "Caption");
        if (!Regex.IsMatch(caption, @"Windows (Server (2022|2025)|11)", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase))
            throw new AgentMessageException("AGENT_DSC_OS_UNSUPPORTED");
    }


    private static void RequireManagement(string root)
    {
        if (LocalStore.ReadProtected(Path.Combine(root, "config.bin"))["mode"]?.GetValue<string>() != "Management")
            throw new AgentMessageException("AGENT_DESIRED_STATE_MANAGEMENT_REQUIRED");
    }

    private static async Task<JsonObject> ExecuteMofAsync(string root, byte[] mof, bool apply, TimeSpan timeout, CancellationToken token)
    {
        if (mof.Length is < 1 or > MaximumMofBytes) throw new AgentMessageException("AGENT_DSC_MOF_TOO_LARGE");
        if (!await LcmGate.WaitAsync(0, token)) throw new AgentMessageException("AGENT_DSC_BUSY");
        byte[] providerMof = mof.ToArray();
        Task<JsonObject> operation = Task.Run(() => { try { return ExecuteMof(root, providerMof, apply, timeout, token); } finally { CryptographicOperations.ZeroMemory(providerMof); } });
        try { return await operation.WaitAsync(token); }
        catch (OperationCanceledException)
        {
            // Cancellation of this client call does not stop the Windows
            // provider. Keep admission closed until that call returns. Calling
            // StopConfiguration blindly could terminate a different manager's
            // configuration if our call just finished in the meantime.
            throw new OperationCanceledException("DSC was cancelled or exceeded the time limit. Check partial changes locally; the job is not repeated.", token);
        }
        finally
        {
            if (operation.IsCompleted) LcmGate.Release();
            else _ = operation.ContinueWith(completed => { _ = completed.Exception; LcmGate.Release(); }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        }
    }

    private static JsonObject ExecuteMof(string root, byte[] mof, bool apply, TimeSpan timeout, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        RequireManagement(root);
        if (apply)
        {
            var metadata = Invoke("GetMetaConfiguration", null, TimeSpan.FromSeconds(20));
            if (metadata.GetValueOrDefault("MetaConfiguration") is not Dictionary<string, object?> lcm) throw new AgentMessageException("AGENT_DSC_LCM_UNREADABLE");
            if (WindowsManagement.Boolean(lcm, "RebootNodeIfNeeded")) throw new AgentMessageException("AGENT_DSC_LCM_AUTO_REBOOT");
            if (WindowsManagement.Text(lcm, "ConfigurationMode") == "ApplyAndAutoCorrect") throw new AgentMessageException("AGENT_DSC_LCM_AUTO_CORRECT");
            if (WindowsManagement.Text(lcm, "LCMState") is "Busy" or "PendingReboot") throw new AgentMessageException("AGENT_DSC_LCM_BUSY");
            token.ThrowIfCancellationRequested();
            RequireManagement(root);
            // Never forcibly stop a concurrent configuration submitted by a
            // different Windows management system.
            Invoke("SendConfigurationApply", new() { ["ConfigurationData"] = mof, ["force"] = false }, timeout);
        }
        token.ThrowIfCancellationRequested();
        RequireManagement(root);
        var tested = Invoke("TestConfiguration", new() { ["configurationData"] = mof }, timeout);
        if (tested.GetValueOrDefault("InDesiredState") is not bool compliant) throw new AgentMessageException("AGENT_DSC_NO_COMPLIANCE");
        var resources = new JsonArray();
        AddMofResources(tested.GetValueOrDefault("ResourcesInDesiredState"), true, resources);
        AddMofResources(tested.GetValueOrDefault("ResourcesNotInDesiredState"), false, resources);
        if (resources.Count == 0) resources.Add(new JsonObject { ["name"] = ReferenceConfiguration, ["type"] = "PSDesiredStateConfiguration", ["inDesiredState"] = compliant, ["differingProperties"] = new JsonArray() });
        return new JsonObject { ["runtime"] = "Windows DSC 1.1 / native LCM WMI", ["compliant"] = compliant, ["resources"] = resources, ["resourceDetail"] = resources.Count == 1 && resources[0]?["name"]?.GetValue<string>() == ReferenceConfiguration ? "overall-reference" : "resources" };
    }

    private static Dictionary<string, object?> Invoke(string method, Dictionary<string, object?>? values, TimeSpan timeout)
    {
        var scope = new ManagementScope(Namespace);
        using var provider = new ManagementClass(scope, new ManagementPath("MSFT_DSCLocalConfigurationManager"), new ObjectGetOptions { Timeout = timeout });
        using var input = provider.GetMethodParameters(method);
        if (values is not null) foreach (var value in values) input[value.Key] = value.Value;
        using var output = provider.InvokeMethod(method, input, new InvokeMethodOptions { Timeout = timeout });
        if (output is null) throw new AgentMessageException("AGENT_DSC_PROVIDER_NO_RESULT", ("method", method));
        var result = WindowsManagement.Copy(output);
        uint status = Convert.ToUInt32(result.GetValueOrDefault("ReturnValue") ?? uint.MaxValue, CultureInfo.InvariantCulture);
        if (status != 0) throw new AgentMessageException("AGENT_DSC_PROVIDER_ERROR", ("method", method), ("status", status));
        return result;
    }

    private static void AddMofResources(object? value, bool compliant, JsonArray resources)
    {
        if (value is not System.Collections.IEnumerable values || value is string) return;
        foreach (object? row in values)
        {
            if (row is not Dictionary<string, object?> resource) throw new AgentMessageException("AGENT_DSC_INVALID_RESOURCE_OUTPUT");
            if (resources.Count >= 200) throw new AgentMessageException("AGENT_DSC_TOO_MANY_RESOURCES");
            resources.Add(new JsonObject { ["name"] = WindowsManagement.Text(resource, "ResourceId", 500), ["type"] = WindowsManagement.Text(resource, "ModuleName", 200), ["inDesiredState"] = compliant, ["differingProperties"] = new JsonArray() });
        }
    }

    private const string Compiler = """
        $ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$WarningPreference='SilentlyContinue'
        [Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
        [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
        try {
          $Payload=[Console]::In.ReadToEnd()|ConvertFrom-Json
          Import-Module PSDesiredStateConfiguration -ErrorAction Stop
          $Tokens=$null;$ParseErrors=$null
          $Ast=[Management.Automation.Language.Parser]::ParseInput([string]$Payload.content,[ref]$Tokens,[ref]$ParseErrors)
          if($ParseErrors.Count){throw 'The PowerShell configuration contains syntax errors.'}
          $Definitions=@($Ast.FindAll({param($Node)$Node -is [Management.Automation.Language.ConfigurationDefinitionAst]},$true))
          if(@($Definitions|Where-Object{$_.InstanceName.Value -ceq [string]$Payload.configurationName}).Count -ne 1){throw 'The script does not define the given Configuration exactly once.'}
          $Parameters=@{}
          foreach($Property in $Payload.parameters.PSObject.Properties){$Parameters[$Property.Name]=$Property.Value}
          $Parameters['OutputPath']=[string]$Payload.work
          # User-authored SYSTEM code; admission, Management and MFA are checked
          # before this compiler is invoked. The source never becomes a PS1 file.
          . ([ScriptBlock]::Create([string]$Payload.content)) | Out-Null
          & ([string]$Payload.configurationName) @Parameters | Out-Null
          $Mofs=@(Get-ChildItem -LiteralPath ([string]$Payload.work) -Filter '*.mof' -File|Where-Object{$_.Name -notmatch '\.meta\.mof$'})
          if($Mofs.Count -ne 1 -or $Mofs[0].BaseName -notin @('localhost',$env:COMPUTERNAME)){throw 'The Configuration must create exactly one local node: localhost or the device name.'}
          if($Mofs[0].Length -gt 1048576){throw 'The compiled MOF configuration exceeds 1 MiB.'}
          [Console]::Out.WriteLine([string]$Payload.marker+[Convert]::ToBase64String([IO.File]::ReadAllBytes($Mofs[0].FullName)))
          exit 0
        } catch { [Console]::Error.WriteLine($_.Exception.Message);exit 1 }
        """;

    private static async Task<byte[]> CompileAsync(string root, string id, string content, string name, JsonObject parameters, CancellationToken token)
    {
        if (!Regex.IsMatch(name, "^[A-Za-z_][A-Za-z0-9_]{0,63}$", RegexOptions.CultureInvariant)) throw new AgentMessageException("AGENT_DSC_INVALID_CONFIGURATION_NAME");
        string work = Path.Combine(root, "v3-jobs", id + ".desired-work-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        try
        {
            string executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            if (!File.Exists(executable)) throw new AgentMessageException("AGENT_DSC_COMPILER_MISSING");
            string marker = "SERVERDESK_MOF_" + Guid.NewGuid().ToString("N") + ":";
            var payload = new JsonObject { ["content"] = content, ["configurationName"] = name, ["parameters"] = parameters.DeepClone(), ["work"] = work, ["marker"] = marker };
            token.ThrowIfCancellationRequested(); RequireManagement(root);
            var execution = await RunProcessAsync(executable, root, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Convert.ToBase64String(Encoding.Unicode.GetBytes(Compiler))], payload.ToJsonString(), 1_500_000, token);
            if (execution.ExitCode != 0) throw new AgentMessageException("AGENT_DSC_COMPILE_FAILED", ("detail", execution.Error));
            int start = execution.Output.LastIndexOf(marker, StringComparison.Ordinal);
            if (start < 0) throw new AgentMessageException("AGENT_DSC_NO_MOF");
            string encoded = execution.Output[(start + marker.Length)..].Trim();
            if (encoded.Length > (MaximumMofBytes + 2) / 3 * 4) throw new AgentMessageException("AGENT_DSC_MOF_TOO_LARGE");
            return Convert.FromBase64String(encoded);
        }
        finally { try { if (Directory.Exists(work)) Directory.Delete(work, true); } catch { } }
    }

    private static async Task<JsonObject> ExecuteDsc3Async(string root, string id, string content, JsonObject parameters, bool apply, CancellationToken token)
    {
        string executable = FindDsc3();
        var version = await RunProcessAsync(executable, root, ["--version"], null, 4096, token);
        Match matched = Regex.Match(version.Output, @"\b3\.(\d+)\.\d+", RegexOptions.CultureInvariant);
        if (version.ExitCode != 0 || !matched.Success || int.Parse(matched.Groups[1].Value, CultureInfo.InvariantCulture) < 2) throw new AgentMessageException("AGENT_DSC3_VERSION");
        string work = Path.Combine(root, "v3-jobs", id + ".dsc3-work-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
        try
        {
            string parameterPath = Path.Combine(work, "parameters.json");
            if (parameters.Count > 0) LocalStore.Json(parameterPath, new JsonObject { ["parameters"] = parameters.DeepClone() });
            async Task<JsonObject> Operation(string operation)
            {
                token.ThrowIfCancellationRequested(); RequireManagement(root);
                var arguments = new List<string> { "config" };
                if (parameters.Count > 0) arguments.AddRange(["--parameters-file", parameterPath]);
                // Withhold the configuration until the engine is attached to
                // its non-breakaway process job. No source file is needed.
                arguments.AddRange([operation, "--file", "-", "--output-format", "json"]);
                var execution = await RunProcessAsync(executable, root, arguments, content, 1_048_576, token);
                if (execution.ExitCode != 0) throw new AgentMessageException("AGENT_DSC_OPERATION_FAILED", ("detail", execution.Error));
                var parsed = JsonNode.Parse(execution.Output)?.AsObject() ?? throw new AgentMessageException("AGENT_DSC_INVALID_JSON");
                if (parsed["hadErrors"]?.GetValue<bool>() == true) throw new AgentMessageException("AGENT_DSC_RESOURCE_ERROR");
                return parsed;
            }
            if (apply) await Operation("set");
            JsonObject tested = await Operation("test"); var resources = new JsonArray();
            AddDsc3Resources(tested["results"]?.AsArray() ?? new JsonArray(), resources);
            if (resources.Count == 0) throw new AgentMessageException("AGENT_DSC_NO_RESOURCES");
            bool compliant = resources.All(resource => resource?["inDesiredState"] is JsonValue value && value.TryGetValue<bool>(out bool desired) && desired);
            return new JsonObject { ["runtime"] = version.Output.Trim(), ["compliant"] = compliant, ["resources"] = resources, ["resourceDetail"] = "resources" };
        }
        finally { try { if (Directory.Exists(work)) Directory.Delete(work, true); } catch { } }
    }

    internal static void AddDsc3Resources(JsonArray entries, JsonArray resources)
    {
        foreach (JsonNode? node in entries)
        {
            if (node is not JsonObject entry) throw new AgentMessageException("AGENT_DSC_INVALID_RESOURCE_OUTPUT");
            if (entry["result"] is JsonArray nested) { AddDsc3Resources(nested, resources); continue; }
            if (entry["result"]?["results"] is JsonArray nestedResults) { AddDsc3Resources(nestedResults, resources); continue; }
            if (resources.Count >= 200) throw new AgentMessageException("AGENT_DSC_TOO_MANY_RESOURCES");
            JsonNode? desired = entry["result"]?["inDesiredState"] ?? entry["result"]?["actualState"]?["_inDesiredState"];
            JsonArray differences = entry["result"]?["differingProperties"] is JsonArray properties ? new JsonArray(properties.Take(50).Select(property => property?.DeepClone()).ToArray()) : new JsonArray();
            resources.Add(new JsonObject { ["name"] = entry["name"]?.DeepClone(), ["type"] = entry["type"]?.DeepClone(), ["inDesiredState"] = desired is JsonValue flag && flag.TryGetValue<bool>(out bool value) ? JsonValue.Create(value) : null, ["differingProperties"] = differences });
        }
    }

    private static string FindDsc3()
    {
        string programs = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles)).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var candidates = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).Select(path => Path.Combine(path, "dsc.exe"))
            .Append(Path.Combine(programs, "DSC", "dsc.exe"));
        foreach (string candidate in candidates)
        {
            string full; try { full = Path.GetFullPath(candidate.Trim('"')); } catch { continue; }
            if (!full.StartsWith(programs, StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) continue;
            for (string? part = full; part is not null; part = Path.GetDirectoryName(part))
            {
                if ((File.GetAttributes(part) & FileAttributes.ReparsePoint) != 0) throw new AgentMessageException("AGENT_DSC_REPARSE");
                if (part.Length <= 3) break;
            }
            return full;
        }
        throw new AgentMessageException("AGENT_DSC3_MISSING", ("path", Path.Combine(programs, "DSC", "dsc.exe")));
    }

    private static async Task<(int ExitCode, string Output, string Error)> RunProcessAsync(string executable, string root, IEnumerable<string> arguments, string? input, int outputLimit, CancellationToken token)
    {
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false), WorkingDirectory = root };
        foreach (string argument in arguments) start.ArgumentList.Add(argument);
        // The embedded SDK's module path must not replace the operating system
        // DSC compiler's module discovery path.
        if (Path.GetFileName(executable).Equals("powershell.exe", StringComparison.OrdinalIgnoreCase)) start.Environment.Remove("PSModulePath");
        using var process = new Process { StartInfo = start };
        using var ioStop = CancellationTokenSource.CreateLinkedTokenSource(token);
        if (!process.Start()) throw new AgentMessageException("AGENT_DSC_PROCESS_START");
        using var containment = ProcessLifetime.Contain(process);
        Task<string> output = DrainAsync(process.StandardOutput, outputLimit, ioStop), error = DrainAsync(process.StandardError, 32768, ioStop);
        try
        {
            if (input is not null) await process.StandardInput.WriteAsync(input.AsMemory(), ioStop.Token);
            process.StandardInput.Close(); await process.WaitForExitAsync(ioStop.Token);
            return (process.ExitCode, await output, await error);
        }
        catch
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { }
            try { await process.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)); } catch { }
            // Observe drain failures even when cancellation happened first.
            try { await Task.WhenAll(output, error); } catch { }
            if (!token.IsCancellationRequested && (output.IsFaulted || error.IsFaulted))
                throw new AgentMessageException("AGENT_DSC_OUTPUT_LIMIT");
            throw;
        }
    }

    private static async Task<string> DrainAsync(StreamReader stream, int maximum, CancellationTokenSource stop)
    {
        var buffer = new char[4096]; var result = new StringBuilder(); int bytes = 0;
        while (true)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(), stop.Token); if (read == 0) return result.ToString();
            bytes += Encoding.UTF8.GetByteCount(buffer.AsSpan(0, read));
            if (bytes > maximum) { stop.Cancel(); throw new AgentMessageException("AGENT_DSC_OUTPUT_TOO_LARGE"); }
            result.Append(buffer, 0, read);
        }
    }
}
