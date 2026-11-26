using System.Runtime.InteropServices;
using System.Xml.Linq;

namespace ServerDesk.Agent;

internal static class UpdateGuardian
{
    private const string Name = "ServerDesk Update Recovery";
    private static Task WithSchedulerAsync(Action<dynamic> action) => Task.Run(() =>
    {
        object? scheduler = null, folder = null;
        try
        {
            scheduler = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service", true)!)!;
            ((dynamic)scheduler).Connect(); folder = ((dynamic)scheduler).GetFolder("\\");
            action((dynamic)folder);
        }
        finally
        {
            if (folder is not null && Marshal.IsComObject(folder)) Marshal.FinalReleaseComObject(folder);
            if (scheduler is not null && Marshal.IsComObject(scheduler)) Marshal.FinalReleaseComObject(scheduler);
        }
    });
    internal static async Task RegisterAsync(string root, string updater, string plan)
    {
        XNamespace ns = "http://schemas.microsoft.com/windows/2004/02/mit/task";
        XElement E(string name, params object[] content) => new(ns + name, content);
        var xml = new XDocument(new XDeclaration("1.0", "utf-16", null), E("Task", new XAttribute("version", "1.4"), E("RegistrationInfo", E("Description", "Completes or rolls back a verified ServerDesk agent update after an interrupted directory switch.")), E("Triggers", E("BootTrigger", E("Enabled", "true"), E("Delay", "PT10S")), E("TimeTrigger", E("Repetition", E("Interval", "PT1M"), E("Duration", "PT30M"), E("StopAtDurationEnd", "false")), E("StartBoundary", DateTimeOffset.UtcNow.AddMinutes(1).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss'Z'")), E("Enabled", "true"))), E("Principals", E("Principal", new XAttribute("id", "System"), E("UserId", "S-1-5-18"), E("RunLevel", "HighestAvailable"))), E("Settings", E("MultipleInstancesPolicy", "IgnoreNew"), E("DisallowStartIfOnBatteries", "false"), E("StopIfGoingOnBatteries", "false"), E("StartWhenAvailable", "true"), E("Enabled", "true"), E("ExecutionTimeLimit", "PT15M")), E("Actions", new XAttribute("Context", "System"), E("Exec", E("Command", updater), E("Arguments", "--update \"" + plan + "\""), E("WorkingDirectory", root)))));
        await WithSchedulerAsync(folder =>
        {
            object task = folder.RegisterTask(Name, xml.ToString(), 6, "SYSTEM", null, 5, null);
            if (Marshal.IsComObject(task)) Marshal.FinalReleaseComObject(task);
        }).WaitAsync(TimeSpan.FromSeconds(30));
    }
    internal static async Task RemoveAsync()
    {
        await WithSchedulerAsync(folder =>
        {
            try { folder.DeleteTask(Name, 0); }
            // COM interop maps 0x80070002 to FileNotFoundException, not COMException.
            catch (Exception e) when (e.HResult == unchecked((int)0x80070002)) { }
        }).WaitAsync(TimeSpan.FromSeconds(30));
    }
}
