using System.Runtime.InteropServices;

namespace ServerDesk.Agent;

/// <summary>
/// The stop of a service as its work sees it: the token, and whether the
/// Service Control Manager sent STOP (1) or SHUTDOWN (5). A system shutdown is
/// a planned stop and creates no integrity event (AgentIntegrity.cs).
/// </summary>
internal sealed class ServiceStop
{
    internal const int StopControl = 1, ShutdownControl = 5;
    private int control;
    internal ServiceStop(CancellationToken token) { Token = token; }
    internal CancellationToken Token { get; }
    /// <summary>0 while the service runs, otherwise the control that stopped it.</summary>
    internal int Control => Volatile.Read(ref control);
    internal bool Shutdown => Control == ShutdownControl;
    internal bool Stopped => Control == StopControl;
    internal void Record(int value) => Interlocked.CompareExchange(ref control, value, 0);
}

internal static class ServiceHost
{
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate void ServiceMain(int argc, IntPtr argv);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate int Handler(int control, int eventType, IntPtr data, IntPtr context);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct Table { public string? Name; public ServiceMain? Main; }
    [StructLayout(LayoutKind.Sequential)] private struct Status { public int Type, State, Controls, Win32Exit, SpecificExit, Checkpoint, WaitHint; }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool StartServiceCtrlDispatcherW([In] Table[] services);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr RegisterServiceCtrlHandlerExW(string name, Handler handler, IntPtr context);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetServiceStatus(IntPtr handle, ref Status status);
    /// <summary>The wait hint of START_PENDING and STOP_PENDING: the worker's last message on a stop (5 s) fits inside it.</summary>
    internal const int WaitHintMilliseconds = 15000;
    internal static int Run(string name, Func<CancellationToken, Task> work, Action<Exception>? onFailure = null, Action<Exception>? onSecurityWarning = null, bool repairPolicy = true) =>
        Run(name, stop => work(stop.Token), onFailure, onSecurityWarning, repairPolicy);
    internal static int Run(string name, Func<ServiceStop, Task> work, Action<Exception>? onFailure = null, Action<Exception>? onSecurityWarning = null, bool repairPolicy = true)
    {
        using var cancel = new CancellationTokenSource(); IntPtr handle = IntPtr.Zero;
        var stop = new ServiceStop(cancel.Token);
        void Report(int state, int exit = 0) { var status = new Status { Type = 0x10, State = state, Controls = state == 4 ? 5 : 0, Win32Exit = exit, SpecificExit = exit == 1066 ? 1 : 0, WaitHint = state is 2 or 3 ? WaitHintMilliseconds : 0 }; SetServiceStatus(handle, ref status); }
        // STOP or SHUTDOWN: the work learns which one before its token is canceled.
        Handler handler = (control, _, _, _) => { if (control is ServiceStop.StopControl or ServiceStop.ShutdownControl) { stop.Record(control); Report(3); cancel.Cancel(); } else if (control == 4) Report(cancel.IsCancellationRequested ? 3 : 4); return 0; };
        int result = 0;
        ServiceMain main = (_, _) => { handle = RegisterServiceCtrlHandlerExW(name, handler, IntPtr.Zero); if (handle == IntPtr.Zero) { result = 1; return; } Report(2); try {
            // A host policy can deny service reconfiguration even to SYSTEM.
            // Installer/repair must apply the protection successfully; at normal
            // startup, report the failure without disabling existing features.
            // The unprivileged worker cannot and need not change service
            // configuration; the broker repairs both services (its integrity
            // check runs before this repair when a baseline exists, see
            // AgentBroker.RunAsync, so a changed protection is reported first).
            if (repairPolicy) try { NativeServiceSetup.ApplySecurityPolicy(); }
            catch (Exception e) { if (onSecurityWarning is not null) onSecurityWarning(e); else Console.Error.WriteLine("Service security policy could not be repaired: " + e.GetType().Name); }
            Task task = work(stop); Report(4); task.GetAwaiter().GetResult(); Report(1);
        } catch (OperationCanceledException) when (cancel.IsCancellationRequested) { Report(1); } catch (Exception e) { onFailure?.Invoke(e); result = 1; Report(1, 1066); } };
        if (!StartServiceCtrlDispatcherW([new Table { Name = name, Main = main }, new Table()])) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Use --console for an interactive development run");
        GC.KeepAlive(handler); GC.KeepAlive(main); return result;
    }
}
