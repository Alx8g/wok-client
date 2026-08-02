import {
	spawn,
	type ChildProcessWithoutNullStreams
} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
	parseWindowsProcessTreeSample,
	type WindowsProcessTreeSample
} from './windows-process-monitor.ts';

const MAX_CAPTURE_LOG_BYTES = 1024 * 1024;
const MAX_STDOUT_LINE_BYTES = 8 * 1024 * 1024;
const MAX_JOB_PROCESS_IDS = 16_384;
const MAX_PENDING_PROCESS_ID_REQUESTS = 16_384;
const DEFAULT_MONITOR_INTERVAL_MS = 1_250;
const DEFAULT_PROCESS_ID_SNAPSHOT_TIMEOUT_MS = 5_000;
const MAX_PROCESS_ID_SNAPSHOT_TIMEOUT_MS = 60_000;
const PROCESS_ID_REQUEST_PATTERN = /^[0-9a-f]{32}$/u;
const MAX_DOTNET_DATE_TIME_TICKS = 3_155_378_975_999_999_999n;

export interface VerifiedWindowsExecutable {
	path: string;
	sha256: string;
	sizeBytes: number;
}

export interface WindowsFileObjectIdentity {
	fileIdHex: string;
	finalPath: string;
	sha256: string;
	sizeBytes: number;
	volumeSerialNumberHex: string;
}

export interface WindowsProcessLifetimeIdentity {
	creationTimeUtcTicks: string;
	executable: WindowsFileObjectIdentity;
	executablePath: string;
	processId: number;
}

export type WindowsJobProcessStart = WindowsProcessLifetimeIdentity;

export type WindowsJobMembershipEvidence =
	| {
		processIds: readonly number[];
		status: 'reconciled';
	}
	| {
		reason: string;
		status: 'unreconciled';
	};

export type WindowsJobLifecycleState =
	| 'suspended'
	| 'resume-requested'
	| 'running'
	| 'termination-requested'
	| 'failed'
	| 'closed';

export interface WindowsJobSnapshotOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

interface PendingWindowsJobProcessIdSnapshot {
	abortListener?: () => void;
	cancelled: boolean;
	reject: (error: Error) => void;
	resolve: (processIds: readonly number[]) => void;
	settled: boolean;
	signal?: AbortSignal;
	timer?: NodeJS.Timeout;
	written: boolean;
}

export interface WindowsJobProcessExit {
	exitCode: number | null;
	finishedAt: string;
	jobClean: boolean;
	launchError?: string;
	membership: WindowsJobMembershipEvidence;
	signal: NodeJS.Signals | null;
	startedAt: string;
	stderr: string;
	stderrTruncated: boolean;
	stdout: string;
	stdoutTruncated: boolean;
	terminationRequested: boolean;
}

export interface WindowsJobProcess {
	child: ChildProcessWithoutNullStreams;
	completed: Promise<WindowsJobProcessExit>;
	firstSample: Promise<WindowsProcessTreeSample>;
	parseErrors: string[];
	rawSampleLines: string[];
	resume(): Promise<void>;
	resumed: Promise<void>;
	samples: WindowsProcessTreeSample[];
	snapshotProcessIds(
		options?: WindowsJobSnapshotOptions
	): Promise<readonly number[]>;
	readonly state: WindowsJobLifecycleState;
	started: Promise<WindowsJobProcessStart>;
	terminate(): Promise<WindowsJobProcessExit>;
}

function appendBounded(
	current: string,
	chunk: Buffer | string
): { truncated: boolean; value: string } {
	const currentBytes = Buffer.byteLength(current);
	if (currentBytes >= MAX_CAPTURE_LOG_BYTES) {
		return { truncated: true, value: current };
	}
	const remaining = MAX_CAPTURE_LOG_BYTES - currentBytes;
	const value = Buffer.isBuffer(chunk)
		? chunk.toString('utf8')
		: chunk;
	const encoded = Buffer.from(value);
	if (encoded.length <= remaining) {
		return {
			truncated: false,
			value: current + value
		};
	}
	let validEnd = remaining;
	while (
		validEnd > 0
		&& (encoded[validEnd] & 0xc0) === 0x80
	) {
		validEnd -= 1;
	}
	return {
		truncated: true,
		value: current + encoded.subarray(0, validEnd).toString('utf8')
	};
}

function quoteWindowsArgument(value: string): string {
	if (value.includes('\0')) {
		throw new TypeError(
			'Windows process arguments cannot contain null bytes.'
		);
	}
	if (value.length === 0) return '""';
	if (!/[\s"]/u.test(value)) return value;
	let result = '"';
	let backslashes = 0;
	for (const character of value) {
		if (character === '\\') {
			backslashes += 1;
			continue;
		}
		if (character === '"') {
			result += '\\'.repeat(backslashes * 2 + 1);
			result += '"';
			backslashes = 0;
			continue;
		}
		result += '\\'.repeat(backslashes);
		result += character;
		backslashes = 0;
	}
	result += '\\'.repeat(backslashes * 2);
	return `${result}"`;
}

export function buildWindowsCommandLine(
	command: string,
	arguments_: readonly string[]
): string {
	if (!command) {
		throw new TypeError('Windows process command must be non-empty.');
	}
	return [command, ...arguments_]
		.map(quoteWindowsArgument)
		.join(' ');
}

const WINDOWS_JOB_HOST_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

public static class WokWindowsJobHost
{
	private const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
	private const uint CREATE_SUSPENDED = 0x00000004;
	private const int ERROR_ALREADY_EXISTS = 183;
	private const int ERROR_BROKEN_PIPE = 109;
	private const int ERROR_MORE_DATA = 234;
	private const uint HANDLE_FLAG_INHERIT = 0x00000001;
	private const int MAX_CAPTURE_LOG_BYTES = 1024 * 1024;
	private const int MAX_MONITORED_PROCESSES = 512;
	private const uint INFINITE = 0xffffffff;
	private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
	private const int JobObjectBasicAccountingInformation = 1;
	private const int JobObjectBasicProcessIdList = 3;
	private const int JobObjectExtendedLimitInformation = 9;
	private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
	private const uint STARTF_USESTDHANDLES = 0x00000100;
	private const uint STD_ERROR_HANDLE = 0xfffffff4;
	private const uint STD_INPUT_HANDLE = 0xfffffff6;
	private const uint STD_OUTPUT_HANDLE = 0xfffffff5;
	private const uint SYNCHRONIZE = 0x00100000;
	private const uint WAIT_OBJECT_0 = 0;
	private const uint WAIT_TIMEOUT = 258;
	private static readonly object ProtocolLock = new object();

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

	[StructLayout(LayoutKind.Sequential)]
	private struct SECURITY_ATTRIBUTES
	{
		public uint nLength;
		public IntPtr lpSecurityDescriptor;
		[MarshalAs(UnmanagedType.Bool)]
		public bool bInheritHandle;
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
	private struct PROCESS_INFORMATION
	{
		public IntPtr hProcess;
		public IntPtr hThread;
		public uint dwProcessId;
		public uint dwThreadId;
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
	private struct PROCESS_MEMORY_COUNTERS_EX
	{
		public uint cb;
		public uint PageFaultCount;
		public UIntPtr PeakWorkingSetSize;
		public UIntPtr WorkingSetSize;
		public UIntPtr QuotaPeakPagedPoolUsage;
		public UIntPtr QuotaPagedPoolUsage;
		public UIntPtr QuotaPeakNonPagedPoolUsage;
		public UIntPtr QuotaNonPagedPoolUsage;
		public UIntPtr PagefileUsage;
		public UIntPtr PeakPagefileUsage;
		public UIntPtr PrivateUsage;
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
			if (Stream != null)
			{
				Stream.Dispose();
				Stream = null;
			}
		}
	}

	private sealed class PreviousCpuReading
	{
		public long CapturedAtTicks { get; set; }
		public long CpuTicks { get; set; }
		public long CreationTicks { get; set; }
	}

	private sealed class BoundedPipeCapture : IDisposable
	{
		private readonly MemoryStream captured = new MemoryStream();
		private Exception failure;
		private IntPtr readHandle;
		private Thread readerThread;
		private IntPtr writeHandle;

		public BoundedPipeCapture()
		{
			var attributes = new SECURITY_ATTRIBUTES();
			attributes.nLength = checked((uint)Marshal.SizeOf(
				typeof(SECURITY_ATTRIBUTES)
			));
			attributes.bInheritHandle = true;
			if (!CreatePipe(
				out readHandle,
				out writeHandle,
				ref attributes,
				0
			))
			{
				throw new Win32Exception(Marshal.GetLastWin32Error());
			}
			if (!SetHandleInformation(
				readHandle,
				HANDLE_FLAG_INHERIT,
				0
			))
			{
				int error = Marshal.GetLastWin32Error();
				Dispose();
				throw new Win32Exception(error);
			}
		}

		public bool Truncated { get; private set; }

		public IntPtr WriteHandle
		{
			get
			{
				if (writeHandle == IntPtr.Zero)
				{
					throw new InvalidOperationException(
						"Candidate output write handle is closed."
					);
				}
				return writeHandle;
			}
		}

		public void CloseHostWriteHandle()
		{
			if (writeHandle == IntPtr.Zero) return;
			CloseHandle(writeHandle);
			writeHandle = IntPtr.Zero;
		}

		public void Start()
		{
			if (readerThread != null)
			{
				throw new InvalidOperationException(
					"Candidate output capture already started."
				);
			}
			readerThread = new Thread(ReadLoop);
			readerThread.IsBackground = true;
			readerThread.Start();
		}

		private void ReadLoop()
		{
			try
			{
				var buffer = new byte[8192];
				for (;;)
				{
					uint bytesRead;
					if (!ReadFile(
						readHandle,
						buffer,
						checked((uint)buffer.Length),
						out bytesRead,
						IntPtr.Zero
					))
					{
						int error = Marshal.GetLastWin32Error();
						if (error == ERROR_BROKEN_PIPE) return;
						throw new Win32Exception(error);
					}
					if (bytesRead == 0) return;
					int remaining = MAX_CAPTURE_LOG_BYTES
						- checked((int)captured.Length);
					if (remaining > 0)
					{
						int toWrite = Math.Min(
							remaining,
							checked((int)bytesRead)
						);
						captured.Write(buffer, 0, toWrite);
					}
					if (checked((int)bytesRead) > remaining)
					{
						Truncated = true;
					}
				}
			}
			catch (Exception error)
			{
				failure = error;
			}
		}

		public string Complete()
		{
			if (readerThread == null)
			{
				throw new InvalidOperationException(
					"Candidate output capture was not started."
				);
			}
			if (!readerThread.Join(5000))
			{
				throw new TimeoutException(
					"Timed out draining candidate output."
				);
			}
			if (failure != null)
			{
				throw new InvalidOperationException(
					"Candidate output capture failed.",
					failure
				);
			}
			return Convert.ToBase64String(captured.ToArray());
		}

		public void Dispose()
		{
			CloseHostWriteHandle();
			if (readHandle != IntPtr.Zero)
			{
				CloseHandle(readHandle);
				readHandle = IntPtr.Zero;
			}
			captured.Dispose();
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
		ref STARTUPINFO startupInfo,
		out PROCESS_INFORMATION processInformation
	);

	[DllImport("kernel32.dll", SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool AssignProcessToJobObject(
		IntPtr job,
		IntPtr process
	);

	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern IntPtr OpenProcess(
		uint desiredAccess,
		[MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
		uint processId
	);

	[DllImport("kernel32.dll", SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool IsProcessInJob(
		IntPtr process,
		IntPtr job,
		[MarshalAs(UnmanagedType.Bool)] out bool result
	);

	[DllImport("psapi.dll", SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool GetProcessMemoryInfo(
		IntPtr process,
		out PROCESS_MEMORY_COUNTERS_EX counters,
		uint size
	);

	[DllImport("user32.dll")]
	private static extern IntPtr GetForegroundWindow();

	[DllImport("user32.dll", SetLastError = true)]
	private static extern uint GetWindowThreadProcessId(
		IntPtr window,
		out uint processId
	);

	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern uint ResumeThread(IntPtr thread);

	[DllImport("kernel32.dll", SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool GetProcessTimes(
		IntPtr process,
		out FILETIME creation,
		out FILETIME exit,
		out FILETIME kernel,
		out FILETIME user
	);

	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool QueryFullProcessImageName(
		IntPtr process,
		uint flags,
		StringBuilder executablePath,
		ref uint size
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
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool TerminateProcess(
		IntPtr process,
		uint exitCode
	);

	[DllImport("kernel32.dll", SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool TerminateJobObject(
		IntPtr job,
		uint exitCode
	);

	[DllImport("kernel32.dll", SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool QueryInformationJobObject(
		IntPtr job,
		int informationClass,
		IntPtr information,
		uint informationLength,
		IntPtr returnLength
	);

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
	private static extern IntPtr GetStdHandle(uint standardHandle);

	[DllImport("kernel32.dll", SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool CreatePipe(
		out IntPtr readPipe,
		out IntPtr writePipe,
		ref SECURITY_ATTRIBUTES pipeAttributes,
		uint size
	);

	[DllImport("kernel32.dll", SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool SetHandleInformation(
		IntPtr handle,
		uint mask,
		uint flags
	);

	[DllImport("kernel32.dll", SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool ReadFile(
		IntPtr file,
		byte[] buffer,
		uint bytesToRead,
		out uint bytesRead,
		IntPtr overlapped
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
		IntPtr handle = stream.SafeFileHandle.DangerousGetHandle();
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
			ExecutableIdentity before = InspectExecutable(stream, string.Empty);
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
			ExecutableIdentity actual = InspectExecutable(stream, string.Empty);
			if (!SameFileObject(actual, expected))
			{
				throw new InvalidOperationException(
					"Launched process image does not match the retained executable."
				);
			}
		}
	}

	private static string Encode(string value)
	{
		return Convert.ToBase64String(
			Encoding.UTF8.GetBytes(value ?? string.Empty)
		);
	}

	private static string JsonString(string value)
	{
		if (value == null) return "\"\"";
		var result = new StringBuilder(value.Length + 2);
		result.Append('\"');
		foreach (char character in value)
		{
			switch (character)
			{
				case '\"': result.Append("\\\""); break;
				case '\\': result.Append("\\\\"); break;
				case '\b': result.Append("\\b"); break;
				case '\f': result.Append("\\f"); break;
				case '\n': result.Append("\\n"); break;
				case '\r': result.Append("\\r"); break;
				case '\t': result.Append("\\t"); break;
				default:
					if (character < 32)
					{
						result.Append("\\u");
						result.Append(((int)character).ToString("x4"));
					}
					else result.Append(character);
					break;
			}
		}
		result.Append('\"');
		return result.ToString();
	}

	private static void Protocol(
		string token,
		string value
	)
	{
		lock (ProtocolLock)
		{
			Console.Out.WriteLine(
				"WOK_JOB_PROTOCOL_" + token + " " + value
			);
			Console.Out.Flush();
		}
	}

	private static bool ConfigureJob(IntPtr job)
	{
		var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
		information.BasicLimitInformation.LimitFlags =
			JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
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

	private static void PreventStandardHandleInheritance()
	{
		foreach (uint standardHandle in new uint[] {
			STD_INPUT_HANDLE,
			STD_OUTPUT_HANDLE,
			STD_ERROR_HANDLE
		})
		{
			IntPtr handle = GetStdHandle(standardHandle);
			if (
				handle == IntPtr.Zero
				|| handle == new IntPtr(-1)
				|| !SetHandleInformation(
					handle,
					HANDLE_FLAG_INHERIT,
					0
				)
			)
			{
				throw new Win32Exception(Marshal.GetLastWin32Error());
			}
		}
	}

	private static bool TryCreateSuspended(
		string executablePath,
		string commandLine,
		string currentDirectory,
		uint flags,
		IntPtr standardOutput,
		IntPtr standardError,
		out PROCESS_INFORMATION processInformation
	)
	{
		var startupInfo = new STARTUPINFO();
		startupInfo.cb = checked((uint)Marshal.SizeOf(typeof(STARTUPINFO)));
		startupInfo.dwFlags = STARTF_USESTDHANDLES;
		startupInfo.hStdInput = IntPtr.Zero;
		startupInfo.hStdOutput = standardOutput;
		startupInfo.hStdError = standardError;
		return CreateProcessW(
			executablePath,
			new StringBuilder(commandLine),
			IntPtr.Zero,
			IntPtr.Zero,
			true,
			flags,
			IntPtr.Zero,
			currentDirectory,
			ref startupInfo,
			out processInformation
		);
	}

	private static uint ActiveProcesses(IntPtr job)
	{
		int size = Marshal.SizeOf(
			typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
		);
		IntPtr buffer = Marshal.AllocHGlobal(size);
		try
		{
			if (!QueryInformationJobObject(
				job,
				JobObjectBasicAccountingInformation,
				buffer,
				checked((uint)size),
				IntPtr.Zero
			))
			{
				throw new Win32Exception(Marshal.GetLastWin32Error());
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

	private static uint[] ProcessIds(IntPtr job)
	{
		int capacity = 64;
		for (;;)
		{
			int size = checked(8 + IntPtr.Size * capacity);
			IntPtr buffer = Marshal.AllocHGlobal(size);
			try
			{
				if (!QueryInformationJobObject(
					job,
					JobObjectBasicProcessIdList,
					buffer,
					checked((uint)size),
					IntPtr.Zero
				))
				{
					int error = Marshal.GetLastWin32Error();
					if (error != ERROR_MORE_DATA)
					{
						throw new Win32Exception(error);
					}
					int assigned = Marshal.ReadInt32(buffer, 0);
					if (assigned < 1 || assigned > 16384)
					{
						throw new InvalidOperationException(
							"Windows job contains too many processes."
						);
					}
					int nextCapacity = Math.Min(
						16384,
						Math.Max(capacity * 2, assigned)
					);
					if (nextCapacity <= capacity)
					{
						throw new InvalidOperationException(
							"Windows job process list did not fit its maximum buffer."
						);
					}
					capacity = nextCapacity;
					continue;
				}
				int count = Marshal.ReadInt32(buffer, 4);
				if (count < 0 || count > capacity)
				{
					throw new InvalidOperationException(
						"Windows job returned an invalid process count."
					);
				}
				var result = new uint[count];
				for (int index = 0; index < count; index++)
				{
					long processId = Marshal.ReadIntPtr(
						buffer,
						8 + index * IntPtr.Size
					).ToInt64();
					if (processId < 1 || processId > uint.MaxValue)
					{
						throw new InvalidOperationException(
							"Windows job returned an invalid process ID."
						);
					}
					result[index] = checked((uint)processId);
				}
				return result;
			}
			finally
			{
				Marshal.FreeHGlobal(buffer);
			}
		}
	}

	private static bool IsCanonicalRequestId(string value)
	{
		if (value == null || value.Length != 32) return false;
		foreach (char character in value)
		{
			bool accepted = character >= '0' && character <= '9'
				|| character >= 'a' && character <= 'f';
			if (!accepted) return false;
		}
		return true;
	}

	private static bool TryParseProcessIdsCommand(
		string line,
		out string requestId
	)
	{
		const string prefix = "process-ids|";
		requestId = null;
		if (line == null || !line.StartsWith(
			prefix,
			StringComparison.Ordinal
		)) return false;
		requestId = line.Substring(prefix.Length);
		if (!IsCanonicalRequestId(requestId))
		{
			throw new InvalidOperationException(
				"Windows job received an invalid process-ID request."
			);
		}
		return true;
	}

	private static void EmitProcessIds(
		IntPtr job,
		string protocolToken,
		string requestId,
		bool emitInvalidTestResponse
	)
	{
		if (emitInvalidTestResponse)
		{
			Protocol(
				protocolToken,
				"PROCESS_IDS|" + requestId + "|0"
			);
			return;
		}
		uint[] processIds = ProcessIds(job);
		var fields = new List<string>();
		fields.Add("PROCESS_IDS");
		fields.Add(requestId);
		foreach (uint processId in processIds)
		{
			fields.Add(processId.ToString(
				System.Globalization.CultureInfo.InvariantCulture
			));
		}
		Protocol(
			protocolToken,
			String.Join("|", fields.ToArray())
		);
	}

	private static ulong ToUInt64(UIntPtr value)
	{
		return UIntPtr.Size == 8
			? value.ToUInt64()
			: value.ToUInt32();
	}

	private static long BoundedSize(UIntPtr value)
	{
		ulong size = ToUInt64(value);
		return size > long.MaxValue
			? long.MaxValue
			: checked((long)size);
	}

	private static uint ForegroundProcessId()
	{
		IntPtr window = GetForegroundWindow();
		if (window == IntPtr.Zero) return 0;
		uint processId;
		GetWindowThreadProcessId(window, out processId);
		return processId;
	}

	private static string BuildSample(
		IntPtr job,
		uint rootProcessId,
		Dictionary<uint, PreviousCpuReading> previousCpu
	)
	{
		DateTime capturedAt = DateTime.UtcNow;
		long capturedAtMs = (
			capturedAt.Ticks
			- new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).Ticks
		) / TimeSpan.TicksPerMillisecond;
		var currentCpu = new Dictionary<uint, PreviousCpuReading>();
		var processJson = new List<string>();
		var readingIds = new HashSet<uint>();
		uint[] processIds = ProcessIds(job);
		if (processIds.Length > MAX_MONITORED_PROCESSES)
		{
			throw new InvalidOperationException(
				"Windows job exceeds the bounded process-monitor capacity."
			);
		}
		foreach (uint processId in processIds)
		{
			IntPtr process = OpenProcess(
				PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
				false,
				processId
			);
			if (process == IntPtr.Zero) continue;
			try
			{
				bool inJob;
				if (
					!IsProcessInJob(process, job, out inJob)
					|| !inJob
					|| WaitForSingleObject(process, 0) != WAIT_TIMEOUT
				) continue;
				FILETIME creation;
				FILETIME exit;
				FILETIME kernel;
				FILETIME user;
				if (!GetProcessTimes(
					process,
					out creation,
					out exit,
					out kernel,
					out user
				)) continue;
				var executablePath = new StringBuilder(32768);
				uint executablePathLength =
					checked((uint)executablePath.Capacity);
				if (!QueryFullProcessImageName(
					process,
					0,
					executablePath,
					ref executablePathLength
				)) continue;
				var memory = new PROCESS_MEMORY_COUNTERS_EX();
				memory.cb = checked((uint)Marshal.SizeOf(
					typeof(PROCESS_MEMORY_COUNTERS_EX)
				));
				if (!GetProcessMemoryInfo(
					process,
					out memory,
					memory.cb
				)) continue;
				if (
					!IsProcessInJob(process, job, out inJob)
					|| !inJob
					|| WaitForSingleObject(process, 0) != WAIT_TIMEOUT
				) continue;

				long creationTicks = ToIdentityTicks(creation);
				long cpuTicks = ToRawTicks(kernel) + ToRawTicks(user);
				double cpuPercent = 0;
				PreviousCpuReading previous;
				if (
					previousCpu.TryGetValue(processId, out previous)
					&& previous.CreationTicks == creationTicks
				)
				{
					long elapsedTicks =
						capturedAt.Ticks - previous.CapturedAtTicks;
					long cpuDeltaTicks = cpuTicks - previous.CpuTicks;
					if (elapsedTicks > 0 && cpuDeltaTicks >= 0)
					{
						cpuPercent =
							((double)cpuDeltaTicks / elapsedTicks) * 100;
					}
				}
				currentCpu[processId] = new PreviousCpuReading
				{
					CapturedAtTicks = capturedAt.Ticks,
					CpuTicks = cpuTicks,
					CreationTicks = creationTicks
				};
				string path = executablePath.ToString();
				if (path.Length == 0 || path.Length > 4096)
				{
					throw new InvalidOperationException(
						"Windows job returned an invalid executable path."
					);
				}
				string name = Path.GetFileName(path) ?? string.Empty;
				if (name.Length == 0 || name.Length > 1024)
				{
					throw new InvalidOperationException(
						"Windows job returned an invalid executable name."
					);
				}
				processJson.Add(
					"{\"commandLine\":\"\","
					+ "\"creationTimeUtcTicks\":"
					+ JsonString(creationTicks.ToString()) + ","
					+ "\"cpuPercent\":"
					+ cpuPercent.ToString(
						"R",
						System.Globalization.CultureInfo.InvariantCulture
					) + ","
					+ "\"executableName\":" + JsonString(name) + ","
					+ "\"executablePath\":" + JsonString(path) + ","
					+ "\"parentProcessId\":0,"
					+ "\"performanceCountersPresent\":true,"
					+ "\"privateBytes\":"
					+ BoundedSize(memory.PrivateUsage) + ","
					+ "\"processId\":" + processId + ","
					+ "\"workingSetBytes\":"
					+ BoundedSize(memory.WorkingSetSize) + "}"
				);
				readingIds.Add(processId);
			}
			finally
			{
				CloseHandle(process);
			}
		}
		previousCpu.Clear();
		foreach (var item in currentCpu)
		{
			previousCpu[item.Key] = item.Value;
		}
		uint foregroundProcessId = ForegroundProcessId();
		return "{\"capturedAtMs\":" + capturedAtMs
			+ ",\"foregroundOwnedByCandidateTree\":"
			+ (readingIds.Contains(foregroundProcessId) ? "true" : "false")
			+ ",\"foregroundProcessId\":" + foregroundProcessId
			+ ",\"processes\":[" + String.Join(",", processJson.ToArray())
			+ "],\"rootProcessId\":" + rootProcessId + "}";
	}

	private static void MonitorJob(
		IntPtr job,
		uint rootProcessId,
		int intervalMs,
		string protocolToken,
		ManualResetEvent stop
	)
	{
		var previousCpu = new Dictionary<uint, PreviousCpuReading>();
		while (!stop.WaitOne(0))
		{
			try
			{
				Protocol(
					protocolToken,
					"SAMPLE|" + Encode(BuildSample(
						job,
						rootProcessId,
						previousCpu
					))
				);
			}
			catch (Exception error)
			{
				Protocol(
					protocolToken,
					"MONITOR_ERROR|" + Encode(error.ToString())
				);
				return;
			}
			if (stop.WaitOne(intervalMs)) return;
		}
	}

	private static bool WaitForJobEmpty(
		IntPtr job,
		int timeoutMs
	)
	{
		DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
		do
		{
			if (ActiveProcesses(job) == 0) return true;
			Thread.Sleep(25);
		}
		while (DateTime.UtcNow < deadline);
		return ActiveProcesses(job) == 0;
	}

	public static int Run(
		string executablePath,
		string expectedExecutableSha256,
		long expectedExecutableSizeBytes,
		string commandLine,
		string currentDirectory,
		string jobName,
		int monitorIntervalMs,
		string protocolToken,
		bool testOnlyFailAssignmentBeforeResume,
		int testOnlyProtocolFailure
	)
	{
		IntPtr job = IntPtr.Zero;
		ExecutableLease executableLease = null;
		var processInformation = new PROCESS_INFORMATION();
		var monitorStop = new ManualResetEvent(false);
		Thread monitorThread = null;
		BoundedPipeCapture standardOutput = null;
		BoundedPipeCapture standardError = null;
		try
		{
			job = CreateJobObject(IntPtr.Zero, jobName);
			int createJobError = Marshal.GetLastWin32Error();
			if (job == IntPtr.Zero)
			{
				throw new Win32Exception(createJobError);
			}
			if (createJobError == ERROR_ALREADY_EXISTS)
			{
				throw new InvalidOperationException(
					"Refusing to use a pre-existing Windows job object."
				);
			}
			if (!ConfigureJob(job))
			{
				throw new Win32Exception(Marshal.GetLastWin32Error());
			}
			executableLease = AcquireExecutableLease(
				executablePath,
				expectedExecutableSha256,
				expectedExecutableSizeBytes
			);

			PreventStandardHandleInheritance();
			standardOutput = new BoundedPipeCapture();
			standardError = new BoundedPipeCapture();
			uint creationFlags =
				CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB;
			if (!TryCreateSuspended(
				executablePath,
				commandLine,
				currentDirectory,
				creationFlags,
				standardOutput.WriteHandle,
				standardError.WriteHandle,
				out processInformation
			))
			{
				int firstError = Marshal.GetLastWin32Error();
				if (firstError != 5 || !TryCreateSuspended(
					executablePath,
					commandLine,
					currentDirectory,
					CREATE_SUSPENDED,
					standardOutput.WriteHandle,
					standardError.WriteHandle,
					out processInformation
				))
				{
					throw new Win32Exception(
						firstError == 5
							? Marshal.GetLastWin32Error()
							: firstError
					);
				}
			}
			standardOutput.CloseHostWriteHandle();
			standardError.CloseHostWriteHandle();
			standardOutput.Start();
			standardError.Start();

			if (
				testOnlyFailAssignmentBeforeResume
				|| !AssignProcessToJobObject(
					job,
					processInformation.hProcess
				)
			)
			{
				int assignError = testOnlyFailAssignmentBeforeResume
					? 5
					: Marshal.GetLastWin32Error();
				TerminateProcess(processInformation.hProcess, 1);
				WaitForSingleObject(processInformation.hProcess, 5000);
				throw new Win32Exception(assignError);
			}

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
			VerifyProcessImage(
				actualPath.ToString(),
				executableLease.Identity
			);
			if (testOnlyProtocolFailure == 7)
			{
				Thread.Sleep(1000);
			}
			Protocol(
				protocolToken,
				"STARTED|"
					+ processInformation.dwProcessId
					+ "|" + ToIdentityTicks(creation)
					+ "|" + Encode(actualPath.ToString())
					+ "|" + Encode(executableLease.Identity.FinalPath)
					+ "|" + executableLease.Identity.FileIdHex
					+ "|" + executableLease.Identity.Sha256
					+ "|" + executableLease.Identity.SizeBytes
					+ "|" + executableLease.Identity.VolumeSerialNumberHex
			);
			if (
				testOnlyProtocolFailure >= 1
				&& testOnlyProtocolFailure <= 3
			)
			{
				if (testOnlyProtocolFailure == 1)
				{
					Protocol(protocolToken, "STDOUT|%%%|0");
				}
				else if (testOnlyProtocolFailure == 2)
				{
					Protocol(protocolToken, "STDOUT||2");
				}
				else if (testOnlyProtocolFailure == 3)
				{
					lock (ProtocolLock)
					{
						Console.Out.Write(
							"WOK_JOB_PROTOCOL_" + protocolToken
								+ " STDOUT|"
								+ new string('A', 8 * 1024 * 1024)
						);
						Console.Out.Flush();
					}
				}
				else
				{
					throw new InvalidOperationException(
						"Unknown test-only protocol failure."
					);
				}
				Thread.Sleep(30000);
				throw new TimeoutException(
					"Test-only protocol failure was not contained."
				);
			}

			int terminationRequested = 0;
			monitorThread = new Thread(delegate()
			{
				MonitorJob(
					job,
					processInformation.dwProcessId,
					monitorIntervalMs,
					protocolToken,
					monitorStop
				);
			});
			monitorThread.IsBackground = true;
			monitorThread.Start();

			bool candidateResumed = false;
			for (;;)
			{
				string initialControl = Console.In.ReadLine();
				if (initialControl == null || initialControl == "terminate")
				{
					Interlocked.Exchange(ref terminationRequested, 1);
					if (!TerminateJobObject(job, 1))
					{
						throw new Win32Exception(Marshal.GetLastWin32Error());
					}
					break;
				}
				string requestId;
				if (TryParseProcessIdsCommand(
					initialControl,
					out requestId
				))
				{
					if (testOnlyProtocolFailure == 5)
					{
						continue;
					}
					if (testOnlyProtocolFailure == 6)
					{
						Thread.Sleep(250);
					}
					EmitProcessIds(
						job,
						protocolToken,
						requestId,
						testOnlyProtocolFailure == 4
					);
					continue;
				}
				if (initialControl != "resume")
				{
					Interlocked.Exchange(ref terminationRequested, 1);
					TerminateJobObject(job, 1);
					throw new InvalidOperationException(
						"Windows job received an invalid initial control command."
					);
				}
				if (ResumeThread(processInformation.hThread) == 0xffffffff)
				{
					throw new Win32Exception(Marshal.GetLastWin32Error());
				}
				CloseHandle(processInformation.hThread);
				processInformation.hThread = IntPtr.Zero;
				Protocol(protocolToken, "RESUMED");
				candidateResumed = true;
				break;
			}

			if (candidateResumed)
			{
				var controlThread = new Thread(delegate()
				{
					try
					{
						for (;;)
						{
							string line = Console.In.ReadLine();
							if (line == null || line == "terminate")
							{
								Interlocked.Exchange(
									ref terminationRequested,
									1
								);
								TerminateJobObject(job, 1);
								return;
							}
							string requestId;
							if (TryParseProcessIdsCommand(
								line,
								out requestId
							))
							{
								if (testOnlyProtocolFailure == 5)
								{
									continue;
								}
								if (testOnlyProtocolFailure == 6)
								{
									Thread.Sleep(250);
								}
								EmitProcessIds(
									job,
									protocolToken,
									requestId,
									testOnlyProtocolFailure == 4
								);
								continue;
							}
							throw new InvalidOperationException(
								"Windows job received an invalid control command."
							);
						}
					}
					catch (Exception error)
					{
						Protocol(
							protocolToken,
							"ERROR|" + Encode(error.ToString())
						);
						Interlocked.Exchange(
							ref terminationRequested,
							1
						);
						TerminateJobObject(job, 1);
					}
				});
				controlThread.IsBackground = true;
				controlThread.Start();
			}

			if (
				WaitForSingleObject(
					processInformation.hProcess,
					INFINITE
				) != WAIT_OBJECT_0
			)
			{
				throw new Win32Exception(Marshal.GetLastWin32Error());
			}
			uint rootExitCode;
			if (!GetExitCodeProcess(
				processInformation.hProcess,
				out rootExitCode
			))
			{
				throw new Win32Exception(Marshal.GetLastWin32Error());
			}
			monitorStop.Set();
			if (monitorThread != null && !monitorThread.Join(5000))
			{
				throw new TimeoutException(
					"Timed out stopping the Windows job monitor."
				);
			}
			if (Interlocked.CompareExchange(
				ref terminationRequested,
				0,
				0
			) == 0)
			{
				TerminateJobObject(job, 1);
			}
			WaitForJobEmpty(job, 5000);
			uint[] finalProcessIds = ProcessIds(job);
			bool clean = finalProcessIds.Length == 0;
			Protocol(
				protocolToken,
				"STDOUT|" + standardOutput.Complete()
					+ "|" + (standardOutput.Truncated ? "1" : "0")
			);
			Protocol(
				protocolToken,
				"STDERR|" + standardError.Complete()
					+ "|" + (standardError.Truncated ? "1" : "0")
			);
			var terminalFields = new List<string>();
			terminalFields.Add("EXITED");
			terminalFields.Add(rootExitCode.ToString(
				System.Globalization.CultureInfo.InvariantCulture
			));
			terminalFields.Add(clean ? "1" : "0");
			terminalFields.Add(
				terminationRequested == 0 ? "0" : "1"
			);
			terminalFields.Add(finalProcessIds.Length.ToString(
				System.Globalization.CultureInfo.InvariantCulture
			));
			foreach (uint processId in finalProcessIds)
			{
				terminalFields.Add(processId.ToString(
					System.Globalization.CultureInfo.InvariantCulture
				));
			}
			Protocol(
				protocolToken,
				String.Join("|", terminalFields.ToArray())
			);
			return clean ? 0 : 3;
		}
		catch (Exception error)
		{
			Protocol(
				protocolToken,
				"ERROR|" + Encode(error.ToString())
			);
			return 2;
		}
		finally
		{
			monitorStop.Set();
			if (monitorThread != null && monitorThread.IsAlive)
			{
				monitorThread.Join(5000);
			}
			monitorStop.Dispose();
			if (processInformation.hThread != IntPtr.Zero)
			{
				CloseHandle(processInformation.hThread);
			}
			if (processInformation.hProcess != IntPtr.Zero)
			{
				CloseHandle(processInformation.hProcess);
			}
			if (job != IntPtr.Zero)
			{
				CloseHandle(job);
			}
			if (executableLease != null)
			{
				executableLease.Dispose();
			}
			if (standardOutput != null)
			{
				standardOutput.Dispose();
			}
			if (standardError != null)
			{
				standardError.Dispose();
			}
		}
	}
}
`;

const WINDOWS_JOB_HOST_SOURCE_GZIP_BASE64 = gzipSync(
	Buffer.from(WINDOWS_JOB_HOST_SOURCE, 'utf8'),
	{ level: 9 }
).toString('base64');

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
		throw new TypeError(`${field} is outside its supported range.`);
	}
	return parsed;
}

function parseNonNegativeInteger(
	value: string,
	field: string,
	maximum: number
): number {
	if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
		throw new TypeError(`${field} must be a non-negative integer.`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > maximum) {
		throw new TypeError(`${field} is outside its supported range.`);
	}
	return parsed;
}

function decodeProtocolText(value: string): string {
	if (
		value.length % 4 !== 0
		|| !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
	) {
		throw new TypeError('Windows job protocol text is not canonical base64.');
	}
	const decoded = Buffer.from(value, 'base64');
	if (decoded.toString('base64') !== value) {
		throw new TypeError('Windows job protocol text is not canonical base64.');
	}
	return decoded.toString('utf8');
}

export function startWindowsJobProcess(options: {
	arguments: readonly string[];
	cwd: string;
	executable: VerifiedWindowsExecutable;
	environment: NodeJS.ProcessEnv;
	intervalMs?: number;
	onSample?: (sample: WindowsProcessTreeSample) => void;
	testOnlyFailAssignmentBeforeResume?: boolean;
	testOnlyProtocolFailure?:
		| 'delayed-process-ids'
		| 'delayed-start-evidence'
		| 'dropped-process-ids'
		| 'invalid-base64'
		| 'invalid-output-state'
		| 'invalid-process-ids'
		| 'oversized-line';
}): WindowsJobProcess {
	if (process.platform !== 'win32') {
		throw new Error('Windows job launch requires Windows.');
	}
	if (
		options.executable.path.length === 0
		|| options.executable.path.length > 4_096
		|| options.executable.path.includes('\0')
		|| !/^[0-9a-f]{64}$/u.test(options.executable.sha256)
		|| !Number.isSafeInteger(options.executable.sizeBytes)
		|| options.executable.sizeBytes <= 0
	) {
		throw new TypeError(
			'Windows job executable identity is invalid.'
		);
	}
	const intervalMs = options.intervalMs ?? DEFAULT_MONITOR_INTERVAL_MS;
	if (
		!Number.isInteger(intervalMs)
		|| intervalMs < 100
		|| intervalMs > 10_000
	) {
		throw new RangeError(
			'Windows job monitor interval must be an integer from 100 through 10,000.'
		);
	}
	if (
		options.testOnlyFailAssignmentBeforeResume !== undefined
		&& typeof options.testOnlyFailAssignmentBeforeResume !== 'boolean'
	) {
		throw new TypeError(
			'testOnlyFailAssignmentBeforeResume must be boolean when provided.'
		);
	}
	const testOnlyProtocolFailure = options.testOnlyProtocolFailure === undefined
		? 0
		: {
			'invalid-base64': 1,
			'invalid-output-state': 2,
			'oversized-line': 3,
			'invalid-process-ids': 4,
			'dropped-process-ids': 5,
			'delayed-process-ids': 6,
			'delayed-start-evidence': 7
		}[options.testOnlyProtocolFailure];
	if (testOnlyProtocolFailure === undefined) {
		throw new TypeError(
			'testOnlyProtocolFailure must select a supported failure mode.'
		);
	}
	const protocolToken = randomBytes(16).toString('hex');
	const jobName = `Local\\WokRuntimeLab-${protocolToken}`;
	const protocolPrefix = `WOK_JOB_PROTOCOL_${protocolToken} `;
	const commandLine = buildWindowsCommandLine(
		options.executable.path,
		options.arguments
	);
	const powerShellCommand = [
		`$compressedSource = [Convert]::FromBase64String('${WINDOWS_JOB_HOST_SOURCE_GZIP_BASE64}');`,
		'$sourceStream = [IO.MemoryStream]::new($compressedSource);',
		'$gzipStream = [IO.Compression.GzipStream]::new($sourceStream, [IO.Compression.CompressionMode]::Decompress);',
		'$sourceReader = [IO.StreamReader]::new($gzipStream, [Text.Encoding]::UTF8);',
		'$source = $sourceReader.ReadToEnd();',
		'$sourceReader.Dispose();',
		'$gzipStream.Dispose();',
		'$sourceStream.Dispose();',
		'Add-Type -TypeDefinition $source;',
		'$executablePath = $env:WOK_JOB_EXECUTABLE_PATH;',
		'$expectedExecutableSha256 = $env:WOK_JOB_EXECUTABLE_SHA256;',
		'$expectedExecutableSizeBytes = [long]$env:WOK_JOB_EXECUTABLE_SIZE_BYTES;',
		'$commandLine = $env:WOK_JOB_COMMAND_LINE;',
		'$currentDirectory = $env:WOK_JOB_CURRENT_DIRECTORY;',
		'$jobName = $env:WOK_JOB_NAME;',
		'$monitorIntervalMs = [int]$env:WOK_JOB_MONITOR_INTERVAL_MS;',
		'$protocolToken = $env:WOK_JOB_PROTOCOL_TOKEN;',
		'$testOnlyFailAssignmentBeforeResume = $env:WOK_JOB_TEST_FAIL_ASSIGNMENT -eq "1";',
		'$testOnlyProtocolFailure = [int]$env:WOK_JOB_TEST_PROTOCOL_FAILURE;',
		'Remove-Item Env:WOK_JOB_EXECUTABLE_PATH -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_JOB_EXECUTABLE_SHA256 -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_JOB_EXECUTABLE_SIZE_BYTES -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_JOB_COMMAND_LINE -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_JOB_CURRENT_DIRECTORY -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_JOB_NAME -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_JOB_MONITOR_INTERVAL_MS -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_JOB_PROTOCOL_TOKEN -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_JOB_TEST_FAIL_ASSIGNMENT -ErrorAction SilentlyContinue;',
		'Remove-Item Env:WOK_JOB_TEST_PROTOCOL_FAILURE -ErrorAction SilentlyContinue;',
		'exit [WokWindowsJobHost]::Run(',
		'$executablePath,',
		'$expectedExecutableSha256,',
		'$expectedExecutableSizeBytes,',
		'$commandLine,',
		'$currentDirectory,',
		'$jobName,',
		'$monitorIntervalMs,',
		'$protocolToken,',
		'$testOnlyFailAssignmentBeforeResume,',
		'$testOnlyProtocolFailure',
		');'
	].join('\n');
	const child = spawn(
		'powershell.exe',
		[
			'-NoLogo',
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			powerShellCommand
		],
		{
			env: {
				...options.environment,
				WOK_JOB_COMMAND_LINE: commandLine,
				WOK_JOB_CURRENT_DIRECTORY: options.cwd,
				WOK_JOB_EXECUTABLE_PATH: options.executable.path,
				WOK_JOB_EXECUTABLE_SHA256: options.executable.sha256,
				WOK_JOB_EXECUTABLE_SIZE_BYTES: String(
					options.executable.sizeBytes
				),
				WOK_JOB_MONITOR_INTERVAL_MS: String(intervalMs),
				WOK_JOB_NAME: jobName,
				WOK_JOB_PROTOCOL_TOKEN: protocolToken,
				WOK_JOB_TEST_FAIL_ASSIGNMENT:
					options.testOnlyFailAssignmentBeforeResume ? '1' : '0',
				WOK_JOB_TEST_PROTOCOL_FAILURE:
					String(testOnlyProtocolFailure)
			},
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true
		}
	);
	let initialControlChannelError: Error | undefined;
	let handleControlChannelError = (error: Error): void => {
		initialControlChannelError ??= error;
	};
	child.stdin.on('error', error => {
		handleControlChannelError(error);
	});
	const startedAt = new Date().toISOString();
	let stdout = '';
	let stderr = '';
	let stdoutTruncated = false;
	let stderrTruncated = false;
	let startRecordSeen = false;
	let startSettled = false;
	let resolveStarted: (start: WindowsJobProcessStart) => void;
	let rejectStarted: (error: Error) => void;
	const started = new Promise<WindowsJobProcessStart>(
		(resolveStart, rejectStart) => {
			resolveStarted = resolveStart;
			rejectStarted = rejectStart;
		}
	);
	let resumedSettled = false;
	let resolveResumed: () => void;
	let rejectResumed: (error: Error) => void;
	const resumed = new Promise<void>((resolveResume, rejectResume) => {
		resolveResumed = resolveResume;
		rejectResumed = rejectResume;
	});
	const samples: WindowsProcessTreeSample[] = [];
	const rawSampleLines: string[] = [];
	const parseErrors: string[] = [];
	let firstSampleSettled = false;
	let resolveFirstSample: (
		sample: WindowsProcessTreeSample
	) => void;
	let rejectFirstSample: (error: Error) => void;
	const firstSample = new Promise<WindowsProcessTreeSample>(
		(resolveSample, rejectSample) => {
			resolveFirstSample = resolveSample;
			rejectFirstSample = rejectSample;
		}
	);
	void started.catch(() => {});
	void resumed.catch(() => {});
	void firstSample.catch(() => {});
	let protocolExit:
		| {
			exitCode: number;
			jobClean: boolean;
			processIds: readonly number[];
			terminationRequested: boolean;
		}
		| undefined;
	let protocolError: string | undefined;
	let stdoutRecordSeen = false;
	let stderrRecordSeen = false;
	let resolveCompleted: (exit: WindowsJobProcessExit) => void;
	const completed = new Promise<WindowsJobProcessExit>(resolveExit => {
		resolveCompleted = resolveExit;
	});
	let controlState: WindowsJobLifecycleState = 'suspended';
	let completedSettled = false;
	const pendingControlWrites = new Set<{
		reject: (error: Error) => void;
		settled: boolean;
	}>();
	const pendingProcessIdSnapshots = new Map<
		string,
		PendingWindowsJobProcessIdSnapshot
	>();
	const clearProcessIdSnapshotResources = (
		request: {
			abortListener?: () => void;
			signal?: AbortSignal;
			timer?: NodeJS.Timeout;
		}
	): void => {
		if (request.timer !== undefined) {
			clearTimeout(request.timer);
			delete request.timer;
		}
		if (
			request.signal !== undefined
			&& request.abortListener !== undefined
		) {
			request.signal.removeEventListener(
				'abort',
				request.abortListener
			);
			delete request.abortListener;
		}
	};
	const rejectPendingControlWrites = (error: Error): void => {
		for (const request of pendingControlWrites) {
			if (request.settled) continue;
			request.settled = true;
			request.reject(error);
		}
		pendingControlWrites.clear();
	};
	const rejectPendingProcessIdSnapshots = (
		error: Error,
		clear: boolean
	): void => {
		for (const [requestId, request] of pendingProcessIdSnapshots) {
			clearProcessIdSnapshotResources(request);
			if (!request.settled) {
				request.cancelled = true;
				request.settled = true;
				request.reject(error);
			}
			if (clear) pendingProcessIdSnapshots.delete(requestId);
		}
	};
	const failProtocol = (error: unknown): void => {
		if (protocolError !== undefined) return;
		protocolError = error instanceof Error
			? error.message
			: String(error);
		if (controlState !== 'closed') controlState = 'failed';
		if (parseErrors.length < 1_000) {
			parseErrors.push(protocolError.slice(0, 8_192));
		}
		const protocolFailure = new Error(protocolError);
		rejectPendingControlWrites(protocolFailure);
		rejectPendingProcessIdSnapshots(protocolFailure, true);
		if (!startSettled) {
			startSettled = true;
			rejectStarted(protocolFailure);
		}
		if (!firstSampleSettled) {
			firstSampleSettled = true;
			rejectFirstSample(protocolFailure);
		}
		if (!resumedSettled) {
			resumedSettled = true;
			rejectResumed(protocolFailure);
		}
		if (
			child.exitCode === null
			&& child.signalCode === null
		) {
			child.kill();
		}
	};
	const failControlChannel = (
		operation: string,
		error: unknown
	): Error => {
		const failure = new Error(
			`Failed to ${operation} through the Windows job control pipe: `
				+ (error instanceof Error ? error.message : String(error))
		);
		failProtocol(failure);
		return failure;
	};
	const writeControl = (
		value: string,
		operation: string
	): Promise<void> => new Promise((resolve, reject) => {
		if (
			child.exitCode !== null
			|| child.signalCode !== null
			|| child.stdin.destroyed
		) {
			const failure = failControlChannel(
				operation,
				new Error('Windows job host control pipe is unavailable.')
			);
			reject(failure);
			return;
		}
		const request = { reject, settled: false };
		pendingControlWrites.add(request);
		const settle = (error?: Error | null): void => {
			if (request.settled) return;
			request.settled = true;
			pendingControlWrites.delete(request);
			if (error !== undefined && error !== null) {
				reject(failControlChannel(operation, error));
				return;
			}
			resolve();
		};
		try {
			child.stdin.write(value, settle);
		} catch (error) {
			settle(
				error instanceof Error
					? error
					: new Error(String(error))
			);
		}
	});
	handleControlChannelError = error => {
		if (completedSettled) return;
		failControlChannel('use the Windows job control pipe', error);
	};
	if (initialControlChannelError !== undefined) {
		failControlChannel(
			'use the Windows job control pipe',
			initialControlChannelError
		);
	}
	const handleStdoutLine = (line: string): void => {
		if (!line.startsWith(protocolPrefix)) {
			const appended = appendBounded(stdout, `${line}\n`);
			stdout = appended.value;
			stdoutTruncated ||= appended.truncated;
			return;
		}
		if (protocolError !== undefined) return;
		const fields = line.slice(protocolPrefix.length).split('|');
		try {
			if (fields[0] === 'SAMPLE' && fields.length === 2) {
				if (!startRecordSeen) {
					throw new TypeError(
						'Windows job emitted a sample before start evidence.'
					);
				}
				const rawSample = decodeProtocolText(fields[1]);
				if (rawSampleLines.length < 10_000) {
					rawSampleLines.push(rawSample.slice(0, 1_048_576));
				}
				const sample = parseWindowsProcessTreeSample(rawSample);
				samples.push(sample);
				if (!firstSampleSettled) {
					firstSampleSettled = true;
					resolveFirstSample(sample);
				}
				options.onSample?.(sample);
				return;
			}
			if (fields[0] === 'PROCESS_IDS') {
				if (!startRecordSeen) {
					throw new TypeError(
						'Windows job emitted process IDs before start evidence.'
					);
				}
				if (
					fields.length < 2
					|| fields.length > MAX_JOB_PROCESS_IDS + 2
				) {
					throw new TypeError(
						'Windows job process-ID response has an invalid field count.'
					);
				}
				const requestId = fields[1];
				if (!PROCESS_ID_REQUEST_PATTERN.test(requestId)) {
					throw new TypeError(
						'Windows job process-ID response has an invalid request ID.'
					);
				}
				const request = pendingProcessIdSnapshots.get(requestId);
				if (request === undefined) {
					throw new TypeError(
						'Windows job emitted an unsolicited or duplicate process-ID response.'
					);
				}
				const processIds: number[] = [];
				const uniqueProcessIds = new Set<number>();
				for (let index = 2; index < fields.length; index += 1) {
					const processId = parsePositiveInteger(
						fields[index],
						`job process ID ${index - 1}`,
						0xffff_ffff
					);
					if (uniqueProcessIds.has(processId)) {
						throw new TypeError(
							'Windows job process-ID response contains duplicate process IDs.'
						);
					}
					uniqueProcessIds.add(processId);
					processIds.push(processId);
				}
				pendingProcessIdSnapshots.delete(requestId);
				clearProcessIdSnapshotResources(request);
				if (!request.cancelled && !request.settled) {
					request.settled = true;
					request.resolve(Object.freeze(processIds));
				}
				return;
			}
			if (
				fields[0] === 'MONITOR_ERROR'
				&& fields.length === 2
			) {
				throw new Error(
					`Windows job monitor failed: ${decodeProtocolText(fields[1])}`
				);
			}
			if (fields[0] === 'STARTED' && fields.length === 9) {
				if (startRecordSeen || startSettled) {
					throw new TypeError(
						'Windows job emitted duplicate start evidence.'
					);
				}
				const processId = parsePositiveInteger(
					fields[1],
					'job process ID',
					0xffff_ffff
				);
				const creationTimeUtcTicks = fields[2];
				if (
					!/^[1-9][0-9]{0,18}$/u.test(creationTimeUtcTicks)
					|| BigInt(creationTimeUtcTicks) % 10n !== 0n
					|| BigInt(creationTimeUtcTicks)
						> MAX_DOTNET_DATE_TIME_TICKS
				) {
					throw new TypeError(
						'Job process creation ticks are invalid.'
					);
				}
				const executablePath = decodeProtocolText(fields[3]);
				const finalPath = decodeProtocolText(fields[4]);
				if (
					executablePath.length === 0
					|| executablePath.length > 4_096
					|| executablePath.includes('\0')
					|| finalPath.length === 0
					|| finalPath.length > 4_096
					|| finalPath.includes('\0')
					|| !/^[0-9a-f]{16}$/u.test(fields[5])
					|| !/^[0-9a-f]{64}$/u.test(fields[6])
					|| !/^[0-9a-f]{8}$/u.test(fields[8])
				) {
					throw new TypeError(
						'Job process executable identity is invalid.'
					);
				}
				const sizeBytes = parsePositiveInteger(
					fields[7],
					'job executable size',
					Number.MAX_SAFE_INTEGER
				);
				if (
					fields[6] !== options.executable.sha256
					|| sizeBytes !== options.executable.sizeBytes
				) {
					throw new TypeError(
						'Job process executable bytes do not match the requested identity.'
					);
				}
				startRecordSeen = true;
				startSettled = true;
				resolveStarted({
					creationTimeUtcTicks: fields[2],
					executable: {
						fileIdHex: fields[5],
						finalPath,
						sha256: fields[6],
						sizeBytes,
						volumeSerialNumberHex: fields[8]
					},
					executablePath,
					processId
				});
				return;
			}
			if (fields[0] === 'RESUMED' && fields.length === 1) {
				if (!startRecordSeen || resumedSettled) {
					throw new TypeError(
						'Windows job emitted invalid resume evidence.'
					);
				}
				resumedSettled = true;
				if (controlState === 'resume-requested') {
					controlState = 'running';
				}
				resolveResumed();
				return;
			}
			if (
				(fields[0] === 'STDOUT' || fields[0] === 'STDERR')
				&& fields.length === 3
			) {
				if (!startRecordSeen) {
					throw new TypeError(
						'Windows job emitted candidate output before start evidence.'
					);
				}
				if (!/^[01]$/u.test(fields[2])) {
					throw new TypeError(
						'Windows job output truncation state must be 0 or 1.'
					);
				}
				const output = decodeProtocolText(fields[1]);
				if (fields[0] === 'STDOUT') {
					if (stdoutRecordSeen) {
						throw new TypeError(
							'Windows job emitted duplicate candidate stdout.'
						);
					}
					stdoutRecordSeen = true;
					const appended = appendBounded(stdout, output);
					stdout = appended.value;
					stdoutTruncated ||= appended.truncated
						|| fields[2] === '1';
				} else {
					if (stderrRecordSeen) {
						throw new TypeError(
							'Windows job emitted duplicate candidate stderr.'
						);
					}
					stderrRecordSeen = true;
					const appended = appendBounded(stderr, output);
					stderr = appended.value;
					stderrTruncated ||= appended.truncated
						|| fields[2] === '1';
				}
				return;
			}
			if (fields[0] === 'EXITED' && fields.length >= 5) {
				if (!startRecordSeen) {
					throw new TypeError(
						'Windows job emitted terminal evidence before start evidence.'
					);
				}
				if (protocolExit !== undefined) {
					throw new TypeError(
						'Windows job emitted duplicate terminal evidence.'
					);
				}
				if (!stdoutRecordSeen || !stderrRecordSeen) {
					throw new TypeError(
						'Windows job terminal evidence omitted candidate output records.'
					);
				}
				if (!/^[01]$/u.test(fields[2])) {
					throw new TypeError(
						'Windows job clean state must be 0 or 1.'
					);
				}
				if (!/^[01]$/u.test(fields[3])) {
					throw new TypeError(
						'Windows job termination state must be 0 or 1.'
					);
				}
				const processCount = parseNonNegativeInteger(
					fields[4],
					'job terminal process count',
					MAX_JOB_PROCESS_IDS
				);
				if (fields.length !== processCount + 5) {
					throw new TypeError(
						'Windows job terminal process count does not match its process IDs.'
					);
				}
				const processIds: number[] = [];
				const uniqueProcessIds = new Set<number>();
				for (let index = 5; index < fields.length; index += 1) {
					const processId = parsePositiveInteger(
						fields[index],
						`terminal job process ID ${index - 4}`,
						0xffff_ffff
					);
					if (uniqueProcessIds.has(processId)) {
						throw new TypeError(
							'Windows job terminal evidence contains duplicate process IDs.'
						);
					}
					uniqueProcessIds.add(processId);
					processIds.push(processId);
				}
				const jobClean = fields[2] === '1';
				if (jobClean !== (processIds.length === 0)) {
					throw new TypeError(
						'Windows job clean state does not match terminal membership.'
					);
				}
				protocolExit = {
					exitCode: parseNonNegativeInteger(
						fields[1],
						'job root exit code',
						0xffff_ffff
					),
					jobClean,
					processIds: Object.freeze(processIds),
					terminationRequested: fields[3] === '1'
				};
				return;
			}
			if (fields[0] === 'ERROR' && fields.length === 2) {
				failProtocol(new Error(decodeProtocolText(fields[1])));
				return;
			}
			throw new TypeError('Malformed Windows job protocol line.');
		} catch (error) {
			failProtocol(error);
		}
	};
	let stdoutLineParts: Buffer[] = [];
	let stdoutLineBytes = 0;
	let discardingOversizedLine = false;
	child.stdout.on('data', chunk => {
		const buffer = Buffer.isBuffer(chunk)
			? chunk
			: Buffer.from(chunk as string);
		let offset = 0;
		while (offset < buffer.length) {
			const newlineIndex = buffer.indexOf(0x0a, offset);
			const end = newlineIndex === -1
				? buffer.length
				: newlineIndex;
			const piece = buffer.subarray(offset, end);
			if (!discardingOversizedLine) {
				const nextLineBytes = stdoutLineBytes + piece.length;
				if (nextLineBytes > MAX_STDOUT_LINE_BYTES) {
					const lineParts = [...stdoutLineParts, piece];
					const prefixProbe = Buffer.concat(
						lineParts,
						Math.min(
							nextLineBytes,
							Buffer.byteLength(protocolPrefix)
						)
					).toString('utf8');
					if (prefixProbe.startsWith(protocolPrefix)) {
						failProtocol(new Error(
							'Windows job protocol line exceeded its byte limit.'
						));
					} else {
						const appended = appendBounded(
							stdout,
							Buffer.concat(
								lineParts,
								Math.min(
									nextLineBytes,
									MAX_CAPTURE_LOG_BYTES
								)
							)
						);
						stdout = appended.value;
						stdoutTruncated = true;
					}
					stdoutLineParts = [];
					stdoutLineBytes = 0;
					discardingOversizedLine = true;
				} else if (piece.length > 0) {
					stdoutLineParts.push(piece);
					stdoutLineBytes = nextLineBytes;
				}
			}
			if (newlineIndex === -1) break;
			if (!discardingOversizedLine) {
				const lineBuffer = Buffer.concat(
					stdoutLineParts,
					stdoutLineBytes
				);
				const lineEnd = lineBuffer.at(-1) === 0x0d
					? lineBuffer.length - 1
					: lineBuffer.length;
				handleStdoutLine(
					lineBuffer.subarray(0, lineEnd).toString('utf8')
				);
			}
			stdoutLineParts = [];
			stdoutLineBytes = 0;
			discardingOversizedLine = false;
			offset = newlineIndex + 1;
		}
	});
	child.stdout.on('end', () => {
		if (discardingOversizedLine || stdoutLineBytes === 0) return;
		handleStdoutLine(
			Buffer.concat(stdoutLineParts, stdoutLineBytes).toString('utf8')
		);
	});
	child.stderr.on('data', chunk => {
		const appended = appendBounded(stderr, chunk as Buffer);
		stderr = appended.value;
		stderrTruncated ||= appended.truncated;
	});
	child.once('error', error => {
		failProtocol(error);
	});
	child.once('close', (_ownerExitCode, signal) => {
		completedSettled = true;
		controlState = 'closed';
		const ownerClosedError = new Error(
			protocolError
				?? 'Windows job host exited before completing the process-ID request.'
		);
		rejectPendingControlWrites(ownerClosedError);
		rejectPendingProcessIdSnapshots(ownerClosedError, true);
		if (!startSettled) {
			startSettled = true;
			rejectStarted(new Error(
				protocolError
					?? 'Windows job host exited before starting the candidate.'
			));
		}
		if (!firstSampleSettled) {
			firstSampleSettled = true;
			rejectFirstSample(new Error(
				protocolError
					?? 'Windows job host exited before its first process sample.'
			));
		}
		if (!resumedSettled) {
			resumedSettled = true;
			rejectResumed(new Error(
				protocolError
					?? 'Windows job host exited before resuming the candidate.'
			));
		}
		const launchError = protocolError
			?? (protocolExit === undefined
				? 'Windows job host exited without a terminal record.'
				: protocolExit.jobClean
					? undefined
					: 'Windows job did not become empty before host exit.');
		const membership: WindowsJobMembershipEvidence =
			protocolError === undefined && protocolExit !== undefined
				? {
					processIds: protocolExit.processIds,
					status: 'reconciled'
				}
				: {
					reason: launchError
						?? 'Windows job terminal membership is unavailable.',
					status: 'unreconciled'
				};
		resolveCompleted({
			exitCode: protocolError === undefined
				? protocolExit?.exitCode ?? null
				: null,
			finishedAt: new Date().toISOString(),
			jobClean: membership.status === 'reconciled'
				&& membership.processIds.length === 0
				&& protocolExit?.jobClean === true,
			...(launchError === undefined ? {} : { launchError }),
			membership,
			signal,
			startedAt,
			stderr,
			stderrTruncated,
			stdout,
			stdoutTruncated,
			terminationRequested:
				protocolExit?.terminationRequested ?? false
		});
	});
	let resumePromise: Promise<void> | undefined;
	let terminationPromise: Promise<WindowsJobProcessExit> | undefined;
	const snapshotAbortError = (signal: AbortSignal): Error => {
		const reason = signal.reason;
		return new Error(
			'Windows job process-ID request was aborted'
				+ (reason === undefined
					? '.'
					: `: ${reason instanceof Error ? reason.message : String(reason)}`)
		);
	};
	const snapshotTimeoutError = (timeoutMs: number): Error =>
		new Error(
			'Windows job process-ID request timed out after '
				+ `${timeoutMs} ms; Job membership trust is lost.`
		);
	const waitForSnapshotStart = (
		signal: AbortSignal | undefined,
		timeoutMs: number
	): Promise<void> => {
		if (signal?.aborted) {
			return Promise.reject(snapshotAbortError(signal));
		}
		return new Promise<void>((resolveWait, rejectWait) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const finish = (error?: unknown): void => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener('abort', abort);
				if (error === undefined) resolveWait();
				else rejectWait(error);
			};
			const abort = (): void => {
				if (signal !== undefined) {
					finish(snapshotAbortError(signal));
				}
			};
			timer = setTimeout(() => {
				const timeoutError = snapshotTimeoutError(timeoutMs);
				finish(timeoutError);
				failProtocol(timeoutError);
			}, timeoutMs);
			signal?.addEventListener('abort', abort, { once: true });
			void started.then(
				() => finish(),
				error => finish(error)
			);
			if (signal?.aborted) abort();
		});
	};
	const snapshotProcessIds = async (
		snapshotOptions: WindowsJobSnapshotOptions = {}
	): Promise<readonly number[]> => {
		const timeoutMs = snapshotOptions.timeoutMs
			?? DEFAULT_PROCESS_ID_SNAPSHOT_TIMEOUT_MS;
		if (
			!Number.isInteger(timeoutMs)
			|| timeoutMs < 1
			|| timeoutMs > MAX_PROCESS_ID_SNAPSHOT_TIMEOUT_MS
		) {
			throw new RangeError(
				'Windows job process-ID snapshot timeout must be an integer '
					+ `from 1 through ${MAX_PROCESS_ID_SNAPSHOT_TIMEOUT_MS}.`
			);
		}
		if (snapshotOptions.signal?.aborted) {
			throw snapshotAbortError(snapshotOptions.signal);
		}
		const requestedAtMs = Date.now();
		await waitForSnapshotStart(
			snapshotOptions.signal,
			timeoutMs
		);
		if (snapshotOptions.signal?.aborted) {
			throw snapshotAbortError(snapshotOptions.signal);
		}
		const remainingTimeoutMs = timeoutMs
			- (Date.now() - requestedAtMs);
		if (remainingTimeoutMs <= 0) {
			const timeoutError = snapshotTimeoutError(timeoutMs);
			failProtocol(timeoutError);
			throw timeoutError;
		}
		if (
			controlState === 'termination-requested'
			|| controlState === 'failed'
			|| controlState === 'closed'
		) {
			throw new Error(
				'Cannot snapshot Windows job process IDs after control shutdown began.'
			);
		}
		if (protocolError !== undefined) {
			throw new Error(protocolError);
		}
		if (protocolExit !== undefined) {
			throw new Error(
				'Windows job host already emitted terminal evidence.'
			);
		}
		if (
			child.exitCode !== null
			|| child.signalCode !== null
			|| child.stdin.destroyed
		) {
			throw new Error(
				'Windows job host exited before the process-ID request.'
			);
		}
		if (
			pendingProcessIdSnapshots.size
			>= MAX_PENDING_PROCESS_ID_REQUESTS
		) {
			throw new Error(
				'Windows job has too many pending process-ID requests.'
			);
		}
		let requestId: string;
		do {
			requestId = randomBytes(16).toString('hex');
		} while (pendingProcessIdSnapshots.has(requestId));
		return new Promise<readonly number[]>((resolve, reject) => {
			const request: {
				abortListener?: () => void;
				cancelled: boolean;
				reject: (error: Error) => void;
				resolve: (processIds: readonly number[]) => void;
				settled: boolean;
				signal?: AbortSignal;
				timer?: NodeJS.Timeout;
				written: boolean;
			} = {
				cancelled: false,
				reject,
				resolve,
				settled: false,
				...(snapshotOptions.signal === undefined
					? {}
					: { signal: snapshotOptions.signal }),
				written: false
			};
			const rejectRequest = (
				error: Error,
				retainTombstone: boolean
			): void => {
				if (request.settled) return;
				request.cancelled = true;
				request.settled = true;
				clearProcessIdSnapshotResources(request);
				if (!retainTombstone) {
					pendingProcessIdSnapshots.delete(requestId);
				}
				reject(error);
			};
			request.abortListener = () => {
				if (request.signal === undefined) return;
				rejectRequest(
					snapshotAbortError(request.signal),
					request.written
				);
			};
			if (request.signal !== undefined) {
				request.signal.addEventListener(
					'abort',
					request.abortListener,
					{ once: true }
				);
			}
			request.timer = setTimeout(() => {
				if (
					request.settled
					|| pendingProcessIdSnapshots.get(requestId) !== request
				) {
					return;
				}
				const timeoutError = snapshotTimeoutError(timeoutMs);
				rejectRequest(timeoutError, true);
				failProtocol(timeoutError);
			}, remainingTimeoutMs);
			pendingProcessIdSnapshots.set(requestId, request);
			if (request.signal?.aborted) {
				rejectRequest(snapshotAbortError(request.signal), false);
				return;
			}
			const write = writeControl(
				`process-ids|${requestId}\n`,
				'write the Windows job process-ID request'
			);
			request.written = true;
			void write.catch(() => {});
		});
	};
	return {
		child,
		completed,
		firstSample,
		parseErrors,
		rawSampleLines,
		resume() {
			if (resumePromise !== undefined) return resumePromise;
			if (
				controlState === 'termination-requested'
				|| controlState === 'failed'
				|| controlState === 'closed'
			) {
				return Promise.reject(new Error(
					'Cannot resume a Windows job after control shutdown began.'
				));
			}
			controlState = 'resume-requested';
			resumePromise = (async () => {
				await started;
				await writeControl(
					'resume\n',
					'write the Windows job resume request'
				);
				await resumed;
			})().catch(error => {
				if (
					controlState !== 'termination-requested'
					&& controlState !== 'closed'
				) {
					controlState = 'failed';
				}
				throw error;
			});
			return resumePromise;
		},
		resumed,
		samples,
		snapshotProcessIds,
		started,
		get state() {
			return controlState;
		},
		terminate() {
			if (terminationPromise !== undefined) {
				return terminationPromise;
			}
			if (controlState !== 'failed' && controlState !== 'closed') {
				controlState = 'termination-requested';
			}
			rejectPendingProcessIdSnapshots(
				new Error(
					'Windows job process-ID request was cancelled by termination.'
				),
				false
			);
			terminationPromise = (async () => {
				if (
					child.exitCode === null
					&& child.signalCode === null
					&& !child.stdin.destroyed
				) {
					const write = writeControl(
						'terminate\n',
						'write the Windows job termination request'
					);
					try {
						child.stdin.end();
					} catch (error) {
						failControlChannel(
							'close the Windows job control pipe',
							error
						);
					}
					void write.catch(() => {});
				}
				return completed;
			})();
			return terminationPromise;
		}
	};
}
