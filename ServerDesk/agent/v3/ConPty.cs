using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Channels;
using Microsoft.Win32.SafeHandles;

namespace ServerDesk.Agent;

/// <summary>
/// One persistent Windows console process. The transport must forward Output bytes unchanged:
/// ConPTY emits UTF-8 and VT sequences, and a read boundary need not be a character boundary.
/// Event handlers run synchronously on the reader/exit thread and must only enqueue work.
/// </summary>
public sealed class ConPty : IAsyncDisposable
{
    private const int MaxInputBytes = 64 * 1024;
    private const int MaxStartupBytes = 256 * 1024;
    private readonly object _lifetime = new();
    private readonly object _outputLock = new();
    private readonly object _exitLock = new();
    private readonly Queue<byte[]> _startupOutput = new();
    private readonly Channel<WriteRequest> _input = Channel.CreateBounded<WriteRequest>(
        new BoundedChannelOptions(32) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
    private Action<byte[]>? _output;
    private Action<int>? _exited;
    private int _startupBytes;
    private int? _exitCode;
    private int _hasExited;
    private int _disposeRequested;
    private IntPtr _pseudoConsole;
    private SafeFileHandle? _inputWrite;
    private SafeFileHandle? _outputRead;
    private SafeNativeHandle? _process;
    private SafeNativeHandle? _job;
    private SafeNativeHandle? _writerThread;
    private Task _reader = Task.CompletedTask;
    private Task _writer = Task.CompletedTask;
    private Task _waiter = Task.CompletedTask;
    private Task? _dispose;

    /// <summary>Receives ordered binary console frames. Startup output is retained until subscribed.</summary>
    public event Action<byte[]> Output
    {
        add
        {
            ArgumentNullException.ThrowIfNull(value);
            lock (_outputLock)
            {
                _output += value;
                while (_startupOutput.TryDequeue(out var bytes)) InvokeOutput(bytes);
                _startupBytes = 0;
            }
        }
        remove { lock (_outputLock) _output -= value; }
    }

    /// <summary>The root shell exited; disposing also kills any remaining descendants.</summary>
    public event Action<int> Exited
    {
        add
        {
            ArgumentNullException.ThrowIfNull(value);
            lock (_exitLock)
            {
                _exited += value;
                if (_exitCode is int code) InvokeExit(value, code);
            }
        }
        remove { lock (_exitLock) _exited -= value; }
    }

    public bool HasExited => Volatile.Read(ref _hasExited) != 0;

    /// <param name="exe">Absolute executable path, without command-line arguments.</param>
    public ConPty(string exe, string cwd, short cols, short rows, params string[] arguments)
    {
        if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess)
            throw new PlatformNotSupportedException("ConPTY requires a 64-bit Windows process.");
        ArgumentException.ThrowIfNullOrWhiteSpace(exe);
        ArgumentException.ThrowIfNullOrWhiteSpace(cwd);
        if (!Path.IsPathFullyQualified(exe) || !File.Exists(exe) || exe.Contains('"'))
            throw new ArgumentException("A local, absolute executable path is required.", nameof(exe));
        if (!Path.IsPathFullyQualified(cwd) || !Directory.Exists(cwd))
            throw new ArgumentException("A local, absolute working directory is required.", nameof(cwd));
        ValidateSize(cols, rows);

        SafeFileHandle? inputRead = null;
        SafeFileHandle? outputWrite = null;
        SafeNativeHandle? primaryThread = null;
        try
        {
            try
            {
                _job = Native.CreateJobObjectW(IntPtr.Zero, null);
                CheckHandle(_job, "CreateJobObject");
                var limits = new Native.JobObjectExtendedLimitInformation
                {
                    BasicLimitInformation = new Native.JobObjectBasicLimitInformation
                    {
                        // No BREAKAWAY flags: grandchildren remain in this job.
                        LimitFlags = Native.JobObjectLimitKillOnJobClose
                    }
                };
                Check(Native.SetInformationJobObject(_job, 9, ref limits,
                    (uint)Marshal.SizeOf<Native.JobObjectExtendedLimitInformation>()), "SetInformationJobObject");
                Check(Native.CreatePipe(out inputRead, out var inputWrite, IntPtr.Zero, 0), "CreatePipe(input)");
                _inputWrite = inputWrite;
                Check(Native.CreatePipe(out var outputRead, out outputWrite, IntPtr.Zero, 0), "CreatePipe(output)");
                _outputRead = outputRead;
                ThrowHResult(Native.CreatePseudoConsole(new Native.Coord(cols, rows), inputRead,
                    outputWrite, 0, out _pseudoConsole));

                // Drain before process startup and keep draining until ClosePseudoConsole finishes.
                // ClosePseudoConsole can synchronously emit a last frame on Server 2022.
                _reader = StartThread(ReadOutput);
                using var attributes = new ProcessAttributes(_pseudoConsole);
                var startup = new Native.StartupInfoEx
                {
                    StartupInfo = new Native.StartupInfo { cb = (uint)Marshal.SizeOf<Native.StartupInfoEx>() },
                    AttributeList = attributes.Pointer
                };
                var command = new StringBuilder('"' + exe + '"');
                foreach (string argument in arguments)
                {
                    // Arguments are fixed host switches; user terminal text goes only
                    // through the console pipe and can never alter process startup.
                    if (argument != "--terminal-host") throw new ArgumentException("Unsupported console host argument.", nameof(arguments));
                    command.Append(' ').Append(argument);
                }
                Check(Native.CreateProcessW(exe, command, IntPtr.Zero, IntPtr.Zero, false,
                    Native.ExtendedStartupInfoPresent | Native.CreateSuspended,
                    IntPtr.Zero, cwd, ref startup, out var information), "CreateProcess");
                _process = new SafeNativeHandle(information.Process, true);
                primaryThread = new SafeNativeHandle(information.Thread, true);
                // Assign while suspended; the shell must not spawn an unowned child in between.
                Check(Native.AssignProcessToJobObject(_job, _process), "AssignProcessToJobObject");
                _writer = StartThread(WriteInput);
                _waiter = StartThread(WaitForExit);
                if (Native.ResumeThread(primaryThread) == uint.MaxValue)
                    throw Win32("ResumeThread");
            }
            finally
            {
                primaryThread?.Dispose();
                // The pseudo console owns its copies. Retaining these would hide broken pipes.
                inputRead?.Dispose();
                outputWrite?.Dispose();
            }
        }
        catch
        {
            // Also handles an unassigned, suspended process when job assignment failed.
            DisposeAsync().AsTask().GetAwaiter().GetResult();
            throw;
        }
    }

    /// <summary>
    /// Serializes a bounded binary input frame. Cancellation is honored before the writer starts.
    /// Once writing starts, completion is awaited even if the caller cancels: acknowledging an
    /// uncertain input frame and retrying it could execute the same command twice.
    /// </summary>
    public async Task WriteAsync(byte[] input, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(input);
        cancellationToken.ThrowIfCancellationRequested();
        ThrowIfClosed();
        if (input.Length > MaxInputBytes)
            throw new ArgumentOutOfRangeException(nameof(input), "Input frames may not exceed 64 KiB.");
        if (input.Length == 0) return;
        var request = new WriteRequest(input.ToArray(), cancellationToken);
        try { await _input.Writer.WriteAsync(request, cancellationToken).ConfigureAwait(false); }
        catch (ChannelClosedException) { throw new ObjectDisposedException(nameof(ConPty)); }
        await request.Completed.Task.ConfigureAwait(false);
    }

    public void Resize(short cols, short rows)
    {
        ValidateSize(cols, rows);
        lock (_lifetime)
        {
            ThrowIfClosed();
            ThrowHResult(Native.ResizePseudoConsole(_pseudoConsole, new Native.Coord(cols, rows)));
        }
    }

    public ValueTask DisposeAsync()
    {
        lock (_lifetime)
        {
            if (_dispose is null)
            {
                Volatile.Write(ref _disposeRequested, 1);
                _input.Writer.TryComplete();
                _dispose = Task.Run(DisposeCoreAsync);
            }
            return new ValueTask(_dispose);
        }
    }

    private async Task DisposeCoreAsync()
    {
        IntPtr pseudoConsole;
        lock (_lifetime)
        {
            pseudoConsole = _pseudoConsole;
            _pseudoConsole = IntPtr.Zero;
        }

        // Closing the only non-inheritable job handle kills every descendant, even a detached one.
        _job?.Dispose();
        if (_process is { IsInvalid: false, IsClosed: false })
        {
            // Required if CreateProcess succeeded but AssignProcessToJobObject failed.
            Native.TerminateProcess(_process, 1);
        }
        lock (_lifetime)
        {
            if (_writerThread is { IsInvalid: false, IsClosed: false })
                Native.CancelSynchronousIo(_writerThread);
        }

        if (pseudoConsole != IntPtr.Zero)
            await StartThread(() => Native.ClosePseudoConsole(pseudoConsole)).ConfigureAwait(false);

        // Do not close the output read end first: the final frame must be drained during close.
        _inputWrite?.Dispose();
        await _writer.ConfigureAwait(false);
        await _reader.ConfigureAwait(false);
        await _waiter.ConfigureAwait(false);
        _outputRead?.Dispose();
        _process?.Dispose();
        lock (_outputLock)
        {
            _startupOutput.Clear();
            _startupBytes = 0;
        }
        Volatile.Write(ref _hasExited, 1);
    }

    private void ReadOutput()
    {
        var buffer = new byte[16 * 1024];
        try
        {
            while (_outputRead is { IsInvalid: false, IsClosed: false })
            {
                if (!Native.ReadFile(_outputRead, buffer, (uint)buffer.Length, out var count, IntPtr.Zero))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (!IsClosedPipe(error))
                        System.Diagnostics.Trace.TraceError("ConPTY output stopped: Win32 {0}.", error);
                    break;
                }
                if (count == 0) break;
                var bytes = buffer.AsSpan(0, (int)count).ToArray();
                var overflow = false;
                lock (_outputLock)
                {
                    if (_output is not null) InvokeOutput(bytes);
                    else if (_startupBytes + bytes.Length <= MaxStartupBytes)
                    {
                        _startupOutput.Enqueue(bytes);
                        _startupBytes += bytes.Length;
                    }
                    else overflow = true;
                }
                // Never grow an unobserved console without bounds or drop an interior UTF-8/VT frame.
                if (overflow) _ = DisposeAsync();
            }
        }
        finally
        {
            // An unexpected read failure must break the pipe so ClosePseudoConsole cannot wait
            // forever for a reader that no longer exists.
            _outputRead?.Dispose();
        }
    }

    private void WriteInput()
    {
        Exception? failure = null;
        try
        {
            lock (_lifetime)
            {
                _writerThread = Native.OpenThread(Native.ThreadTerminate, false, Native.GetCurrentThreadId());
                CheckHandle(_writerThread, "OpenThread(writer)");
            }
            while (_input.Reader.WaitToReadAsync().AsTask().GetAwaiter().GetResult())
            {
                while (_input.Reader.TryRead(out var request))
                {
                    if (Volatile.Read(ref _disposeRequested) != 0)
                    {
                        request.Completed.TrySetException(new ObjectDisposedException(nameof(ConPty)));
                        continue;
                    }
                    if (request.Cancellation.IsCancellationRequested)
                    {
                        request.Completed.TrySetCanceled(request.Cancellation);
                        continue;
                    }
                    var pinned = GCHandle.Alloc(request.Bytes, GCHandleType.Pinned);
                    try
                    {
                        var offset = 0;
                        while (offset < request.Bytes.Length)
                        {
                            if (Volatile.Read(ref _disposeRequested) != 0)
                                throw new ObjectDisposedException(nameof(ConPty));
                            if (_inputWrite is null || !Native.WriteFile(_inputWrite,
                                IntPtr.Add(pinned.AddrOfPinnedObject(), offset),
                                (uint)(request.Bytes.Length - offset), out var written, IntPtr.Zero))
                                throw Win32("WriteFile(ConPTY input)");
                            if (written == 0) throw new IOException("The console input pipe accepted no bytes.");
                            offset += (int)written;
                        }
                        request.Completed.TrySetResult();
                    }
                    catch (Exception ex)
                    {
                        request.Completed.TrySetException(ex);
                        throw;
                    }
                    finally { pinned.Free(); }
                }
            }
        }
        catch (Exception ex)
        {
            failure = ex;
            if (Volatile.Read(ref _disposeRequested) == 0) _ = DisposeAsync();
        }
        finally
        {
            _input.Writer.TryComplete(failure);
            while (_input.Reader.TryRead(out var request))
                request.Completed.TrySetException(failure ?? new ObjectDisposedException(nameof(ConPty)));
            lock (_lifetime)
            {
                _writerThread?.Dispose();
                _writerThread = null;
            }
        }
    }

    private void WaitForExit()
    {
        var code = 1;
        if (_process is { IsInvalid: false, IsClosed: false } &&
            Native.WaitForSingleObject(_process, uint.MaxValue) == Native.WaitObject0 &&
            Native.GetExitCodeProcess(_process, out var nativeCode))
            code = unchecked((int)nativeCode);
        Volatile.Write(ref _hasExited, 1);
        lock (_exitLock)
        {
            _exitCode = code;
            if (_exited is not null)
                foreach (Action<int> callback in _exited.GetInvocationList()) InvokeExit(callback, code);
        }
    }

    private void InvokeOutput(byte[] bytes)
    {
        if (_output is null) return;
        foreach (Action<byte[]> callback in _output.GetInvocationList())
        {
            try { callback(bytes); }
            catch (Exception ex) { System.Diagnostics.Trace.TraceError("ConPTY output subscriber failed: {0}.", ex.GetType().Name); }
        }
    }

    private static void InvokeExit(Action<int> callback, int code)
    {
        try { callback(code); }
        catch (Exception ex) { System.Diagnostics.Trace.TraceError("ConPTY exit subscriber failed: {0}.", ex.GetType().Name); }
    }

    private void ThrowIfClosed()
    {
        if (Volatile.Read(ref _disposeRequested) != 0 || HasExited)
            throw new ObjectDisposedException(nameof(ConPty));
    }

    private static void ValidateSize(short cols, short rows)
    {
        if (cols is < 1 or > 1000 || rows is < 1 or > 1000)
            throw new ArgumentOutOfRangeException(nameof(cols), "Console dimensions must be 1–1000 cells.");
    }

    private static bool IsClosedPipe(int code) => code is 6 or 109 or 232 or 995;
    private static Task StartThread(Action action) => Task.Factory.StartNew(action,
        CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    private static void Check(bool succeeded, string operation)
    {
        if (!succeeded) throw Win32(operation);
    }
    private static void CheckHandle(SafeHandle handle, string operation)
    {
        if (handle.IsInvalid) throw Win32(operation);
    }
    private static Win32Exception Win32(string operation) => new(Marshal.GetLastWin32Error(), operation);
    private static void ThrowHResult(int result)
    {
        if (result < 0) Marshal.ThrowExceptionForHR(result);
    }

    private sealed record WriteRequest(byte[] Bytes, CancellationToken Cancellation)
    {
        public TaskCompletionSource Completed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private sealed class ProcessAttributes : IDisposable
    {
        public IntPtr Pointer { get; private set; }
        private bool _initialized;

        public ProcessAttributes(IntPtr pseudoConsole)
        {
            nuint size = 0;
            Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            if (size == 0 || size > int.MaxValue) throw Win32("Size process attributes");
            Pointer = Marshal.AllocHGlobal((int)size);
            try
            {
                Check(Native.InitializeProcThreadAttributeList(Pointer, 1, 0, ref size), "Initialize process attributes");
                _initialized = true;
                // The PSEUDOCONSOLE attribute takes the HPCON itself, not a pointer to HPCON.
                Check(Native.UpdateProcThreadAttribute(Pointer, 0, Native.ProcThreadAttributePseudoConsole,
                    pseudoConsole, (nuint)IntPtr.Size, IntPtr.Zero, IntPtr.Zero), "Set pseudo console attribute");
            }
            catch { Dispose(); throw; }
        }

        public void Dispose()
        {
            if (Pointer == IntPtr.Zero) return;
            if (_initialized) Native.DeleteProcThreadAttributeList(Pointer);
            Marshal.FreeHGlobal(Pointer);
            Pointer = IntPtr.Zero;
        }
    }

    private sealed class SafeNativeHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        public SafeNativeHandle() : base(true) { }
        public SafeNativeHandle(IntPtr handle, bool ownsHandle) : base(ownsHandle) => SetHandle(handle);
        protected override bool ReleaseHandle() => Native.CloseHandle(handle);
    }

    private static class Native
    {
        internal const uint ExtendedStartupInfoPresent = 0x00080000;
        internal const uint CreateSuspended = 0x00000004;
        internal const uint JobObjectLimitKillOnJobClose = 0x00002000;
        internal const uint ThreadTerminate = 0x00000001;
        internal const uint WaitObject0 = 0;
        internal static readonly nuint ProcThreadAttributePseudoConsole = 0x00020016;

        [StructLayout(LayoutKind.Sequential)]
        internal readonly struct Coord(short x, short y) { public readonly short X = x; public readonly short Y = y; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct StartupInfo
        {
            public uint cb;
            public string? Reserved, Desktop, Title;
            public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
            public ushort ShowWindow, Reserved2Size;
            public IntPtr Reserved2, StandardInput, StandardOutput, StandardError;
        }
        [StructLayout(LayoutKind.Sequential)]
        internal struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr AttributeList; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public nuint MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public nuint Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        internal struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public nuint ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, IntPtr security, uint size);
        [DllImport("kernel32.dll")]
        internal static extern int CreatePseudoConsole(Coord size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr pseudoConsole);
        [DllImport("kernel32.dll")]
        internal static extern int ResizePseudoConsole(IntPtr pseudoConsole, Coord size);
        [DllImport("kernel32.dll")]
        internal static extern void ClosePseudoConsole(IntPtr pseudoConsole);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref nuint bytes);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, nuint attribute, IntPtr value, nuint size, IntPtr previousValue, IntPtr returnSize);
        [DllImport("kernel32.dll")]
        internal static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes,
            IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags,
            IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation information);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint ResumeThread(SafeNativeHandle thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ReadFile(SafeFileHandle file, [Out] byte[] buffer, uint count, out uint read, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool WriteFile(SafeFileHandle file, IntPtr buffer, uint count, out uint written, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern SafeNativeHandle OpenThread(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint threadId);
        [DllImport("kernel32.dll")]
        internal static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CancelSynchronousIo(SafeNativeHandle thread);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern SafeNativeHandle CreateJobObjectW(IntPtr attributes, string? name);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetInformationJobObject(SafeNativeHandle job, int informationClass,
            ref JobObjectExtendedLimitInformation information, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool AssignProcessToJobObject(SafeNativeHandle job, SafeNativeHandle process);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool TerminateProcess(SafeNativeHandle process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(SafeNativeHandle handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetExitCodeProcess(SafeNativeHandle process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);
    }
}
