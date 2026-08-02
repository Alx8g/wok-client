import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import { parsePresentMonCsv } from './presentmon-csv.ts';
import { sha256Hex } from '../shared/hash.ts';
import { assertRuntimeLabIdentifier } from '../shared/protocol.ts';

const ETL_RECORDER_SESSION_PREFIX = 'WOKRuntimeLabFile';
const ETL_RECORDER_SCHEMA_VERSION = 5;
const MAX_SESSION_RUN_ID_LENGTH = 44;
const MAX_RECORDER_SESSION_NAME_LENGTH = 1023;
const MAX_SIDECAR_BYTES = 64 * 1024;
const MAX_ARTIFACT_FILENAME_LENGTH = 240;
const MAX_RECORDER_ETL_PATH_LENGTH = 32_767;
const MAX_JOB_PROCESS_IDS = 16_384;
const MIN_RECORDING_DURATION_MS = 100;
const MAX_RECORDING_DURATION_MS = 10 * 60 * 1000;
const ERROR_SUCCESS = 0;
const WAIT_TIMEOUT = 258;
const FILETIME_UNIX_EPOCH_TICKS = 116_444_736_000_000_000n;
const FILETIME_TICKS_PER_MILLISECOND = 10_000n;
const ZERO_SHA256 = '0'.repeat(64);
const PRESENTMON_V2_REPLAY_HEADER = [
	'Application',
	'ProcessID',
	'SwapChainAddress',
	'PresentRuntime',
	'SyncInterval',
	'PresentFlags',
	'AllowsTearing',
	'PresentMode',
	'CPUStartDateTime',
	'FrameTime',
	'CPUBusy',
	'CPUWait',
	'DisplayLatency',
	'DisplayedTime',
	'AnimationError',
	'AnimationTime',
	'MsFlipDelay'
].join(',');
const DOS_DEVICE_NAMES = new Set([
	'CON',
	'PRN',
	'AUX',
	'NUL',
	...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
	...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)
]);
const VOLUME_GUID_PATH_PATTERN = /^\\\\\?\\Volume\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\\/iu;
const SNAPSHOT_KEYS = [
	'queryStatus',
	'bufferSizeKiB',
	'minimumBuffers',
	'maximumBuffers',
	'numberOfBuffers',
	'freeBuffers',
	'eventsLost',
	'buffersWritten',
	'logBuffersLost',
	'realTimeBuffersLost'
] as const;

export interface EtlRecorderSnapshot {
	bufferSizeKiB: number;
	buffersWritten: number;
	eventsLost: number;
	freeBuffers: number;
	logBuffersLost: number;
	maximumBuffers: number;
	minimumBuffers: number;
	numberOfBuffers: number;
	queryStatus: number;
	realTimeBuffersLost: number;
}

export interface EtlRecorderReadySidecar {
	captureStartFileTimeUtc: string;
	durationMs: number;
	effective: EtlRecorderSnapshot;
	etlFileIndex: string;
	etlIdentityVerifiedForCapture: boolean;
	etlPath: string;
	etlVolumeSerialNumber: string;
	filterEventIds: boolean;
	isWin11OrGreater: boolean;
	operationalEtlPath: string;
	phase: 'ready';
	processEventsEnabled: boolean;
	processEventsRequired: boolean;
	processRundownRequested: boolean;
	requested: {
		bufferSizeKiB: number;
		flushTimerSeconds: number;
		maximumBuffers: number;
		minimumBuffers: number;
	};
	sessionName: string;
	version: 5;
}

export interface EtlRecorderStatusSidecar {
	beforeStop: EtlRecorderSnapshot;
	captureStartFileTimeUtc: string;
	captureStopFileTimeUtc: string;
	cleanupStopStatus: number;
	durationMs: number;
	etlExists: boolean;
	etlFileIndex: string;
	etlFinalized: boolean;
	etlIdentityVerifiedAfterStop: boolean;
	etlIdentityVerifiedForCapture: boolean;
	etlPath: string;
	etlReadLease: 'held-until-controller-release' | 'unavailable';
	etlSha256: string;
	etlSizeBytes: number;
	etlVolumeSerialNumber: string;
	filterEventIds: boolean;
	initial: EtlRecorderSnapshot;
	operationalEtlPath: string;
	phase: 'completed';
	processEventsEnabled: boolean;
	processEventsRequired: boolean;
	processRundownRequested: boolean;
	providerStatus: number;
	sessionName: string;
	startStatus: number;
	stopAttemptStatuses: number[];
	stopStatus: number;
	stopped: EtlRecorderSnapshot;
	valid: boolean;
	version: 5;
	waitStatus: number;
}

export interface EtlRecorderLaunchOptions {
	durationMs: number;
	etlPath: string;
	readyPath: string;
	runId: string;
	statusPath: string;
}

export interface EtlRecorderLaunchArguments extends EtlRecorderLaunchOptions {
	args: string[];
	releaseToken: string;
	sessionName: string;
}

export interface AcceptedEtlRecorderCapture {
	captureStartFileTimeUtc: string;
	captureStopFileTimeUtc: string;
	etlFileIndex: string;
	etlReadLease: 'held-until-controller-release';
	etlSha256: string;
	etlSizeBytes: number;
	etlVolumeSerialNumber: string;
	operationalEtlPath: string;
	sessionName: string;
}

export interface OfflinePresentMonOptions {
	acceptedCapture: AcceptedEtlRecorderCapture;
	outputCsvPath: string;
	targetProcessId?: number;
	targetProcessName?: string;
}

export interface OfflinePresentMonArguments {
	args: string[];
	etlPath: string;
	outputCsvPath: string;
	targetProcessId?: number;
	targetProcessName?: string;
}

export interface EtlProcessEventInspectionOptions {
	acceptedCapture: AcceptedEtlRecorderCapture;
	targetProcessId: number;
}

export interface EtlProcessEventInspectionArguments {
	args: string[];
	etlPath: string;
	targetProcessId: number;
}

export interface EtlRecorderExpectedIdentity {
	durationMs: number;
	etlPath: string;
	sessionName: string;
}

export interface EtlRecorderAssessment {
	reasons: string[];
	valid: boolean;
}

export interface OfflinePresentMonFileIdentity {
	fileIndex: string;
	volumeSerialNumber: string;
}

export interface OfflinePresentMonReplayEvidence {
	exitCode: number | null;
	outputContents: Uint8Array | undefined;
	outputExistedBefore: boolean;
	outputExistsAfter: boolean;
	outputIdentityAfterRead: OfflinePresentMonFileIdentity | undefined;
	outputIdentityAtOpen: OfflinePresentMonFileIdentity | undefined;
	outputPath: string;
	outputSha256AfterRead: string | undefined;
	outputSizeBytesAfterRead: number;
	outputSizeBytesAtOpen: number;
	stderr: string;
	stderrComplete: boolean;
	stdoutByteLimitExceeded: boolean;
	stdoutComplete: boolean;
	stdoutSha256: string;
	stdoutSizeBytes: number;
	terminatedByController: boolean;
}

interface OfflinePresentMonReplayExpectationBase {
	expectedOutputPath: string;
	minimumFrameRecords?: number;
}

export interface OfflinePresentMonPidReplayExpectation extends OfflinePresentMonReplayExpectationBase {
	expectedApplicationName: string;
	mode: 'process-id';
	targetProcessId: number;
}

export interface OfflinePresentMonNameReplayExpectation extends OfflinePresentMonReplayExpectationBase {
	allowedProcessIds: readonly number[];
	mode: 'process-name';
	targetProcessName: string;
}

export type OfflinePresentMonReplayExpectation =
	| OfflinePresentMonNameReplayExpectation
	| OfflinePresentMonPidReplayExpectation;

export interface OfflinePresentMonReplayAssessment extends EtlRecorderAssessment {
	applicationNames: string[];
	capturedProcessIds: number[];
	malformedRowCount: number;
	recordCount: number;
}

const acceptedEtlRecorderCaptures = new WeakSet<object>();
const parsedEtlRecorderReadySidecars = new WeakSet<object>();
const parsedEtlRecorderStatusSidecars = new WeakSet<object>();

function deepFreeze<T extends object>(
	value: T,
	visited = new WeakSet<object>()
): T {
	if (visited.has(value)) return value;
	visited.add(value);
	for (const nested of Object.values(value)) {
		if (nested !== null && typeof nested === 'object') {
			deepFreeze(nested, visited);
		}
	}
	return Object.freeze(value);
}

function registerParsedSidecar<T extends object>(
	value: T,
	registry: WeakSet<object>
): T {
	const immutable = deepFreeze(value);
	registry.add(immutable);
	return immutable;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeUtf8Bytes(contents: Uint8Array, label: string): string {
	if (!(contents instanceof Uint8Array)) {
		throw new TypeError(`${label} must be supplied as the exact file bytes.`);
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(contents);
	} catch (error) {
		throw new TypeError(`${label} must contain valid UTF-8.`, { cause: error });
	}
}

function parseJsonObject(contents: Uint8Array, label: string): Record<string, unknown> {
	const byteLength = contents.byteLength;
	if (byteLength === 0 || byteLength > MAX_SIDECAR_BYTES) {
		throw new TypeError(`${label} must contain between 1 and ${MAX_SIDECAR_BYTES} bytes.`);
	}
	const text = decodeUtf8Bytes(contents, label);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new TypeError(`${label} must contain valid JSON.`, { cause: error });
	}
	if (!isRecord(value)) throw new TypeError(`${label} must contain a JSON object.`);
	return value;
}

function assertExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[], label: string): void {
	const expected = new Set(expectedKeys);
	const missing = expectedKeys.filter(key => !Object.hasOwn(record, key));
	const unexpected = Object.keys(record).filter(key => !expected.has(key));
	if (missing.length > 0) {
		throw new TypeError(`${label}.${missing[0]} is required by the closed schema.`);
	}
	if (unexpected.length > 0) {
		throw new TypeError(`${label}.${unexpected[0]} is not allowed by the closed schema.`);
	}
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
	const value = record[key];
	if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
		throw new TypeError(`${label}.${key} must be a non-empty string without null bytes.`);
	}
	return value;
}

function requiredBoundedString(
	record: Record<string, unknown>,
	key: string,
	label: string,
	maximumLength: number
): string {
	const value = requiredString(record, key, label);
	if (value.length > maximumLength) {
		throw new TypeError(`${label}.${key} must not exceed ${maximumLength} UTF-16 code units.`);
	}
	return value;
}

function requiredBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
	const value = record[key];
	if (typeof value !== 'boolean') throw new TypeError(`${label}.${key} must be boolean.`);
	return value;
}

function requiredUint32(record: Record<string, unknown>, key: string, label: string): number {
	const value = record[key];
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
		throw new TypeError(`${label}.${key} must be an unsigned 32-bit integer.`);
	}
	return value;
}

function requiredUint32Array(record: Record<string, unknown>, key: string, label: string): number[] {
	const value = record[key];
	if (!Array.isArray(value)) throw new TypeError(`${label}.${key} must be an array.`);
	return value.map((entry, index) => {
		if (
			typeof entry !== 'number'
			|| !Number.isInteger(entry)
			|| entry < 0
			|| entry > 0xffff_ffff
		) {
			throw new TypeError(`${label}.${key}[${index}] must be an unsigned 32-bit integer.`);
		}
		return entry;
	});
}

function requiredSafeInteger(record: Record<string, unknown>, key: string, label: string): number {
	const value = record[key];
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${label}.${key} must be a non-negative safe integer.`);
	}
	return value;
}

function requiredObject(record: Record<string, unknown>, key: string, label: string): Record<string, unknown> {
	const value = record[key];
	if (!isRecord(value)) throw new TypeError(`${label}.${key} must be an object.`);
	return value;
}

function requiredVolumeSerialNumber(record: Record<string, unknown>, key: string, label: string): string {
	const value = requiredString(record, key, label);
	if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || BigInt(value) > 0xffff_ffffn) {
		throw new TypeError(`${label}.${key} must be a canonical decimal unsigned 32-bit integer string.`);
	}
	return value;
}

function requiredFileIndex(record: Record<string, unknown>, key: string, label: string): string {
	const value = requiredString(record, key, label);
	if (!/^[0-9a-f]{16}$/u.test(value)) {
		throw new TypeError(`${label}.${key} must be a lowercase 16-character hexadecimal file index.`);
	}
	return value;
}

function requiredFileTimeUtc(
	record: Record<string, unknown>,
	key: string,
	label: string
): string {
	const value = requiredString(record, key, label);
	if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
		throw new TypeError(
			`${label}.${key} must be a canonical decimal unsigned FILETIME string.`
		);
	}
	const ticks = BigInt(value);
	if (ticks > 0xffff_ffff_ffff_ffffn) {
		throw new TypeError(
			`${label}.${key} must fit in an unsigned 64-bit FILETIME.`
		);
	}
	return value;
}

function requiredSha256(
	record: Record<string, unknown>,
	key: string,
	label: string
): string {
	const value = requiredString(record, key, label);
	if (!/^[0-9a-f]{64}$/u.test(value)) {
		throw new TypeError(
			`${label}.${key} must be a lowercase 64-character SHA-256.`
		);
	}
	return value;
}

function requiredEtlReadLease(
	record: Record<string, unknown>,
	key: string,
	label: string
): EtlRecorderStatusSidecar['etlReadLease'] {
	const value = requiredString(record, key, label);
	if (
		value !== 'held-until-controller-release'
		&& value !== 'unavailable'
	) {
		throw new TypeError(
			`${label}.${key} must describe the native ETL read lease state.`
		);
	}
	return value;
}

export function captureFileTimeUtcToUnixMs(
	value: string,
	boundary: 'start' | 'stop'
): number {
	if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
		throw new TypeError(
			'Capture FILETIME must be a canonical decimal unsigned integer string.'
		);
	}
	const ticks = BigInt(value);
	if (
		ticks < FILETIME_UNIX_EPOCH_TICKS
		|| ticks > 0xffff_ffff_ffff_ffffn
	) {
		throw new RangeError(
			'Capture FILETIME must represent a UTC instant at or after the Unix epoch.'
		);
	}
	const unixTicks = ticks - FILETIME_UNIX_EPOCH_TICKS;
	const unixMs = boundary === 'start'
		? unixTicks / FILETIME_TICKS_PER_MILLISECOND
		: (
			unixTicks + FILETIME_TICKS_PER_MILLISECOND - 1n
		) / FILETIME_TICKS_PER_MILLISECOND;
	if (unixMs > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new RangeError(
			'Capture FILETIME exceeds the JavaScript safe millisecond range.'
		);
	}
	return Number(unixMs);
}

function assertFileIdentity(value: OfflinePresentMonFileIdentity, label: string): void {
	if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
	assertExactKeys(value, ['volumeSerialNumber', 'fileIndex'], label);
	requiredVolumeSerialNumber(value, 'volumeSerialNumber', label);
	requiredFileIndex(value, 'fileIndex', label);
}

function fileIdentitiesEqual(
	left: OfflinePresentMonFileIdentity,
	right: OfflinePresentMonFileIdentity
): boolean {
	return left.volumeSerialNumber === right.volumeSerialNumber
		&& left.fileIndex === right.fileIndex;
}

function assertLiteral(record: Record<string, unknown>, key: string, expected: unknown, label: string): void {
	if (record[key] !== expected) throw new TypeError(`${label}.${key} must equal ${JSON.stringify(expected)}.`);
}

function parseSnapshot(value: unknown, label: string): EtlRecorderSnapshot {
	if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
	assertExactKeys(value, SNAPSHOT_KEYS, label);
	return {
		queryStatus: requiredUint32(value, 'queryStatus', label),
		bufferSizeKiB: requiredUint32(value, 'bufferSizeKiB', label),
		minimumBuffers: requiredUint32(value, 'minimumBuffers', label),
		maximumBuffers: requiredUint32(value, 'maximumBuffers', label),
		numberOfBuffers: requiredUint32(value, 'numberOfBuffers', label),
		freeBuffers: requiredUint32(value, 'freeBuffers', label),
		eventsLost: requiredUint32(value, 'eventsLost', label),
		buffersWritten: requiredUint32(value, 'buffersWritten', label),
		logBuffersLost: requiredUint32(value, 'logBuffersLost', label),
		realTimeBuffersLost: requiredUint32(value, 'realTimeBuffersLost', label)
	};
}

function assertSafeArtifactFilename(value: string, extension: string, label: string): void {
	const filename = win32.basename(value);
	if (filename.length === 0 || filename.length > MAX_ARTIFACT_FILENAME_LENGTH) {
		throw new TypeError(`${label} filename must contain from 1 through ${MAX_ARTIFACT_FILENAME_LENGTH} characters.`);
	}
	if (filename.endsWith('.') || filename.endsWith(' ')) {
		throw new TypeError(`${label} filename must not end with a period or space.`);
	}
	if (!/^[a-z0-9._-]+$/iu.test(filename)) {
		throw new TypeError(`${label} filename may contain only ASCII letters, digits, periods, underscores, and hyphens.`);
	}
	if (win32.extname(filename).toLowerCase() !== extension) {
		throw new TypeError(`${label} must name a ${extension} file.`);
	}
	const firstPeriod = filename.indexOf('.');
	const deviceStem = (firstPeriod === -1 ? filename : filename.slice(0, firstPeriod)).toUpperCase();
	if (DOS_DEVICE_NAMES.has(deviceStem)) {
		throw new TypeError(`${label} filename must not use a reserved DOS device name.`);
	}
}

function assertAbsoluteArtifactPath(value: string, extension: string, label: string): void {
	if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
		throw new TypeError(`${label} must be a non-empty path without null bytes.`);
	}
	if (!win32.isAbsolute(value)) throw new TypeError(`${label} must be absolute.`);
	assertSafeArtifactFilename(value, extension, label);
}

function assertOperationalEtlPath(value: string, label: string): void {
	assertAbsoluteArtifactPath(value, '.etl', label);
	const prefix = VOLUME_GUID_PATH_PATTERN.exec(value)?.[0];
	if (prefix === undefined) {
		throw new TypeError(`${label} must use a volume-GUID path.`);
	}
	if (value.length > MAX_RECORDER_ETL_PATH_LENGTH) {
		throw new TypeError(`${label} must not exceed ${MAX_RECORDER_ETL_PATH_LENGTH} UTF-16 code units.`);
	}
	if (value.includes('/')) {
		throw new TypeError(`${label} must use canonical Windows backslash separators.`);
	}
	const suffixSegments = value.slice(prefix.length).split('\\');
	if (
		suffixSegments.length === 0
		|| suffixSegments.some(segment => segment.length === 0 || segment === '.' || segment === '..')
	) {
		throw new TypeError(`${label} must not contain empty or relative path segments.`);
	}
	if (win32.normalize(value) !== value) {
		throw new TypeError(`${label} must be a normalized final path.`);
	}
}

function windowsPathIdentity(value: string): string {
	return win32.normalize(value).toLowerCase();
}

function assertDistinctArtifactPaths(paths: readonly string[], label: string): void {
	const identities = paths.map(windowsPathIdentity);
	if (new Set(identities).size !== identities.length) {
		throw new TypeError(`${label} paths must be distinct under Windows path semantics.`);
	}
}

function assertSameArtifactParent(paths: readonly string[], label: string): void {
	const parents = paths.map(path => windowsPathIdentity(win32.dirname(path)));
	if (new Set(parents).size !== 1) {
		throw new TypeError(`${label} paths must share one parent directory under Windows path semantics.`);
	}
}

function assertRecordingDuration(durationMs: number): void {
	if (
		!Number.isInteger(durationMs)
		|| durationMs < MIN_RECORDING_DURATION_MS
		|| durationMs > MAX_RECORDING_DURATION_MS
	) {
		throw new TypeError(
			`durationMs must be an integer from ${MIN_RECORDING_DURATION_MS} through ${MAX_RECORDING_DURATION_MS}.`
		);
	}
}

function createRecorderSessionName(runId: string): string {
	const boundedRunId = runId.slice(0, MAX_SESSION_RUN_ID_LENGTH);
	return `${ETL_RECORDER_SESSION_PREFIX}-${boundedRunId}-${randomUUID()}`;
}

function validateOfflinePresentMonTarget(options: Pick<OfflinePresentMonOptions, 'targetProcessId' | 'targetProcessName'>): string[] {
	const hasProcessId = options.targetProcessId !== undefined;
	const hasProcessName = options.targetProcessName !== undefined;
	if (hasProcessId === hasProcessName) {
		throw new TypeError('Exactly one offline PresentMon target must be provided.');
	}
	if (
		hasProcessId
		&& (
			!Number.isInteger(options.targetProcessId)
			|| options.targetProcessId < 1
			|| options.targetProcessId > 0xffff_ffff
		)
	) {
		throw new TypeError('targetProcessId must be a positive 32-bit process ID.');
	}
	if (hasProcessName) {
		assertSafeArtifactFilename(String(options.targetProcessName), '.exe', 'targetProcessName');
		if (win32.basename(String(options.targetProcessName)) !== options.targetProcessName) {
			throw new TypeError('targetProcessName must be an executable base name, not a path.');
		}
	}
	return hasProcessId
		? ['--process_id', String(options.targetProcessId)]
		: ['--process_name', String(options.targetProcessName)];
}

export function buildEtlRecorderLaunchArguments(options: EtlRecorderLaunchOptions): EtlRecorderLaunchArguments {
	assertRuntimeLabIdentifier(options.runId, 'runId');
	assertRecordingDuration(options.durationMs);
	assertAbsoluteArtifactPath(options.etlPath, '.etl', 'etlPath');
	if (options.etlPath.length > MAX_RECORDER_ETL_PATH_LENGTH) {
		throw new TypeError(`etlPath must not exceed ${MAX_RECORDER_ETL_PATH_LENGTH} UTF-16 code units for the native recorder buffer.`);
	}
	assertAbsoluteArtifactPath(options.readyPath, '.json', 'readyPath');
	assertAbsoluteArtifactPath(options.statusPath, '.json', 'statusPath');
	assertSameArtifactParent([options.etlPath, options.readyPath, options.statusPath], 'Recorder artifact');
	assertDistinctArtifactPaths([
		options.etlPath,
		options.readyPath,
		options.statusPath,
		`${options.readyPath}.tmp`,
		`${options.statusPath}.tmp`
	], 'Recorder artifact');

	const sessionName = createRecorderSessionName(options.runId);
	const releaseToken = randomUUID().replaceAll('-', '');
	return {
		...options,
		releaseToken,
		sessionName,
		args: [
			'--session-name', sessionName,
			'--etl-file', options.etlPath,
			'--ready-file', options.readyPath,
			'--status-file', options.statusPath,
			'--duration-ms', String(options.durationMs),
			'--release-token', releaseToken
		]
	};
}

export function buildOfflinePresentMonArguments(options: OfflinePresentMonOptions): OfflinePresentMonArguments {
	if (
		!isRecord(options.acceptedCapture)
		|| !acceptedEtlRecorderCaptures.has(options.acceptedCapture)
	) {
		throw new TypeError('acceptedCapture must come from acceptEtlRecorderPair().');
	}
	const etlPath = options.acceptedCapture.operationalEtlPath;
	assertOperationalEtlPath(etlPath, 'acceptedCapture.operationalEtlPath');
	assertAbsoluteArtifactPath(options.outputCsvPath, '.csv', 'outputCsvPath');
	assertDistinctArtifactPaths(
		[etlPath, options.outputCsvPath],
		'Offline PresentMon artifact'
	);
	const targetArguments = validateOfflinePresentMonTarget(options);
	return {
		args: [
			'--etl_file', etlPath,
			...targetArguments,
			'--output_stdout',
			'--date_time',
			'--v2_metrics',
			'--no_console_stats',
			'--no_track_gpu',
			'--no_track_input',
			'--set_circular_buffer_size', '16384'
		],
		etlPath,
		outputCsvPath: options.outputCsvPath,
		...(options.targetProcessId === undefined
			? { targetProcessName: options.targetProcessName }
			: { targetProcessId: options.targetProcessId })
	};
}

export function buildEtlProcessEventInspectionArguments(
	options: EtlProcessEventInspectionOptions
): EtlProcessEventInspectionArguments {
	if (
		!isRecord(options.acceptedCapture)
		|| !acceptedEtlRecorderCaptures.has(options.acceptedCapture)
	) {
		throw new TypeError('acceptedCapture must come from acceptEtlRecorderPair().');
	}
	if (
		!Number.isInteger(options.targetProcessId)
		|| options.targetProcessId < 1
		|| options.targetProcessId > 0xffff_ffff
	) {
		throw new TypeError('targetProcessId must be a positive uint32.');
	}
	const etlPath = options.acceptedCapture.operationalEtlPath;
	assertOperationalEtlPath(etlPath, 'acceptedCapture.operationalEtlPath');
	return {
		args: [
			'--inspect-etl', etlPath,
			'--expected-etl-sha256', options.acceptedCapture.etlSha256,
			'--expected-etl-size-bytes', String(options.acceptedCapture.etlSizeBytes),
			'--expected-etl-file-index', options.acceptedCapture.etlFileIndex,
			'--expected-etl-volume-serial-number', options.acceptedCapture.etlVolumeSerialNumber,
			'--target-process-id', String(options.targetProcessId)
		],
		etlPath,
		targetProcessId: options.targetProcessId
	};
}

export function parseEtlRecorderReadySidecar(contents: Uint8Array): EtlRecorderReadySidecar {
	const record = parseJsonObject(contents, 'ETL recorder ready sidecar');
	assertExactKeys(record, [
		'version',
		'phase',
		'captureStartFileTimeUtc',
		'sessionName',
		'etlPath',
		'operationalEtlPath',
		'etlVolumeSerialNumber',
		'etlFileIndex',
		'etlIdentityVerifiedForCapture',
		'durationMs',
		'filterEventIds',
		'processEventsRequired',
		'processEventsEnabled',
		'processRundownRequested',
		'isWin11OrGreater',
		'requested',
		'effective'
	], 'ready');
	assertLiteral(record, 'version', ETL_RECORDER_SCHEMA_VERSION, 'ready');
	assertLiteral(record, 'phase', 'ready', 'ready');
	const requested = requiredObject(record, 'requested', 'ready');
	assertExactKeys(requested, [
		'bufferSizeKiB',
		'minimumBuffers',
		'maximumBuffers',
		'flushTimerSeconds'
	], 'ready.requested');
	const etlPath = requiredString(record, 'etlPath', 'ready');
	const operationalEtlPath = requiredString(record, 'operationalEtlPath', 'ready');
	const durationMs = requiredUint32(record, 'durationMs', 'ready');
	assertAbsoluteArtifactPath(etlPath, '.etl', 'ready.etlPath');
	assertOperationalEtlPath(operationalEtlPath, 'ready.operationalEtlPath');
	assertRecordingDuration(durationMs);
	const parsed: EtlRecorderReadySidecar = {
		version: 5,
		phase: 'ready',
		captureStartFileTimeUtc: requiredFileTimeUtc(
			record,
			'captureStartFileTimeUtc',
			'ready'
		),
		sessionName: requiredBoundedString(
			record,
			'sessionName',
			'ready',
			MAX_RECORDER_SESSION_NAME_LENGTH
		),
		etlPath,
		operationalEtlPath,
		etlVolumeSerialNumber: requiredVolumeSerialNumber(record, 'etlVolumeSerialNumber', 'ready'),
		etlFileIndex: requiredFileIndex(record, 'etlFileIndex', 'ready'),
		etlIdentityVerifiedForCapture: requiredBoolean(record, 'etlIdentityVerifiedForCapture', 'ready'),
		durationMs,
		filterEventIds: requiredBoolean(record, 'filterEventIds', 'ready'),
		processEventsRequired: requiredBoolean(record, 'processEventsRequired', 'ready'),
		processEventsEnabled: requiredBoolean(record, 'processEventsEnabled', 'ready'),
		processRundownRequested: requiredBoolean(record, 'processRundownRequested', 'ready'),
		isWin11OrGreater: requiredBoolean(record, 'isWin11OrGreater', 'ready'),
		requested: {
			bufferSizeKiB: requiredUint32(requested, 'bufferSizeKiB', 'ready.requested'),
			minimumBuffers: requiredUint32(requested, 'minimumBuffers', 'ready.requested'),
			maximumBuffers: requiredUint32(requested, 'maximumBuffers', 'ready.requested'),
			flushTimerSeconds: requiredUint32(requested, 'flushTimerSeconds', 'ready.requested')
		},
		effective: parseSnapshot(record.effective, 'ready.effective')
	};
	return registerParsedSidecar(
		parsed,
		parsedEtlRecorderReadySidecars
	);
}

export function parseEtlRecorderStatusSidecar(contents: Uint8Array): EtlRecorderStatusSidecar {
	const record = parseJsonObject(contents, 'ETL recorder status sidecar');
	assertExactKeys(record, [
		'version',
		'phase',
		'valid',
		'captureStartFileTimeUtc',
		'captureStopFileTimeUtc',
		'sessionName',
		'etlPath',
		'operationalEtlPath',
		'etlVolumeSerialNumber',
		'etlFileIndex',
		'etlIdentityVerifiedForCapture',
		'etlIdentityVerifiedAfterStop',
		'durationMs',
		'filterEventIds',
		'processEventsRequired',
		'processEventsEnabled',
		'processRundownRequested',
		'startStatus',
		'providerStatus',
		'initial',
		'waitStatus',
		'beforeStop',
		'stopStatus',
		'cleanupStopStatus',
		'stopAttemptStatuses',
		'etlFinalized',
		'stopped',
		'etlExists',
		'etlSizeBytes',
		'etlSha256',
		'etlReadLease'
	], 'status');
	assertLiteral(record, 'version', ETL_RECORDER_SCHEMA_VERSION, 'status');
	assertLiteral(record, 'phase', 'completed', 'status');
	const etlPath = requiredString(record, 'etlPath', 'status');
	const operationalEtlPath = requiredString(record, 'operationalEtlPath', 'status');
	const durationMs = requiredUint32(record, 'durationMs', 'status');
	assertAbsoluteArtifactPath(etlPath, '.etl', 'status.etlPath');
	assertOperationalEtlPath(operationalEtlPath, 'status.operationalEtlPath');
	assertRecordingDuration(durationMs);
	const parsed: EtlRecorderStatusSidecar = {
		version: 5,
		phase: 'completed',
		valid: requiredBoolean(record, 'valid', 'status'),
		captureStartFileTimeUtc: requiredFileTimeUtc(
			record,
			'captureStartFileTimeUtc',
			'status'
		),
		captureStopFileTimeUtc: requiredFileTimeUtc(
			record,
			'captureStopFileTimeUtc',
			'status'
		),
		sessionName: requiredBoundedString(
			record,
			'sessionName',
			'status',
			MAX_RECORDER_SESSION_NAME_LENGTH
		),
		etlPath,
		operationalEtlPath,
		etlVolumeSerialNumber: requiredVolumeSerialNumber(record, 'etlVolumeSerialNumber', 'status'),
		etlFileIndex: requiredFileIndex(record, 'etlFileIndex', 'status'),
		etlIdentityVerifiedForCapture: requiredBoolean(record, 'etlIdentityVerifiedForCapture', 'status'),
		etlIdentityVerifiedAfterStop: requiredBoolean(record, 'etlIdentityVerifiedAfterStop', 'status'),
		durationMs,
		filterEventIds: requiredBoolean(record, 'filterEventIds', 'status'),
		processEventsRequired: requiredBoolean(record, 'processEventsRequired', 'status'),
		processEventsEnabled: requiredBoolean(record, 'processEventsEnabled', 'status'),
		processRundownRequested: requiredBoolean(record, 'processRundownRequested', 'status'),
		startStatus: requiredUint32(record, 'startStatus', 'status'),
		providerStatus: requiredUint32(record, 'providerStatus', 'status'),
		initial: parseSnapshot(record.initial, 'status.initial'),
		waitStatus: requiredUint32(record, 'waitStatus', 'status'),
		beforeStop: parseSnapshot(record.beforeStop, 'status.beforeStop'),
		stopStatus: requiredUint32(record, 'stopStatus', 'status'),
		cleanupStopStatus: requiredUint32(record, 'cleanupStopStatus', 'status'),
		stopAttemptStatuses: requiredUint32Array(record, 'stopAttemptStatuses', 'status'),
		etlFinalized: requiredBoolean(record, 'etlFinalized', 'status'),
		stopped: parseSnapshot(record.stopped, 'status.stopped'),
		etlExists: requiredBoolean(record, 'etlExists', 'status'),
		etlSizeBytes: requiredSafeInteger(record, 'etlSizeBytes', 'status'),
		etlSha256: requiredSha256(record, 'etlSha256', 'status'),
		etlReadLease: requiredEtlReadLease(
			record,
			'etlReadLease',
			'status'
		)
	};
	return registerParsedSidecar(
		parsed,
		parsedEtlRecorderStatusSidecars
	);
}

function snapshotReasons(snapshot: EtlRecorderSnapshot, label: string): string[] {
	const reasons: string[] = [];
	if (snapshot.queryStatus !== ERROR_SUCCESS) reasons.push(`${label}-query-status:${snapshot.queryStatus}`);
	if (snapshot.maximumBuffers < snapshot.minimumBuffers) reasons.push(`${label}-buffer-range-invalid`);
	if (snapshot.numberOfBuffers < snapshot.minimumBuffers) reasons.push(`${label}-buffer-count-below-minimum`);
	if (snapshot.numberOfBuffers > snapshot.maximumBuffers) reasons.push(`${label}-buffer-count-above-maximum`);
	if (snapshot.freeBuffers > snapshot.numberOfBuffers) reasons.push(`${label}-free-buffer-count-invalid`);
	if (snapshot.eventsLost !== 0) reasons.push(`${label}-events-lost:${snapshot.eventsLost}`);
	if (snapshot.logBuffersLost !== 0) reasons.push(`${label}-log-buffers-lost:${snapshot.logBuffersLost}`);
	if (snapshot.realTimeBuffersLost !== 0) reasons.push(`${label}-realtime-buffers-lost:${snapshot.realTimeBuffersLost}`);
	return reasons;
}

function snapshotSequenceReasons(
	initial: EtlRecorderSnapshot,
	beforeStop: EtlRecorderSnapshot,
	stopped: EtlRecorderSnapshot
): string[] {
	const reasons: string[] = [];
	for (const key of ['bufferSizeKiB', 'minimumBuffers', 'maximumBuffers'] as const) {
		if (beforeStop[key] !== initial[key]) reasons.push(`before-stop-${key}-changed`);
		if (stopped[key] !== initial[key]) reasons.push(`stopped-${key}-changed`);
	}
	for (const key of ['buffersWritten', 'eventsLost', 'logBuffersLost', 'realTimeBuffersLost'] as const) {
		if (beforeStop[key] < initial[key]) reasons.push(`before-stop-${key}-regressed`);
		if (stopped[key] < beforeStop[key]) reasons.push(`stopped-${key}-regressed`);
	}
	return reasons;
}

function validateExpectedIdentity(expected: EtlRecorderExpectedIdentity): void {
	if (!isRecord(expected)) {
		throw new TypeError('expected recorder identity must be an object.');
	}
	assertExactKeys(expected, ['durationMs', 'etlPath', 'sessionName'], 'expected');
	assertRecordingDuration(expected.durationMs);
	assertAbsoluteArtifactPath(expected.etlPath, '.etl', 'expected.etlPath');
	if (
		typeof expected.sessionName !== 'string'
		|| expected.sessionName.length === 0
		|| expected.sessionName.length > MAX_RECORDER_SESSION_NAME_LENGTH
		|| expected.sessionName.includes('\0')
	) {
		throw new TypeError(`expected.sessionName must contain from 1 through ${MAX_RECORDER_SESSION_NAME_LENGTH} UTF-16 code units without null bytes.`);
	}
}

function identityReasons(
	actual: Pick<EtlRecorderReadySidecar, 'durationMs' | 'etlPath' | 'sessionName'>,
	expected: EtlRecorderExpectedIdentity
): string[] {
	validateExpectedIdentity(expected);
	const reasons: string[] = [];
	if (actual.sessionName !== expected.sessionName) reasons.push('session-name-mismatch');
	if (actual.etlPath !== expected.etlPath) reasons.push('etl-path-mismatch');
	if (actual.durationMs !== expected.durationMs) reasons.push('duration-mismatch');
	return reasons;
}

function artifactIdentityReasons(
	actual: Pick<EtlRecorderReadySidecar, 'etlIdentityVerifiedForCapture' | 'etlPath' | 'operationalEtlPath'>
): string[] {
	const reasons: string[] = [];
	if (!actual.etlIdentityVerifiedForCapture) reasons.push('etl-identity-not-verified-for-capture');
	if (win32.basename(actual.etlPath) !== win32.basename(actual.operationalEtlPath)) {
		reasons.push('operational-etl-filename-mismatch');
	}
	return reasons;
}

function captureBoundaryReasons(
	startFileTimeUtc: string,
	stopFileTimeUtc?: string
): string[] {
	const reasons: string[] = [];
	let startTicks: bigint | undefined;
	try {
		captureFileTimeUtcToUnixMs(startFileTimeUtc, 'start');
		startTicks = BigInt(startFileTimeUtc);
	} catch {
		reasons.push('capture-start-filetime-invalid');
	}
	if (stopFileTimeUtc === undefined) return reasons;
	let stopTicks: bigint | undefined;
	try {
		captureFileTimeUtcToUnixMs(stopFileTimeUtc, 'stop');
		stopTicks = BigInt(stopFileTimeUtc);
	} catch {
		reasons.push('capture-stop-filetime-invalid');
	}
	if (
		startTicks !== undefined
		&& stopTicks !== undefined
		&& stopTicks <= startTicks
	) {
		reasons.push('capture-boundary-order-invalid');
	}
	return reasons;
}

export function assessEtlRecorderReady(
	ready: EtlRecorderReadySidecar,
	expected: EtlRecorderExpectedIdentity
): EtlRecorderAssessment {
	const reasons = identityReasons(ready, expected);
	reasons.push(...artifactIdentityReasons(ready));
	reasons.push(...captureBoundaryReasons(
		ready.captureStartFileTimeUtc
	));
	if (!ready.filterEventIds) reasons.push('event-id-filtering-unavailable');
	if (!ready.processEventsRequired) reasons.push('process-events-not-required');
	if (!ready.processEventsEnabled) reasons.push('process-events-unavailable');
	if (ready.processRundownRequested) reasons.push('process-rundown-requested');
	if (ready.requested.bufferSizeKiB !== 64) reasons.push('requested-buffer-size-mismatch');
	if (ready.requested.minimumBuffers !== 256) reasons.push('requested-minimum-buffers-mismatch');
	if (ready.requested.maximumBuffers !== 1024) reasons.push('requested-maximum-buffers-mismatch');
	if (ready.requested.flushTimerSeconds !== 0) reasons.push('requested-flush-timer-mismatch');
	if (ready.effective.bufferSizeKiB < ready.requested.bufferSizeKiB) reasons.push('effective-buffer-size-too-small');
	if (ready.effective.minimumBuffers < ready.requested.minimumBuffers) reasons.push('effective-minimum-buffers-too-small');
	if (ready.effective.maximumBuffers < ready.requested.maximumBuffers) reasons.push('effective-maximum-buffers-too-small');
	if (ready.effective.maximumBuffers < ready.effective.minimumBuffers) reasons.push('effective-buffer-range-invalid');
	reasons.push(...snapshotReasons(ready.effective, 'initial'));
	return { reasons, valid: reasons.length === 0 };
}

export function assessEtlRecorderStatus(
	status: EtlRecorderStatusSidecar,
	expected: EtlRecorderExpectedIdentity
): EtlRecorderAssessment {
	const reasons = identityReasons(status, expected);
	reasons.push(...artifactIdentityReasons(status));
	reasons.push(...captureBoundaryReasons(
		status.captureStartFileTimeUtc,
		status.captureStopFileTimeUtc
	));
	if (!status.etlIdentityVerifiedAfterStop) reasons.push('etl-identity-not-verified-after-stop');
	if (!status.filterEventIds) reasons.push('event-id-filtering-unavailable');
	if (!status.processEventsRequired) reasons.push('process-events-not-required');
	if (!status.processEventsEnabled) reasons.push('process-events-unavailable');
	if (status.processRundownRequested) reasons.push('process-rundown-requested');
	if (status.startStatus !== ERROR_SUCCESS) reasons.push(`start-status:${status.startStatus}`);
	if (status.providerStatus !== ERROR_SUCCESS) reasons.push(`provider-status:${status.providerStatus}`);
	if (status.waitStatus !== WAIT_TIMEOUT) reasons.push(`wait-status:${status.waitStatus}`);
	if (status.stopStatus !== ERROR_SUCCESS) reasons.push(`stop-status:${status.stopStatus}`);
	if (status.cleanupStopStatus !== ERROR_SUCCESS) {
		reasons.push(`cleanup-stop-status:${status.cleanupStopStatus}`);
	}
	if (status.stopAttemptStatuses.length === 0) {
		reasons.push('stop-attempts-missing');
	} else {
		if (status.stopAttemptStatuses[0] !== status.stopStatus) {
			reasons.push('primary-stop-attempt-mismatch');
		}
		if (status.stopAttemptStatuses.at(-1) !== status.cleanupStopStatus) {
			reasons.push('cleanup-stop-attempt-mismatch');
		}
	}
	if (status.stopAttemptStatuses.length !== 1 || status.stopAttemptStatuses[0] !== ERROR_SUCCESS) {
		reasons.push('stop-attempt-sequence-invalid');
	}
	if (!status.etlFinalized) reasons.push('etl-not-finalized');
	if (status.etlSha256 === ZERO_SHA256) {
		reasons.push('etl-sha256-unavailable');
	}
	if (status.etlReadLease !== 'held-until-controller-release') {
		reasons.push('etl-read-lease-unavailable');
	}
	reasons.push(...snapshotReasons(status.initial, 'initial'));
	reasons.push(...snapshotReasons(status.beforeStop, 'before-stop'));
	reasons.push(...snapshotReasons(status.stopped, 'stopped'));
	reasons.push(...snapshotSequenceReasons(status.initial, status.beforeStop, status.stopped));
	if (!status.etlExists) reasons.push('etl-missing');
	if (status.etlSizeBytes <= 0) reasons.push('etl-empty');
	if (!status.valid) reasons.push('recorder-reported-invalid');
	return { reasons, valid: reasons.length === 0 };
}

function snapshotsEqual(left: EtlRecorderSnapshot, right: EtlRecorderSnapshot): boolean {
	return SNAPSHOT_KEYS.every(key => left[key] === right[key]);
}

export function assessEtlRecorderPair(
	ready: EtlRecorderReadySidecar,
	status: EtlRecorderStatusSidecar,
	expected: EtlRecorderExpectedIdentity
): EtlRecorderAssessment {
	const reasons = [
		...assessEtlRecorderReady(ready, expected).reasons,
		...assessEtlRecorderStatus(status, expected).reasons
	];
	if (ready.sessionName !== status.sessionName) reasons.push('ready-status-session-name-mismatch');
	if (
		ready.captureStartFileTimeUtc
		!== status.captureStartFileTimeUtc
	) {
		reasons.push('ready-status-capture-start-mismatch');
	}
	if (ready.etlPath !== status.etlPath) reasons.push('ready-status-etl-path-mismatch');
	if (ready.operationalEtlPath !== status.operationalEtlPath) reasons.push('ready-status-operational-etl-path-mismatch');
	if (ready.etlVolumeSerialNumber !== status.etlVolumeSerialNumber) reasons.push('ready-status-etl-volume-serial-number-mismatch');
	if (ready.etlFileIndex !== status.etlFileIndex) reasons.push('ready-status-etl-file-index-mismatch');
	if (ready.etlIdentityVerifiedForCapture !== status.etlIdentityVerifiedForCapture) {
		reasons.push('ready-status-capture-identity-evidence-mismatch');
	}
	if (ready.durationMs !== status.durationMs) reasons.push('ready-status-duration-mismatch');
	if (ready.filterEventIds !== status.filterEventIds) reasons.push('ready-status-filter-capability-mismatch');
	if (ready.processEventsRequired !== status.processEventsRequired) reasons.push('ready-status-process-events-requirement-mismatch');
	if (ready.processEventsEnabled !== status.processEventsEnabled) reasons.push('ready-status-process-events-capability-mismatch');
	if (ready.processRundownRequested !== status.processRundownRequested) reasons.push('ready-status-process-rundown-mismatch');
	if (!snapshotsEqual(ready.effective, status.initial)) reasons.push('ready-status-initial-snapshot-mismatch');
	const uniqueReasons = [...new Set(reasons)];
	return { reasons: uniqueReasons, valid: uniqueReasons.length === 0 };
}

export function acceptEtlRecorderPair(
	ready: EtlRecorderReadySidecar,
	status: EtlRecorderStatusSidecar,
	expected: EtlRecorderExpectedIdentity
): AcceptedEtlRecorderCapture {
	if (
		!isRecord(ready)
		|| !parsedEtlRecorderReadySidecars.has(ready)
	) {
		throw new TypeError(
			'ready must come from parseEtlRecorderReadySidecar().'
		);
	}
	if (
		!isRecord(status)
		|| !parsedEtlRecorderStatusSidecars.has(status)
	) {
		throw new TypeError(
			'status must come from parseEtlRecorderStatusSidecar().'
		);
	}
	const assessment = assessEtlRecorderPair(ready, status, expected);
	if (!assessment.valid) {
		throw new Error(`ETL recorder pair is not acceptable: ${assessment.reasons.join(', ')}`);
	}
	const accepted = Object.freeze({
		captureStartFileTimeUtc:
			status.captureStartFileTimeUtc,
		captureStopFileTimeUtc:
			status.captureStopFileTimeUtc,
		etlFileIndex: status.etlFileIndex,
		etlReadLease: 'held-until-controller-release' as const,
		etlSha256: status.etlSha256,
		etlSizeBytes: status.etlSizeBytes,
		etlVolumeSerialNumber: status.etlVolumeSerialNumber,
		operationalEtlPath: status.operationalEtlPath,
		sessionName: status.sessionName
	});
	acceptedEtlRecorderCaptures.add(accepted);
	return accepted;
}

function decodeReplayOutput(contents: Uint8Array): string {
	return decodeUtf8Bytes(contents, 'Offline PresentMon output');
}

function validateReplayEvidence(evidence: OfflinePresentMonReplayEvidence): void {
	if (!isRecord(evidence)) throw new TypeError('Offline PresentMon replay evidence must be an object.');
	assertExactKeys(evidence, [
		'exitCode',
		'outputContents',
		'outputExistedBefore',
		'outputExistsAfter',
		'outputIdentityAfterRead',
		'outputIdentityAtOpen',
		'outputPath',
		'outputSha256AfterRead',
		'outputSizeBytesAfterRead',
		'outputSizeBytesAtOpen',
		'stderr',
		'stderrComplete',
		'stdoutByteLimitExceeded',
		'stdoutComplete',
		'stdoutSha256',
		'stdoutSizeBytes',
		'terminatedByController'
	], 'evidence');
	if (evidence.exitCode !== null && (!Number.isInteger(evidence.exitCode) || evidence.exitCode < 0)) {
		throw new TypeError('Offline PresentMon exitCode must be null or a non-negative integer.');
	}
	for (const [label, value] of [
		['outputSizeBytesAtOpen', evidence.outputSizeBytesAtOpen],
		['outputSizeBytesAfterRead', evidence.outputSizeBytesAfterRead],
		['stdoutSizeBytes', evidence.stdoutSizeBytes]
	] as const) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new TypeError(`Offline PresentMon ${label} must be a non-negative safe integer.`);
		}
	}
	assertAbsoluteArtifactPath(evidence.outputPath, '.csv', 'evidence.outputPath');
	if (typeof evidence.stderr !== 'string') {
		throw new TypeError('Offline PresentMon stderr must be a string.');
	}
	for (const key of [
		'outputExistedBefore',
		'outputExistsAfter',
		'stderrComplete',
		'stdoutByteLimitExceeded',
		'stdoutComplete',
		'terminatedByController'
	] as const) {
		if (typeof evidence[key] !== 'boolean') {
			throw new TypeError(`Offline PresentMon ${key} must be boolean.`);
		}
	}
	if (!/^[0-9a-f]{64}$/u.test(evidence.stdoutSha256)) {
		throw new TypeError(
			'Offline PresentMon stdoutSha256 must be a lowercase 64-character SHA-256.'
		);
	}
	if (
		evidence.outputSha256AfterRead !== undefined
		&& !/^[0-9a-f]{64}$/u.test(evidence.outputSha256AfterRead)
	) {
		throw new TypeError(
			'Offline PresentMon outputSha256AfterRead must be undefined or a lowercase 64-character SHA-256.'
		);
	}
	if (evidence.outputContents !== undefined && !(evidence.outputContents instanceof Uint8Array)) {
		throw new TypeError('Offline PresentMon outputContents must contain exact file bytes.');
	}
	if (evidence.outputIdentityAtOpen !== undefined) {
		assertFileIdentity(evidence.outputIdentityAtOpen, 'evidence.outputIdentityAtOpen');
	}
	if (evidence.outputIdentityAfterRead !== undefined) {
		assertFileIdentity(evidence.outputIdentityAfterRead, 'evidence.outputIdentityAfterRead');
	}
}

function assertExecutableBaseName(value: string, label: string): void {
	assertSafeArtifactFilename(value, '.exe', label);
	if (win32.basename(value) !== value) {
		throw new TypeError(`${label} must be an executable base name, not a path.`);
	}
}

function validateReplayExpectation(expectation: OfflinePresentMonReplayExpectation): number {
	if (
		expectation === null
		|| typeof expectation !== 'object'
		|| Array.isArray(expectation)
	) {
		throw new TypeError('Offline PresentMon replay expectation must be an object.');
	}
	const minimumFrameRecords = expectation.minimumFrameRecords ?? 1;
	if (!Number.isInteger(minimumFrameRecords) || minimumFrameRecords < 1) {
		throw new TypeError('minimumFrameRecords must be a positive integer.');
	}
	assertAbsoluteArtifactPath(
		expectation.expectedOutputPath,
		'.csv',
		'expectation.expectedOutputPath'
	);
	const record = expectation as unknown as Record<string, unknown>;
	if (expectation.mode === 'process-id') {
		assertExactKeys(
			record,
			Object.hasOwn(expectation, 'minimumFrameRecords')
				? [
					'mode',
					'targetProcessId',
					'expectedApplicationName',
					'expectedOutputPath',
					'minimumFrameRecords'
				]
				: [
					'mode',
					'targetProcessId',
					'expectedApplicationName',
					'expectedOutputPath'
				],
			'expectation'
		);
		validateOfflinePresentMonTarget({ targetProcessId: expectation.targetProcessId });
		assertExecutableBaseName(expectation.expectedApplicationName, 'expectedApplicationName');
		return minimumFrameRecords;
	}
	if (expectation.mode !== 'process-name') {
		throw new TypeError('expectation.mode must equal process-id or process-name.');
	}
	assertExactKeys(
		record,
		Object.hasOwn(expectation, 'minimumFrameRecords')
			? [
				'mode',
				'targetProcessName',
				'allowedProcessIds',
				'expectedOutputPath',
				'minimumFrameRecords'
			]
			: [
				'mode',
				'targetProcessName',
				'allowedProcessIds',
				'expectedOutputPath'
			],
		'expectation'
	);
	validateOfflinePresentMonTarget({ targetProcessName: expectation.targetProcessName });
	if (
		!Array.isArray(expectation.allowedProcessIds)
		|| expectation.allowedProcessIds.length === 0
		|| expectation.allowedProcessIds.length > MAX_JOB_PROCESS_IDS
	) {
		throw new TypeError(`allowedProcessIds must contain from 1 through ${MAX_JOB_PROCESS_IDS} process IDs.`);
	}
	const uniqueProcessIds = new Set<number>();
	for (const [index, processId] of expectation.allowedProcessIds.entries()) {
		if (!Number.isInteger(processId) || processId < 1 || processId > 0xffff_ffff) {
			throw new TypeError(`allowedProcessIds[${index}] must be a positive 32-bit process ID.`);
		}
		if (uniqueProcessIds.has(processId)) {
			throw new TypeError('allowedProcessIds must not contain duplicate process IDs.');
		}
		uniqueProcessIds.add(processId);
	}
	return minimumFrameRecords;
}

function hasUtf8Bom(contents: Uint8Array): boolean {
	return contents.byteLength >= 3
		&& contents[0] === 0xef
		&& contents[1] === 0xbb
		&& contents[2] === 0xbf;
}

function nativeReplayCsvReasons(contents: Uint8Array, csv: string): string[] {
	const reasons: string[] = [];
	if (hasUtf8Bom(contents)) {
		reasons.push('replay-output-unexpected-utf8-bom');
	}
	if (!csv.endsWith('\r\n')) reasons.push('replay-output-terminal-crlf-missing');
	const withoutCrlf = csv.replaceAll('\r\n', '');
	if (withoutCrlf.includes('\r') || withoutCrlf.includes('\n')) {
		reasons.push('replay-output-line-ending-invalid');
	}
	const headerEnd = csv.indexOf('\r\n');
	const header = headerEnd === -1 ? csv : csv.slice(0, headerEnd);
	if (header !== PRESENTMON_V2_REPLAY_HEADER) {
		reasons.push('replay-output-header-mismatch');
	}
	return reasons;
}

export function assessOfflinePresentMonReplay(
	evidence: OfflinePresentMonReplayEvidence,
	expectation: OfflinePresentMonReplayExpectation
): OfflinePresentMonReplayAssessment {
	validateReplayEvidence(evidence);
	const minimumFrameRecords = validateReplayExpectation(expectation);
	const reasons: string[] = [];
	let recordCount = 0;
	let malformedRowCount = 0;
	let capturedProcessIds: number[] = [];
	let applicationNames: string[] = [];

	if (
		windowsPathIdentity(evidence.outputPath)
		!== windowsPathIdentity(expectation.expectedOutputPath)
	) {
		reasons.push('replay-output-path-mismatch');
	}
	if (evidence.terminatedByController) reasons.push('replay-terminated-by-controller');
	if (evidence.exitCode === null) reasons.push('replay-exit-code-unavailable');
	else if (evidence.exitCode !== ERROR_SUCCESS) reasons.push(`replay-exit-code:${evidence.exitCode}`);
	if (evidence.outputExistedBefore) reasons.push('replay-output-pre-existed');
	if (!evidence.outputExistsAfter) reasons.push('replay-output-missing');
	if (evidence.outputIdentityAtOpen === undefined || evidence.outputIdentityAfterRead === undefined) {
		reasons.push('replay-output-identity-unverified');
	} else if (!fileIdentitiesEqual(evidence.outputIdentityAtOpen, evidence.outputIdentityAfterRead)) {
		reasons.push('replay-output-identity-changed');
	}
	if (evidence.outputSizeBytesAtOpen !== evidence.outputSizeBytesAfterRead) {
		reasons.push(`replay-output-size-changed:${evidence.outputSizeBytesAtOpen}/${evidence.outputSizeBytesAfterRead}`);
	}
	if (evidence.outputSizeBytesAfterRead === 0) reasons.push('replay-output-empty');
	if (evidence.stdoutByteLimitExceeded) {
		reasons.push('replay-stdout-byte-limit-exceeded');
	}
	if (!evidence.stdoutComplete) reasons.push('replay-stdout-incomplete');
	if (!evidence.stderrComplete) reasons.push('replay-stderr-incomplete');
	if (
		evidence.stdoutSizeBytes
		!== evidence.outputSizeBytesAfterRead
	) {
		reasons.push(
			'replay-stdout-output-size-mismatch:'
				+ `${evidence.stdoutSizeBytes}/`
				+ `${evidence.outputSizeBytesAfterRead}`
		);
	}
	if (evidence.outputSha256AfterRead === undefined) {
		reasons.push('replay-output-sha256-unavailable');
	} else if (
		evidence.outputSha256AfterRead
		!== evidence.stdoutSha256
	) {
		reasons.push('replay-stdout-output-sha256-mismatch');
	}

	const messages = evidence.stderr;
	const warningLines = messages.split(/\r?\n/u).filter(line => /^\s*warning:/iu.test(line));
	if (/overflowed present events?/iu.test(messages)) reasons.push('replay-present-event-overflow');
	if (warningLines.some(line => !/overflowed present events?/iu.test(line))) reasons.push('replay-warning-output');
	if (messages.split(/\r?\n/u).some(line => /^\s*(?:error|fatal):/iu.test(line))) reasons.push('replay-error-output');

	if (evidence.outputContents === undefined) {
		reasons.push('replay-output-unreadable');
	} else {
		let csv: string | undefined;
		try {
			csv = decodeReplayOutput(evidence.outputContents);
		} catch {
			reasons.push('replay-output-invalid-utf8');
		}
		if (csv !== undefined) {
			const actualSizeBytes = evidence.outputContents.byteLength;
			if (actualSizeBytes !== evidence.outputSizeBytesAfterRead) {
				reasons.push(`replay-output-size-mismatch:${actualSizeBytes}/${evidence.outputSizeBytesAfterRead}`);
			}
			const actualSha256 = sha256Hex(
				evidence.outputContents
			);
			if (
				evidence.outputSha256AfterRead !== undefined
				&& actualSha256
					!== evidence.outputSha256AfterRead
			) {
				reasons.push('replay-output-contents-sha256-mismatch');
			}
			if (actualSha256 !== evidence.stdoutSha256) {
				reasons.push('replay-stdout-contents-sha256-mismatch');
			}
			reasons.push(...nativeReplayCsvReasons(evidence.outputContents, csv));
			try {
				const document = parsePresentMonCsv(csv);
				recordCount = document.records.length;
				malformedRowCount = document.malformedRowCount;
				capturedProcessIds = [...new Set(document.records.flatMap(record => record.processId === undefined ? [] : [record.processId]))].sort((left, right) => left - right);
				applicationNames = [...new Set(document.records.flatMap(record => record.application === undefined ? [] : [record.application]))].sort((left, right) => left.localeCompare(right));
				if (document.schema !== 'v2') reasons.push(`replay-csv-schema:${document.schema}`);
				if (recordCount === 0) reasons.push('replay-output-header-only');
				else if (recordCount < minimumFrameRecords) reasons.push(`replay-record-count:${recordCount}/${minimumFrameRecords}`);
				if (malformedRowCount !== 0) reasons.push(`replay-malformed-row-count:${malformedRowCount}`);
				if (document.frameTimeColumn === undefined) reasons.push('replay-frame-time-column-missing');
				if (document.timestampColumn === undefined) reasons.push('replay-timestamp-column-missing');
				if (document.classificationSource === 'unavailable') reasons.push('replay-display-classification-unavailable');

				const missingFrameTimes = document.records.filter(record => record.frameTimeMs === undefined).length;
				const missingTimestamps = document.records.filter(record => record.timestampMs === undefined).length;
				const missingProcessIds = document.records.filter(record => record.processId === undefined).length;
				const missingApplications = document.records.filter(record => record.application === undefined).length;
				const missingSwapChains = document.records.filter(record => record.swapChainAddress === undefined).length;
				const unknownClassifications = document.records.filter(record => record.classification === 'unknown').length;
				if (missingFrameTimes !== 0) reasons.push(`replay-frame-times-missing:${missingFrameTimes}`);
				if (missingTimestamps !== 0) reasons.push(`replay-timestamps-missing:${missingTimestamps}`);
				if (missingProcessIds !== 0) reasons.push(`replay-process-ids-missing:${missingProcessIds}`);
				if (missingApplications !== 0) reasons.push(`replay-applications-missing:${missingApplications}`);
				if (missingSwapChains !== 0) reasons.push(`replay-swapchains-missing:${missingSwapChains}`);
				if (unknownClassifications !== 0) reasons.push(`replay-display-classifications-unknown:${unknownClassifications}`);

				if (expectation.mode === 'process-id') {
					if (!capturedProcessIds.includes(expectation.targetProcessId)) reasons.push('replay-target-process-id-missing');
					if (capturedProcessIds.some(processId => processId !== expectation.targetProcessId)) {
						reasons.push('replay-unexpected-process-id');
					}
					const expectedName = expectation.expectedApplicationName.toLowerCase();
					const normalizedNames = applicationNames.map(name => name.toLowerCase());
					if (!normalizedNames.includes(expectedName)) reasons.push('replay-expected-application-missing');
					if (normalizedNames.some(name => name !== expectedName)) reasons.push('replay-unexpected-application');
				} else {
					const expectedName = expectation.targetProcessName.toLowerCase();
					const normalizedNames = applicationNames.map(name => name.toLowerCase());
					if (!normalizedNames.includes(expectedName)) reasons.push('replay-target-process-name-missing');
					if (normalizedNames.some(name => name !== expectedName)) reasons.push('replay-unexpected-process-name');
					const allowedProcessIds = new Set(expectation.allowedProcessIds);
					if (capturedProcessIds.length === 0) reasons.push('replay-job-process-id-missing');
					if (capturedProcessIds.some(processId => !allowedProcessIds.has(processId))) {
						reasons.push('replay-process-id-outside-job');
					}
				}
			} catch (error) {
				reasons.push(`replay-csv-invalid:${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	const uniqueReasons = [...new Set(reasons)];
	return {
		applicationNames,
		capturedProcessIds,
		malformedRowCount,
		reasons: uniqueReasons,
		recordCount,
		valid: uniqueReasons.length === 0
	};
}
