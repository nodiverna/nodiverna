namespace ServerDesk.Agent;

internal static class TerminalSessionLeaseTests
{
    internal static void Run()
    {
        string root = Path.Combine(Path.GetTempPath(), "ServerDesk-TerminalLease-" + Guid.NewGuid().ToString("N"));
        try
        {
            using (var installation = AgentUpdateLease.Acquire(root))
            {
                var blocked = new TerminalSession(Guid.NewGuid().ToString(), root, 80, 20, DateTimeOffset.UtcNow.AddMinutes(1));
                var snapshot = blocked.Snapshot();
                if (snapshot["state"]?.GetValue<string>() != "error" || snapshot["error"]?.GetValue<string>()?.Contains("installation or agent update", StringComparison.Ordinal) != true)
                    throw new InvalidOperationException("An installation lease did not reject terminal admission before process startup.");
                blocked.DisposeAsync().AsTask().GetAwaiter().GetResult();
            }
            // Zero columns fail before native process creation on Windows; Linux
            // rejects ConPTY earlier. Both paths have already acquired admission.
            var failed = new TerminalSession(Guid.NewGuid().ToString(), root, 0, 20, DateTimeOffset.UtcNow.AddMinutes(1));
            if (failed.Snapshot()["state"]?.GetValue<string>() != "error") throw new InvalidOperationException("Invalid terminal startup unexpectedly succeeded.");
            Task.WhenAll(failed.DisposeAsync().AsTask(), failed.DisposeAsync().AsTask()).GetAwaiter().GetResult();
            using var afterFailure = AgentUpdateLease.Acquire(root);
            Console.WriteLine("Terminal activity lease tests passed: exclusive installation blocks admission; startup failure and repeated cleanup release admission.");
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
    }
}
