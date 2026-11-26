using System.ComponentModel;
using System.Management;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;

namespace ServerDesk.Agent;

// Inventory errors cross the heartbeat boundary. Preserve provider codes and
// known operation context without sending arbitrary Windows exception messages.
internal sealed class NativeInventoryException(string context, Exception inner)
    : Exception(WindowsManagement.Limit(context, 200) + ": " + NativeInventoryDiagnostics.Describe(inner), inner)
{
    internal string Context { get; } = WindowsManagement.Limit(context, 200);
}

internal static class NativeInventoryDiagnostics
{
    internal static string Describe(Exception error) => Describe(error, 0);

    private static string Describe(Exception error, int depth)
    {
        if (error is NativeInventoryException inventory && depth < 3)
            return inventory.Context + ": " + Describe(inventory.InnerException!, depth + 1);
        string code = error switch
        {
            NetworkInformationException network => ", Windows code=" + network.ErrorCode,
            ManagementException management => ", WMI=" + management.ErrorCode + " (0x" + unchecked((uint)(int)management.ErrorCode).ToString("X8") + ")",
            Win32Exception windows => ", Windows code=" + windows.NativeErrorCode,
            COMException => ", HRESULT=0x" + unchecked((uint)error.HResult).ToString("X8"),
            _ => ""
        };
        return error.GetType().Name + code;
    }
}
