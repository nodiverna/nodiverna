namespace ServerDesk.Agent;

// A file handle is an async-safe, cross-process lease. Unlike a named Mutex it
// is not bound to the managed thread that happened to acquire it before await.
internal static class AgentUpdateLease
{
    internal static FileStream Acquire(string root) => Open(root, activity: false);
    internal static FileStream AcquireActivity(string root) => Open(root, activity: true);
    private static FileStream Open(string root, bool activity)
    {
        Directory.CreateDirectory(root);
        try
        {
            string path = Path.Combine(root, "update.lock");
            if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("The update lease cannot be a reparse point.");
            var stream = new FileStream(path, FileMode.OpenOrCreate, activity ? FileAccess.Read : FileAccess.ReadWrite, activity ? FileShare.Read : FileShare.None);
            try
            {
                if (OperatingSystem.IsWindows())
                {
                    PathPolicy.NoHardLinks(stream.SafeFileHandle);
                    if (!PathPolicy.FinalPath(stream.SafeFileHandle).Equals(Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("The update lease resolved outside the protected agent directory.");
                }
                return stream;
            }
            catch { stream.Dispose(); throw; }
        }
        catch (IOException e) { throw new InvalidOperationException(activity ? "A native installation or agent update is in progress. No new work was started." : "Finish active jobs, terminals and transfers before installation or update.", e); }
    }
}
