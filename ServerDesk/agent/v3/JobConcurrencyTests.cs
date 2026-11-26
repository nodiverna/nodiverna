using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

/// <summary>
/// Parallel jobs (4.21.0): the class of every row of the concurrency table, and the JobRunner admission with jobs held
/// running: two parallel jobs run, a sole job next to them, a second exclusive job, a second job of one group and a
/// fifth job get AGENT_BUSY. Runs in --self-test and alone with --jobs-self-test.
/// </summary>
internal static class JobConcurrencyTests
{
    private static void Assert(bool condition, string label)
    {
        if (!condition) throw new InvalidOperationException("Job concurrency regression: " + label);
    }

    internal static void Run()
    {
        ClassTable();
        Admission();
    }

    private static void ClassTable()
    {
        static JobClass P(string? group = null) => new(JobMode.Parallel, group);
        static JobClass E(string? group = null) => new(JobMode.Exclusive, group);
        var sole = new JobClass(JobMode.Sole, null);
        var rows = new (string[] Kinds, JobClass Class)[]
        {
            (["refresh"], P("inventory")),
            (["scan-updates"], P("windows-update")),
            (["test-connection"], P()),
            (["start-service", "stop-service", "restart-service", "set-service-startup"], E()),
            (["install-feature", "remove-feature"], E()),
            (["set-network", "set-dns", "set-rdp", "set-pagefile", "set-task"], E()),
            (["join-domain", "leave-domain", "rename-computer"], E()),
            (["create-local-user", "set-local-user", "reset-local-password", "delete-local-user", "local-group-add", "local-group-remove"], E()),
            (["set-firewall-rule", "add-firewall-rule"], E()),
            (["schedule-power", "cancel-power-schedule"], E()),
            (["restart-computer", "shutdown-computer"], sole),
            (["install-updates"], E("windows-update")),
            (["install-gpu-driver"], E()),
            (["defender-quick-scan", "defender-full-scan"], P("defender")),
            (["defender-update-signatures", "defender-clean-detections"], E("defender")),
            (["list-files"], P()),
            (["create-directory", "rename-file", "delete-file"], E()),
            (["storage-inspect"], P("storage")),
            (["storage-initialize", "storage-set-disk", "storage-new-volume", "storage-resize", "storage-drive-letter", "storage-format", "storage-delete-partition"], E("storage")),
            (["desired-state-test", "desired-state-apply"], E()),
            (["list-processes", "list-sessions", "list-connections", "network-diagnostics", "query-events", "export-events", "support-bundle"], P()),
            (["kill-process", "message-session", "disconnect-session", "logoff-session"], E()),
            (["assistant-powershell"], E()),
            (["ad-sign-in"], P()),
            (["plugin-install", "plugin-remove", "agent-update", "agent-uninstall"], sole),
        };
        foreach (var (kinds, expected) in rows) foreach (string kind in kinds) Assert(JobConcurrency.Classify(kind, new JsonObject()) == expected, kind);
        Assert(rows.Sum(row => row.Kinds.Length) == JobConcurrency.Kinds.Count, "the table has exactly the rows of the spec");
        // Every kind the agent runs has an entry; nothing it runs reaches the fail-safe by accident.
        foreach (string kind in JobRunner.ManagementActions.Concat(JobRunner.DiagnosticActions).Concat(JobRunner.FileActions).Concat(JobRunner.StorageActions).Concat(JobRunner.DesiredStateActions).Concat(JobRunner.DefenderActions).Concat(JobRunner.AssistantActions))
            Assert(JobConcurrency.Kinds.ContainsKey(kind), kind + " has an entry");
        JsonObject Parameters(string json) => JsonNode.Parse(json)!.AsObject();
        void RunbookCase(string json, JobClass expected, string label) => Assert(JobConcurrency.Classify("runbook-step", Parameters(json)) == expected, "runbook step: " + label);
        // Runbook steps, one case per line in the form RunbookCase("""<parameters JSON>""", <class>, "<label>");
        // tests/agent/agent-parallel-jobs-source.mjs parses these lines and checks that the portal gives the same class.
        RunbookCase("""{"kind":"diagnosis","operation":"refresh"}""", P("inventory"), "refresh without parameters");
        RunbookCase("""{"kind":"diagnosis","operation":"refresh","operationParameters":{}}""", P("inventory"), "refresh with {}");
        RunbookCase("""{"kind":"diagnosis","operation":"refresh","operationParameters":null}""", P("inventory"), "refresh with null");
        RunbookCase("""{"kind":"diagnosis","operation":"refresh","operationParameters":{"x":1}}""", E(), "refresh with a property");
        RunbookCase("""{"kind":"diagnosis","operation":"scan-updates","operationParameters":{},"script":""}""", P("windows-update"), "scan-updates with an empty script");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection","operationParameters":{"host":"srv01.example.com","port":443}}""", P(), "test-connection with valid parameters");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection"}""", E(), "test-connection without parameters");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection","operationParameters":{"host":"srv01.example.com","port":"443"}}""", E(), "test-connection with a string port");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection","operationParameters":{"host":"srv01.example.com","port":0}}""", E(), "test-connection with port 0");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection","operationParameters":{"host":"srv01.example.com","port":65536}}""", E(), "test-connection with port 65536");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection","operationParameters":{"host":"srv01.example.com","port":1.5}}""", E(), "test-connection with port 1.5");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection","operationParameters":{"host":"-bad","port":443}}""", E(), "test-connection with host -bad");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection","operationParameters":{"host":"","port":443}}""", E(), "test-connection with an empty host");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection","operationParameters":{"host":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","port":443}}""", E(), "test-connection with a 254-character host");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection","operationParameters":{"host":"srv01.example.com","port":443,"extra":true}}""", E(), "test-connection with an extra key");
        RunbookCase("""{"kind":"diagnosis","operation":"refresh","operationParameters":[]}""", E(), "operationParameters is an array");
        RunbookCase("""{"kind":"diagnosis","operation":"refresh","operationParameters":"text"}""", E(), "operationParameters is a string");
        RunbookCase("""{"kind":"diagnosis","operation":"refresh","script":"Get-Date"}""", E(), "a diagnosis with a script");
        RunbookCase("""{"kind":"powershell","script":"Get-Date"}""", E(), "a powershell step");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection","operationParameters":{"host":"srv01.example.com","port":443.0}}""", P(), "test-connection with port 443.0");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection","operationParameters":{"host":"srv01.example.com","port":65535}}""", P(), "test-connection with port 65535");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection","operationParameters":{"host":"srv01.example.com","port":true}}""", E(), "test-connection with a boolean port");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection","operationParameters":{"host":"srv01.example.com\n","port":443}}""", E(), "test-connection with a final newline in the host");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection","operationParameters":{"host":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","port":443}}""", P(), "test-connection with a 253-character host");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection","operationParameters":{"host":443,"port":443}}""", E(), "test-connection with a numeric host");
        RunbookCase("""{"kind":"diagnosis","operation":"test-connection","operationParameters":{"port":443}}""", E(), "test-connection without host");
        RunbookCase("""{"kind":"diagnosis","operation":"install-updates"}""", E(), "a diagnosis outside the fixed list");
        RunbookCase("""{}""", E(), "a runbook step without parameters");
        Assert(JobConcurrency.Classify("plugin-job", Parameters("{\"plugin\":\"dhcp\",\"operation\":\"dhcp-read\"}")) == P("plugin:dhcp"), "dhcp-read");
        Assert(JobConcurrency.Classify("plugin-job", Parameters("{\"plugin\":\"dns\",\"operation\":\"dns-zone-read\"}")) == P("plugin:dns"), "dns-zone-read");
        Assert(JobConcurrency.Classify("plugin-job", Parameters("{\"plugin\":\"dhcp\",\"operation\":\"dhcp-scope-create\"}")) == E("plugin:dhcp"), "a DHCP change");
        Assert(JobConcurrency.Classify("plugin-job", Parameters("{\"plugin\":\"dns\",\"operation\":\"dns-record-add\"}")) == E("plugin:dns"), "a DNS change");
        Assert(JobConcurrency.Classify("plugin-job", Parameters("{\"plugin\":\"dns\",\"operation\":\"dhcp-read\"}")) == sole, "a plugin mismatch");
        Assert(JobConcurrency.Classify("plugin-job", Parameters("{\"plugin\":\"dhcp\",\"operation\":\"dhcp-format\"}")) == sole, "an unknown plugin operation");
        Assert(JobConcurrency.Classify("plugin-job", Parameters("{\"plugin\":{},\"operation\":[]}")) == sole, "malformed plugin parameters");
        Assert(JobConcurrency.Classify("format-c", null) == sole && JobConcurrency.Classify(null, null) == sole, "an unknown kind");
        Assert(JobConcurrency.MaxRunning == 4, "the cap");
    }

    private static void Admission()
    {
        string temporary = Path.Combine(Path.GetTempPath(), "ServerDesk-JobConcurrency-" + Guid.NewGuid().ToString("N"));
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            var runner = new JobRunner(temporary, temporary, new JsonObject()) { HoldForTest = _ => release.Task };
            string Start(string action, JsonObject? parameters = null)
            {
                string id = Guid.NewGuid().ToString();
                runner.Start(new JsonObject { ["id"] = id, ["action"] = action, ["parameters"] = parameters ?? new JsonObject() }, false, CancellationToken.None);
                return id;
            }
            string? Code(string id)
            {
                string path = Path.Combine(temporary, "v3-jobs", id + ".result.json");
                return File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path))?["code"]?.GetValue<string>() : null;
            }
            bool Runs(string id) => runner.Running.Any(node => node?.GetValue<string>() == id) && Code(id) is null;

            string refresh = Start("refresh"), files = Start("list-files");
            Assert(Runs(refresh) && Runs(files) && runner.Busy, "two parallel starts both run");
            string restart = Start("restart-computer");
            Assert(Code(restart) == "AGENT_BUSY" && !Runs(restart), "a sole start while parallel jobs run gives AGENT_BUSY");
            string update = Start("agent-update");
            Assert(Code(update) == "AGENT_UPDATE_BUSY" && !runner.Updating, "an agent update next to running jobs gives its busy code");
            string service = Start("start-service");
            Assert(Runs(service), "one exclusive job runs next to parallel jobs");
            string second = Start("stop-service");
            Assert(Code(second) == "AGENT_BUSY", "a second exclusive gives AGENT_BUSY");
            string inventory = Start("refresh");
            Assert(Code(inventory) == "AGENT_BUSY", "a same-group parallel start gives AGENT_BUSY");
            string connection = Start("test-connection");
            Assert(Runs(connection) && runner.Running.Count == 4, "the fourth job runs");
            string fifth = Start("list-processes");
            Assert(Code(fifth) == "AGENT_BUSY", "a fifth start gives AGENT_BUSY");
            release.SetResult();
            runner.StopAsync().GetAwaiter().GetResult();
            Assert(!runner.Busy && runner.Running.Count == 0, "StopAsync awaits every running job");
            foreach (string id in new[] { refresh, files, service, connection }) Assert(File.Exists(Path.Combine(temporary, "v3-jobs", id + ".result.json")) && Code(id) != "AGENT_BUSY", "every started job wrote its own result");

            // With nothing running, a sole job starts and holds the device alone.
            var hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var alone = new JobRunner(temporary, temporary, new JsonObject()) { HoldForTest = _ => hold.Task };
            string reboot = Guid.NewGuid().ToString(), read = Guid.NewGuid().ToString();
            alone.Start(new JsonObject { ["id"] = reboot, ["action"] = "restart-computer", ["parameters"] = new JsonObject() }, false, CancellationToken.None);
            alone.Start(new JsonObject { ["id"] = read, ["action"] = "list-files", ["parameters"] = new JsonObject() }, false, CancellationToken.None);
            Assert(Code(read) == "AGENT_BUSY" && alone.Running.Count == 1, "no job starts next to a sole job");
            hold.SetResult();
            alone.StopAsync().GetAwaiter().GetResult();
        }
        finally { release.TrySetResult(); if (Directory.Exists(temporary)) Directory.Delete(temporary, true); }
    }

    internal static int RunSelfTest()
    {
        try
        {
            Run();
            Console.WriteLine("Job concurrency self-tests passed: the class of every job kind, two parallel jobs, one exclusive job, sole alone, one job per group and the cap of 4.");
            return 0;
        }
        catch (Exception e) { Console.Error.WriteLine(e); return 1; }
    }
}
