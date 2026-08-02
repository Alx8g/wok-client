import {
	spawn,
	type ChildProcess
} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
	closeSync,
	fsyncSync,
	openSync,
	unlinkSync,
	writeSync
} from 'node:fs';
import {
	open,
	unlink
} from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import {
	dirname,
	isAbsolute,
	join
} from 'node:path';
import {
	buildWindowsCommandLine,
	type WindowsProcessLifetimeIdentity
} from './windows-job.ts';

export interface VerifiedWindowsExecutable {
	path: string;
	sha256: string;
	sizeBytes: number;
}

export interface VerifiedWindowsToolProcessOptions {
	arguments: readonly string[];
	controlDirectory: string;
	cwd?: string;
	environment?: NodeJS.ProcessEnv;
	executable: VerifiedWindowsExecutable;
	stdin?: 'ignore' | 'pipe';
	testOnlyFailAfterAssignmentBeforeResume?: boolean;
	testOnlyFailAssignmentBeforeResume?: boolean;
	testOnlyHangBeforeFailureCleanup?: boolean;
	testOnlyProtocolToken?: string;
	testOnlyRejectedStartCleanupTimeoutMs?: number;
	windowsHide?: boolean;
}

export interface VerifiedWindowsToolProcess {
	child: ChildProcess;
	controlPath: string;
	started: Promise<WindowsProcessLifetimeIdentity>;
}

const WINDOWS_TOOL_HOST_SOURCE = `
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class WokVerifiedToolHost
{
    private const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint INFINITE = 0xffffffff;
    private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const long PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint STD_ERROR_HANDLE = 0xfffffff4;
    private const uint STD_INPUT_HANDLE = 0xfffffff6;
    private const uint STD_OUTPUT_HANDLE = 0xfffffff5;
    private const uint WAIT_FAILED = 0xffffffff;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public FILETIME CreationTime;
        public FILETIME LastAccessTime;
        public FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public long Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private sealed class ExecutableIdentity
    {
        public string FileIdHex { get; set; }
        public string FinalPath { get; set; }
        public string Sha256 { get; set; }
        public long SizeBytes { get; set; }
        public string VolumeSerialNumberHex { get; set; }
    }

    private sealed class ExecutableLease : IDisposable
    {
        public ExecutableLease(FileStream stream, ExecutableIdentity identity)
        {
            Stream = stream;
            Identity = identity;
        }

        public ExecutableIdentity Identity { get; private set; }
        public FileStream Stream { get; private set; }

        public void Dispose()
        {
            if (Stream == null) return;
            Stream.Dispose();
            Stream = null;
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(
        IntPtr jobAttributes,
        string name
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        out uint returnLength
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize
    );

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(
        IntPtr attributeList
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(
        IntPtr job,
        IntPtr process
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(
        IntPtr handle,
        uint milliseconds
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(
        IntPtr process,
        out uint exitCode
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(
        IntPtr process,
        uint flags,
        StringBuilder executablePath,
        ref uint size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(
        IntPtr process,
        out FILETIME creation,
        out FILETIME exit,
        out FILETIME kernel,
        out FILETIME user
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        IntPtr file,
        out BY_HANDLE_FILE_INFORMATION information
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        IntPtr file,
        StringBuilder path,
        uint pathLength,
        uint flags
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(uint standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(
        IntPtr handle,
        uint mask,
        uint flags
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(
        IntPtr job,
        uint exitCode
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(
        IntPtr process,
        uint exitCode
    );

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private static long ToRawTicks(FILETIME value)
    {
        return ((long)value.High << 32) | value.Low;
    }

    private static long ToIdentityTicks(FILETIME value)
    {
        long ticks = DateTime.FromFileTimeUtc(
            ToRawTicks(value)
        ).Ticks;
        return ticks - (ticks % 10);
    }

    private static string Encode(string value)
    {
        return Convert.ToBase64String(
            Encoding.UTF8.GetBytes(value)
        );
    }

    private static FileStream CreateControlLease(
        string path,
        string protocolToken,
        uint processId,
        long creationTimeUtcTicks,
        string actualPath,
        ExecutableIdentity executable
    )
    {
        if (
            String.IsNullOrEmpty(protocolToken)
            || protocolToken.Length != 32
        )
        {
            throw new InvalidOperationException(
                "Verified tool protocol token is invalid."
            );
        }
        foreach (char character in protocolToken)
        {
            bool accepted = character >= '0' && character <= '9'
                || character >= 'a' && character <= 'f';
            if (!accepted)
            {
                throw new InvalidOperationException(
                    "Verified tool protocol token is not canonical."
                );
            }
        }
        var stream = new FileStream(
            path,
            FileMode.CreateNew,
            FileAccess.ReadWrite,
            FileShare.Read,
            4096,
            FileOptions.WriteThrough
        );
        try
        {
            string record = "WOK_VERIFIED_TOOL_START|"
                + protocolToken
                + "|" + processId
                + "|" + creationTimeUtcTicks
                + "|" + Encode(actualPath)
                + "|" + Encode(executable.FinalPath)
                + "|" + executable.FileIdHex
                + "|" + executable.Sha256
                + "|" + executable.SizeBytes
                + "|" + executable.VolumeSerialNumberHex
                + "\\r\\n";
            byte[] bytes = Encoding.UTF8.GetBytes(record);
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(true);
            stream.Position = 0;
            return stream;
        }
        catch
        {
            stream.Dispose();
            throw;
        }
    }

    private static bool SameBytes(byte[] left, byte[] right)
    {
        if (left.Length != right.Length) return false;
        for (int index = 0; index < left.Length; index += 1)
        {
            if (left[index] != right[index]) return false;
        }
        return true;
    }

    private static void WaitForControlDecision(
        string path,
        string protocolToken
    )
    {
        byte[] acceptedBytes = Encoding.UTF8.GetBytes(
            "WOK_VERIFIED_TOOL_ACCEPT|"
                + protocolToken
                + "\\r\\n"
        );
        byte[] rejectedBytes = Encoding.UTF8.GetBytes(
            "WOK_VERIFIED_TOOL_REJECT|"
                + protocolToken
                + "\\r\\n"
        );
        var guard = Stopwatch.StartNew();
        while (guard.ElapsedMilliseconds < 45000)
        {
            try
            {
                bool accepted;
                using (var stream = new FileStream(
                    path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.None
                ))
                {
                    if (
                        stream.Length != acceptedBytes.Length
                        && stream.Length != rejectedBytes.Length
                    )
                    {
                        throw new InvalidOperationException(
                            "Verified tool controller decision has an invalid size."
                        );
                    }
                    var observed = new byte[checked((int)stream.Length)];
                    int offset = 0;
                    while (offset < observed.Length)
                    {
                        int count = stream.Read(
                            observed,
                            offset,
                            observed.Length - offset
                        );
                        if (count <= 0)
                        {
                            throw new EndOfStreamException(
                                "Verified tool controller decision ended early."
                            );
                        }
                        offset += count;
                    }
                    if (stream.ReadByte() != -1)
                    {
                        throw new InvalidOperationException(
                            "Verified tool controller decision contains trailing bytes."
                        );
                    }
                    accepted = SameBytes(observed, acceptedBytes);
                    if (!accepted && !SameBytes(observed, rejectedBytes))
                    {
                        throw new InvalidOperationException(
                            "Verified tool controller decision is invalid."
                        );
                    }
                }
                File.Delete(path);
                if (!accepted)
                {
                    throw new InvalidOperationException(
                        "Verified tool launch was rejected by the controller."
                    );
                }
                return;
            }
            catch (FileNotFoundException)
            {
                Thread.Sleep(10);
            }
            catch (DirectoryNotFoundException)
            {
                Thread.Sleep(10);
            }
            catch (IOException error)
            {
                int errorCode = error.HResult & 0xffff;
                if (errorCode == 32 || errorCode == 33)
                {
                    Thread.Sleep(10);
                    continue;
                }
                throw new InvalidOperationException(
                    "Verified tool controller decision could not be read exactly.",
                    error
                );
            }
        }
        throw new TimeoutException(
            "Verified tool host timed out waiting for a controller decision."
        );
    }

    private static long FileSize(BY_HANDLE_FILE_INFORMATION information)
    {
        ulong size = ((ulong)information.FileSizeHigh << 32)
            | information.FileSizeLow;
        if (size > long.MaxValue)
        {
            throw new InvalidOperationException(
                "Executable size exceeds the supported range."
            );
        }
        return checked((long)size);
    }

    private static BY_HANDLE_FILE_INFORMATION FileInformation(IntPtr file)
    {
        BY_HANDLE_FILE_INFORMATION information;
        if (!GetFileInformationByHandle(file, out information))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return information;
    }

    private static string FinalFilePath(IntPtr file)
    {
        var path = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(
            file,
            path,
            checked((uint)path.Capacity),
            1
        );
        if (length == 0)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        if (length >= path.Capacity)
        {
            throw new InvalidOperationException(
                "Executable final path exceeds the supported range."
            );
        }
        return path.ToString();
    }

    private static string HashHex(Stream stream)
    {
        stream.Position = 0;
        byte[] digest;
        using (var hash = SHA256.Create())
        {
            digest = hash.ComputeHash(stream);
        }
        var result = new StringBuilder(digest.Length * 2);
        foreach (byte value in digest)
        {
            result.Append(value.ToString("x2"));
        }
        return result.ToString();
    }

    private static ExecutableIdentity InspectExecutable(
        FileStream stream,
        string sha256
    )
    {
        SafeFileHandle safeHandle = stream.SafeFileHandle;
        IntPtr handle = safeHandle.DangerousGetHandle();
        BY_HANDLE_FILE_INFORMATION information = FileInformation(handle);
        return new ExecutableIdentity
        {
            FileIdHex = information.FileIndexHigh.ToString("x8")
                + information.FileIndexLow.ToString("x8"),
            FinalPath = FinalFilePath(handle),
            Sha256 = sha256,
            SizeBytes = FileSize(information),
            VolumeSerialNumberHex =
                information.VolumeSerialNumber.ToString("x8")
        };
    }

    private static bool SameFileObject(
        ExecutableIdentity left,
        ExecutableIdentity right
    )
    {
        return left.FileIdHex == right.FileIdHex
            && left.SizeBytes == right.SizeBytes
            && left.VolumeSerialNumberHex == right.VolumeSerialNumberHex;
    }

    private static ExecutableLease AcquireExecutableLease(
        string path,
        string expectedSha256,
        long expectedSizeBytes
    )
    {
        if (
            expectedSha256 == null
            || expectedSha256.Length != 64
            || expectedSizeBytes <= 0
        )
        {
            throw new InvalidOperationException(
                "Expected executable identity is invalid."
            );
        }
        foreach (char character in expectedSha256)
        {
            bool accepted = character >= '0' && character <= '9'
                || character >= 'a' && character <= 'f';
            if (!accepted)
            {
                throw new InvalidOperationException(
                    "Expected executable SHA-256 is not canonical."
                );
            }
        }
        var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read
        );
        try
        {
            ExecutableIdentity before = InspectExecutable(
                stream,
                string.Empty
            );
            string sha256 = HashHex(stream);
            ExecutableIdentity after = InspectExecutable(stream, sha256);
            if (
                !SameFileObject(before, after)
                || after.SizeBytes != expectedSizeBytes
                || !String.Equals(
                    after.Sha256,
                    expectedSha256,
                    StringComparison.Ordinal
                )
            )
            {
                throw new InvalidOperationException(
                    "Executable bytes changed or did not match the verified identity."
                );
            }
            return new ExecutableLease(stream, after);
        }
        catch
        {
            stream.Dispose();
            throw;
        }
    }

    private static void VerifyProcessImage(
        string actualPath,
        ExecutableIdentity expected
    )
    {
        using (var stream = new FileStream(
            actualPath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read
        ))
        {
            ExecutableIdentity actual = InspectExecutable(
                stream,
                string.Empty
            );
            if (!SameFileObject(actual, expected))
            {
                throw new InvalidOperationException(
                    "Launched process image does not match the retained executable."
                );
            }
        }
    }

    private static bool ConfigureJob(IntPtr job)
    {
        var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.ActiveProcessLimit = 1;
        information.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(
            typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)
        );
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, buffer, false);
            return SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                buffer,
                checked((uint)size)
            );
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static uint ActiveJobProcessCount(IntPtr job)
    {
        int size = Marshal.SizeOf(
            typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
        );
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            uint returnLength;
            if (!QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                buffer,
                checked((uint)size),
                out returnLength
            ))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error()
                );
            }
            if (returnLength != size)
            {
                throw new InvalidOperationException(
                    "Verified tool Job accounting evidence has an invalid size."
                );
            }
            var information =
                (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
                    Marshal.PtrToStructure(
                        buffer,
                        typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
                    );
            return information.ActiveProcesses;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static bool WaitForJobEmpty(
        IntPtr job,
        int timeoutMilliseconds
    )
    {
        var guard = Stopwatch.StartNew();
        do
        {
            if (ActiveJobProcessCount(job) == 0) return true;
            Thread.Sleep(10);
        }
        while (guard.ElapsedMilliseconds < timeoutMilliseconds);
        return ActiveJobProcessCount(job) == 0;
    }

    private static IntPtr InheritableStandardHandle(uint kind)
    {
        IntPtr handle = GetStdHandle(kind);
        if (
            handle == IntPtr.Zero
            || handle == new IntPtr(-1)
            || !SetHandleInformation(
                handle,
                HANDLE_FLAG_INHERIT,
                HANDLE_FLAG_INHERIT
            )
        )
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return handle;
    }

    private static bool TryCreateSuspended(
        string executablePath,
        string commandLine,
        string currentDirectory,
        uint creationFlags,
        out PROCESS_INFORMATION processInformation,
        out int createError
    )
    {
        IntPtr attributeList = IntPtr.Zero;
        IntPtr handleList = IntPtr.Zero;
        bool attributeListInitialized = false;
        processInformation = new PROCESS_INFORMATION();
        createError = 0;
        try
        {
            IntPtr standardInput =
                InheritableStandardHandle(STD_INPUT_HANDLE);
            IntPtr standardOutput =
                InheritableStandardHandle(STD_OUTPUT_HANDLE);
            IntPtr standardError =
                InheritableStandardHandle(STD_ERROR_HANDLE);
            IntPtr attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(
                IntPtr.Zero,
                1,
                0,
                ref attributeListSize
            );
            if (attributeListSize == IntPtr.Zero)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error()
                );
            }
            attributeList = Marshal.AllocHGlobal(
                attributeListSize
            );
            if (!InitializeProcThreadAttributeList(
                attributeList,
                1,
                0,
                ref attributeListSize
            ))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error()
                );
            }
            attributeListInitialized = true;
            int handleListSize = checked(IntPtr.Size * 3);
            handleList = Marshal.AllocHGlobal(handleListSize);
            Marshal.WriteIntPtr(
                handleList,
                0,
                standardInput
            );
            Marshal.WriteIntPtr(
                handleList,
                IntPtr.Size,
                standardOutput
            );
            Marshal.WriteIntPtr(
                handleList,
                IntPtr.Size * 2,
                standardError
            );
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST),
                handleList,
                new IntPtr(handleListSize),
                IntPtr.Zero,
                IntPtr.Zero
            ))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error()
                );
            }
            var startupInfo = new STARTUPINFOEX();
            startupInfo.StartupInfo.cb = checked(
                (uint)Marshal.SizeOf(typeof(STARTUPINFOEX))
            );
            startupInfo.StartupInfo.dwFlags =
                STARTF_USESTDHANDLES;
            startupInfo.StartupInfo.hStdInput = standardInput;
            startupInfo.StartupInfo.hStdOutput = standardOutput;
            startupInfo.StartupInfo.hStdError = standardError;
            startupInfo.AttributeList = attributeList;
            bool created = CreateProcessW(
                executablePath,
                new StringBuilder(commandLine),
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                creationFlags | EXTENDED_STARTUPINFO_PRESENT,
                IntPtr.Zero,
                currentDirectory,
                ref startupInfo,
                out processInformation
            );
            if (!created)
            {
                createError = Marshal.GetLastWin32Error();
            }
            return created;
        }
        finally
        {
            if (attributeListInitialized)
            {
                DeleteProcThreadAttributeList(attributeList);
            }
            if (handleList != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(handleList);
            }
            if (attributeList != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(attributeList);
            }
        }
    }

    public static int Run(
        string executablePath,
        string expectedExecutableSha256,
        long expectedExecutableSizeBytes,
        string commandLine,
        string currentDirectory,
        string controlPath,
        string controlAcceptPath,
        string protocolToken,
        bool testOnlyFailAfterAssignmentBeforeResume,
        bool testOnlyFailAssignmentBeforeResume,
        bool testOnlyHangBeforeFailureCleanup
    )
    {
        IntPtr job = IntPtr.Zero;
        FileStream controlLease = null;
        ExecutableLease executableLease = null;
        var processInformation = new PROCESS_INFORMATION();
        bool assignedToJob = false;
        bool childCompleted = false;
        bool cleanupFailed = false;
        int result = 240;
        string stage = "create-job";
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            stage = "configure-job";
            if (!ConfigureJob(job))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            stage = "acquire-executable";
            executableLease = AcquireExecutableLease(
                executablePath,
                expectedExecutableSha256,
                expectedExecutableSizeBytes
            );

            stage = "create-process";
            uint baseFlags = CREATE_SUSPENDED | CREATE_NO_WINDOW;
            int firstError;
            if (!TryCreateSuspended(
                executablePath,
                commandLine,
                currentDirectory,
                baseFlags | CREATE_BREAKAWAY_FROM_JOB,
                out processInformation,
                out firstError
            ))
            {
                int fallbackError;
                if (!TryCreateSuspended(
                    executablePath,
                    commandLine,
                    currentDirectory,
                    baseFlags,
                    out processInformation,
                    out fallbackError
                ))
                {
                    throw new InvalidOperationException(
                        "Both breakaway and inherited executable launches failed (breakaway="
                        + firstError + ", inherited=" + fallbackError + ").",
                        new Win32Exception(fallbackError)
                    );
                }
            }
            stage = "assign-job";
            if (
                testOnlyFailAssignmentBeforeResume
                || !AssignProcessToJobObject(
                    job,
                    processInformation.hProcess
                )
            )
            {
                throw new Win32Exception(
                    testOnlyFailAssignmentBeforeResume
                        ? 5
                        : Marshal.GetLastWin32Error()
                );
            }
            assignedToJob = true;
            if (testOnlyFailAfterAssignmentBeforeResume)
            {
                stage = "test-after-assignment";
                throw new InvalidOperationException(
                    "Test-only failure after Job assignment."
                );
            }

            stage = "query-process-image";
            var actualPath = new StringBuilder(32768);
            uint actualPathLength = checked((uint)actualPath.Capacity);
            if (!QueryFullProcessImageName(
                processInformation.hProcess,
                0,
                actualPath,
                ref actualPathLength
            ))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            stage = "verify-process-image";
            VerifyProcessImage(
                actualPath.ToString(),
                executableLease.Identity
            );
            stage = "query-process-lifetime";
            FILETIME creation;
            FILETIME exit;
            FILETIME kernel;
            FILETIME user;
            if (!GetProcessTimes(
                processInformation.hProcess,
                out creation,
                out exit,
                out kernel,
                out user
            ))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            stage = "publish-process-identity";
            string publishedProtocolToken =
                testOnlyHangBeforeFailureCleanup
                    ? new string(
                        protocolToken[0] == '0' ? '1' : '0',
                        protocolToken.Length
                    )
                    : protocolToken;
            controlLease = CreateControlLease(
                controlPath,
                publishedProtocolToken,
                processInformation.dwProcessId,
                ToIdentityTicks(creation),
                actualPath.ToString(),
                executableLease.Identity
            );
            stage = "wait-for-controller-decision";
            WaitForControlDecision(
                controlAcceptPath,
                protocolToken
            );
            stage = "resume-process";
            if (ResumeThread(processInformation.hThread) == 0xffffffff)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            CloseHandle(processInformation.hThread);
            processInformation.hThread = IntPtr.Zero;

            stage = "wait-for-process";
            uint waitStatus = WaitForSingleObject(
                processInformation.hProcess,
                INFINITE
            );
            if (waitStatus == WAIT_FAILED)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            stage = "read-exit-code";
            uint exitCode;
            if (!GetExitCodeProcess(
                processInformation.hProcess,
                out exitCode
            ))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            stage = "verify-job-empty";
            if (!WaitForJobEmpty(job, 5000))
            {
                throw new InvalidOperationException(
                    "Verified tool Job remained non-empty after tool exit."
                );
            }
            childCompleted = true;
            result = unchecked((int)exitCode);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(
                "WOK verified tool host failure at " + stage + ": "
                + error.ToString()
            );
            if (testOnlyHangBeforeFailureCleanup)
            {
                Thread.Sleep(Timeout.Infinite);
            }
        }
        finally
        {
            if (
                !childCompleted
                && processInformation.hProcess != IntPtr.Zero
            )
            {
                bool terminationStarted = assignedToJob
                    ? TerminateJobObject(job, 241)
                    : TerminateProcess(
                        processInformation.hProcess,
                        241
                    );
                if (!terminationStarted)
                {
                    cleanupFailed = true;
                    Console.Error.WriteLine(
                        "WOK verified tool cleanup could not start termination: "
                        + new Win32Exception(
                            Marshal.GetLastWin32Error()
                        ).ToString()
                    );
                }
                else if (
                    WaitForSingleObject(
                        processInformation.hProcess,
                        5000
                    ) != 0
                )
                {
                    cleanupFailed = true;
                    Console.Error.WriteLine(
                        "WOK verified tool cleanup did not confirm process termination."
                    );
                }
                else if (!WaitForJobEmpty(job, 5000))
                {
                    cleanupFailed = true;
                    Console.Error.WriteLine(
                        "WOK verified tool cleanup did not confirm an empty Job."
                    );
                }
            }
            if (processInformation.hThread != IntPtr.Zero)
            {
                CloseHandle(processInformation.hThread);
            }
            if (processInformation.hProcess != IntPtr.Zero)
            {
                CloseHandle(processInformation.hProcess);
            }
            if (job != IntPtr.Zero) CloseHandle(job);
            if (controlLease != null) controlLease.Dispose();
            if (executableLease != null) executableLease.Dispose();
        }
        return cleanupFailed ? 242 : result;
    }
}
`;

const WINDOWS_TOOL_HOST_SOURCE_GZIP_BASE64 = gzipSync(
	Buffer.from(WINDOWS_TOOL_HOST_SOURCE, 'utf8'),
	{ level: 9 }
).toString('base64');
const MAX_CONTROL_RECORD_BYTES = 16 * 1024;
const MAX_DOTNET_DATE_TIME_TICKS = 3_155_378_975_999_999_999n;
const VERIFIED_TOOL_START_TIMEOUT_MS = 30_000;
const VERIFIED_TOOL_REJECTED_START_CLEANUP_TIMEOUT_MS = 50_000;
const VERIFIED_TOOL_FORCED_HOST_TERMINATION_TIMEOUT_MS = 5_000;

function windowsPowerShellPath(environment: NodeJS.ProcessEnv): string {
	const systemRoot = environment.SystemRoot ?? environment.WINDIR;
	if (systemRoot === undefined || !isAbsolute(systemRoot)) {
		throw new Error(
			'SystemRoot must identify the absolute Windows installation directory.'
		);
	}
	return join(
		systemRoot,
		'System32',
		'WindowsPowerShell',
		'v1.0',
		'powershell.exe'
	);
}

function decodeControlText(value: string, field: string): string {
	if (
		value.length === 0
		|| value.length > 8_192
		|| !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
	) {
		throw new TypeError(`${field} is not canonical base64.`);
	}
	const bytes = Buffer.from(value, 'base64');
	if (bytes.toString('base64') !== value) {
		throw new TypeError(`${field} is not canonical base64.`);
	}
	const decoded = bytes.toString('utf8');
	if (
		!Buffer.from(decoded, 'utf8').equals(bytes)
		|| decoded.length === 0
		|| decoded.length > 4_096
		|| decoded.includes('\0')
	) {
		throw new TypeError(`${field} is not canonical bounded UTF-8.`);
	}
	return decoded;
}

function parsePositiveInteger(
	value: string,
	field: string,
	maximum: number
): number {
	if (!/^[1-9][0-9]*$/u.test(value)) {
		throw new TypeError(`${field} must be a positive integer.`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > maximum) {
		throw new TypeError(`${field} exceeds the supported range.`);
	}
	return parsed;
}

function parseControlRecord(
	bytes: Buffer,
	protocolToken: string,
	executable: VerifiedWindowsExecutable
): WindowsProcessLifetimeIdentity {
	const text = bytes.toString('utf8');
	if (!Buffer.from(text, 'utf8').equals(bytes) || !text.endsWith('\r\n')) {
		throw new TypeError(
			'Verified tool start evidence is not canonical UTF-8 with CRLF.'
		);
	}
	const fields = text.slice(0, -2).split('|');
	if (
		fields.length !== 10
		|| fields[0] !== 'WOK_VERIFIED_TOOL_START'
		|| fields[1] !== protocolToken
	) {
		throw new TypeError(
			'Verified tool start evidence has an invalid protocol record.'
		);
	}
	const processId = parsePositiveInteger(
		fields[2],
		'verified tool process ID',
		0xffff_ffff
	);
	const creationTimeUtcTicks = fields[3];
	if (
		!/^[1-9][0-9]{0,18}$/u.test(creationTimeUtcTicks)
		|| BigInt(creationTimeUtcTicks) % 10n !== 0n
		|| BigInt(creationTimeUtcTicks) > MAX_DOTNET_DATE_TIME_TICKS
	) {
		throw new TypeError(
			'Verified tool process creation ticks are invalid.'
		);
	}
	if (
		!/^[0-9a-f]{16}$/u.test(fields[6])
		|| !/^[0-9a-f]{64}$/u.test(fields[7])
		|| !/^[0-9a-f]{8}$/u.test(fields[9])
	) {
		throw new TypeError(
			'Verified tool executable identity is invalid.'
		);
	}
	const sizeBytes = parsePositiveInteger(
		fields[8],
		'verified tool executable size',
		Number.MAX_SAFE_INTEGER
	);
	if (
		fields[7] !== executable.sha256
		|| sizeBytes !== executable.sizeBytes
	) {
		throw new TypeError(
			'Verified tool executable bytes do not match the requested identity.'
		);
	}
	return Object.freeze({
		creationTimeUtcTicks,
		executable: Object.freeze({
			fileIdHex: fields[6],
			finalPath: decodeControlText(
				fields[5],
				'verified tool final executable path'
			),
			sha256: fields[7],
			sizeBytes,
			volumeSerialNumberHex: fields[9]
		}),
		executablePath: decodeControlText(
			fields[4],
			'verified tool executable path'
		),
		processId
	});
}

async function readControlRecord(
	controlPath: string,
	protocolToken: string,
	executable: VerifiedWindowsExecutable
): Promise<WindowsProcessLifetimeIdentity | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(controlPath, 'r');
	} catch (error) {
		if (
			error !== null
			&& typeof error === 'object'
			&& 'code' in error
			&& error.code === 'ENOENT'
		) {
			return undefined;
		}
		throw error;
	}
	try {
		const before = await handle.stat({ bigint: true });
		if (
			!before.isFile()
			|| before.size > BigInt(MAX_CONTROL_RECORD_BYTES)
		) {
			throw new TypeError(
				'Verified tool start evidence is not a bounded regular file.'
			);
		}
		if (before.size === 0n) {
			return undefined;
		}
		const sizeBytes = Number(before.size);
		const bytes = Buffer.alloc(sizeBytes);
		let offset = 0;
		while (offset < sizeBytes) {
			const { bytesRead } = await handle.read(
				bytes,
				offset,
				sizeBytes - offset,
				offset
			);
			if (bytesRead <= 0) {
				throw new Error(
					'Verified tool start evidence ended before its attested size.'
				);
			}
			offset += bytesRead;
		}
		const after = await handle.stat({ bigint: true });
		if (
			after.dev !== before.dev
			|| after.ino !== before.ino
			|| after.size !== before.size
		) {
			throw new Error(
				'Verified tool start evidence changed during read.'
			);
		}
		return parseControlRecord(bytes, protocolToken, executable);
	} finally {
		await handle.close();
	}
}

async function requireControlLease(controlPath: string): Promise<void> {
	let writableHandle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		writableHandle = await open(controlPath, 'r+');
	} catch (error) {
		if (
			error !== null
			&& typeof error === 'object'
			&& 'code' in error
			&& ['EACCES', 'EBUSY', 'EPERM'].includes(String(error.code))
		) {
			return;
		}
		throw error;
	}
	try {
		throw new Error(
			'Verified tool start evidence is not held by the native producer.'
		);
	} finally {
		await writableHandle.close();
	}
}

interface ControlDecisionLease {
	descriptor: number;
	path: string;
	released: boolean;
}

function createControlDecisionLease(path: string): ControlDecisionLease {
	return {
		descriptor: openSync(path, 'wx+'),
		path,
		released: false
	};
}

function publishControlDecision(
	lease: ControlDecisionLease,
	protocolToken: string,
	decision: 'ACCEPT' | 'REJECT'
): void {
	if (lease.released) {
		throw new Error(
			'Verified tool controller decision lease was already released.'
		);
	}
	const bytes = Buffer.from(
		`WOK_VERIFIED_TOOL_${decision}|${protocolToken}\r\n`,
		'utf8'
	);
	try {
		let offset = 0;
		while (offset < bytes.byteLength) {
			const bytesWritten = writeSync(
				lease.descriptor,
				bytes,
				offset,
				bytes.byteLength - offset,
				offset
			);
			if (bytesWritten <= 0) {
				throw new Error(
					'Verified tool controller decision could not be written exactly.'
				);
			}
			offset += bytesWritten;
		}
		fsyncSync(lease.descriptor);
	} finally {
		lease.released = true;
		closeSync(lease.descriptor);
	}
}

function releaseControlDecisionLease(lease: ControlDecisionLease): void {
	if (lease.released) return;
	lease.released = true;
	closeSync(lease.descriptor);
}

async function removeControlDecision(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (
			error !== null
			&& typeof error === 'object'
			&& 'code' in error
			&& error.code === 'ENOENT'
		) {
			return;
		}
		throw error;
	}
}

function childProcessStopped(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildClose(
	child: ChildProcess,
	timeoutMs: number
): Promise<boolean> {
	if (childProcessStopped(child)) return true;
	return new Promise(resolve => {
		let settled = false;
		const finish = (closed: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.off('close', onClose);
			resolve(closed);
		};
		const onClose = (): void => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		child.once('close', onClose);
	});
}

async function requireRejectedStartCleanup(
	child: ChildProcess,
	timeoutMs: number
): Promise<void> {
	if (
		!Number.isInteger(timeoutMs)
		|| timeoutMs < 1
		|| timeoutMs > VERIFIED_TOOL_REJECTED_START_CLEANUP_TIMEOUT_MS
	) {
		throw new TypeError(
			'Verified tool rejected-start cleanup timeout is invalid.'
		);
	}
	if (
		!childProcessStopped(child)
		&& !await waitForChildClose(child, timeoutMs)
	) {
		if (child.exitCode === 240 && child.signalCode === null) return;
		const failures: unknown[] = [new Error(
			'Verified tool host did not complete rejected-start cleanup in time.'
		)];
		let forcedTerminationRequested = false;
		if (!childProcessStopped(child)) {
			try {
				forcedTerminationRequested = child.kill();
				if (!forcedTerminationRequested) {
					failures.push(new Error(
						'Verified tool controller could not request owned-host termination.'
					));
				}
			} catch (error) {
				failures.push(error);
			}
		}
		const hostStopped = childProcessStopped(child)
			|| await waitForChildClose(
				child,
				VERIFIED_TOOL_FORCED_HOST_TERMINATION_TIMEOUT_MS
			);
		if (!hostStopped) {
			failures.push(new Error(
				'Verified tool controller did not confirm owned-host termination.'
			));
		} else if (forcedTerminationRequested) {
			failures.push(new Error(
				'Verified tool native Job cleanup remains unconfirmed after forced owned-host termination.'
			));
		}
		throw new AggregateError(
			failures,
			'Verified tool rejected-start cleanup timed out and remains unconfirmed.'
		);
	}
	if (child.signalCode !== null || child.exitCode !== 240) {
		throw new Error(
			`Verified tool host did not attest rejected-start cleanup (code=${child.exitCode ?? 'null'}, signal=${child.signalCode ?? 'null'}).`
		);
	}
}

async function rejectStartEvidence(options: {
	child: ChildProcess;
	controlDecisionLease: ControlDecisionLease;
	protocolToken: string;
	rejectedStartCleanupTimeoutMs: number;
}): Promise<void> {
	let decisionError: unknown;
	try {
		publishControlDecision(
			options.controlDecisionLease,
			options.protocolToken,
			'REJECT'
		);
	} catch (error) {
		decisionError = error;
		try {
			releaseControlDecisionLease(options.controlDecisionLease);
		} catch (releaseError) {
			decisionError = new AggregateError(
				[error, releaseError],
				'Verified tool rejection and decision-lease release both failed.'
			);
		}
	}
	let cleanupError: unknown;
	try {
		await requireRejectedStartCleanup(
			options.child,
			options.rejectedStartCleanupTimeoutMs
		);
	} catch (error) {
		cleanupError = error;
	}
	let removalError: unknown;
	try {
		await removeControlDecision(options.controlDecisionLease.path);
	} catch (error) {
		removalError = error;
	}
	const failures: unknown[] = [];
	if (decisionError !== undefined) failures.push(decisionError);
	if (cleanupError !== undefined) failures.push(cleanupError);
	if (removalError !== undefined) failures.push(removalError);
	if (failures.length > 0) {
		throw new AggregateError(
			failures,
			'Verified tool rejected-start cleanup was not exact.'
		);
	}
}

async function rejectStartAndThrow(options: {
	cause: unknown;
	child: ChildProcess;
	controlDecisionLease: ControlDecisionLease;
	protocolToken: string;
	rejectedStartCleanupTimeoutMs: number;
}): Promise<never> {
	try {
		await rejectStartEvidence(options);
	} catch (cleanupError) {
		throw new AggregateError(
			[options.cause, cleanupError],
			'Verified tool start evidence was rejected, but cleanup was not exact.'
		);
	}
	throw options.cause;
}

async function waitForControlAcceptanceConsumed(options: {
	child: ChildProcess;
	controlAcceptPath: string;
	deadline: number;
}): Promise<void> {
	while (true) {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(options.controlAcceptPath, 'r');
		} catch (error) {
			if (
				error !== null
				&& typeof error === 'object'
				&& 'code' in error
			) {
				if (error.code === 'ENOENT') return;
				if (
					['EACCES', 'EBUSY', 'EPERM'].includes(
						String(error.code)
					)
				) {
					if (
						options.child.exitCode !== null
						|| options.child.signalCode !== null
					) {
						throw new Error(
							'Verified tool host exited while consuming controller acceptance.'
						);
					}
					if (Date.now() >= options.deadline) {
						throw new Error(
							'Verified tool host timed out while consuming controller acceptance.'
						);
					}
					await new Promise(resolve => setTimeout(resolve, 10));
					continue;
				}
			}
			throw error;
		} finally {
			await handle?.close();
		}
		if (
			options.child.exitCode !== null
			|| options.child.signalCode !== null
		) {
			throw new Error(
				'Verified tool host exited before consuming controller acceptance.'
			);
		}
		if (Date.now() >= options.deadline) {
			throw new Error(
				'Verified tool host timed out while consuming controller acceptance.'
			);
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

async function waitForControlRecord(options: {
	child: ChildProcess;
	controlAcceptPath: string;
	controlDecisionLease: ControlDecisionLease;
	controlPath: string;
	executable: VerifiedWindowsExecutable;
	protocolToken: string;
	rejectedStartCleanupTimeoutMs: number;
}): Promise<WindowsProcessLifetimeIdentity> {
	try {
		await once(options.child, 'spawn');
	} catch (error) {
		releaseControlDecisionLease(options.controlDecisionLease);
		await removeControlDecision(options.controlAcceptPath);
		throw error;
	}
	const deadline = Date.now() + VERIFIED_TOOL_START_TIMEOUT_MS;
	while (true) {
		let identity: WindowsProcessLifetimeIdentity | undefined;
		try {
			identity = await readControlRecord(
				options.controlPath,
				options.protocolToken,
				options.executable
			);
			if (identity !== undefined) {
				await requireControlLease(options.controlPath);
			}
		} catch (error) {
			return rejectStartAndThrow({
				cause: error,
				child: options.child,
				controlDecisionLease: options.controlDecisionLease,
				protocolToken: options.protocolToken,
				rejectedStartCleanupTimeoutMs:
					options.rejectedStartCleanupTimeoutMs
			});
		}
		if (identity !== undefined) {
			if (
				options.child.exitCode !== null
				|| options.child.signalCode !== null
			) {
				return rejectStartAndThrow({
					cause: new Error(
						'Verified tool host exited before controller acceptance.'
					),
					child: options.child,
					controlDecisionLease: options.controlDecisionLease,
					protocolToken: options.protocolToken,
					rejectedStartCleanupTimeoutMs:
						options.rejectedStartCleanupTimeoutMs
				});
			}
			try {
				publishControlDecision(
					options.controlDecisionLease,
					options.protocolToken,
					'ACCEPT'
				);
			} catch (error) {
				let cleanupError: unknown;
				try {
					await requireRejectedStartCleanup(
						options.child,
						options.rejectedStartCleanupTimeoutMs
					);
				} catch (observedCleanupError) {
					cleanupError = observedCleanupError;
				}
				await removeControlDecision(options.controlAcceptPath);
				if (cleanupError !== undefined) {
					throw new AggregateError(
						[error, cleanupError],
						'Verified tool acceptance publication and cleanup both failed.'
					);
				}
				throw error;
			}
			await waitForControlAcceptanceConsumed({
				child: options.child,
				controlAcceptPath: options.controlAcceptPath,
				deadline
			});
			return identity;
		}
		if (
			options.child.exitCode !== null
			|| options.child.signalCode !== null
		) {
			releaseControlDecisionLease(options.controlDecisionLease);
			await removeControlDecision(options.controlAcceptPath);
			throw new Error(
				'Verified tool host exited before publishing process identity.'
			);
		}
		if (Date.now() >= deadline) {
			return rejectStartAndThrow({
				cause: new Error(
					'Verified tool host timed out before publishing process identity.'
				),
				child: options.child,
				controlDecisionLease: options.controlDecisionLease,
				protocolToken: options.protocolToken,
				rejectedStartCleanupTimeoutMs:
					options.rejectedStartCleanupTimeoutMs
			});
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

export function startVerifiedWindowsToolProcess(
	options: VerifiedWindowsToolProcessOptions
): VerifiedWindowsToolProcess {
	if (process.platform !== 'win32') {
		throw new Error('Verified runtime-tool launch requires Windows.');
	}
	if (!isAbsolute(options.executable.path)) {
		throw new TypeError(
			'Verified runtime-tool executable path must be absolute.'
		);
	}
	if (!/^[a-f0-9]{64}$/u.test(options.executable.sha256)) {
		throw new TypeError(
			'Verified runtime-tool SHA-256 must be a lowercase digest.'
		);
	}
	if (
		!Number.isSafeInteger(options.executable.sizeBytes)
		|| options.executable.sizeBytes <= 0
	) {
		throw new TypeError(
			'Verified runtime-tool size must be a positive safe integer.'
		);
	}
	if (!isAbsolute(options.controlDirectory)) {
		throw new TypeError(
			'Verified runtime-tool control directory must be absolute.'
		);
	}
	const protocolToken =
		options.testOnlyProtocolToken
		?? randomBytes(16).toString('hex');
	if (!/^[0-9a-f]{32}$/u.test(protocolToken)) {
		throw new TypeError(
			'Verified runtime-tool protocol token must be canonical.'
		);
	}
	const rejectedStartCleanupTimeoutMs =
		options.testOnlyRejectedStartCleanupTimeoutMs
		?? VERIFIED_TOOL_REJECTED_START_CLEANUP_TIMEOUT_MS;
	if (
		!Number.isInteger(rejectedStartCleanupTimeoutMs)
		|| rejectedStartCleanupTimeoutMs < 1
		|| rejectedStartCleanupTimeoutMs
			> VERIFIED_TOOL_REJECTED_START_CLEANUP_TIMEOUT_MS
	) {
		throw new TypeError(
			'Verified runtime-tool rejected-start cleanup timeout is invalid.'
		);
	}
	const controlPath = join(
		options.controlDirectory,
		`wok-verified-tool-${protocolToken}.start`
	);
	const controlAcceptPath = join(
		options.controlDirectory,
		`wok-verified-tool-${protocolToken}.accept`
	);
	const environment = options.environment ?? process.env;
	const currentDirectory = options.cwd ?? dirname(options.executable.path);
	if (!isAbsolute(currentDirectory)) {
		throw new TypeError(
			'Verified runtime-tool working directory must be absolute.'
		);
	}
	const commandLine = buildWindowsCommandLine(
		options.executable.path,
		options.arguments
	);
	if (commandLine.length > 32_766) {
		throw new RangeError(
			'Verified runtime-tool command line exceeds the Windows limit.'
		);
	}
	const powerShellCommand = [
		`$compressedSource = [Convert]::FromBase64String('${WINDOWS_TOOL_HOST_SOURCE_GZIP_BASE64}');`,
		'$sourceStream = [IO.MemoryStream]::new($compressedSource);',
		'$gzipStream = [IO.Compression.GzipStream]::new($sourceStream, [IO.Compression.CompressionMode]::Decompress);',
		'$sourceReader = [IO.StreamReader]::new($gzipStream, [Text.Encoding]::UTF8);',
		'$source = $sourceReader.ReadToEnd();',
		'$sourceReader.Dispose();',
		'$gzipStream.Dispose();',
		'$sourceStream.Dispose();',
		'Add-Type -TypeDefinition $source;',
		'$executablePath = $env:WOK_TOOL_EXECUTABLE_PATH;',
		'$expectedSha256 = $env:WOK_TOOL_EXECUTABLE_SHA256;',
		'$expectedSizeBytes = [long]$env:WOK_TOOL_EXECUTABLE_SIZE_BYTES;',
		'$commandLine = $env:WOK_TOOL_COMMAND_LINE;',
		'$currentDirectory = $env:WOK_TOOL_CURRENT_DIRECTORY;',
		'$controlPath = $env:WOK_TOOL_CONTROL_PATH;',
		'$controlAcceptPath = $env:WOK_TOOL_CONTROL_ACCEPT_PATH;',
		'$protocolToken = $env:WOK_TOOL_PROTOCOL_TOKEN;',
		"$testOnlyFailAfterAssignmentBeforeResume = $env:WOK_TOOL_TEST_FAIL_AFTER_ASSIGNMENT -eq '1';",
		"$testOnlyFailAssignmentBeforeResume = $env:WOK_TOOL_TEST_FAIL_ASSIGNMENT -eq '1';",
		"$testOnlyHangBeforeFailureCleanup = $env:WOK_TOOL_TEST_HANG_BEFORE_FAILURE_CLEANUP -eq '1';",
		'Remove-Item Env:WOK_TOOL_EXECUTABLE_PATH -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_TOOL_EXECUTABLE_SHA256 -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_TOOL_EXECUTABLE_SIZE_BYTES -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_TOOL_COMMAND_LINE -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_TOOL_CURRENT_DIRECTORY -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_TOOL_CONTROL_PATH -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_TOOL_CONTROL_ACCEPT_PATH -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_TOOL_PROTOCOL_TOKEN -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_TOOL_TEST_FAIL_AFTER_ASSIGNMENT -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_TOOL_TEST_FAIL_ASSIGNMENT -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_TOOL_TEST_HANG_BEFORE_FAILURE_CLEANUP -ErrorAction SilentlyContinue;',
		'exit [WokVerifiedToolHost]::Run(',
		'$executablePath,',
		'$expectedSha256,',
		'$expectedSizeBytes,',
		'$commandLine,',
		'$currentDirectory,',
		'$controlPath,',
		'$controlAcceptPath,',
		'$protocolToken,',
		'$testOnlyFailAfterAssignmentBeforeResume,',
		'$testOnlyFailAssignmentBeforeResume,',
		'$testOnlyHangBeforeFailureCleanup',
		');'
	].join('\n');
	if (powerShellCommand.length > 32_766) {
		throw new RangeError(
			'Verified runtime-tool bootstrap exceeds the Windows command-line limit.'
		);
	}
	const trustedSystemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (trustedSystemRoot === undefined) {
		throw new Error('The controller process has no trusted Windows root.');
	}
	const controlDecisionLease = createControlDecisionLease(
		controlAcceptPath
	);
	let child: ChildProcess;
	try {
		child = spawn(
			windowsPowerShellPath(process.env),
		[
			'-NoLogo',
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			powerShellCommand
		],
		{
			cwd: currentDirectory,
			env: {
				...environment,
				SystemRoot: trustedSystemRoot,
				WINDIR: trustedSystemRoot,
				WOK_TOOL_COMMAND_LINE: commandLine,
				WOK_TOOL_CONTROL_ACCEPT_PATH: controlAcceptPath,
				WOK_TOOL_CONTROL_PATH: controlPath,
				WOK_TOOL_CURRENT_DIRECTORY: currentDirectory,
				WOK_TOOL_EXECUTABLE_PATH: options.executable.path,
				WOK_TOOL_EXECUTABLE_SHA256: options.executable.sha256,
				WOK_TOOL_EXECUTABLE_SIZE_BYTES: String(
					options.executable.sizeBytes
				),
				WOK_TOOL_PROTOCOL_TOKEN: protocolToken,
				WOK_TOOL_TEST_FAIL_AFTER_ASSIGNMENT:
					options.testOnlyFailAfterAssignmentBeforeResume === true
						? '1'
						: '0',
				WOK_TOOL_TEST_FAIL_ASSIGNMENT:
					options.testOnlyFailAssignmentBeforeResume === true
						? '1'
						: '0',
				WOK_TOOL_TEST_HANG_BEFORE_FAILURE_CLEANUP:
					options.testOnlyHangBeforeFailureCleanup === true
						? '1'
						: '0'
			},
			stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe'],
			windowsHide: options.windowsHide ?? true
			}
		);
	} catch (error) {
		releaseControlDecisionLease(controlDecisionLease);
		try {
			unlinkSync(controlAcceptPath);
		} catch (removalError) {
			throw new AggregateError(
				[error, removalError],
				'Verified tool host spawn and decision cleanup both failed.'
			);
		}
		throw error;
	}
	const started = waitForControlRecord({
		child,
		controlAcceptPath,
		controlDecisionLease,
		controlPath,
		executable: options.executable,
		protocolToken,
		rejectedStartCleanupTimeoutMs
	});
	return { child, controlPath, started };
}
