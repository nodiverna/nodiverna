using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace ServerDesk.Plugin.Dns;

// The local DNS server through the documented WMI providers (docs/dns-server.md):
// root\MicrosoftDNS (MicrosoftDNS_Server, _Zone, _ResourceRecord and the
// per-type classes, _Cache) and root\Microsoft\Windows\DNS (DnsServerZone,
// DnsServerScavenging, and the static methods of the PS_DnsServer*Zone classes
// for a zone create and delete) where root\MicrosoftDNS lacks a setting or a
// zone. The plugin connects only to the local namespaces (no
// server name, so no network connection). COM goes through raw vtable calls
// with function pointers, which work in a trimmed single-file build without
// built-in COM interop. Every WQL value is escaped (Wql); method values are
// typed parameters.

/// <summary>
/// A failed WMI call with its HRESULT and, when WMI gave them, the details of
/// the error object of the call: the provider code (__ExtendedStatus.StatusCode
/// or MSFT_WmiError.error_Code, for example the DNS server's own error number
/// behind a generic 0x80041001), the description (__ExtendedStatus.Description,
/// else MSFT_WmiError.Message), the provider name and the operation. A failed
/// lookup step (GetMethod, Put of a method input) carries the method or
/// parameter names of its class as Signature. Attempts holds every call that a
/// change tried before it gave up, in order.
/// </summary>
internal sealed class WmiException(string call, int hresult, long? providerCode = null, string? description = null, string? providerName = null, string? operation = null, string? signature = null) : Exception(call + " failed with 0x" + hresult.ToString("X8", CultureInfo.InvariantCulture) + (providerCode is long code ? ", provider code " + code.ToString(CultureInfo.InvariantCulture) + "." : ", no provider code."))
{
    internal string Call { get; } = call;
    internal int HResult32 { get; } = hresult;
    /// <summary>The number of the WMI error object of the failed call, or null when there was none or it had no number.</summary>
    internal long? ProviderCode { get; } = providerCode;
    /// <summary>The Windows text of the error object (__ExtendedStatus.Description, else MSFT_WmiError.Message), or null.</summary>
    internal string? Description { get; } = description;
    /// <summary>ProviderName of __ExtendedStatus, or null.</summary>
    internal string? ProviderName { get; } = providerName;
    /// <summary>Operation of __ExtendedStatus, or null.</summary>
    internal string? Operation { get; } = operation;
    /// <summary>The method names of the class (GetMethod failed) or the input parameter names of the method (Put failed), or null.</summary>
    internal string? Signature { get; } = signature;
    /// <summary>Every call the change tried, in order, when it tried more than one; empty for a single call.</summary>
    internal IReadOnlyList<WmiException> Attempts { get; set; } = [];
    /// <summary>The calls tried: Attempts, or this exception alone.</summary>
    internal IReadOnlyList<WmiException> Tried => Attempts.Count > 0 ? Attempts : [this];
    /// <summary>The HRESULT as 0x and 8 upper-case hex digits.</summary>
    internal string HResultText => "0x" + HResult32.ToString("X8", CultureInfo.InvariantCulture);
    /// <summary>The Win32 or DNS error number inside a FACILITY_WIN32 code (its low 16 bits), else the value itself.</summary>
    internal static long Unwrap(long value) => (value & 0xFFFF0000L) == 0x80070000L ? value & 0xFFFF : value & 0xFFFFFFFFL;
    /// <summary>The error number of the failure: the provider code when there is one, else the HRESULT, both unwrapped.</summary>
    internal long Code => Unwrap(ProviderCode ?? unchecked((uint)HResult32));
    internal bool AccessDenied => HResult32 is unchecked((int)0x80070005) or unchecked((int)0x80041003) || ProviderCode is long code && Unwrap(code) == 5;
    /// <summary>A failed lookup of a class, method or method parameter (GetObject of the class, GetMethod, Put of a method input): a wrong name in the plugin, not a missing DNS object.</summary>
    internal bool SchemaStep { get; init; }
    /// <summary>WBEM_E_NOT_FOUND of a DNS object (a zone, a record); a failed schema step does not count.</summary>
    internal bool NotFound => HResult32 == unchecked((int)0x80041002) && !SchemaStep;
}

/// <summary>What the WMI error object of a failed call says; a value is null when the object has none or reading it failed.</summary>
internal sealed record WmiErrorDetails(long? ProviderCode, string? Description, string? ProviderName, string? Operation)
{
    internal static readonly WmiErrorDetails None = new(null, null, null, null);
}

/// <summary>The managed values of WMI properties as the plugin uses them: for a WmiObject, and for plain values in the self-test.</summary>
internal static class WmiValue
{
    internal static string? Text(object? value) => value switch { string text => text, int number => number.ToString(CultureInfo.InvariantCulture), long number => number.ToString(CultureInfo.InvariantCulture), _ => null };
    internal static long? Number(object? value) => value switch { int number => (uint)number, long number => number, string text when long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out long parsed) => parsed, bool flag => flag ? 1 : 0, _ => null };
    internal static bool Flag(object? value) => value switch { bool flag => flag, int number => number != 0, _ => false };
    internal static string[] List(object? value) => value switch { string[] list => list, string text when text.Length > 0 => [text], _ => [] };
}

/// <summary>The WQL text of a string value: inside single quotes, with backslash and quote escaped.</summary>
internal static class Wql
{
    internal static string Quote(string value)
    {
        if (value.Any(char.IsControl)) throw new ArgumentException("A WQL value has a control character.", nameof(value));
        return "'" + value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("'", "\\'", StringComparison.Ordinal) + "'";
    }
}

/// <summary>The VARIANT of the COM calls (24 bytes on x64).</summary>
[StructLayout(LayoutKind.Explicit, Size = 24)]
internal struct Variant
{
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(8)] public long Long;
    [FieldOffset(8)] public IntPtr Pointer;
    [FieldOffset(8)] public int Int;
    [FieldOffset(8)] public short Short;
    [FieldOffset(8)] public byte Byte;
    [FieldOffset(8)] public double Double;
}

internal static unsafe class Com
{
    internal const ushort Empty = 0, Null = 1, I2 = 2, I4 = 3, R4 = 4, R8 = 5, Bstr = 8, Bool = 11, Unknown = 13, I1 = 16, UI1 = 17, UI2 = 18, UI4 = 19, I8 = 20, UI8 = 21, Array = 0x2000;
    [DllImport("ole32.dll")] internal static extern int CoInitializeEx(IntPtr reserved, uint init);
    [DllImport("ole32.dll")] internal static extern int CoInitializeSecurity(IntPtr descriptor, int count, IntPtr services, IntPtr reserved, uint authentication, uint impersonation, IntPtr list, uint capabilities, IntPtr reserved3);
    [DllImport("ole32.dll")] internal static extern int CoCreateInstance(in Guid clsid, IntPtr outer, uint context, in Guid iid, out IntPtr result);
    [DllImport("ole32.dll")] internal static extern int CoSetProxyBlanket(IntPtr proxy, uint authentication, uint authorization, IntPtr principal, uint level, uint impersonation, IntPtr identity, uint capabilities);
    [DllImport("oleaut32.dll")] internal static extern int VariantClear(ref Variant value);
    [DllImport("oleaut32.dll")] internal static extern IntPtr SysAllocString([MarshalAs(UnmanagedType.LPWStr)] string value);
    [DllImport("oleaut32.dll")] internal static extern void SysFreeString(IntPtr value);
    [DllImport("oleaut32.dll")] internal static extern int SafeArrayGetLBound(IntPtr array, uint dimension, out int bound);
    [DllImport("oleaut32.dll")] internal static extern int SafeArrayGetUBound(IntPtr array, uint dimension, out int bound);
    [DllImport("oleaut32.dll")] internal static extern int SafeArrayGetElement(IntPtr array, ref int index, void* value);
    [DllImport("oleaut32.dll")] internal static extern IntPtr SafeArrayCreateVector(ushort type, int lower, uint count);
    [DllImport("oleaut32.dll")] internal static extern int SafeArrayPutElement(IntPtr array, ref int index, void* value);
    [DllImport("oleaut32.dll")] internal static extern int SafeArrayDestroy(IntPtr array);

    /// <summary>The vtable slot of a COM object.</summary>
    internal static IntPtr Slot(IntPtr instance, int index) => (*(IntPtr**)instance)[index];
    internal static void Release(IntPtr instance) { if (instance != IntPtr.Zero) ((delegate* unmanaged<IntPtr, uint>)Slot(instance, 2))(instance); }
    internal static void Check(int hresult, string call) { if (hresult < 0) throw new WmiException(call, hresult); }
    /// <summary>Like Check for a WMI operation that sets an error object (ExecMethod, PutInstance, DeleteInstance): the exception carries its details. Call it right after the failed call, on the same thread.</summary>
    internal static void CheckWmi(int hresult, string call)
    {
        if (hresult >= 0) return;
        var details = ErrorDetails(hresult);
        throw new WmiException(call, hresult, details.ProviderCode, details.Description, details.ProviderName, details.Operation);
    }

    [DllImport("oleaut32.dll")] private static extern int GetErrorInfo(uint reserved, IntPtr* info);
    private static readonly Guid WbemClassObjectInterface = new("dc12a681-737f-11cf-884d-00aa004b2e24");
    /// <summary>
    /// The error object of the WMI call that just failed on this thread: the
    /// COM error object (GetErrorInfo, which also clears it), queried for
    /// IWbemClassObject. The provider code is StatusCode of __ExtendedStatus or
    /// else error_Code of MSFT_WmiError; it is null when there is no number or a
    /// number that only repeats the HRESULT. The description is Description of
    /// __ExtendedStatus or else Message of MSFT_WmiError; ProviderName and
    /// Operation come from __ExtendedStatus. A value that cannot be read is null,
    /// and no error object gives WmiErrorDetails.None: reading the error object
    /// never replaces the original failure. Both COM objects are released in
    /// every path.
    /// </summary>
    internal static WmiErrorDetails ErrorDetails(int hresult)
    {
        IntPtr info = IntPtr.Zero, error = IntPtr.Zero;
        try
        {
            if (GetErrorInfo(0, &info) != 0 || info == IntPtr.Zero) return WmiErrorDetails.None; // S_FALSE: no error object.
            Guid iid = WbemClassObjectInterface;
            // IUnknown::QueryInterface (slot 0).
            if (((delegate* unmanaged<IntPtr, Guid*, IntPtr*, int>)Slot(info, 0))(info, &iid, &error) < 0 || error == IntPtr.Zero) return WmiErrorDetails.None;
            var status = new WmiObject(error); error = IntPtr.Zero;
            using (status)
            {
                long? code = Safe(() => status.Number("StatusCode") ?? status.Number("error_Code"));
                long? provider = code is long value && value != 0 && (value & 0xFFFFFFFFL) != unchecked((uint)hresult) ? value & 0xFFFFFFFFL : null;
                string? description = Safe(() => Filled(status.Text("Description")) ?? Filled(status.Text("Message")));
                return new WmiErrorDetails(provider, description, Safe(() => Filled(status.Text("ProviderName"))), Safe(() => Filled(status.Text("Operation"))));
            }
        }
        catch (Exception) { return WmiErrorDetails.None; }
        finally { Release(error); Release(info); }
    }
    /// <summary>One value of the error object; a failure while reading it gives null.</summary>
    private static T? Safe<T>(Func<T?> read) { try { return read(); } catch (Exception) { return default; } }
    private static string? Filled(string? text) => string.IsNullOrWhiteSpace(text) ? null : text;

    /// <summary>The managed value of a VARIANT: string, int, long, bool, double, string[] or int[]; null for VT_NULL and VT_EMPTY.</summary>
    internal static object? Read(in Variant value)
    {
        switch (value.Type)
        {
            case Empty: case Null: return null;
            case Bstr: return value.Pointer == IntPtr.Zero ? "" : Marshal.PtrToStringBSTR(value.Pointer);
            case I4: case UI4: return value.Int;
            case I2: return (int)value.Short;
            case UI2: return (int)(ushort)value.Short;
            case UI1: case I1: return (int)value.Byte;
            case I8: case UI8: return value.Long;
            case Bool: return value.Short != 0;
            case R8: return value.Double;
            case Array | Bstr: return Strings(value.Pointer);
            case Array | I4: case Array | UI4: return Integers(value.Pointer);
            default: return null;
        }
    }
    private static (int Low, int High) Bounds(IntPtr array)
    {
        if (array == IntPtr.Zero) return (0, -1);
        Check(SafeArrayGetLBound(array, 1, out int low), "SafeArrayGetLBound"); Check(SafeArrayGetUBound(array, 1, out int high), "SafeArrayGetUBound");
        return (low, high);
    }
    internal static string[] Strings(IntPtr array)
    {
        var (low, high) = Bounds(array); var list = new List<string>();
        for (int index = low; index <= high; index++)
        {
            IntPtr item = IntPtr.Zero; Check(SafeArrayGetElement(array, ref index, &item), "SafeArrayGetElement");
            try { list.Add(item == IntPtr.Zero ? "" : Marshal.PtrToStringBSTR(item)); } finally { SysFreeString(item); }
        }
        return list.ToArray();
    }
    private static int[] Integers(IntPtr array)
    {
        var (low, high) = Bounds(array); var list = new List<int>();
        for (int index = low; index <= high; index++) { int item = 0; Check(SafeArrayGetElement(array, ref index, &item), "SafeArrayGetElement"); list.Add(item); }
        return list.ToArray();
    }
    /// <summary>A VARIANT for Put: string, int, bool, string[] or null. The caller clears it.</summary>
    internal static Variant Create(object? value)
    {
        var result = new Variant();
        switch (value)
        {
            case null: result.Type = Null; break;
            case string text: result.Type = Bstr; result.Pointer = SysAllocString(text); break;
            case bool flag: result.Type = Bool; result.Short = flag ? (short)-1 : (short)0; break;
            case int number: result.Type = I4; result.Int = number; break;
            case uint number: result.Type = I4; result.Int = unchecked((int)number); break;
            case string[] list:
                {
                    IntPtr array = SafeArrayCreateVector(Bstr, 0, (uint)list.Length);
                    for (int index = 0; index < list.Length; index++)
                    {
                        IntPtr item = SysAllocString(list[index]);
                        try { Check(SafeArrayPutElement(array, ref index, (void*)item), "SafeArrayPutElement"); } finally { SysFreeString(item); }
                    }
                    result.Type = Array | Bstr; result.Pointer = array; break;
                }
            default: throw new ArgumentException("Unsupported WMI value " + value.GetType().Name + ".", nameof(value));
        }
        return result;
    }
}

/// <summary>One IWbemClassObject: an instance, a class or method parameters.</summary>
internal sealed unsafe class WmiObject(IntPtr pointer) : IDisposable
{
    internal IntPtr Pointer { get; private set; } = pointer;
    public void Dispose() { Com.Release(Pointer); Pointer = IntPtr.Zero; }

    /// <summary>IWbemClassObject::Get (slot 4).</summary>
    internal object? Get(string name)
    {
        var value = new Variant();
        fixed (char* text = name)
        {
            int hr = ((delegate* unmanaged<IntPtr, char*, int, Variant*, int*, int*, int>)Com.Slot(Pointer, 4))(Pointer, text, 0, &value, null, null);
            if (hr < 0) { if (hr == unchecked((int)0x80041002)) return null; Com.Check(hr, "Get " + name); }
        }
        try { return Com.Read(value); } finally { Com.VariantClear(ref value); }
    }
    internal string? Text(string name) => WmiValue.Text(Get(name));
    internal long? Number(string name) => WmiValue.Number(Get(name));
    internal bool Flag(string name) => WmiValue.Flag(Get(name));
    internal string[] List(string name) => WmiValue.List(Get(name));

    /// <summary>IWbemClassObject::Put (slot 5).</summary>
    internal void Put(string name, object? value)
    {
        var variant = Com.Create(value);
        try { fixed (char* text = name) Com.Check(((delegate* unmanaged<IntPtr, char*, int, Variant*, int, int>)Com.Slot(Pointer, 5))(Pointer, text, 0, &variant, 0), "Put " + name); }
        finally { Com.VariantClear(ref variant); }
    }
    /// <summary>IWbemClassObject::SpawnInstance (slot 15).</summary>
    internal WmiObject Spawn()
    {
        IntPtr instance; Com.Check(((delegate* unmanaged<IntPtr, int, IntPtr*, int>)Com.Slot(Pointer, 15))(Pointer, 0, &instance), "SpawnInstance");
        return new WmiObject(instance);
    }
    /// <summary>
    /// The input parameters of a method of this class (the class named
    /// className): IWbemClassObject::GetMethod (slot 19), then an instance of the
    /// in signature. When the method is missing or has no input, the
    /// WmiException names the class and the step ("PS_DnsServerZone GetMethod
    /// Remove") and carries the method names of the class.
    /// </summary>
    internal WmiObject MethodInput(string className, string method)
    {
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero;
        int hr;
        fixed (char* text = method) hr = ((delegate* unmanaged<IntPtr, char*, int, IntPtr*, IntPtr*, int>)Com.Slot(Pointer, 19))(Pointer, text, 0, &input, &output);
        Com.Release(output);
        if (hr < 0 || input == IntPtr.Zero)
        {
            Com.Release(input);
            throw new WmiException(className + " GetMethod " + method, hr < 0 ? hr : unchecked((int)0x80041002), signature: MethodNames() is { } names ? "methods " + names : null) { SchemaStep = true };
        }
        using var signature = new WmiObject(input);
        return signature.Spawn();
    }

    /// <summary>
    /// The method names of this class, space-separated:
    /// IWbemClassObject::BeginMethodEnumeration (slot 22), NextMethod (23) up to
    /// WBEM_S_NO_MORE_DATA, EndMethodEnumeration (24). Null when the enumeration
    /// fails, so that it never replaces the failure it explains.
    /// </summary>
    internal string? MethodNames()
    {
        try
        {
            if (((delegate* unmanaged<IntPtr, int, int>)Com.Slot(Pointer, 22))(Pointer, 0) < 0) return null;
            var names = new List<string>();
            try
            {
                for (int count = 0; count < 256; count++)
                {
                    IntPtr name = IntPtr.Zero;
                    // NextMethod(flags, name, in signature, out signature): null signatures are not returned.
                    int hr = ((delegate* unmanaged<IntPtr, int, IntPtr*, IntPtr*, IntPtr*, int>)Com.Slot(Pointer, 23))(Pointer, 0, &name, null, null);
                    if (hr != 0) { Com.SysFreeString(name); break; } // WBEM_S_NO_MORE_DATA or a failure.
                    try { if (name != IntPtr.Zero) names.Add(Marshal.PtrToStringBSTR(name)); } finally { Com.SysFreeString(name); }
                }
            }
            finally { ((delegate* unmanaged<IntPtr, int>)Com.Slot(Pointer, 24))(Pointer); }
            return string.Join(" ", names);
        }
        catch (Exception) { return null; }
    }

    /// <summary>
    /// The non-system property names of this object, comma-separated:
    /// IWbemClassObject::GetNames (slot 7) with WBEM_FLAG_NONSYSTEM_ONLY. For a
    /// method input these are the parameter names. Null when reading fails.
    /// </summary>
    internal string? PropertyNames()
    {
        IntPtr array = IntPtr.Zero;
        try
        {
            if (((delegate* unmanaged<IntPtr, char*, int, Variant*, IntPtr*, int>)Com.Slot(Pointer, 7))(Pointer, null, 0x40, null, &array) < 0) return null;
            return string.Join(", ", Com.Strings(array));
        }
        catch (Exception) { return null; }
        finally { if (array != IntPtr.Zero) Com.SafeArrayDestroy(array); }
    }
}

/// <summary>One connection to a local WMI namespace (IWbemServices).</summary>
internal sealed unsafe class WmiConnection : IDisposable
{
    private static readonly Guid LocatorClass = new("4590f811-1d3a-11d0-891f-00aa004b2e24"), LocatorInterface = new("dc12a687-737f-11cf-884d-00aa004b2e24");
    private static bool initialized;
    private IntPtr services;
    internal const string Dns = @"root\MicrosoftDNS", DnsCim = @"root\Microsoft\Windows\DNS";

    private WmiConnection(IntPtr services) { this.services = services; }
    public void Dispose() { Com.Release(services); services = IntPtr.Zero; }

    /// <summary>Connects to a local namespace with the process token (an S4U account in a change, SYSTEM in a read).</summary>
    internal static WmiConnection Open(string path)
    {
        if (!initialized)
        {
            Com.CoInitializeEx(IntPtr.Zero, 0); // COINIT_MULTITHREADED; S_FALSE or RPC_E_CHANGED_MODE keep the existing apartment.
            // RPC_C_AUTHN_LEVEL_DEFAULT, RPC_C_IMP_LEVEL_IMPERSONATE; RPC_E_TOO_LATE when already set.
            Com.CoInitializeSecurity(IntPtr.Zero, -1, IntPtr.Zero, IntPtr.Zero, 0, 3, IntPtr.Zero, 0, IntPtr.Zero);
            initialized = true;
        }
        Com.Check(Com.CoCreateInstance(LocatorClass, IntPtr.Zero, 1, LocatorInterface, out IntPtr locator), "CoCreateInstance WbemLocator");
        try
        {
            IntPtr resource = Com.SysAllocString(path), result = IntPtr.Zero;
            try
            {
                // IWbemLocator::ConnectServer (slot 3): no user, no authority, so only the local namespace with the current token.
                Com.Check(((delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr, IntPtr, int, IntPtr, IntPtr, IntPtr*, int>)Com.Slot(locator, 3))(locator, resource, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero, IntPtr.Zero, &result), "ConnectServer " + path);
            }
            finally { Com.SysFreeString(resource); }
            // RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE.
            Com.CoSetProxyBlanket(result, 10, 0, IntPtr.Zero, 3, 3, IntPtr.Zero, 0);
            return new WmiConnection(result);
        }
        finally { Com.Release(locator); }
    }

    private static T WithBstr<T>(string value, Func<IntPtr, T> call)
    {
        IntPtr text = Com.SysAllocString(value);
        try { return call(text); } finally { Com.SysFreeString(text); }
    }

    /// <summary>IWbemServices::ExecQuery (slot 20), forward only; every object of the result.</summary>
    internal List<WmiObject> Query(string wql)
    {
        IntPtr enumerator = WithBstr("WQL", language => WithBstr(wql, query =>
        {
            IntPtr result; Com.Check(((delegate* unmanaged<IntPtr, IntPtr, IntPtr, int, IntPtr, IntPtr*, int>)Com.Slot(services, 20))(services, language, query, 0x20 | 0x10, IntPtr.Zero, &result), "ExecQuery");
            return result;
        }));
        var list = new List<WmiObject>();
        try
        {
            while (true)
            {
                // IEnumWbemClassObject::Next (slot 4): one object, WBEM_INFINITE.
                IntPtr item; uint returned;
                int hr = ((delegate* unmanaged<IntPtr, int, uint, IntPtr*, uint*, int>)Com.Slot(enumerator, 4))(enumerator, -1, 1, &item, &returned);
                if (hr < 0) { foreach (var done in list) done.Dispose(); Com.Check(hr, "Next"); }
                if (returned == 0) break;
                list.Add(new WmiObject(item));
            }
        }
        finally { Com.Release(enumerator); }
        return list;
    }
    /// <summary>IWbemServices::GetObject (slot 6): a class by its name or an instance by its path.</summary>
    internal WmiObject Object(string path) => WithBstr(path, text =>
    {
        IntPtr result; Com.Check(((delegate* unmanaged<IntPtr, IntPtr, int, IntPtr, IntPtr*, IntPtr, int>)Com.Slot(services, 6))(services, text, 0, IntPtr.Zero, &result, IntPtr.Zero), "GetObject " + path);
        return new WmiObject(result);
    });
    /// <summary>IWbemServices::PutInstance (slot 14), WBEM_FLAG_UPDATE_ONLY.</summary>
    internal void Update(WmiObject instance) => Com.CheckWmi(((delegate* unmanaged<IntPtr, IntPtr, int, IntPtr, IntPtr, int>)Com.Slot(services, 14))(services, instance.Pointer, 1, IntPtr.Zero, IntPtr.Zero), "PutInstance");
    /// <summary>IWbemServices::DeleteInstance (slot 16).</summary>
    internal void Delete(string path) => WithBstr(path, text => { Com.CheckWmi(((delegate* unmanaged<IntPtr, IntPtr, int, IntPtr, IntPtr, int>)Com.Slot(services, 16))(services, text, 0, IntPtr.Zero, IntPtr.Zero), "DeleteInstance"); return 0; });
    /// <summary>
    /// IWbemServices::ExecMethod (slot 24) on an object path (a class for a
    /// static method), with the input values set by name. Every failure names
    /// the class and the step, for example "PS_DnsServerPrimaryZone Put
    /// ZoneFile"; a failed Put carries the parameter names of the method. With
    /// checkReturn, a nonzero ReturnValue of the output fails as 0x80041001 with
    /// that value as the provider code (the uint32 methods of
    /// root\Microsoft\Windows\DNS).
    /// </summary>
    internal void Call(string path, string className, string method, IReadOnlyDictionary<string, object?>? values = null, bool checkReturn = false)
    {
        WmiObject? input = null;
        long? returned = null;
        string call = className + " ExecMethod " + method;
        try
        {
            if (values is { Count: > 0 })
            {
                WmiObject definition;
                try { definition = Object(className); }
                catch (WmiException e) { throw new WmiException(className + " GetObject", e.HResult32) { SchemaStep = true }; }
                using (definition) input = definition.MethodInput(className, method);
                foreach (var pair in values)
                {
                    try { input.Put(pair.Key, pair.Value); }
                    catch (WmiException e) { throw new WmiException(className + " Put " + pair.Key, e.HResult32, signature: input.PropertyNames() is { } names ? method + "(" + names + ")" : null) { SchemaStep = true }; }
                }
            }
            WithBstr(path, target => WithBstr(method, name =>
            {
                IntPtr output = IntPtr.Zero;
                try
                {
                    Com.CheckWmi(((delegate* unmanaged<IntPtr, IntPtr, IntPtr, int, IntPtr, IntPtr, IntPtr*, IntPtr, int>)Com.Slot(services, 24))(services, target, name, 0, IntPtr.Zero, input?.Pointer ?? IntPtr.Zero, &output, IntPtr.Zero), call);
                    if (checkReturn && output != IntPtr.Zero)
                    {
                        using var result = new WmiObject(output); output = IntPtr.Zero;
                        try { returned = result.Number("ReturnValue"); } catch (WmiException) { returned = null; }
                    }
                }
                finally { Com.Release(output); }
                return 0;
            }));
        }
        finally { input?.Dispose(); }
        if (returned is long value && value != 0) throw new WmiException(call + " ReturnValue", unchecked((int)0x80041001), value);
    }
}

/// <summary>The SCM service DNS, read only, like DhcpService of the DHCP plugin.</summary>
internal static class DnsService
{
    internal enum Status { Missing, Stopped, Running }
    [StructLayout(LayoutKind.Sequential)] private struct ServiceStatus { public uint Type, CurrentState, ControlsAccepted, Win32ExitCode, ServiceSpecificExitCode, CheckPoint, WaitHint; }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenSCManagerW(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatus(IntPtr service, out ServiceStatus status);
    [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr handle);

    internal static Status State()
    {
        IntPtr manager = OpenSCManagerW(null, null, 0x0001); // SC_MANAGER_CONNECT
        if (manager == IntPtr.Zero) return Status.Missing;
        try
        {
            IntPtr service = OpenServiceW(manager, "DNS", 0x0004); // SERVICE_QUERY_STATUS
            if (service == IntPtr.Zero) return Status.Missing;
            try { return QueryServiceStatus(service, out var status) && status.CurrentState == 4 ? Status.Running : Status.Stopped; }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }
}

/// <summary>Small text helpers shared by the read and the changes.</summary>
internal static class DnsText
{
    /// <summary>A DNS name as the portal compares it: trimmed, without the trailing dot, lower case.</summary>
    internal static string Name(string? value) => (value ?? "").Trim().TrimEnd('.').ToLowerInvariant();
    /// <summary>The quoted strings of a TXT record ("a" "b"), or the whole text as one string.</summary>
    internal static List<string> TxtStrings(string? text)
    {
        var value = (text ?? "").Trim(); var list = new List<string>();
        if (!value.StartsWith('"')) { if (value.Length > 0) list.Add(value); return list; }
        var current = new StringBuilder(); bool inside = false, escaped = false;
        foreach (char c in value)
        {
            if (inside)
            {
                if (escaped) { current.Append(c); escaped = false; }
                else if (c == '\\') escaped = true;
                else if (c == '"') { list.Add(current.ToString()); current.Clear(); inside = false; }
                else current.Append(c);
            }
            else if (c == '"') inside = true;
        }
        return list;
    }
    /// <summary>The TXT strings as DNS text: each quoted, quotes and backslashes escaped.</summary>
    internal static string TxtText(IEnumerable<string> strings) => string.Join(" ", strings.Select(item => "\"" + item.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal) + "\""));
}
