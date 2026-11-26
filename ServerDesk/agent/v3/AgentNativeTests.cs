using System.IO.Compression;

namespace ServerDesk.Agent;

internal static class AgentNativeTests
{
    internal static void Run()
    {
        string root = Path.Combine(Path.GetTempPath(), "ServerDesk-native-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            using (var first = AgentUpdateLease.Acquire(root))
            {
                bool blocked = false;
                try { using var second = AgentUpdateLease.Acquire(root); } catch (InvalidOperationException) { blocked = true; }
                if (!blocked) throw new Exception("Concurrent installers acquired the same protected update lease.");
            }
            using (var activity = AgentUpdateLease.AcquireActivity(root))
            using (var secondActivity = AgentUpdateLease.AcquireActivity(root))
            {
                bool blocked = false; try { using var installer = AgentUpdateLease.Acquire(root); } catch (InvalidOperationException) { blocked = true; }
                if (!blocked) throw new Exception("An installer acquired the native lease while work was active.");
            }
            using (var installer = AgentUpdateLease.Acquire(root))
            {
                bool blocked = false; try { using var activity = AgentUpdateLease.AcquireActivity(root); } catch (InvalidOperationException) { blocked = true; }
                if (!blocked) throw new Exception("Native work crossed the installer admission boundary.");
            }
            // A lease may be disposed on another thread after an async continuation.
            var lease = AgentUpdateLease.Acquire(root); Task.Run(lease.Dispose).GetAwaiter().GetResult();
            using (AgentUpdateLease.Acquire(root)) { }
            void Archive(string[] names)
            {
                using var zip = ZipFile.Open(Path.Combine(root, "test.zip"), ZipArchiveMode.Create);
                foreach (string name in names) { using var writer = new StreamWriter(zip.CreateEntry(name).Open()); writer.Write("test binary"); }
            }
            Archive(["ServerDesk.Agent.exe"]);
            AgentUpdater.Extract(Path.Combine(root, "test.zip"), Path.Combine(root, "valid"));
            if (!File.Exists(Path.Combine(root, "valid", "ServerDesk.Agent.exe"))) throw new Exception("Single-EXE release extraction failed.");
            foreach (string[] names in new[] { new[] { "../ServerDesk.Agent.exe" }, new[] { "ServerDesk.Agent.exe", "ServerDesk-Monitor.ps1" }, new[] { "ServerDesk.Agent.exe", "ServerDesk.Agent.exe" }, new[] { "ServerDesk.Agent.exe/" }, Array.Empty<string>() })
            {
                File.Delete(Path.Combine(root, "test.zip")); Archive(names);
                bool rejected = false; try { AgentUpdater.Extract(Path.Combine(root, "test.zip"), Path.Combine(root, "bad-" + Guid.NewGuid().ToString("N"))); } catch (InvalidDataException) { rejected = true; }
                if (!rejected) throw new Exception("Unsafe or non-native release archive was accepted.");
            }
            Console.WriteLine("Native packaging and async update lease tests passed.");
        }
        finally { Directory.Delete(root, true); }
    }
}
