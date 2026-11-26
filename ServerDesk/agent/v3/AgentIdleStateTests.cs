using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal static class AgentIdleStateTests
{
    internal static void Run()
    {
        var stamp = new AgentConfigStamp(500, 1, 1); TimeSpan now = TimeSpan.Zero;
        string source = "Management"; int reads = 0; bool missing = false, unstable = false;
        var mode = new AgentLocalMode(() => missing ? throw new IOException("missing") : stamp,
            () => { reads++; if (unstable) stamp = stamp with { WrittenTicks = stamp.WrittenTicks + 1 }; return source; }, () => now);
        for (int i = 0; i < 200; i++) if (!mode.ManagementAllowed) throw new Exception("Valid local Management was unavailable.");
        if (reads != 1) throw new Exception("Idle mode checks repeatedly decrypted unchanged credentials.");
        source = "ReadOnly"; stamp = stamp with { WrittenTicks = 2 };
        if (mode.ManagementAllowed || reads != 2) throw new Exception("Atomic local mode change did not revoke cached Management immediately.");
        source = "Management"; now = AgentLocalMode.MaximumCacheAge;
        if (!mode.ManagementAllowed || reads != 3) throw new Exception("Periodic mode fallback failed to revalidate identical file metadata.");
        if (mode.Read(force: true) != "Management" || reads != 4) throw new Exception("Explicit admission check reused cached Management.");
        missing = true; if (mode.ManagementAllowed) throw new Exception("Missing configuration retained privileged local authority.");
        missing = false; source = "ReadOnly";
        if (mode.ManagementAllowed || reads != 5) throw new Exception("Recovery from missing configuration reused old privileged authority.");
        source = "unknown"; stamp = stamp with { WrittenTicks = 3 };
        if (mode.ManagementAllowed) throw new Exception("Invalid local mode enabled Management.");
        source = "Management"; unstable = true;
        if (mode.ManagementAllowed) throw new Exception("Configuration replaced during read enabled Management.");
        unstable = false;
        if (!mode.ManagementAllowed) throw new Exception("A later stable protected configuration did not recover.");

        now = TimeSpan.Zero; var writes = new List<JsonObject>(); bool fail = false;
        var publisher = new AgentActiveStateWriter(state => { if (fail) throw new IOException("write failed"); writes.Add(state); }, () => now);
        JsonObject State(bool active = false) => new() { ["runningJobs"] = new JsonArray(), ["terminalActive"] = active, ["rdpActive"] = false, ["transfersActive"] = false, ["updatePending"] = false };
        for (int i = 0; i < 40; i++) publisher.Publish(State());
        if (writes.Count != 1 || writes[0]["at"] is null) throw new Exception("Unchanged active state caused repeated durable writes or lacked a timestamp.");
        now = TimeSpan.FromSeconds(1); publisher.Publish(State(true)); publisher.Publish(State(false));
        if (writes.Count != 3 || writes[1]["terminalActive"]?.GetValue<bool>() != true) throw new Exception("Active-work admission changes were delayed by idle write coalescing.");
        now += AgentActiveStateWriter.RenewalInterval; publisher.Publish(State());
        if (writes.Count != 4) throw new Exception("Idle installation state was not renewed before becoming stale.");
        fail = true; try { publisher.Publish(State(true)); throw new Exception("Fixture write failure was ignored."); } catch (IOException) { }
        fail = false; publisher.Publish(State(true));
        if (writes.Count != 5) throw new Exception("Failed state writes suppressed the successful retry.");
        Console.WriteLine("Native idle-state tests passed: mode invalidation, fail-closed authority, forced admission, durable transitions and bounded renewal.");
    }
}
