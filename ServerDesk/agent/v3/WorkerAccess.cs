using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

// File-system boundary between the SYSTEM broker and the worker:
//   root\              SYSTEM + Administrators only (config.bin, jobs, claims)
//   root\current\      + worker read/execute (the shared single-file EXE)
//   root\worker.bin    + worker read (identity, origin, bearer, key fingerprint)
//   root\worker\       worker-owned data: token state, health, logs, runtime
// The broker and the installer never write into root\worker, so links the
// worker might plant there cannot redirect a privileged write.
internal static class WorkerAccess
{
    private static readonly SecurityIdentifier Administrators = new(WellKnownSidType.BuiltinAdministratorsSid, null), LocalSystem = new(WellKnownSidType.LocalSystemSid, null);
    private static SecurityIdentifier Worker => new(BrokerProtocol.WorkerSid);
    private const InheritanceFlags All = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;

    internal static DirectorySecurity DataSecurity() => DataSecurity(Worker);
    /// <summary>The worker data DACL for a worker SID; the lifecycle self-test uses its test worker.</summary>
    internal static DirectorySecurity DataSecurity(SecurityIdentifier worker)
    {
        var security = new DirectorySecurity(); security.SetAccessRuleProtection(true, false); security.SetOwner(Administrators);
        foreach (var sid in new[] { Administrators, LocalSystem }) security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, All, PropagationFlags.None, AccessControlType.Allow));
        // The folder itself: list and add entries, but not delete or rename it.
        security.AddAccessRule(new FileSystemAccessRule(worker, FileSystemRights.ReadAndExecute | FileSystemRights.CreateFiles | FileSystemRights.CreateDirectories, InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
        // Everything inside it: full ordinary use by the worker.
        security.AddAccessRule(new FileSystemAccessRule(worker, FileSystemRights.Modify, All, PropagationFlags.InheritOnly, AccessControlType.Allow));
        return security;
    }

    internal static void CreateData(string root, bool recreate)
    {
        string path = BrokerProtocol.WorkerRoot(root);
        if (Directory.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("The worker directory is a reparse point.");
        // Directory.Delete removes planted junctions without following them.
        if (recreate && Directory.Exists(path)) Directory.Delete(path, true);
        if (!Directory.Exists(path)) new DirectoryInfo(path).Create(DataSecurity());
    }

    internal static void GrantPackage(string root)
    {
        var current = new DirectoryInfo(Path.Combine(root, "current"));
        if (!current.Exists) return;
        if ((current.Attributes & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("The package directory is a reparse point.");
        var security = current.GetAccessControl();
        security.AddAccessRule(new FileSystemAccessRule(Worker, FileSystemRights.ReadAndExecute, All, PropagationFlags.None, AccessControlType.Allow));
        current.SetAccessControl(security);
        // SecureDirectory gives every file a protected DACL, so the folder ACE
        // above is not inherited. Grant the package files explicitly, or the
        // SCM cannot start the worker from its own EXE (access denied).
        foreach (var file in current.EnumerateFiles("*", SearchOption.AllDirectories))
        {
            if ((file.Attributes & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("The package directory contains a reparse point.");
            var acl = file.GetAccessControl();
            acl.AddAccessRule(new FileSystemAccessRule(Worker, FileSystemRights.ReadAndExecute, AccessControlType.Allow));
            file.SetAccessControl(acl);
        }
    }

    // The worker never receives the RSA device key, the job-signing key, the
    // local mode or anything else from config.bin beyond its portal identity.
    internal static JsonObject WorkerConfiguration(JsonObject config) => new()
    {
        ["id"] = config["id"]!.DeepClone(), ["origin"] = config["origin"]!.DeepClone(),
        ["token"] = config["token"]!.DeepClone(), ["keyHash"] = DeviceTokenClient.Fingerprint(config["privateKey"]!.GetValue<string>())
    };

    internal static void WriteConfiguration(string root, JsonObject config)
    {
        LocalStore.SaveProtected(BrokerProtocol.WorkerConfigPath(root), WorkerConfiguration(config));
        GrantConfiguration(root);
    }

    private static void GrantConfiguration(string root)
    {
        var file = new FileInfo(BrokerProtocol.WorkerConfigPath(root));
        if (!file.Exists) return;
        var security = new FileSecurity(); security.SetAccessRuleProtection(true, false); security.SetOwner(Administrators);
        foreach (var sid in new[] { Administrators, LocalSystem }) security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(Worker, FileSystemRights.Read, AccessControlType.Allow));
        file.SetAccessControl(security);
    }

    // Broker start: after an update switched directories or SecureDirectory
    // reset inherited ACLs, restore exactly the worker grants above.
    internal static void Repair(string root)
    {
        CreateData(root, recreate: false); GrantPackage(root); GrantConfiguration(root);
    }
}
