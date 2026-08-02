import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSanitizedEnvironment } from '../adapter/launch-plan.ts';
import type { ProcessTreeResourceSample } from '../host/process-resources.ts';

const execFileAsync = promisify(execFile);
const MAX_DOTNET_DATE_TIME_TICKS = 3_155_378_975_999_999_999n;
const PROCESS_ID_QUERY_BATCH_SIZE = 128;

export interface WindowsProcessIdentity {
	commandLine: string;
	creationTimeUtcTicks: string;
	executableName: string;
	executablePath: string;
	parentProcessId: number;
	processId: number;
}

export interface WindowsProcessResourceReading extends WindowsProcessIdentity {
	cpuPercent: number;
	performanceCountersPresent: boolean;
	privateBytes: number;
	workingSetBytes: number;
}

export interface WindowsProcessTreeSample extends ProcessTreeResourceSample {
	foregroundOwnedByCandidateTree: boolean;
	foregroundProcessId: number;
	processes: readonly WindowsProcessResourceReading[];
}

function expectObject(value: unknown, field: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object.`);
	return value as Record<string, unknown>;
}

function expectString(value: unknown, field: string, maximumLength: number): string {
	if (typeof value !== 'string' || value.length > maximumLength) throw new TypeError(`${field} must be a bounded string.`);
	return value;
}

function expectBoolean(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') throw new TypeError(`${field} must be boolean.`);
	return value;
}

function expectCreationTimeUtcTicks(
	value: unknown,
	field: string
): string {
	if (
		typeof value !== 'string'
		|| !/^[1-9][0-9]{0,18}$/u.test(value)
		|| BigInt(value) % 10n !== 0n
		|| BigInt(value) > MAX_DOTNET_DATE_TIME_TICKS
	) {
		throw new TypeError(
			`${field} must be a positive canonical 10-tick UTC DateTime string.`
		);
	}
	return value;
}

function expectInteger(value: unknown, field: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new TypeError(`${field} must be an integer from ${minimum} through ${maximum}.`);
	}
	return value as number;
}

function expectNonNegative(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be finite and non-negative.`);
	return value;
}

function parseIdentity(value: unknown, field: string): WindowsProcessIdentity {
	const record = expectObject(value, field);
	return {
		commandLine: expectString(record.commandLine ?? '', `${field}.commandLine`, 32_768),
		creationTimeUtcTicks: expectCreationTimeUtcTicks(
			record.creationTimeUtcTicks,
			`${field}.creationTimeUtcTicks`
		),
		executableName: expectString(record.executableName, `${field}.executableName`, 1_024),
		executablePath: expectString(record.executablePath ?? '', `${field}.executablePath`, 4_096),
		parentProcessId: expectInteger(record.parentProcessId, `${field}.parentProcessId`, 0, 0xffff_ffff),
		processId: expectInteger(record.processId, `${field}.processId`, 1, 0xffff_ffff)
	};
}

export function parseWindowsProcessTreeSample(value: string): WindowsProcessTreeSample {
	const root = expectObject(JSON.parse(value) as unknown, 'sample');
	if (!Array.isArray(root.processes)) throw new TypeError('sample.processes must be an array.');
	return {
		capturedAtMs: expectNonNegative(root.capturedAtMs, 'sample.capturedAtMs'),
		foregroundOwnedByCandidateTree: expectBoolean(
			root.foregroundOwnedByCandidateTree,
			'sample.foregroundOwnedByCandidateTree'
		),
		foregroundProcessId: expectInteger(
			root.foregroundProcessId,
			'sample.foregroundProcessId',
			0,
			0xffff_ffff
		),
		processes: root.processes.map((process, index) => {
			const record = expectObject(process, `sample.processes[${index}]`);
			return {
				...parseIdentity(record, `sample.processes[${index}]`),
				cpuPercent: expectNonNegative(record.cpuPercent, `sample.processes[${index}].cpuPercent`),
				performanceCountersPresent: expectBoolean(
					record.performanceCountersPresent,
					`sample.processes[${index}].performanceCountersPresent`
				),
				privateBytes: expectInteger(record.privateBytes, `sample.processes[${index}].privateBytes`, 0, Number.MAX_SAFE_INTEGER),
				workingSetBytes: expectInteger(record.workingSetBytes, `sample.processes[${index}].workingSetBytes`, 0, Number.MAX_SAFE_INTEGER)
			};
		}),
		rootProcessId: expectInteger(root.rootProcessId, 'sample.rootProcessId', 1, 0xffff_ffff)
	};
}

const PROCESS_IDENTITY_PROJECTION = [
	'ForEach-Object { [PSCustomObject]@{',
	"commandLine = if ($null -eq $_.CommandLine) { '' } else { [string]$_.CommandLine };",
	"creationTimeUtcTicks = if ($null -eq $_.CreationDate) { '' } else { $ticks = [long]$_.CreationDate.ToUniversalTime().Ticks; [string]($ticks - ($ticks % 10)) };",
	'executableName = [string]$_.Name;',
	"executablePath = if ($null -eq $_.ExecutablePath) { '' } else { [string]$_.ExecutablePath };",
	'parentProcessId = [int]$_.ParentProcessId;',
	'processId = [int]$_.ProcessId',
	'} }'
].join(' ');

async function runWindowsProcessIdentityQuery(
	command: string,
	environment: NodeJS.ProcessEnv = {}
): Promise<WindowsProcessIdentity[]> {
	if (process.platform !== 'win32') throw new Error('Windows process discovery requires Windows.');
	const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
		env: {
			...buildSanitizedEnvironment(),
			...environment
		},
		maxBuffer: 4 * 1024 * 1024,
		timeout: 15_000,
		windowsHide: true
	});
	const parsed = JSON.parse(stdout.trim() || '[]') as unknown;
	if (!Array.isArray(parsed)) throw new TypeError('Windows process discovery did not return an array.');
	return parsed.map((item, index) => parseIdentity(item, `processes[${index}]`));
}

export async function listWindowsProcessesByExecutableName(executableName: string): Promise<WindowsProcessIdentity[]> {
	if (!/^[a-z0-9._-]+\.exe$/iu.test(executableName) || executableName.length > 260) {
		throw new TypeError('executableName must be a bounded executable base name.');
	}
	const command = [
		'$items = @(Get-CimInstance Win32_Process |',
		"Where-Object { $_.Name -ieq $env:WOK_RUNTIME_PROCESS_NAME } |",
		PROCESS_IDENTITY_PROJECTION,
		');',
		'ConvertTo-Json -InputObject @($items) -Compress -Depth 3'
	].join(' ');
	return runWindowsProcessIdentityQuery(command, {
		WOK_RUNTIME_PROCESS_NAME: executableName
	});
}

export async function listWindowsProcessesById(processIds: readonly number[]): Promise<WindowsProcessIdentity[]> {
	const ids = [...new Set(processIds.map(processId => expectInteger(processId, 'processId', 1, 0xffff_ffff)))];
	if (ids.length === 0) return [];
	if (ids.length > 4_096) throw new RangeError('No more than 4,096 process IDs can be queried at once.');
	const command = [
		'$items = @(Get-CimInstance',
		'-ClassName Win32_Process',
		'-Filter $env:WOK_RUNTIME_PROCESS_FILTER',
		'-Property CommandLine,CreationDate,ExecutablePath,Name,ParentProcessId,ProcessId |',
		PROCESS_IDENTITY_PROJECTION,
		');',
		'ConvertTo-Json -InputObject @($items) -Compress -Depth 3'
	].join(' ');
	const identities: WindowsProcessIdentity[] = [];
	for (
		let offset = 0;
		offset < ids.length;
		offset += PROCESS_ID_QUERY_BATCH_SIZE
	) {
		const filter = ids
			.slice(offset, offset + PROCESS_ID_QUERY_BATCH_SIZE)
			.map(processId => `ProcessId = ${processId}`)
			.join(' OR ');
		identities.push(...await runWindowsProcessIdentityQuery(command, {
			WOK_RUNTIME_PROCESS_FILTER: filter
		}));
	}
	return identities;
}

