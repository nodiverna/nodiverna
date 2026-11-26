using Microsoft.Win32;
using System.Text.Json.Nodes;

namespace ServerDesk.Agent;

internal sealed record NativeRebootState(bool Pending, string[] Reasons, int PendingFileOperationsCount)
{
    internal JsonObject ToJson() => new()
    {
        ["rebootPending"] = Pending,
        ["rebootReasons"] = new JsonArray(Reasons.Select(reason => (JsonNode?)JsonValue.Create(reason)).ToArray()),
        ["pendingFileOperationsCount"] = PendingFileOperationsCount
    };
}

internal static class NativeRebootStatus
{
    internal static NativeRebootState Read()
    {
        if (!OperatingSystem.IsWindows()) return Evaluate(false, false, null);
        using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var servicing = machine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending");
        using var updating = machine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired");
        using var manager = machine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager");
        return Evaluate(servicing is not null, updating is not null, manager?.GetValue("PendingFileRenameOperations"));
    }

    // PendingFileRenameOperations stores source/destination pairs. An empty
    // destination schedules cleanup at the next boot; it does not by itself
    // establish that a system update needs a reboot. Keep cleanup visible
    // separately, without clearing Windows state or hiding replacement work.
    internal static NativeRebootState Evaluate(bool servicing, bool updating, object? pending)
    {
        var reasons = new List<string>();
        if (servicing) reasons.Add("windows-servicing");
        if (updating) reasons.Add("windows-update");
        bool replacement = false, unknown = false; int cleanup = 0;
        if (pending is string[] entries)
        {
            for (int i = 0; i < entries.Length; i += 2)
            {
                string? source = entries[i];
                // Some REG_MULTI_SZ readers retain an empty terminator. A
                // nonempty unpaired source must never silently look healthy.
                if (i + 1 >= entries.Length) { unknown |= source != ""; break; }
                string? destination = entries[i + 1];
                if (source == "" && destination == "") continue;
                if (!LocalAbsolutePath(source, false)) { unknown = true; continue; }
                if (destination == "") { cleanup = Math.Min(cleanup + 1, 1_000_000); continue; }
                if (LocalAbsolutePath(destination, true)) replacement = true;
                else unknown = true;
            }
        }
        else if (pending is not null) unknown = true;
        if (replacement) reasons.Add("file-replacement");
        if (unknown) reasons.Add("file-operations-unknown");
        return new(reasons.Count > 0, reasons.ToArray(), cleanup);
    }

    private static bool LocalAbsolutePath(string? value, bool destination)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 32767 || value.Any(char.IsControl)) return false;
        // Windows may prefix cleanup sources with *1 and replacement targets
        // with !. NT/Win32 long-path prefixes still resolve to an absolute
        // local drive; UNC, relative and unfamiliar forms stay conservative.
        string path = value;
        if (!destination && path.StartsWith("*1", StringComparison.Ordinal)) path = path[2..];
        if (destination && path.StartsWith('!')) path = path[1..];
        if (path.StartsWith(@"\??\", StringComparison.Ordinal) || path.StartsWith(@"\\?\", StringComparison.Ordinal)) path = path[4..];
        return path.Length > 3 && char.IsAsciiLetter(path[0]) && path[1] == ':' && path[2] == '\\'
            && path[3..].Split('\\').All(segment => segment.Length > 0 && segment is not "." and not ".."
                && !segment.Any(character => character is ':' or '*' or '?' or '"' or '<' or '>' or '|' or '/'));
    }
}
