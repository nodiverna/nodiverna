using System.Buffers.Binary;
using System.Text;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// --autostart-self-test: Run and RunOnce (both views and a user hive), a Startup
// shortcut, Winlogon, services (svchost with ServiceDll, Microsoft and third
// party), scheduled tasks (\Microsoft\ and others, a non-exec action), the
// signature and "Microsoft" decision with a fake verifier, the user path decided
// before scrubbing, the masking cases, the drift category, the limits and the
// entry ID and checksum shared with tests/support/autostart-checksum-fixture.mjs.
internal static class NativeAutostartTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException("Autostart regression: " + message); }
    internal static int RunSelfTest() { try { Run(); Console.WriteLine("Autostart self-test passed."); return 0; } catch (Exception error) { Console.Error.WriteLine(error); return 1; } }

    private const string Sid = "S-1-5-21-1111111111-2222222222-3333333333-1001", Token = "agent-token-7f3a9c";
    private sealed class FakeSource : IAutostartSource
    {
        internal List<RunValue> Runs = [];
        internal List<StartupFile> Files = [];
        internal List<(string, string)> Logon = [];
        internal List<AutoService> Services = [];
        internal List<ScheduledTaskEntry> Tasks = [];
        public IEnumerable<RunValue> RunValues() => Runs;
        public IEnumerable<StartupFile> StartupFiles() => Files;
        public IEnumerable<(string Name, string Value)> Winlogon() => Logon;
        public IEnumerable<AutoService> AutoServices() => Services;
        public IEnumerable<ScheduledTaskEntry> EnabledTasks() => Tasks;
    }
    private sealed class FakeInspector : IFileInspector
    {
        internal readonly Dictionary<string, (string, string?)> Signatures = new(StringComparer.OrdinalIgnoreCase);
        internal readonly Dictionary<string, string> Publishers = new(StringComparer.OrdinalIgnoreCase);
        public string Expand(string text) => text.Replace("%SystemRoot%", @"C:\Windows", StringComparison.OrdinalIgnoreCase).Replace("%windir%", @"C:\Windows", StringComparison.OrdinalIgnoreCase).Replace("%ProgramFiles%", @"C:\Program Files", StringComparison.OrdinalIgnoreCase);
        public bool Exists(string path) => Signatures.ContainsKey(path);
        public (string Signature, string? Signer) Signature(string path) => Signatures.TryGetValue(path, out var value) ? value : ("unknown", null);
        public string? Publisher(string path) => Publishers.GetValueOrDefault(path);
    }

    /// <summary>A minimal Unicode shortcut with a LinkInfo local base path and arguments.</summary>
    internal static byte[] Shortcut(string target, string arguments)
    {
        var data = new List<byte>();
        var header = new byte[76];
        BinaryPrimitives.WriteUInt32LittleEndian(header, 0x4C);
        Guid.Parse("00021401-0000-0000-C000-000000000046").ToByteArray().CopyTo(header, 4);
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(20), 0x2 | 0x20 | 0x80);
        data.AddRange(header);
        byte[] volume = [17, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0];
        byte[] path = Encoding.Latin1.GetBytes(target + "\0"), suffix = [0];
        int headerSize = 28, size = headerSize + volume.Length + path.Length + suffix.Length;
        var info = new byte[size];
        BinaryPrimitives.WriteUInt32LittleEndian(info, (uint)size);
        BinaryPrimitives.WriteUInt32LittleEndian(info.AsSpan(4), (uint)headerSize);
        BinaryPrimitives.WriteUInt32LittleEndian(info.AsSpan(8), 1);
        BinaryPrimitives.WriteUInt32LittleEndian(info.AsSpan(12), (uint)headerSize);
        BinaryPrimitives.WriteUInt32LittleEndian(info.AsSpan(16), (uint)(headerSize + volume.Length));
        BinaryPrimitives.WriteUInt32LittleEndian(info.AsSpan(24), (uint)(headerSize + volume.Length + path.Length));
        volume.CopyTo(info, headerSize); path.CopyTo(info, headerSize + volume.Length);
        data.AddRange(info);
        var count = new byte[2]; BinaryPrimitives.WriteUInt16LittleEndian(count, (ushort)arguments.Length);
        data.AddRange(count); data.AddRange(Encoding.Unicode.GetBytes(arguments));
        return data.ToArray();
    }

    private static void Run()
    {
        // ---- Masking ----
        string Mask(string text) => SecretMask.CommandLine(text, [Token]);
        Check(Mask("tool.exe -Password hunter2 -v") == "tool.exe -Password [redacted] -v", "-Password value.");
        Check(Mask("tool.exe --token=abc123") == "tool.exe --token=[redacted]", "--token=value.");
        Check(Mask("tool.exe /apikey:XYZ /secret \"two words\" -credential 'c d'") == "tool.exe /apikey:[redacted] /secret [redacted] -credential [redacted]", "/apikey:, quoted values.");
        Check(Mask("msiexec /p:patch.msp -passthru x") == "msiexec /p:patch.msp -passthru x", "/p: and -passthru are no credential arguments.");
        Check(Mask("sync.exe \"Server=db;User Id=sa;pwd=x;Database=main\"") == "sync.exe \"Server=db;User Id=sa;pwd=[redacted];Database=main\"", "pwd= in a connection string.");
        Check(Mask("agent.exe Password=abc") == "agent.exe Password=[redacted]", "password= in a connection string.");
        Check(Mask("curl -H \"Authorization: Bearer eyJhbGciOi.x\" https://api") == "curl -H \"Authorization: Bearer [redacted]\" https://api", "Bearer value.");
        Check(Mask("fetch.exe https://u:p4ss@host/path") == "fetch.exe https://u:[redacted]@host/path", "URL user info.");
        Check(Mask("report.exe --key " + Token) == "report.exe --key [redacted]", "the agent's own token.");
        Check(Mask("sync.exe \"Server=db;User Id=sa;Password='S3cret';\"") == "sync.exe \"Server=db;User Id=sa;Password=[redacted];\"", "single-quoted Password= value: " + Mask("sync.exe \"Server=db;User Id=sa;Password='S3cret';\""));
        Check(Mask("sync.exe Server=db;Pwd=\"x;y\";Database=main") == "sync.exe Server=db;Pwd=[redacted];Database=main", "double-quoted Pwd= value with a semicolon: " + Mask("sync.exe Server=db;Pwd=\"x;y\";Database=main"));
        Check(Mask("sync.exe \"Password=a b;\"") == "sync.exe \"Password=[redacted];\"", "unquoted Password= value with a space: " + Mask("sync.exe \"Password=a b;\""));
        Check(Mask("sync.exe \"Server=db;Password=a b\" -v") == "sync.exe \"Server=db;Password=[redacted]\" -v", "unquoted value ends at the closing quote.");
        Check(Mask("sync.exe Pwd=\"a\"\"b\";x=1") == "sync.exe Pwd=[redacted];x=1", "doubled quote inside a quoted value.");
        Check(Mask("tool.exe --api-key K1 --client-secret K2 -ClientSecret K3 --access-token K4 --passphrase K5") == "tool.exe --api-key [redacted] --client-secret [redacted] -ClientSecret [redacted] --access-token [redacted] --passphrase [redacted]", "hyphenated credential argument names: " + Mask("tool.exe --api-key K1 --client-secret K2 -ClientSecret K3 --access-token K4 --passphrase K5"));
        Check(Mask("powershell -Command \"$p = ConvertTo-SecureString 'S3cret' -AsPlainText -Force\"") == "powershell -Command \"$p = ConvertTo-SecureString [redacted] -AsPlainText -Force\"", "ConvertTo-SecureString plain text.");
        Check(Mask("fetch.exe https://:p4ss@host/path") == "fetch.exe https://:[redacted]@host/path", "URL user info with an empty user name.");
        Check(Mask("open.exe http://host:8080/a@b") == "open.exe http://host:8080/a@b", "a port is no user info.");
        Check(Mask("powershell -Command \"& x.ps1 -Password \\\"S3cret\\\"\"") == "powershell -Command \"& x.ps1 -Password [redacted]\"", "backslash-escaped quotes around a -Password value: " + Mask("powershell -Command \"& x.ps1 -Password \\\"S3cret\\\"\""));
        Check(Mask("sync.exe \"Server=db;Password=\\\"S3cret\\\";\"") == "sync.exe \"Server=db;Password=[redacted];\"", "backslash-escaped quotes around a Password= value: " + Mask("sync.exe \"Server=db;Password=\\\"S3cret\\\";\""));
        Check(Mask("sync.exe \"Server=db;Password=O'Brien1;\"") == "sync.exe \"Server=db;Password=[redacted];\"", "a quote inside an unquoted Password= value: " + Mask("sync.exe \"Server=db;Password=O'Brien1;\""));
        Check(Mask("tool.exe -Password S3c'ret -v") == "tool.exe -Password [redacted] -v", "a quote inside an unquoted -Password value: " + Mask("tool.exe -Password S3c'ret -v"));
        Check(Mask("tool.exe \"-Password abc\" -v") == "tool.exe \"-Password [redacted]\" -v", "an unquoted value ends at a closing quote: " + Mask("tool.exe \"-Password abc\" -v"));
        Check(NativeAutostartInventory.Scrub("C:\\Users/alice\\x.exe") == "C:\\Users/…\\x.exe", "mixed separators are scrubbed: " + NativeAutostartInventory.Scrub("C:\\Users/alice\\x.exe"));
        Check(NativeAutostartInventory.IsUserPath("C:\\Users/alice\\x.exe"), "mixed separators are a user path.");
        Check(NativeAutostartInventory.IsUserPath("C:/Users/alice/AppData/x.exe") && NativeAutostartInventory.IsUserPath(@"C:\Documents and Settings\bob\x.exe") && !NativeAutostartInventory.IsUserPath(@"C:\Program Files\x.exe"), "forward-slash and Documents and Settings profiles are user paths.");
        Check(NativeAutostartInventory.Scrub("C:/Users/alice/x.exe and D:\\Documents and Settings\\bob\\y.exe") == "C:/Users/…/x.exe and D:\\Documents and Settings\\…\\y.exe", "forward-slash and Documents and Settings profiles are scrubbed: " + NativeAutostartInventory.Scrub("C:/Users/alice/x.exe and D:\\Documents and Settings\\bob\\y.exe"));

        // ---- Collection ----
        var files = new FakeInspector();
        files.Signatures[@"C:\Windows\system32\SecurityHealthSystray.exe"] = ("valid", "Microsoft Windows");
        files.Signatures[@"C:\Program Files (x86)\Contoso\tray.exe"] = ("valid", "Contoso Ltd");
        files.Signatures[@"C:\Users\alice\AppData\Local\Temp\upd.exe"] = ("unsigned", null);
        files.Signatures[@"C:\Windows\explorer.exe"] = ("valid", "Microsoft Windows");
        files.Signatures[@"C:\Windows\system32\userinit.exe"] = ("valid", "Microsoft Windows");
        files.Signatures[@"C:\Windows\System32\svchost.exe"] = ("valid", "Microsoft Windows Publisher");
        files.Signatures[@"C:\Windows\System32\wuaueng.dll"] = ("valid", "Microsoft Windows");
        files.Signatures[@"C:\Program Files\Fabrikam\fabsvc.dll"] = ("invalid", "Fabrikam");
        files.Signatures[@"C:\Program Files\Contoso\agent.exe"] = ("valid", "Contoso Ltd");
        files.Signatures[@"C:\Windows\System32\spoolsv.exe"] = ("valid", "Microsoft Windows");
        files.Signatures[@"C:\Windows\System32\compattelrunner.exe"] = ("valid", "Microsoft Windows");
        files.Signatures[@"C:\Program Files\Microsoft Office\root\Office16\sdxhelper.exe"] = ("valid", "Microsoft Corporation");
        files.Signatures[@"C:\Program Files\Vendor\update.exe"] = ("valid", "Vendor Inc");
        files.Signatures[@"C:\Users\alice\AppData\Local\Microsoft\OneDrive\OneDriveStandaloneUpdater.exe"] = ("valid", "Microsoft Corporation");
        files.Publishers[@"C:\Program Files (x86)\Contoso\tray.exe"] = "Contoso";
        files.Publishers[@"C:\Users\alice\AppData\Local\Temp\upd.exe"] = @"C:\Users\alice builds";
        var source = new FakeSource();
        source.Runs.AddRange([
            new("run", "machine", @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "SecurityHealth", @"%windir%\system32\SecurityHealthSystray.exe"),
            new("run", "machine", @"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run", "ContosoTray", @"""C:\Program Files (x86)\Contoso\tray.exe"" /background"),
            new("run-once", "machine", @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce", "Cleanup", @"C:\Missing\cleanup.exe -pwd s3cret"),
            new("run", "user", @"HKU\" + Sid + @"\SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "Updater", @"C:\Users\alice\AppData\Local\Temp\upd.exe --token=abc " + Token),
            new("run", "user", @"HKU\S-1-5-21-1-2-3-1002\SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "Updater", @"C:\Users\alice\AppData\Local\Temp\upd.exe --token=abc " + Token),
        ]);
        byte[] link = Shortcut(@"C:\Users\alice\AppData\Local\Temp\upd.exe", "--silent --password hunter2");
        source.Files.AddRange([
            new("user", @"C:\Users\alice\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup", "Updater.lnk", () => link),
            new("machine", @"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp", "mount.bat", () => null),
        ]);
        source.Logon.AddRange([("Shell", "explorer.exe"), ("Userinit", @"C:\Windows\system32\userinit.exe,")]);
        source.Services.AddRange([
            new("wuauserv", @"C:\Windows\System32\svchost.exe -k netsvcs -p", @"%SystemRoot%\System32\wuaueng.dll"),
            new("FabSvc", @"C:\Windows\System32\svchost.exe -k fabrikam", @"C:\Program Files\Fabrikam\fabsvc.dll"),
            new("ContosoAgent", @"""C:\Program Files\Contoso\agent.exe"" --apikey=K-123", null),
            new("Spooler", @"C:\Windows\System32\spoolsv.exe", null),
        ]);
        source.Tasks.AddRange([
            new(@"\Microsoft\Windows\Application Experience\", "Microsoft Compatibility Appraiser", [(@"%windir%\System32\compattelrunner.exe", null)]),
            new(@"\Microsoft\Windows\Shell\", "CreateObjectTask", [(null, null)]),
            new(@"\Microsoft\Office\", "Office Feature Updates", [(@"C:\Program Files\Microsoft Office\root\Office16\sdxhelper.exe", null), (@"C:\Program Files\Vendor\update.exe", "/q")]),
            new(@"\Vendor\", "Vendor Update", [(@"C:\Program Files\Vendor\update.exe", "/silent /secret topsecret")]),
            new(@"\", "OneDrive Standalone Update Task-" + Sid, [(@"C:\Users\alice\AppData\Local\Microsoft\OneDrive\OneDriveStandaloneUpdater.exe", "/reporting")]),
        ]);
        var inventory = new NativeAutostartInventory(source, files, () => [Token]);
        var collected = inventory.Collect();
        var list = collected[NativeAutostartInventory.InventoryKey]!.AsObject();
        var items = list["items"]!.AsArray().Select(item => item!.AsObject()).ToList();
        JsonObject Find(string name) => items.Single(item => item["name"]!.GetValue<string>() == name);
        string Text(JsonObject item, string field) => item[field]?.GetValue<string>() ?? "";
        bool Flag(JsonObject item, string field) => item[field]!.GetValue<bool>();

        var health = Find("SecurityHealth");
        Check(Text(health, "category") == "run" && Text(health, "target") == @"C:\Windows\system32\SecurityHealthSystray.exe" && Text(health, "signature") == "valid" && Flag(health, "microsoft") && !Flag(health, "userPath"), "a Microsoft Run entry, target expanded.");
        var tray = Find("ContosoTray");
        Check(Text(tray, "location").Contains("WOW6432Node") && Text(tray, "signer") == "Contoso Ltd" && Text(tray, "publisher") == "Contoso" && !Flag(tray, "microsoft"), "the 32-bit view and a third-party signer.");
        var cleanup = Find("Cleanup");
        Check(Text(cleanup, "category") == "run-once" && Text(cleanup, "signature") == "unknown" && Text(cleanup, "command") == @"C:\Missing\cleanup.exe -pwd [redacted]" && cleanup["publisher"] is null, "RunOnce; an unreadable target is unknown; the command is masked.");
        var updaters = items.Where(item => Text(item, "name") == "Updater").ToList();
        Check(updaters.Count == 1, "the same user entry of two users is one entry.");
        var updater = updaters[0];
        Check(Text(updater, "scope") == "user" && Text(updater, "location") == @"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "a user hive becomes HKCU; no SID.");
        Check(Flag(updater, "userPath") && Text(updater, "target") == @"C:\Users\…\AppData\Local\Temp\upd.exe" && Text(updater, "signature") == "unsigned", "the user path is decided before scrubbing; the target is scrubbed.");
        Check(Text(updater, "command") == @"C:\Users\…\AppData\Local\Temp\upd.exe --token=[redacted] [redacted]", "token argument and the agent token masked: " + Text(updater, "command"));
        Check(Text(updater, "id") == NativeAutostartInventory.Id("run", "user", @"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "Updater", Text(updater, "command")), "the ID covers the masked command.");
        var lnk = Find("Updater.lnk");
        Check(Text(lnk, "category") == "startup-folder" && Text(lnk, "location") == @"C:\Users\…\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup" && Text(lnk, "target") == @"C:\Users\…\AppData\Local\Temp\upd.exe" && Text(lnk, "command") == @"C:\Users\…\AppData\Local\Temp\upd.exe --silent --password [redacted]" && Flag(lnk, "userPath"), "a Startup shortcut resolved to target and arguments.");
        var bat = Find("mount.bat");
        Check(Text(bat, "target") == @"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp\mount.bat" && Text(bat, "scope") == "machine", "another file in the Startup folder as it is.");
        var shell = Find("Shell"); var userinit = Find("Userinit");
        Check(Text(shell, "category") == "winlogon" && Text(shell, "target") == @"C:\Windows\explorer.exe" && Flag(shell, "microsoft") && Text(userinit, "target") == @"C:\Windows\system32\userinit.exe" && Flag(userinit, "microsoft"), "Winlogon Shell (relative) and Userinit (trailing comma).");
        Check(!items.Any(item => Text(item, "name") is "wuauserv" or "Spooler"), "Microsoft services are not listed (svchost judged by its ServiceDll).");
        var fab = Find("FabSvc"); var agent = Find("ContosoAgent");
        Check(Text(fab, "category") == "service" && Text(fab, "target") == @"C:\Program Files\Fabrikam\fabsvc.dll" && Text(fab, "signature") == "invalid" && !Flag(fab, "microsoft"), "a third-party svchost service is judged by its ServiceDll.");
        Check(Text(agent, "command") == @"""C:\Program Files\Contoso\agent.exe"" --apikey=[redacted]" && Text(agent, "location") == @"HKLM\SYSTEM\CurrentControlSet\Services\ContosoAgent", "a third-party service with a masked command.");
        Check(!items.Any(item => Text(item, "name") is "Microsoft Compatibility Appraiser" or "CreateObjectTask"), "Microsoft tasks (Microsoft executable or non-exec action below \\Microsoft\\) are not listed.");
        var office = Find("Office Feature Updates"); var vendor = Find("Vendor Update");
        Check(Text(office, "category") == "task" && !Flag(office, "microsoft") && Text(office, "location") == @"\Microsoft\Office\", "a task below \\Microsoft\\ with a third-party executable is listed.");
        Check(Text(vendor, "command") == @"""C:\Program Files\Vendor\update.exe"" /silent /secret [redacted]" && Text(vendor, "signer") == "Vendor Inc", "a third-party task with a masked command.");
        var onedrive = items.Single(item => Text(item, "name").StartsWith("OneDrive Standalone Update Task-", StringComparison.Ordinal));
        Check(Text(onedrive, "name") == "OneDrive Standalone Update Task-S-1-5-21-…" && Flag(onedrive, "userPath") && !Flag(onedrive, "microsoft"), "a task outside \\Microsoft\\ is listed; its SID is scrubbed.");
        string json = collected.ToJsonString();
        foreach (string forbidden in new[] { "alice", Sid, "S-1-5-21-1-2-3", "hunter2", "abc", "s3cret", "K-123", "topsecret", Token, "HKU" })
            Check(!json.Contains(forbidden, StringComparison.Ordinal), "no user name, SID or secret leaves the device: " + forbidden);
        Check(collected["autostartChecksum"]!.GetValue<string>() == list["checksum"]!.GetValue<string>() && list["count"]!.GetValue<int>() == items.Count && !list["truncated"]!.GetValue<bool>(), "checksum and count.");
        Check(items.Select(item => Text(item, "id")).SequenceEqual(items.Select(item => Text(item, "id")).Order(StringComparer.Ordinal)), "sorted by ID.");

        // ---- Drift category ----
        var drift = inventory.Drift().Select(item => item!.AsObject()).ToList();
        Check(drift.Select(item => Text(item, "id")).Order(StringComparer.Ordinal).SequenceEqual(items.Where(item => Text(item, "category") is "run" or "run-once" or "startup-folder" or "winlogon").Select(item => Text(item, "id")).Order(StringComparer.Ordinal)), "the drift category returns the same Run, Startup and Winlogon entries.");
        Check(DriftMonitor.AutostartIdentifier(Find("ContosoTray")) == @"run\HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run\ContosoTray", "the drift identifier.");

        // ---- Shortcut parser ----
        Check(ShellLink.Parse(null) is null && ShellLink.Parse(new byte[10]) is null && ShellLink.Parse(new byte[ShellLink.MaximumBytes + 1]) is null, "invalid or oversized shortcuts give null.");
        var random = new Random(7);
        for (int i = 0; i < 40; i++) { var buffer = link.ToArray(); buffer[random.Next(20, buffer.Length)] = (byte)random.Next(256); ShellLink.Parse(buffer); ShellLink.Parse(buffer[..random.Next(buffer.Length)]); }

        // ---- Limits and checksum ----
        var flood = new FakeSource();
        flood.Runs.AddRange(Enumerable.Range(0, 2500).Select(i => new RunValue("run", "machine", @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "Entry" + i, @"C:\Tools\app" + i + ".exe")));
        var floodList = new NativeAutostartInventory(flood, files, () => [])
            .Collect()[NativeAutostartInventory.InventoryKey]!;
        Check(floodList["items"]!.AsArray().Count == 2000 && floodList["count"]!.GetValue<int>() == 2500 && floodList["truncated"]!.GetValue<bool>(), "2500 entries: 2000 items, count 2500, truncated.");
        // Same entries and values as tests/support/autostart-checksum-fixture.mjs (lib/autostart-inventory.ts).
        string[] ids = ["850fdeb4603732974ff7c9aa55cac851e072604e9d6953d0543382e3854027e2", "186c655beb8273d6c19d6af367de70457303782798e40f05963c215a60f7a360", "1c44a9072bb236000177aa66e62a0dbbc541ef8795e5cc190d2660ffe56f937c"];
        var fixture = new List<AutostartEntry>
        {
            new(ids[0], "run", "machine", @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "SecurityHealth", @"%windir%\system32\SecurityHealthSystray.exe", @"C:\Windows\system32\SecurityHealthSystray.exe", "valid", "Microsoft Windows", "Microsoft Corporation", true, false),
            new(ids[1], "startup-folder", "user", @"C:\Users\…\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup", "Updater \"Tool\".lnk", @"""C:\Users\…\AppData\Local\Temp\upd.exe"" --token=[redacted]", @"C:\Users\…\AppData\Local\Temp\upd.exe", "unsigned", null, null, false, true),
            new(ids[2], "service", "machine", @"HKLM\SYSTEM\CurrentControlSet\Services\Müller ✓", "Müller ✓", "", null, "unknown", null, null, false, false),
        };
        foreach (var entry in fixture) Check(NativeAutostartInventory.Id(entry.Category, entry.Scope, entry.Location, entry.Name, entry.Command) == entry.Id, "the entry ID equals the portal's value: " + entry.Name);
        const string expected = "af20011a547e9f4710da095c578b3cb52a3f16b2607f32f46c89b9c164aecfe5";
        Check(NativeAutostartInventory.Checksum(fixture) == expected && NativeAutostartInventory.Checksum(Enumerable.Reverse(fixture)) == expected, "the checksum equals the portal's value and ignores the order: " + NativeAutostartInventory.Checksum(fixture));
    }
}
