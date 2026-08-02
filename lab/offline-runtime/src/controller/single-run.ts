import { createHash, randomBytes } from 'node:crypto';
import {
	spawn,
	type ChildProcess
} from 'node:child_process';
import type { BigIntStats } from 'node:fs';
import {
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	stat,
	writeFile
} from 'node:fs/promises';
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve
} from 'node:path';
import { buildRuntimeLaunchPlan, type RuntimeLaunchPlan } from '../adapter/launch-plan.ts';
import {
	fetchChromiumRuntimeIdentity,
	waitForChromiumDevTools,
	type ChromiumRuntimeIdentity
} from '../adapter/chromium-devtools.ts';
import {
	resolveRuntimeCandidateManifest,
	type ResolvedRuntimeCandidate
} from '../candidate/manifest.ts';
import {
	analyzePresentMonCsv,
	parsePresentMonCsv,
	type PresentMonCsvAnalysis,
	type PresentMonFrameRecord,
	type PresentMonStreamAnalysis
} from '../host/presentmon-csv.ts';
import {
	classifyRuntimeLabFailures,
	type RuntimeLabFailure
} from '../host/failure-classification.ts';
import { startLoopbackServer, type RuntimeLabCompletedRun, type RuntimeLabServer } from '../host/loopback-server.ts';
import {
	acceptEtlRecorderPair,
	assessEtlRecorderPair,
	assessEtlRecorderReady,
	assessEtlRecorderStatus,
	assessOfflinePresentMonReplay,
	buildEtlProcessEventInspectionArguments,
	buildEtlRecorderLaunchArguments,
	buildOfflinePresentMonArguments,
	captureFileTimeUtcToUnixMs,
	parseEtlRecorderReadySidecar,
	parseEtlRecorderStatusSidecar,
	type AcceptedEtlRecorderCapture,
	type EtlProcessEventInspectionArguments,
	type EtlRecorderAssessment,
	type EtlRecorderExpectedIdentity,
	type EtlRecorderLaunchArguments,
	type EtlRecorderReadySidecar,
	type EtlRecorderStatusSidecar,
	type OfflinePresentMonArguments,
	type OfflinePresentMonFileIdentity,
	type OfflinePresentMonReplayAssessment,
	type OfflinePresentMonReplayEvidence,
	type OfflinePresentMonReplayExpectation
} from '../host/presentmon-etl.ts';
import {
	bindSelectedPresentMonFramesToProcessLifetime,
	deriveEtlProcessLifetimes,
	parseEtlProcessEventEvidence,
	sameEtlProcessInspectionInvocation,
	sameEtlProcessInspectorIdentity,
	type EtlProcessEventEvidenceArtifact,
	type EtlProcessLifetimeArtifact,
	type PresentMonProcessLifetimeBinding,
	type ProcessLifetimeIdentityExpectation
} from '../host/etl-process-lifetimes.ts';
import {
	assessProcessTreeResourceCoverage,
	summarizeProcessTreeResourceSamples,
	type ProcessTreeResourceCoverage,
	type ProcessTreeResourceSummary
} from '../host/process-resources.ts';
import { buildCalibrationParityPage } from '../page/calibration-parity.ts';
import {
	resolveRuntimeLabScenario,
	type ResolvedRuntimeLabScenario
} from '../scenario/manifest.ts';
import { canonicalJson, sha256FileHex, sha256Hex } from '../shared/hash.ts';
import {
	assertRuntimeLabIdentifier,
	RUNTIME_LAB_FOREGROUND_TIMEOUT_MS
} from '../shared/protocol.ts';
import {
	attestRuntimeControllerSources,
	getAttestedWokMarkSvg,
	getRuntimeControllerAttestationIdentity,
	persistAttestedRuntimeControllerElectronHost,
	persistAttestedRuntimeControllerSources,
	type RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION,
	type PersistedRuntimeControllerSource,
	type RuntimeControllerSourceAttestation,
	type RuntimeControllerSourceInventory,
	type VerifiedRuntimeControllerElectronHost,
	type VerifiedRuntimeControllerSource
} from './source-attestation.ts';
import {
	closeWindowsEgressGuardWithRetry,
	installWindowsEgressGuard,
	type WindowsEgressGuard,
	type WindowsFirewallRule
} from './windows-firewall.ts';
import {
	findWindowsProcessImageMismatches,
	sameWindowsProcessIdentity
} from './windows-process-control.ts';
import {
	startWindowsJobProcess,
	type WindowsJobMembershipEvidence,
	type WindowsJobProcess,
	type WindowsJobProcessExit,
	type WindowsProcessLifetimeIdentity
} from './windows-job.ts';
import { startVerifiedWindowsToolProcess } from './windows-tool-process.ts';
import {
	listWindowsProcessesByExecutableName,
	type WindowsProcessIdentity,
	type WindowsProcessTreeSample
} from './windows-process-monitor.ts';

const CONTROLLER_RESULT_VERSION = 5;
const ELECTRON_HOST_EVENT_PREFIX = 'WOK_RUNTIME_HOST_EVENT ';
const ELECTRON_INTEGRITY_EVENT_TYPES = new Set([
	'authentication-denied',
	'certificate-denied',
	'navigation-denied',
	'popup-denied',
	'request-denied',
	'webview-denied'
]);
const ETL_RECORDER_READY_TIMEOUT_MS = 30_000;
const ETL_RECORDER_RELEASE_TIMEOUT_MS = 10_000;
const ETL_RECORDER_TAIL_MS = 5_000;
const MAX_CAPTURE_LOG_BYTES = 1024 * 1024;
const MAX_ETL_PROCESS_EVENT_BYTES = 16 * 1024 * 1024;
const MAX_OFFLINE_REPLAY_BYTES = 256 * 1024 * 1024;
const MAX_CONTROLLER_BENCHMARK_MS = 300_000;
const MAX_ETL_RECORDER_DURATION_MS = 600_000;
const MAX_OFFLINE_REPLAY_TIMEOUT_MS = 300_000;
const MIN_OFFLINE_REPLAY_TIMEOUT_MS = 30_000;
const PROCESS_MONITOR_INTERVAL_MS = 1_250;
const PROCESS_ID_SNAPSHOT_TIMEOUT_MS = 5_000;
const STABLE_JOB_MEMBERSHIP_ATTEMPTS = 5;

export interface VerifiedTool {
	path: string;
	sha256: string;
	sizeBytes: number;
}

interface OwnedProcessExit {
	exitCode: number | null;
	finishedAt: string;
	launchError?: string;
	signal: NodeJS.Signals | null;
	startedAt: string;
	stderr: string;
	stderrTruncated: boolean;
	stdout: string;
	stdoutTruncated: boolean;
}

interface OwnedProcess {
	child: ChildProcess;
	completed: Promise<OwnedProcessExit>;
	started: Promise<WindowsProcessLifetimeIdentity | undefined>;
}

interface OfflineReplayOutputCapture {
	outputContents: Uint8Array | undefined;
	outputExistsAfter: boolean;
	outputIdentityAfterRead:
		| OfflinePresentMonFileIdentity
		| undefined;
	outputIdentityAtOpen:
		| OfflinePresentMonFileIdentity
		| undefined;
	outputSha256AfterRead: string | undefined;
	outputSizeBytesAfterRead: number;
	outputSizeBytesAtOpen: number;
	stdoutByteLimitExceeded: boolean;
	stdoutComplete: boolean;
	stdoutSha256: string;
	stdoutSizeBytes: number;
}

interface OfflineReplayOwnedProcess extends OwnedProcess {
	outputCapture: Promise<OfflineReplayOutputCapture>;
	stdoutByteLimitExceeded(): boolean;
}

class UnexpectedWindowsJobExitError extends Error {
	readonly exit: WindowsJobProcessExit;

	constructor(exit: WindowsJobProcessExit) {
		super(
			'Windows job host exited during the controlled run '
				+ `(code=${exit.exitCode ?? 'null'}, `
				+ `signal=${exit.signal ?? 'null'}).`
		);
		this.name = 'UnexpectedWindowsJobExitError';
		this.exit = exit;
	}
}

interface EtlRecorderRun {
	acceptedCapture?: AcceptedEtlRecorderCapture;
	exit?: OwnedProcessExit;
	launch: EtlRecorderLaunchArguments;
	pairAssessment?: EtlRecorderAssessment;
	process?: OwnedProcess;
	processIdentity?: WindowsProcessLifetimeIdentity;
	ready?: EtlRecorderReadySidecar;
	readyEvidence?: ArtifactRecord;
	releaseAcknowledged?: boolean;
	readyAssessment?: EtlRecorderAssessment;
	status?: EtlRecorderStatusSidecar;
	statusEvidence?: ArtifactRecord;
	statusAssessment?: EtlRecorderAssessment;
	terminatedByController: boolean;
}

interface OfflinePresentMonReplayRun {
	assessment?: OfflinePresentMonReplayAssessment;
	evidence?: OfflinePresentMonReplayEvidence;
	exit?: OwnedProcessExit;
	expectation: OfflinePresentMonReplayExpectation;
	launch: OfflinePresentMonArguments;
	name: 'presentmon-process-id' | 'presentmon-process-name';
	process?: OfflineReplayOwnedProcess;
	processIdentity?: WindowsProcessLifetimeIdentity;
	terminatedByController: boolean;
}

interface EtlProcessInspectionRun {
	evidence?: EtlProcessEventEvidenceArtifact;
	evidenceRecord?: ArtifactRecord;
	exit?: OwnedProcessExit;
	launch: EtlProcessEventInspectionArguments;
	outputPath: string;
	process?: OfflineReplayOwnedProcess;
	processIdentity?: WindowsProcessLifetimeIdentity;
	terminatedByController: boolean;
}

interface StableJobMembership {
	processIds: readonly number[];
	sample: WindowsProcessTreeSample;
}

export interface WindowsJobCleanupResult {
	jobClean: boolean;
	membership: WindowsJobMembershipEvidence;
	orphanProcessIds: number[];
	rootProcessId?: number;
	terminationAttempted: boolean;
	terminationError?: string;
}

export interface RuntimeHostEvent {
	details: Record<string, unknown>;
	epochMs: number;
	monotonicMs: number;
	pid: number;
	type: string;
}

export interface ArtifactRecord {
	path: string;
	sha256: string;
	sizeBytes: number;
}

export interface RuntimeLabAcceptedEtlEvidence {
	acceptedCapture: AcceptedEtlRecorderCapture;
	captureArtifact: ArtifactRecord;
	processEventArtifact: ArtifactRecord;
	readySidecarArtifact: ArtifactRecord;
	recorderExpectedIdentity: EtlRecorderExpectedIdentity;
	statusSidecarArtifact: ArtifactRecord;
}

export interface RuntimeLabExecutionIdentities {
	candidateRoot?: WindowsProcessLifetimeIdentity;
	etlProcessInspector?: WindowsProcessLifetimeIdentity;
	etlRecorder?: WindowsProcessLifetimeIdentity;
	presentingProcessSample?: WindowsProcessIdentity;
	presentMonProcessIdReplay?: WindowsProcessLifetimeIdentity;
	presentMonProcessNameReplay?: WindowsProcessLifetimeIdentity;
}

export interface RuntimeLabSingleRunExpectedAttestation {
	candidate: {
		executablePath: string;
		executableSha256: string;
		executableSizeBytes: number;
		id: string;
		manifestPath: string;
		manifestSha256: string;
		runtimeKind: ResolvedRuntimeCandidate['manifest']['runtimeKind'];
	};
	controllerSourceInventory: RuntimeControllerSourceInventory<
		VerifiedRuntimeControllerSource
	>;
	electronHost: VerifiedRuntimeControllerElectronHost;
	etlRecorder: VerifiedTool;
	presentMon: VerifiedTool;
	scenario: {
		id: string;
		manifestPath: string;
		manifestSha256: string;
	};
}

export interface RuntimeLabSingleRunOptions {
	candidateManifestPath: string;
	confirmIdleSystem: boolean;
	electronHostDirectory: string;
	etlRecorderPath: string;
	etlRecorderSha256: string;
	expectedAttestation?: RuntimeLabSingleRunExpectedAttestation;
	outputRootDirectory: string;
	presentMonPath: string;
	presentMonSha256: string;
	runtimeControllerAttestation?: RuntimeControllerSourceAttestation;
	runId?: string;
	scenarioManifestPath: string;
	signal?: AbortSignal;
	startupTimeoutMs?: number;
}

export interface RuntimeLabSingleRunResult {
	artifactManifestPath: string;
	candidate: ResolvedRuntimeCandidate;
	cleanup?: WindowsJobCleanupResult;
	completedAt: string;
	controllerSourceInventoryVersion:
		typeof RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION;
	controllerSources: Record<
		string,
		PersistedRuntimeControllerSource
	>;
	controllerVersion: typeof CONTROLLER_RESULT_VERSION;
	electronHostEvents?: RuntimeHostEvent[];
	etlEvidence?: RuntimeLabAcceptedEtlEvidence;
	etlProcessLifetime?: EtlProcessLifetimeArtifact;
	etlProcessLifetimeEvidence?: ArtifactRecord;
	executionIdentities?: RuntimeLabExecutionIdentities;
	failures: RuntimeLabFailure[];
	firewallRule?: WindowsFirewallRule;
	headlineAnalysis?: PresentMonCsvAnalysis;
	headlineStream?: PresentMonStreamAnalysis;
	headlineStreamKey?: string;
	pageRun?: RuntimeLabCompletedRun;
	presentingProcessId?: number;
	presentMonProcessLifetimeBinding?: PresentMonProcessLifetimeBinding;
	presentMonProcessLifetimeBindingEvidence?: ArtifactRecord;
	resourceCoverage?: ProcessTreeResourceCoverage;
	resources: ProcessTreeResourceSummary;
	runDirectory: string;
	runId: string;
	runtimeIdentity?: ChromiumRuntimeIdentity | RuntimeHostEvent;
	scenario: ResolvedRuntimeLabScenario;
	startedAt: string;
	valid: boolean;
	violations: string[];
}

export function unclassifiedInvalidResultViolation(options: {
	failures: readonly RuntimeLabFailure[];
	headlineAnalysisValid?: boolean;
	pageRunValid?: boolean;
	resourceCoverageValid?: boolean;
	resourceSampleCount: number;
	violations: readonly string[];
}): string | undefined {
	const valid = Boolean(
		options.pageRunValid
		&& options.headlineAnalysisValid
		&& options.resourceCoverageValid
		&& options.resourceSampleCount > 0
		&& options.failures.length === 0
	);
	return !valid
		&& options.failures.length === 0
		&& options.violations.length === 0
		? 'unclassified-invalid-result'
		: undefined;
}

function createRunId(): string {
	const timestamp = new Date().toISOString().replaceAll(/[^0-9]/gu, '').slice(0, 14);
	return `run-${timestamp}-${randomBytes(4).toString('hex')}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function calculateEtlRecorderDurationMs(
	benchmarkMs: number,
	startupTimeoutMs: number
): number {
	if (!Number.isInteger(benchmarkMs) || benchmarkMs < 1) {
		throw new TypeError('benchmarkMs must be a positive integer.');
	}
	if (
		!Number.isInteger(startupTimeoutMs)
		|| startupTimeoutMs < 1_000
		|| startupTimeoutMs > 120_000
	) {
		throw new TypeError(
			'startupTimeoutMs must be an integer from 1,000 through 120,000.'
		);
	}
	const durationMs =
		benchmarkMs
		+ startupTimeoutMs
		+ RUNTIME_LAB_FOREGROUND_TIMEOUT_MS
		+ ETL_RECORDER_TAIL_MS;
	if (durationMs > MAX_ETL_RECORDER_DURATION_MS) {
		throw new RangeError(
			`ETL recorder duration must not exceed ${MAX_ETL_RECORDER_DURATION_MS} ms.`
		);
	}
	return durationMs;
}

export function buildWindowsJobCleanupResult(
	exit: WindowsJobProcessExit,
	rootProcessId?: number
): WindowsJobCleanupResult {
	const membership = exit.membership;
	const orphanProcessIds = membership.status === 'reconciled'
		? [...membership.processIds]
		: [];
	return {
		jobClean: exit.jobClean
			&& membership.status === 'reconciled'
			&& orphanProcessIds.length === 0,
		membership,
		orphanProcessIds,
		...(rootProcessId === undefined ? {} : { rootProcessId }),
		terminationAttempted: exit.terminationRequested,
		...(exit.launchError === undefined
			? {}
			: { terminationError: exit.launchError })
	};
}

export function shouldRetainCandidateFirewall(options: {
	candidateExit?: {
		jobClean: boolean;
	};
	candidateHostStarted: boolean;
	candidateProcessId?: number;
	cleanup?: Pick<
		WindowsJobCleanupResult,
		'jobClean' | 'membership' | 'orphanProcessIds'
	>;
}): boolean {
	if (!options.candidateHostStarted) return false;
	const cleanup = options.cleanup;
	return !options.candidateExit?.jobClean
		|| cleanup === undefined
		|| !cleanup.jobClean
		|| cleanup.membership.status !== 'reconciled'
		|| cleanup.orphanProcessIds.length > 0;
}

export function buildArtifactSealReasons(
	cleanupViolations: readonly string[],
	orphanProcessIds: readonly number[],
	membership?: WindowsJobMembershipEvidence
): string[] {
	return [...new Set([
		...cleanupViolations,
		...(membership?.status === 'unreconciled'
			? [
				'candidate-cleanup:windows-job-membership-unreconciled:'
					+ membership.reason
			]
			: []),
		...orphanProcessIds.map(
			processId =>
				`verified-orphan-process:${processId}`
		)
	])];
}

function appendBounded(current: string, chunk: Buffer | string): { truncated: boolean; value: string } {
	if (Buffer.byteLength(current) >= MAX_CAPTURE_LOG_BYTES) return { truncated: true, value: current };
	const remaining = MAX_CAPTURE_LOG_BYTES - Buffer.byteLength(current);
	const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
	const bounded = Buffer.from(value).subarray(0, remaining).toString('utf8');
	return {
		truncated: Buffer.byteLength(value) > remaining,
		value: current + bounded
	};
}

function startOwnedProcess(
	executable: VerifiedTool,
	args: readonly string[],
	options: {
		controlDirectory: string;
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		stdin?: 'ignore' | 'pipe';
		windowsHide: boolean;
	}
): OwnedProcess {
	const verifiedProcess = startVerifiedWindowsToolProcess({
		arguments: args,
		controlDirectory: options.controlDirectory,
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		...(options.env === undefined
			? {}
			: { environment: options.env }),
		executable,
		stdin: options.stdin ?? 'ignore',
		windowsHide: options.windowsHide
	});
	const child = verifiedProcess.child;
	const childStdout = child.stdout;
	const childStderr = child.stderr;
	if (childStdout === null || childStderr === null) {
		child.kill();
		throw new Error(
			'Owned process did not expose the required stdout and stderr pipes.'
		);
	}
	let stdout = '';
	let stderr = '';
	let stdoutTruncated = false;
	let stderrTruncated = false;
	childStdout.on('data', chunk => {
		const appended = appendBounded(stdout, chunk as Buffer);
		stdout = appended.value;
		stdoutTruncated ||= appended.truncated;
	});
	childStderr.on('data', chunk => {
		const appended = appendBounded(stderr, chunk as Buffer);
		stderr = appended.value;
		stderrTruncated ||= appended.truncated;
	});
	const startedAt = new Date().toISOString();
	const started = verifiedProcess.started;
	let settled = false;
	let resolveCompleted: (result: OwnedProcessExit) => void;
	const completed = new Promise<OwnedProcessExit>(resolveExit => {
		resolveCompleted = resolveExit;
	});
	const finish = (exitCode: number | null, signal: NodeJS.Signals | null, launchError?: string) => {
		if (settled) return;
		settled = true;
		resolveCompleted({
			exitCode,
			finishedAt: new Date().toISOString(),
			...(launchError === undefined ? {} : { launchError }),
			signal,
			startedAt,
			stderr,
			stderrTruncated,
			stdout,
			stdoutTruncated
		});
	};
	child.once('error', error => {
		finish(null, null, error.message);
	});
	child.once('close', (exitCode, signal) => finish(exitCode, signal));
	return { child, completed, started };
}

async function writeFileHandleChunk(
	handle: Awaited<ReturnType<typeof open>>,
	chunk: Buffer,
	position: number
): Promise<void> {
	let offset = 0;
	while (offset < chunk.byteLength) {
		const { bytesWritten } = await handle.write(
			chunk,
			offset,
			chunk.byteLength - offset,
			position + offset
		);
		if (bytesWritten <= 0) {
			throw new Error(
				'Offline PresentMon stdout persistence made no forward progress.'
			);
		}
		offset += bytesWritten;
	}
}

async function readFileHandleExact(
	handle: Awaited<ReturnType<typeof open>>,
	sizeBytes: number
): Promise<Buffer> {
	const contents = Buffer.alloc(sizeBytes);
	let offset = 0;
	while (offset < sizeBytes) {
		const { bytesRead } = await handle.read(
			contents,
			offset,
			sizeBytes - offset,
			offset
		);
		if (bytesRead <= 0) {
			throw new Error(
				'Offline PresentMon output ended before its attested size.'
			);
		}
		offset += bytesRead;
	}
	return contents;
}

export async function startOfflineReplayProcess(
	command: string,
	args: readonly string[],
	outputPath: string,
	maxStdoutBytes = MAX_OFFLINE_REPLAY_BYTES,
	verifiedExecutable?: VerifiedTool
): Promise<OfflineReplayOwnedProcess> {
	if (
		!Number.isSafeInteger(maxStdoutBytes)
		|| maxStdoutBytes <= 0
		|| maxStdoutBytes > MAX_OFFLINE_REPLAY_BYTES
	) {
		throw new RangeError(
			'Offline PresentMon stdout byte limit is invalid.'
		);
	}
	const outputHandle = await open(outputPath, 'wx+');
	const metadataAtCreation = await outputHandle.stat({
		bigint: true
	});
	if (!metadataAtCreation.isFile()) {
		await outputHandle.close();
		throw new Error(
			'Offline PresentMon output path is not a regular file.'
		);
	}
	const outputIdentityAtOpen = offlineFileIdentity(
		metadataAtCreation
	);
	let child: ChildProcess;
	let verifiedStarted:
		| Promise<WindowsProcessLifetimeIdentity>
		| undefined;
	try {
		if (
			verifiedExecutable !== undefined
			&& verifiedExecutable.path !== command
		) {
			throw new Error(
				'Offline PresentMon command does not match its verified executable path.'
			);
		}
		if (verifiedExecutable === undefined) {
			child = spawn(command, args, {
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true
			});
		} else {
			const verifiedProcess = startVerifiedWindowsToolProcess({
				arguments: args,
				controlDirectory: dirname(outputPath),
				executable: verifiedExecutable,
				stdin: 'ignore',
				windowsHide: true
			});
			child = verifiedProcess.child;
			verifiedStarted = verifiedProcess.started;
		}
	} catch (error) {
		await outputHandle.close();
		throw error;
	}
	const childStdout = child.stdout;
	const childStderr = child.stderr;
	if (childStdout === null || childStderr === null) {
		child.kill();
		await outputHandle.close();
		throw new Error(
			'Offline PresentMon did not expose the required stdout and stderr pipes.'
		);
	}
	const stdoutHash = createHash('sha256');
	let stdoutSizeBytes = 0;
	let stdoutByteLimitExceeded = false;
	let stdoutEnded = false;
	let stdoutErrored = false;
	let outputWrites = Promise.resolve();
	let stderr = '';
	let stderrTruncated = false;

	childStdout.on('data', chunkValue => {
		const chunk = Buffer.from(chunkValue as Buffer);
		if (stdoutByteLimitExceeded) return;
		if (
			stdoutSizeBytes + chunk.byteLength
			> maxStdoutBytes
		) {
			stdoutByteLimitExceeded = true;
			child.kill();
			return;
		}
		const position = stdoutSizeBytes;
		stdoutSizeBytes += chunk.byteLength;
		stdoutHash.update(chunk);
		outputWrites = outputWrites.then(() =>
			writeFileHandleChunk(
				outputHandle,
				chunk,
				position
			)
		);
		void outputWrites.catch(() => child.kill());
	});
	childStdout.once('end', () => {
		stdoutEnded = true;
	});
	childStdout.once('error', () => {
		stdoutErrored = true;
		child.kill();
	});
	childStderr.on('data', chunk => {
		const appended = appendBounded(stderr, chunk as Buffer);
		stderr = appended.value;
		stderrTruncated ||= appended.truncated;
	});

	const startedAt = new Date().toISOString();
	let rejectDirectStart: ((error: Error) => void) | undefined;
	const started = verifiedStarted
		?? new Promise<WindowsProcessLifetimeIdentity | undefined>(
			(resolveStart, rejectStart) => {
				rejectDirectStart = rejectStart;
				child.once('spawn', () => resolveStart(undefined));
			}
		);
	let settled = false;
	let resolveCompleted: (result: OwnedProcessExit) => void;
	const completed = new Promise<OwnedProcessExit>(resolveExit => {
		resolveCompleted = resolveExit;
	});
	const finish = (
		exitCode: number | null,
		signal: NodeJS.Signals | null,
		launchError?: string
	): void => {
		if (settled) return;
		settled = true;
		resolveCompleted({
			exitCode,
			finishedAt: new Date().toISOString(),
			...(launchError === undefined
				? {}
				: { launchError }),
			signal,
			startedAt,
			stderr,
			stderrTruncated,
			stdout: '',
			stdoutTruncated: false
		});
	};
	child.once('error', error => {
		rejectDirectStart?.(error);
		finish(null, null, error.message);
	});
	child.once('close', (exitCode, signal) =>
		finish(exitCode, signal));

	const outputCapture = completed.then(async () => {
		try {
			await outputWrites;
			await outputHandle.sync();
			const metadataBeforeRead = await outputHandle.stat({
				bigint: true
			});
			const outputSizeBytesAtOpen = safeBigIntNumber(
				metadataBeforeRead.size,
				'Offline PresentMon owned output size before read'
			);
			const outputContents = await readFileHandleExact(
				outputHandle,
				outputSizeBytesAtOpen
			);
			const metadataAfterRead = await outputHandle.stat({
				bigint: true
			});
			let outputExistsAfter = false;
			let outputIdentityAfterRead:
				| OfflinePresentMonFileIdentity
				| undefined;
			let outputSizeBytesAfterRead = 0;
			try {
				const pathMetadata = await stat(outputPath, {
					bigint: true
				});
				if (pathMetadata.isFile()) {
					outputExistsAfter = true;
					outputIdentityAfterRead =
						offlineFileIdentity(pathMetadata);
					outputSizeBytesAfterRead =
						safeBigIntNumber(
							pathMetadata.size,
							'Offline PresentMon output path size after read'
						);
				}
			} catch (error) {
				if (!isNotFoundError(error)) throw error;
			}
			const ownedSizeAfterRead = safeBigIntNumber(
				metadataAfterRead.size,
				'Offline PresentMon owned output size after read'
			);
			if (ownedSizeAfterRead !== outputContents.byteLength) {
				throw new Error(
					'Offline PresentMon owned output size changed during read.'
				);
			}
			return {
				outputContents,
				outputExistsAfter,
				outputIdentityAfterRead,
				outputIdentityAtOpen,
				outputSha256AfterRead:
					sha256Hex(outputContents),
				outputSizeBytesAfterRead,
				outputSizeBytesAtOpen,
				stdoutByteLimitExceeded,
				stdoutComplete:
					stdoutEnded
					&& !stdoutErrored
					&& !stdoutByteLimitExceeded,
				stdoutSha256: stdoutHash.digest('hex'),
				stdoutSizeBytes
			};
		} finally {
			await outputHandle.close();
		}
	});
	void outputCapture.catch(() => {});
	return {
		child,
		completed,
		outputCapture,
		started,
		stdoutByteLimitExceeded: () =>
			stdoutByteLimitExceeded
	};
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
	signal?: AbortSignal
): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	let abortHandler: (() => void) | undefined;
	try {
		signal?.throwIfAborted();
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)), timeoutMs);
			}),
			...(signal
				? [new Promise<T>((_resolve, reject) => {
					abortHandler = () => reject(signal.reason ?? new Error(`${label} was aborted.`));
					signal.addEventListener('abort', abortHandler, { once: true });
				})]
				: [])
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
		if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
	}
}

async function verifyTool(path: string, expectedSha256: string, label: string): Promise<VerifiedTool> {
	if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new TypeError(`${label} SHA-256 must be a lowercase digest.`);
	const resolvedPath = await realpath(resolve(path));
	const metadata = await stat(resolvedPath);
	if (!metadata.isFile()) throw new TypeError(`${label} path must resolve to a regular file.`);
	const sha256 = await sha256FileHex(resolvedPath);
	if (sha256 !== expectedSha256) {
		throw new Error(`${label} SHA-256 mismatch: expected ${expectedSha256}, received ${sha256}.`);
	}
	return { path: resolvedPath, sha256, sizeBytes: metadata.size };
}

export async function reverifyFileImmediatelyBeforeUse(
	verified: VerifiedTool,
	label: string
): Promise<void> {
	const current = await verifyTool(
		verified.path,
		verified.sha256,
		label
	);
	if (
		current.path !== verified.path
		|| current.sizeBytes !== verified.sizeBytes
	) {
		throw new Error(
			`${label} identity changed immediately before use.`
		);
	}
}

function processImageViolation(
	processes: readonly WindowsProcessIdentity[],
	expectedExecutablePath: string
): string | undefined {
	const mismatches = findWindowsProcessImageMismatches(processes, expectedExecutablePath);
	if (mismatches.length === 0) return undefined;
	const details = mismatches
		.slice(0, 16)
		.map(process => `${process.processId}:${process.executablePath || '<unavailable>'}`)
		.join(',');
	return `candidate-tree-image-mismatch:${details}${mismatches.length > 16 ? `,+${mismatches.length - 16}` : ''}`;
}

async function stopOwnedProcess(
	process: OwnedProcess,
	label: string
): Promise<OwnedProcessExit> {
	if (process.child.exitCode === null && process.child.signalCode === null) {
		process.child.kill();
	}
	return withTimeout(process.completed, 5_000, `${label} process closure`);
}

function guardJobOperation<T>(
	operation: Promise<T>,
	candidateProcess: WindowsJobProcess,
	processIsolationFailure: Promise<never>
): Promise<T> {
	return Promise.race([
		operation,
		processIsolationFailure,
		candidateProcess.completed.then(exit => {
			throw new UnexpectedWindowsJobExitError(exit);
		})
	]);
}

export function selectPresentingProcessId(
	analysis: PresentMonCsvAnalysis,
	candidateProcessIds: ReadonlySet<number>
): number {
	const streams = analysis.streams
		.filter(stream => stream.processId !== undefined && candidateProcessIds.has(stream.processId) && stream.sampleCount > 0)
		.sort((left, right) => Number(right.valid) - Number(left.valid) || right.sampleCount - left.sampleCount || left.key.localeCompare(right.key));
	const processId = streams[0]?.processId;
	if (processId === undefined) {
		throw new Error(
			'Offline process-name replay did not identify a presenting PID '
				+ 'inside the exact Windows Job membership.'
		);
	}
	return processId;
}

function replayRecordEvidence(
	record: PresentMonFrameRecord
): Omit<PresentMonFrameRecord, 'sourceRow'> {
	const {
		sourceRow: _sourceRow,
		...evidence
	} = record;
	return evidence;
}

export function selectedPidReplayEvidenceViolation(
	processNameCsv: string,
	processIdCsv: string,
	selectedProcessId: number
): string | undefined {
	if (
		!Number.isInteger(selectedProcessId)
		|| selectedProcessId < 1
		|| selectedProcessId > 0xffff_ffff
	) {
		throw new TypeError(
			'selectedProcessId must be a positive 32-bit process ID.'
		);
	}
	const processNameRecords = parsePresentMonCsv(processNameCsv).records
		.filter(record => record.processId === selectedProcessId)
		.map(replayRecordEvidence);
	const processIdRecords = parsePresentMonCsv(processIdCsv).records
		.filter(record => record.processId === selectedProcessId)
		.map(replayRecordEvidence);
	if (processNameRecords.length === 0) {
		return 'process-name-replay-selected-pid-evidence-missing';
	}
	if (processIdRecords.length === 0) {
		return 'process-id-replay-selected-pid-evidence-missing';
	}
	return canonicalJson(processNameRecords)
		=== canonicalJson(processIdRecords)
		? undefined
		: 'offline-replay-selected-pid-evidence-mismatch';
}

export function exactJobMembershipViolation(
	exactProcessIds: readonly number[],
	sample: WindowsProcessTreeSample
): string | undefined {
	if (exactProcessIds.length === 0) {
		return 'exact-job-membership-empty';
	}
	const exactSet = new Set<number>();
	for (const [index, processId] of exactProcessIds.entries()) {
		if (
			!Number.isInteger(processId)
			|| processId < 1
			|| processId > 0xffff_ffff
		) {
			throw new TypeError(
				`exactProcessIds[${index}] must be a positive 32-bit process ID.`
			);
		}
		if (exactSet.has(processId)) {
			throw new TypeError(
				'exactProcessIds must not contain duplicate process IDs.'
			);
		}
		exactSet.add(processId);
	}
	const sampledSet = new Set(
		sample.processes.map(process => process.processId)
	);
	const omitted = [...exactSet]
		.filter(processId => !sampledSet.has(processId))
		.sort((left, right) => left - right);
	const stale = [...sampledSet]
		.filter(processId => !exactSet.has(processId))
		.sort((left, right) => left - right);
	if (omitted.length === 0 && stale.length === 0) return undefined;
	return 'exact-job-membership-sample-mismatch:'
		+ `omitted=${omitted.join(',') || 'none'};`
		+ `stale=${stale.join(',') || 'none'}`;
}

export function headlinePresentingProcessViolation(
	analysis: PresentMonCsvAnalysis,
	expectedProcessId: number
): string | undefined {
	if (analysis.capturedProcessIds.length === 0) return 'headline-presenting-pid-unavailable';
	return analysis.capturedProcessIds.includes(expectedProcessId)
		? undefined
		: 'headline-presenting-pid-mismatch';
}

export function selectHeadlinePresentMonStream(
	analysis: PresentMonCsvAnalysis,
	expectedProcessId: number
): PresentMonStreamAnalysis | undefined {
	return analysis.streams
		.filter(stream =>
			stream.processId === expectedProcessId
		)
		.sort((left, right) =>
			Number(right.valid) - Number(left.valid)
				|| right.sampleCount - left.sampleCount
				|| left.key.localeCompare(right.key)
		)[0];
}

export function headlinePresentMonStreamViolation(
	stream: PresentMonStreamAnalysis | undefined,
	expectedProcessId: number
): string | undefined {
	if (stream === undefined) {
		return 'headline-presenting-stream-missing';
	}
	if (stream.processId !== expectedProcessId) {
		return 'headline-presenting-stream-pid-mismatch';
	}
	return stream.valid
		? undefined
		: 'headline-presenting-stream-invalid';
}

export function parseElectronHostEvents(stdout: string): { events: RuntimeHostEvent[]; violations: string[] } {
	const events: RuntimeHostEvent[] = [];
	const violations: string[] = [];
	for (const line of stdout.split(/\r?\n/u)) {
		if (!line.startsWith(ELECTRON_HOST_EVENT_PREFIX)) continue;
		try {
			const value = JSON.parse(line.slice(ELECTRON_HOST_EVENT_PREFIX.length)) as unknown;
			if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('event is not an object');
			const event = value as Record<string, unknown>;
			if (
				typeof event.type !== 'string'
				|| event.type.length === 0
				|| event.type.length > 256
				|| typeof event.epochMs !== 'number'
				|| !Number.isFinite(event.epochMs)
				|| event.epochMs <= 0
				|| typeof event.monotonicMs !== 'number'
				|| !Number.isFinite(event.monotonicMs)
				|| event.monotonicMs < 0
				|| !Number.isInteger(event.pid)
				|| (event.pid as number) <= 0
				|| (event.pid as number) > 0xffff_ffff
			) {
				throw new TypeError('event fields are invalid');
			}
			events.push({
				details: event.details && typeof event.details === 'object' && !Array.isArray(event.details)
					? event.details as Record<string, unknown>
					: {},
				epochMs: event.epochMs,
				monotonicMs: event.monotonicMs,
				pid: event.pid as number,
				type: event.type
			});
			if (ELECTRON_INTEGRITY_EVENT_TYPES.has(event.type)) {
				violations.push(`electron-integrity-event:${event.type}`);
			}
		} catch (error) {
			violations.push(`malformed-electron-host-event:${errorMessage(error)}`);
		}
	}
	return { events, violations };
}

export function electronHostRootIdentityViolation(
	events: readonly RuntimeHostEvent[],
	expectedRoot?: WindowsProcessLifetimeIdentity
): string | undefined {
	const hostStartedEvents = events.filter(
		event => event.type === 'host-started'
	);
	if (hostStartedEvents.length === 0) {
		return 'electron-runtime-identity-missing';
	}
	if (hostStartedEvents.length !== 1) {
		return `electron-runtime-identity-count:${hostStartedEvents.length}`;
	}
	if (expectedRoot === undefined) {
		return 'electron-runtime-root-lifetime-unavailable';
	}
	const [hostStarted] = hostStartedEvents;
	if (hostStarted === undefined) {
		return 'electron-runtime-identity-missing';
	}
	return hostStarted.pid === expectedRoot.processId
		? undefined
		: 'electron-runtime-root-pid-mismatch:'
			+ `${hostStarted.pid}:${expectedRoot.processId}`;
}

function isNotFoundError(error: unknown): boolean {
	return error !== null
		&& typeof error === 'object'
		&& 'code' in error
		&& error.code === 'ENOENT';
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (isNotFoundError(error)) return false;
		throw error;
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch (error) {
		if (isNotFoundError(error)) return false;
		throw error;
	}
}

export async function exactArtifactRecordViolation(
	expected: ArtifactRecord,
	label: string
): Promise<string | undefined> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(expected.path, 'r');
	} catch (error) {
		return isNotFoundError(error)
			? `${label}-missing-after-acceptance`
			: `${label}-read-failed-after-acceptance:${errorMessage(error)}`;
	}
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile()) {
			return `${label}-not-regular-file-after-acceptance`;
		}
		if (metadata.size !== expected.sizeBytes) {
			return `${label}-size-changed-after-acceptance`;
		}
		const contents = await handle.readFile();
		if (contents.byteLength !== expected.sizeBytes) {
			return `${label}-size-changed-after-acceptance`;
		}
		if (sha256Hex(contents) !== expected.sha256) {
			return `${label}-bytes-changed-after-acceptance`;
		}
		const finalMetadata = await handle.stat();
		if (!finalMetadata.isFile()) {
			return `${label}-not-regular-file-after-acceptance`;
		}
		if (finalMetadata.size !== expected.sizeBytes) {
			return `${label}-size-changed-after-acceptance`;
		}
		return undefined;
	} catch (error) {
		return `${label}-read-failed-after-acceptance:${errorMessage(error)}`;
	} finally {
		await handle.close();
	}
}

function isTransientSidecarReadError(error: unknown): boolean {
	return error !== null
		&& typeof error === 'object'
		&& 'code' in error
		&& ['EACCES', 'EBUSY', 'EPERM'].includes(String(error.code));
}

async function waitForEtlRecorderSidecarBytes(
	path: string,
	process: OwnedProcess,
	timeoutMs: number,
	phase: 'ready' | 'status',
	signal?: AbortSignal
): Promise<Uint8Array> {
	return withTimeout((async () => {
		for (;;) {
			signal?.throwIfAborted();
			try {
				const contents = await readFile(path);
				if (
					process.child.exitCode !== null
					|| process.child.signalCode !== null
				) {
					throw new Error(
						`ETL recorder exited while ${phase} evidence was being read.`
					);
				}
				return contents;
			} catch (error) {
				if (
					!isNotFoundError(error)
					&& !isTransientSidecarReadError(error)
				) {
					throw error;
				}
			}
			if (
				process.child.exitCode !== null
				|| process.child.signalCode !== null
			) {
				throw new Error(
					`ETL recorder exited before creating its ${phase} sidecar.`
				);
			}
			await new Promise(resolveWait => setTimeout(resolveWait, 25));
		}
	})(), timeoutMs, `ETL recorder ${phase} evidence`, signal);
}

function waitForEtlRecorderReadyBytes(
	path: string,
	process: OwnedProcess,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<Uint8Array> {
	return waitForEtlRecorderSidecarBytes(
		path,
		process,
		timeoutMs,
		'ready',
		signal
	);
}

function waitForEtlRecorderStatusBytes(
	path: string,
	process: OwnedProcess,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<Uint8Array> {
	return waitForEtlRecorderSidecarBytes(
		path,
		process,
		timeoutMs,
		'status',
		signal
	);
}

function safeBigIntNumber(value: bigint, label: string): number {
	if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new RangeError(`${label} is outside the safe integer range.`);
	}
	return Number(value);
}

function offlineFileIdentity(
	metadata: BigIntStats
): OfflinePresentMonFileIdentity {
	if (metadata.dev < 0n || metadata.dev > 0xffff_ffffn) {
		throw new RangeError(
			'Windows volume serial number is outside the unsigned 32-bit range.'
		);
	}
	if (metadata.ino < 0n || metadata.ino > 0xffff_ffff_ffff_ffffn) {
		throw new RangeError(
			'Windows file index is outside the unsigned 64-bit range.'
		);
	}
	return {
		fileIndex: metadata.ino.toString(16).padStart(16, '0'),
		volumeSerialNumber: metadata.dev.toString(10)
	};
}

async function sha256FileHandle(
	handle: Awaited<ReturnType<typeof open>>,
	sizeBytes: number
): Promise<string> {
	const hash = createHash('sha256');
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	let position = 0;
	while (position < sizeBytes) {
		const requested = Math.min(
			buffer.byteLength,
			sizeBytes - position
		);
		const { bytesRead } = await handle.read(
			buffer,
			0,
			requested,
			position
		);
		if (bytesRead <= 0) {
			throw new Error(
				'Accepted ETL ended before its attested size.'
			);
		}
		hash.update(buffer.subarray(0, bytesRead));
		position += bytesRead;
	}
	return hash.digest('hex');
}

async function verifyAcceptedEtlCapture(
	capture: AcceptedEtlRecorderCapture
): Promise<void> {
	const handle = await open(capture.operationalEtlPath, 'r');
	try {
		const metadataBeforeHash = await handle.stat({ bigint: true });
		if (!metadataBeforeHash.isFile()) {
			throw new Error('Accepted ETL path is no longer a regular file.');
		}
		const identityBeforeHash = offlineFileIdentity(
			metadataBeforeHash
		);
		if (
			identityBeforeHash.fileIndex !== capture.etlFileIndex
			|| identityBeforeHash.volumeSerialNumber
				!== capture.etlVolumeSerialNumber
		) {
			throw new Error(
				'Accepted ETL file identity changed before offline replay.'
			);
		}
		const sizeBeforeHash = safeBigIntNumber(
			metadataBeforeHash.size,
			'Accepted ETL size'
		);
		if (sizeBeforeHash !== capture.etlSizeBytes) {
			throw new Error(
				'Accepted ETL file size changed before offline replay.'
			);
		}
		const sha256 = await sha256FileHandle(
			handle,
			sizeBeforeHash
		);
		if (sha256 !== capture.etlSha256) {
			throw new Error(
				'Accepted ETL SHA-256 changed before offline replay.'
			);
		}
		const metadataAfterHash = await handle.stat({ bigint: true });
		const identityAfterHash = offlineFileIdentity(
			metadataAfterHash
		);
		if (
			identityAfterHash.fileIndex
				!== identityBeforeHash.fileIndex
			|| identityAfterHash.volumeSerialNumber
				!== identityBeforeHash.volumeSerialNumber
			|| safeBigIntNumber(
				metadataAfterHash.size,
				'Accepted ETL size after hash'
			) !== sizeBeforeHash
		) {
			throw new Error(
				'Accepted ETL identity or size changed while hashing.'
			);
		}
	} finally {
		await handle.close();
	}
}

async function completeOwnedProcess(
	process: OwnedProcess,
	timeoutMs: number,
	label: string,
	signal?: AbortSignal,
	interruption?: Promise<never>
): Promise<{
	exit: OwnedProcessExit;
	interruption?: Error;
	terminatedByController: boolean;
}> {
	try {
		const exit = await withTimeout(
			interruption === undefined
				? process.completed
				: Promise.race([process.completed, interruption]),
			timeoutMs,
			label,
			signal
		);
		return {
			exit,
			terminatedByController: false
		};
	} catch (error) {
		const interruptionError = error instanceof Error
			? error
			: new Error(String(error));
		const exit = await stopOwnedProcess(process, label);
		return {
			exit,
			interruption: interruptionError,
			terminatedByController: true
		};
	}
}

export function etlRecorderReleaseAcknowledgmentViolation(
	stdout: string,
	releaseToken: string
): string | undefined {
	return stdout === `RELEASED|${releaseToken}\r\n`
		? undefined
		: 'etl-recorder-release-acknowledgment-not-exact';
}

async function releaseEtlRecorder(options: {
	interruption?: Promise<never>;
	launch: EtlRecorderLaunchArguments;
	process: OwnedProcess;
	signal?: AbortSignal;
}): Promise<{
	exit: OwnedProcessExit;
	releaseAcknowledged: boolean;
	terminatedByController: boolean;
}> {
	const stdin = options.process.child.stdin;
	if (stdin === null || stdin.destroyed) {
		throw new Error(
			'ETL recorder release pipe is unavailable.'
		);
	}
	const releaseRecord =
		`RELEASE|${options.launch.releaseToken}\r\n`;
	await new Promise<void>((resolveWrite, rejectWrite) => {
		const onError = (error: Error): void => {
			rejectWrite(error);
		};
		stdin.once('error', onError);
		stdin.end(releaseRecord, 'utf8', () => {
			stdin.removeListener('error', onError);
			resolveWrite();
		});
	});
	const completion = await completeOwnedProcess(
		options.process,
		ETL_RECORDER_RELEASE_TIMEOUT_MS,
		'ETL recorder lease release',
		options.signal,
		options.interruption
	);
	if (completion.interruption !== undefined) {
		throw new Error(
			'ETL recorder release was interrupted: '
				+ completion.interruption.message
		);
	}
	if (
		completion.exit.launchError !== undefined
		|| completion.exit.exitCode !== 0
	) {
		throw new Error(
			'ETL recorder failed during lease release: '
				+ (
					completion.exit.launchError
					?? `exit code ${completion.exit.exitCode}`
				)
				+ '.'
		);
	}
	if (
		completion.exit.stdoutTruncated
		|| completion.exit.stderrTruncated
	) {
		throw new Error(
			'ETL recorder release output was truncated.'
		);
	}
	if (
		etlRecorderReleaseAcknowledgmentViolation(
			completion.exit.stdout,
			options.launch.releaseToken
		) !== undefined
	) {
		throw new Error(
			'ETL recorder did not return the exact release acknowledgment.'
		);
	}
	return {
		exit: completion.exit,
		releaseAcknowledged: true,
		terminatedByController:
			completion.terminatedByController
	};
}

async function collectOfflineReplayEvidence(options: {
	exit: OwnedProcessExit;
	outputCapture: Promise<OfflineReplayOutputCapture>;
	outputExistedBefore: boolean;
	outputPath: string;
	terminatedByController: boolean;
}): Promise<OfflinePresentMonReplayEvidence> {
	const outputCapture = await options.outputCapture;
	return {
		exitCode: options.exit.exitCode,
		...outputCapture,
		outputExistedBefore: options.outputExistedBefore,
		outputPath: options.outputPath,
		stderr: options.exit.stderr,
		stderrComplete: !options.exit.stderrTruncated,
		terminatedByController: options.terminatedByController
	};
}

async function executeOfflinePresentMonReplay(
	run: OfflinePresentMonReplayRun,
	presentMon: VerifiedTool,
	timeoutMs: number,
	signal?: AbortSignal,
	interruption?: Promise<never>
): Promise<void> {
	const outputExistedBefore = await pathExists(
		run.launch.outputCsvPath
	);
	if (outputExistedBefore) {
		throw new Error(
			`${run.name} output path already exists; refusing to overwrite evidence.`
		);
	}
	await reverifyFileImmediatelyBeforeUse(
		presentMon,
		'PresentMon'
	);
	run.process = await startOfflineReplayProcess(
		presentMon.path,
		run.launch.args,
		run.launch.outputCsvPath,
		MAX_OFFLINE_REPLAY_BYTES,
		presentMon
	);
	const replayProcessIdentity = await run.process.started;
	if (replayProcessIdentity === undefined) {
		throw new Error(
			`${run.name} launch did not produce verified process identity.`
		);
	}
	run.processIdentity = replayProcessIdentity;
	const completion = await completeOwnedProcess(
		run.process,
		timeoutMs,
		`${run.name} offline replay`,
		signal,
		interruption
	);
	run.exit = completion.exit;
	run.terminatedByController =
		completion.terminatedByController
		|| run.process.stdoutByteLimitExceeded();
	run.evidence = await collectOfflineReplayEvidence({
		exit: completion.exit,
		outputCapture: run.process.outputCapture,
		outputExistedBefore,
		outputPath: run.launch.outputCsvPath,
		terminatedByController: run.terminatedByController
	});
	run.assessment = assessOfflinePresentMonReplay(
		run.evidence,
		run.expectation
	);
	if (completion.interruption !== undefined) {
		throw new Error(
			`${run.name} was terminated by the controller: `
				+ completion.interruption.message
		);
	}
	if (completion.exit.launchError !== undefined) {
		throw new Error(
			`${run.name} failed to launch: ${completion.exit.launchError}.`
		);
	}
	if (!run.assessment.valid) {
		throw new Error(
			`${run.name} evidence is invalid: `
				+ `${run.assessment.reasons.join(', ')}.`
		);
	}
}

async function executeEtlProcessInspection(
	run: EtlProcessInspectionRun,
	etlRecorder: VerifiedTool,
	timeoutMs: number,
	signal?: AbortSignal,
	interruption?: Promise<never>
): Promise<void> {
	if (await pathExists(run.outputPath)) {
		throw new Error(
			'ETL process-event output path already exists; refusing to overwrite evidence.'
		);
	}
	await reverifyFileImmediatelyBeforeUse(
		etlRecorder,
		'ETL process inspector'
	);
	run.process = await startOfflineReplayProcess(
		etlRecorder.path,
		run.launch.args,
		run.outputPath,
		MAX_ETL_PROCESS_EVENT_BYTES,
		etlRecorder
	);
	const processIdentity = await run.process.started;
	if (processIdentity === undefined) {
		throw new Error(
			'ETL process inspection did not produce verified process identity.'
		);
	}
	run.processIdentity = processIdentity;
	const completion = await completeOwnedProcess(
		run.process,
		timeoutMs,
		'ETL process-event inspection',
		signal,
		interruption
	);
	run.exit = completion.exit;
	run.terminatedByController =
		completion.terminatedByController
		|| run.process.stdoutByteLimitExceeded();
	const capture = await run.process.outputCapture;
	if (completion.interruption !== undefined) {
		throw new Error(
			'ETL process-event inspection was terminated by the controller: '
				+ completion.interruption.message
		);
	}
	if (
		completion.exit.launchError !== undefined
		|| completion.exit.exitCode !== 0
		|| completion.exit.signal !== null
		|| completion.exit.stderrTruncated
		|| completion.exit.stdoutTruncated
		|| completion.exit.stderr.length !== 0
		|| run.terminatedByController
		|| !capture.stdoutComplete
		|| capture.stdoutByteLimitExceeded
		|| capture.outputContents === undefined
		|| !capture.outputExistsAfter
		|| capture.outputIdentityAtOpen === undefined
		|| capture.outputIdentityAfterRead === undefined
		|| capture.outputIdentityAtOpen.fileIndex
			!== capture.outputIdentityAfterRead.fileIndex
		|| capture.outputIdentityAtOpen.volumeSerialNumber
			!== capture.outputIdentityAfterRead.volumeSerialNumber
		|| capture.stdoutSizeBytes < 2
		|| capture.outputSizeBytesAtOpen !== capture.stdoutSizeBytes
		|| capture.outputSizeBytesAfterRead !== capture.stdoutSizeBytes
		|| capture.outputContents.byteLength !== capture.stdoutSizeBytes
		|| capture.outputSha256AfterRead !== capture.stdoutSha256
		|| sha256Hex(capture.outputContents) !== capture.stdoutSha256
	) {
		throw new Error(
			'ETL process-event inspection output or process evidence is invalid.'
		);
	}
	run.evidenceRecord = Object.freeze({
		path: run.outputPath,
		sha256: capture.stdoutSha256,
		sizeBytes: capture.stdoutSizeBytes
	});
	run.evidence = parseEtlProcessEventEvidence(
		capture.outputContents
	);
	if (
		!sameEtlProcessInspectorIdentity(
			run.evidence.inspectorProcessIdentity,
			processIdentity
		)
	) {
		throw new Error(
			'Native ETL process-event evidence does not match the verified inspector process lifetime.'
		);
	}
	if (
		!sameEtlProcessInspectionInvocation(
			run.evidence.inspectionInvocation,
			run.launch.invocation
		)
	) {
		throw new Error(
			'Native ETL process-event evidence does not match the accepted inspection invocation.'
		);
	}
}

function decodeOfflineReplayOutput(
	run: OfflinePresentMonReplayRun
): string {
	const contents = run.evidence?.outputContents;
	if (contents === undefined) {
		throw new Error(`${run.name} output bytes are unavailable.`);
	}
	return new TextDecoder('utf-8', { fatal: true }).decode(contents);
}

async function waitForJobSampleAfter(
	candidateProcess: WindowsJobProcess,
	minimumTimestampMs: number,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<WindowsProcessTreeSample> {
	return withTimeout((async () => {
		for (;;) {
			signal?.throwIfAborted();
			const sample = candidateProcess.samples.at(-1);
			if (
				sample !== undefined
				&& sample.capturedAtMs >= minimumTimestampMs
			) {
				return sample;
			}
			await new Promise(resolveWait =>
				setTimeout(resolveWait, 25)
			);
		}
	})(), timeoutMs, 'Fresh Windows job process sample', signal);
}

function validateCandidateJobSample(
	sample: WindowsProcessTreeSample,
	rootProcessId: number,
	launchedRootProcess: WindowsProcessIdentity,
	expectedExecutablePath: string
): ReadonlySet<number> {
	const currentRootProcess = sample.processes.find(
		process => process.processId === rootProcessId
	);
	if (currentRootProcess === undefined) {
		throw new Error(
			'The launched root process disappeared before benchmark release.'
		);
	}
	if (
		!sameWindowsProcessIdentity(
			launchedRootProcess,
			currentRootProcess
		)
	) {
		throw new Error(
			'The launched root process changed identity before benchmark release.'
		);
	}
	const imageViolation = processImageViolation(
		sample.processes,
		expectedExecutablePath
	);
	if (imageViolation) throw new Error(imageViolation);
	return new Set(
		sample.processes.map(process => process.processId)
	);
}

function canonicalProcessIds(
	processIds: readonly number[]
): readonly number[] {
	return [...processIds].sort((left, right) => left - right);
}

function sameProcessIds(
	left: readonly number[],
	right: readonly number[]
): boolean {
	const canonicalLeft = canonicalProcessIds(left);
	const canonicalRight = canonicalProcessIds(right);
	return canonicalLeft.length === canonicalRight.length
		&& canonicalLeft.every(
			(processId, index) => processId === canonicalRight[index]
		);
}

async function captureStableJobMembership(options: {
	candidateProcess: WindowsJobProcess;
	expectedExecutablePath: string;
	launchedRootProcess: WindowsProcessIdentity;
	processIsolationFailure: Promise<never>;
	rootProcessId: number;
	signal?: AbortSignal;
}): Promise<StableJobMembership> {
	let lastReason = 'stable-membership-unavailable';
	for (
		let attempt = 0;
		attempt < STABLE_JOB_MEMBERSHIP_ATTEMPTS;
		attempt += 1
	) {
		const before = await guardJobOperation(
			options.candidateProcess.snapshotProcessIds({
				signal: options.signal,
				timeoutMs: PROCESS_ID_SNAPSHOT_TIMEOUT_MS
			}),
			options.candidateProcess,
			options.processIsolationFailure
		);
		const minimumSampleTimestampMs = Date.now();
		const sample = await guardJobOperation(
			waitForJobSampleAfter(
				options.candidateProcess,
				minimumSampleTimestampMs,
				PROCESS_MONITOR_INTERVAL_MS + 5_000,
				options.signal
			),
			options.candidateProcess,
			options.processIsolationFailure
		);
		const after = await guardJobOperation(
			options.candidateProcess.snapshotProcessIds({
				signal: options.signal,
				timeoutMs: PROCESS_ID_SNAPSHOT_TIMEOUT_MS
			}),
			options.candidateProcess,
			options.processIsolationFailure
		);
		if (!sameProcessIds(before, after)) {
			lastReason = 'exact-job-membership-changed-around-sample';
			continue;
		}
		const membershipViolation = exactJobMembershipViolation(
			after,
			sample
		);
		if (membershipViolation !== undefined) {
			lastReason = membershipViolation;
			continue;
		}
		validateCandidateJobSample(
			sample,
			options.rootProcessId,
			options.launchedRootProcess,
			options.expectedExecutablePath
		);
		return {
			processIds: Object.freeze(canonicalProcessIds(after)),
			sample
		};
	}
	throw new Error(
		'Exact Windows Job membership did not match a fresh identity-bearing '
			+ `process sample after ${STABLE_JOB_MEMBERSHIP_ATTEMPTS} attempts: `
			+ `${lastReason}.`
	);
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, '\t')}\n`);
}

async function writeJsonArtifact(
	path: string,
	value: unknown
): Promise<ArtifactRecord> {
	const contents = Buffer.from(
		`${JSON.stringify(value, null, '\t')}\n`,
		'utf8'
	);
	await writeFile(path, contents, { flag: 'wx' });
	return Object.freeze({
		path,
		sha256: sha256Hex(contents),
		sizeBytes: contents.byteLength
	});
}

function offlineReplayEvidenceRecord(
	evidence: OfflinePresentMonReplayEvidence
): Omit<OfflinePresentMonReplayEvidence, 'outputContents'> & {
	outputContentsSha256?: string;
	outputContentsSizeBytes?: number;
} {
	const {
		outputContents,
		...record
	} = evidence;
	return {
		...record,
		...(outputContents === undefined
			? {}
			: {
				outputContentsSha256: sha256Hex(outputContents),
				outputContentsSizeBytes: outputContents.byteLength
			})
	};
}

async function collectArtifacts(root: string): Promise<ArtifactRecord[]> {
	const records: ArtifactRecord[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const absolutePath = join(directory, entry.name);
			const relativePath = relative(root, absolutePath).replaceAll('\\', '/');
			if (entry.isDirectory()) {
				if (relativePath === 'profile' || relativePath === 'session') continue;
				await visit(absolutePath);
			} else if (entry.isFile() && relativePath !== 'artifact-manifest.json') {
				const metadata = await stat(absolutePath);
				records.push({
					path: relativePath,
					sha256: await sha256FileHex(absolutePath),
					sizeBytes: metadata.size
				});
			}
		}
	};
	await visit(root);
	return records.sort((left, right) => left.path.localeCompare(right.path));
}

async function persistProcessLogs(
	logsDirectory: string,
	name: string,
	launch:
		| EtlProcessEventInspectionArguments
		| EtlRecorderLaunchArguments
		| OfflinePresentMonArguments
		| RuntimeLaunchPlan,
	exit: OwnedProcessExit
): Promise<void> {
	await Promise.all([
		writeJson(join(logsDirectory, `${name}.json`), { exit, launch }),
		writeFile(join(logsDirectory, `${name}.stdout.log`), exit.stdout),
		writeFile(join(logsDirectory, `${name}.stderr.log`), exit.stderr)
	]);
}

function assertExpectedAttestation(options: {
	candidate: ResolvedRuntimeCandidate;
	controllerSourceInventory: RuntimeControllerSourceInventory<
		VerifiedRuntimeControllerSource
	>;
	electronHost: VerifiedRuntimeControllerElectronHost;
	etlRecorder: VerifiedTool;
	expected?: RuntimeLabSingleRunExpectedAttestation;
	presentMon: VerifiedTool;
	scenario: ResolvedRuntimeLabScenario;
}): void {
	if (options.expected === undefined) return;
	const actual: RuntimeLabSingleRunExpectedAttestation = {
		candidate: {
			executablePath: options.candidate.executablePath,
			executableSha256: options.candidate.executableSha256,
			executableSizeBytes:
				options.candidate.executableSizeBytes,
			id: options.candidate.manifest.id,
			manifestPath: options.candidate.manifestPath,
			manifestSha256: options.candidate.manifestSha256,
			runtimeKind: options.candidate.manifest.runtimeKind
		},
		controllerSourceInventory:
			options.controllerSourceInventory,
		electronHost: options.electronHost,
		etlRecorder: options.etlRecorder,
		presentMon: options.presentMon,
		scenario: {
			id: options.scenario.scenario.id,
			manifestPath: options.scenario.manifestPath,
			manifestSha256: options.scenario.manifestSha256
		}
	};
	if (
		canonicalJson(actual)
		!== canonicalJson(options.expected)
	) {
		throw new Error(
			'Single-run inputs do not match the tournament dry-run attestation.'
		);
	}
}

export async function runRuntimeLabSingleRun(options: RuntimeLabSingleRunOptions): Promise<RuntimeLabSingleRunResult> {
	options.signal?.throwIfAborted();
	const operationAbortController = new AbortController();
	const operationSignal = options.signal
		? AbortSignal.any([options.signal, operationAbortController.signal])
		: operationAbortController.signal;
	if (!options.confirmIdleSystem) {
		throw new Error('A runtime run requires an explicit idle-system confirmation; no candidate will be launched while the active client may be in use.');
	}
	if (process.platform !== 'win32') throw new Error('The sealed runtime controller currently requires Windows.');
	const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
	if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1_000 || startupTimeoutMs > 120_000) {
		throw new TypeError('startupTimeoutMs must be an integer from 1,000 through 120,000.');
	}
	const runId = options.runId ?? createRunId();
	assertRuntimeLabIdentifier(runId, 'runId');
	const startedAt = new Date().toISOString();

	const [
		candidate,
		scenario,
		etlRecorder,
		presentMon,
		runtimeControllerAttestation
	] = await Promise.all([
		resolveRuntimeCandidateManifest(options.candidateManifestPath),
		resolveRuntimeLabScenario(options.scenarioManifestPath),
		verifyTool(
			options.etlRecorderPath,
			options.etlRecorderSha256,
			'ETL recorder'
		),
		verifyTool(options.presentMonPath, options.presentMonSha256, 'PresentMon'),
		options.runtimeControllerAttestation === undefined
			? attestRuntimeControllerSources(options.electronHostDirectory)
			: Promise.resolve(options.runtimeControllerAttestation)
	]);
	const {
		electronHost: verifiedElectronHost,
		inventory: verifiedControllerSourceInventory
	} = getRuntimeControllerAttestationIdentity(
		runtimeControllerAttestation
	);
	const configuredElectronHostDirectory = await realpath(
		resolve(options.electronHostDirectory)
	);
	if (
		(process.platform === 'win32'
			? configuredElectronHostDirectory.toLowerCase()
				!== verifiedElectronHost.directory.toLowerCase()
			: configuredElectronHostDirectory
				!== verifiedElectronHost.directory)
	) {
		throw new Error(
			'Supplied runtime controller attestation belongs to a different Electron host directory.'
		);
	}
	if (!candidate.manifest.capabilities.presentMon) throw new Error('Candidate manifest does not declare PresentMon support.');
	if (scenario.scenario.benchmarkMs > MAX_CONTROLLER_BENCHMARK_MS) {
		throw new Error(`The controller page currently bounds benchmarkMs to ${MAX_CONTROLLER_BENCHMARK_MS}.`);
	}
	assertExpectedAttestation({
		candidate,
		controllerSourceInventory:
			verifiedControllerSourceInventory,
		electronHost: verifiedElectronHost,
		etlRecorder,
		expected: options.expectedAttestation,
		presentMon,
		scenario
	});

	const executableName = basename(candidate.executablePath);
	const initialCollisions = await listWindowsProcessesByExecutableName(executableName);
	if (initialCollisions.length > 0) {
		throw new Error(`Refusing to launch ${executableName}: ${initialCollisions.length} process(es) with that executable name are already active.`);
	}

	const outputRootDirectory = isAbsolute(options.outputRootDirectory)
		? options.outputRootDirectory
		: resolve(options.outputRootDirectory);
	await mkdir(outputRootDirectory, { recursive: true });
	const runDirectory = join(outputRootDirectory, runId);
	await mkdir(runDirectory);
	const capturesDirectory = join(runDirectory, 'captures');
	const etlPath = join(capturesDirectory, 'presentmon.etl');
	const recorderReadyPath = join(
		capturesDirectory,
		'etl-recorder-ready.json'
	);
	const recorderStatusPath = join(
		capturesDirectory,
		'etl-recorder-status.json'
	);
	const processNameCsvPath = join(
		capturesDirectory,
		'presentmon-process-name.csv'
	);
	const headlineCsvPath = join(
		capturesDirectory,
		'presentmon-headline.csv'
	);
	const etlProcessEventsPath = join(
		capturesDirectory,
		'etl-process-events.json'
	);
	const etlProcessLifetimesPath = join(
		capturesDirectory,
		'etl-process-lifetimes.json'
	);
	const presentMonProcessLifetimeBindingPath = join(
		capturesDirectory,
		'presentmon-headline-process-lifetime-binding.json'
	);
	const controllerSourceEvidenceDirectory = join(
		runDirectory,
		'controller-sources'
	);
	const electronHostEvidenceDirectory = join(runDirectory, 'electron-host');
	const logsDirectory = join(runDirectory, 'logs');
	const serverDirectory = join(runDirectory, 'server');
	await Promise.all([
		mkdir(capturesDirectory),
		mkdir(controllerSourceEvidenceDirectory),
		mkdir(electronHostEvidenceDirectory),
		mkdir(logsDirectory),
		mkdir(serverDirectory)
	]);
	await Promise.all([
		writeJson(
			join(runDirectory, 'candidate-manifest.json'),
			candidate.manifest
		),
		writeJson(
			join(runDirectory, 'scenario-manifest.json'),
			scenario.scenario
		)
	]);

	const [controllerSourceInventory, persistedElectronHost] =
		await Promise.all([
			persistAttestedRuntimeControllerSources(
				runtimeControllerAttestation,
				controllerSourceEvidenceDirectory
			),
			persistAttestedRuntimeControllerElectronHost(
				runtimeControllerAttestation,
				electronHostEvidenceDirectory
			)
		]);
	const controllerSources = controllerSourceInventory.sources;
	const page = buildCalibrationParityPage(
		getAttestedWokMarkSvg(runtimeControllerAttestation)
	);
	const recorderDurationMs = calculateEtlRecorderDurationMs(
		scenario.scenario.benchmarkMs,
		startupTimeoutMs
	);
	const recorderLaunch = buildEtlRecorderLaunchArguments({
		durationMs: recorderDurationMs,
		etlPath,
		readyPath: recorderReadyPath,
		runId,
		statusPath: recorderStatusPath
	});
	const controllerTimeoutMs = Math.min(
		MAX_ETL_RECORDER_DURATION_MS,
		recorderDurationMs + 30_000
	);
	const offlineReplayTimeoutMs = Math.min(
		MAX_OFFLINE_REPLAY_TIMEOUT_MS,
		Math.max(MIN_OFFLINE_REPLAY_TIMEOUT_MS, recorderDurationMs)
	);

	let guard: WindowsEgressGuard | undefined;
	let server: RuntimeLabServer | undefined;
	let serverOutcome: Promise<{ error?: Error; run?: RuntimeLabCompletedRun }> | undefined;
	let launchPlan: RuntimeLaunchPlan | undefined;
	let candidateProcess: WindowsJobProcess | undefined;
	let candidateExit: WindowsJobProcessExit | undefined;
	let processIsolationFailure: Promise<never> | undefined;
	let rejectProcessIsolation: ((error: Error) => void) | undefined;
	let processIsolationFailed = false;
	const recorderRun: EtlRecorderRun = {
		launch: recorderLaunch,
		terminatedByController: false
	};
	let processNameReplay: OfflinePresentMonReplayRun | undefined;
	let processIdReplay: OfflinePresentMonReplayRun | undefined;
	let etlProcessInspection: EtlProcessInspectionRun | undefined;
	let processNameAnalysis: PresentMonCsvAnalysis | undefined;
	let headlineAnalysis: PresentMonCsvAnalysis | undefined;
	let headlineStream: PresentMonStreamAnalysis | undefined;
	let etlProcessLifetime: EtlProcessLifetimeArtifact | undefined;
	let etlProcessLifetimeEvidence: ArtifactRecord | undefined;
	let presentMonProcessLifetimeBinding:
		| PresentMonProcessLifetimeBinding
		| undefined;
	let presentMonProcessLifetimeBindingEvidence:
		| ArtifactRecord
		| undefined;
	let stableJobMembership: StableJobMembership | undefined;
	let pageRun: RuntimeLabCompletedRun | undefined;
	let presentingProcessId: number | undefined;
	let presentingProcessSample: WindowsProcessIdentity | undefined;
	let runtimeIdentity: ChromiumRuntimeIdentity | RuntimeHostEvent | undefined;
	let runtimeIdentityError: string | undefined;
	let cleanup: WindowsJobCleanupResult | undefined;
	let rootProcessId: number | undefined;
	let rootProcessIdentity: WindowsProcessIdentity | undefined;
	let rootProcessLifetimeIdentity:
		| WindowsProcessLifetimeIdentity
		| undefined;
	let primaryError: Error | undefined;
	let unexpectedProcessExit: OwnedProcessExit | undefined;
	const controllerViolations: string[] = [];
	const cleanupViolations: string[] = [];

	const controllerManifestBase = {
		candidate: {
			executablePath: candidate.executablePath,
			executableSha256: candidate.executableSha256,
			id: candidate.manifest.id,
			manifestPath: candidate.manifestPath,
			manifestSha256: candidate.manifestSha256
		},
		controllerSourceInventoryVersion:
			controllerSourceInventory.version,
		controllerSources,
		controllerVersion: CONTROLLER_RESULT_VERSION,
		electronHost: {
			launchDirectory: persistedElectronHost.launchDirectory,
			mainPath: persistedElectronHost.main.path,
			mainSha256: persistedElectronHost.main.sha256,
			mainSizeBytes: persistedElectronHost.main.sizeBytes,
			packagePath: persistedElectronHost.package.path,
			packageSha256: persistedElectronHost.package.sha256,
			packageSizeBytes: persistedElectronHost.package.sizeBytes
		},
		etlRecorder,
		page: {
			calibrationSourceSha256: page.calibrationSourceSha256,
			id: page.pageId,
			sha256: page.sha256,
			workloadVersion: page.workloadVersion
		},
		presentMon,
		runId,
		scenario: {
			id: scenario.scenario.id,
			manifestPath: scenario.manifestPath,
			manifestSha256: scenario.manifestSha256
		},
		startedAt
	};
	await writeJson(join(runDirectory, 'controller-manifest.json'), {
		...controllerManifestBase,
		status: 'running'
	});

	try {
		operationSignal.throwIfAborted();
		guard = await installWindowsEgressGuard(runId);
		const postGuardCollisions = await listWindowsProcessesByExecutableName(executableName);
		if (postGuardCollisions.length > 0) {
			throw new Error(`A ${executableName} process appeared after collision preflight; refusing to continue.`);
		}
		operationSignal.throwIfAborted();
		server = await startLoopbackServer({
			benchmarkMs: scenario.scenario.benchmarkMs,
			candidateId: candidate.manifest.id,
			inputMode: scenario.scenario.inputMode,
			minSamples: scenario.scenario.minSamples,
			outputDirectory: serverDirectory,
			page,
			runId,
			startMode: 'controller',
			timeoutMs: controllerTimeoutMs
		});
		serverOutcome = server.completed.then(
			run => ({ run }),
			error => ({ error: error instanceof Error ? error : new Error(String(error)) })
		);
		launchPlan = buildRuntimeLaunchPlan({
			candidate,
			electronHostDirectory:
				persistedElectronHost.launchDirectory,
			pageUrl: server.pageUrl,
			runDirectory,
			scenario: scenario.scenario
		});
		await Promise.all([
			mkdir(launchPlan.profileDirectory),
			mkdir(launchPlan.sessionDirectory),
			writeJson(join(logsDirectory, 'candidate-launch.json'), launchPlan)
		]);
		operationSignal.throwIfAborted();
		await writeJson(
			join(logsDirectory, 'etl-recorder-launch.json'),
			recorderLaunch
		);
		await reverifyFileImmediatelyBeforeUse(
			etlRecorder,
			'ETL recorder'
		);
		recorderRun.process = startOwnedProcess(
			etlRecorder,
			recorderLaunch.args,
			{
				controlDirectory: logsDirectory,
				stdin: 'pipe',
				windowsHide: true
			}
		);
		const recorderProcessIdentity = await recorderRun.process.started;
		if (recorderProcessIdentity === undefined) {
			throw new Error(
				'ETL recorder launch did not produce verified process identity.'
			);
		}
		recorderRun.processIdentity = recorderProcessIdentity;
		const readyBytes = await waitForEtlRecorderReadyBytes(
			recorderReadyPath,
			recorderRun.process,
			ETL_RECORDER_READY_TIMEOUT_MS,
			operationSignal
		);
		recorderRun.readyEvidence = {
			path: recorderReadyPath,
			sha256: sha256Hex(readyBytes),
			sizeBytes: readyBytes.byteLength
		};
		recorderRun.ready = parseEtlRecorderReadySidecar(readyBytes);
		const expectedRecorderIdentity = {
			durationMs: recorderLaunch.durationMs,
			etlPath: recorderLaunch.etlPath,
			sessionName: recorderLaunch.sessionName
		};
		recorderRun.readyAssessment = assessEtlRecorderReady(
			recorderRun.ready,
			expectedRecorderIdentity
		);
		if (!recorderRun.readyAssessment.valid) {
			throw new Error(
				'ETL recorder ready evidence is invalid: '
					+ `${recorderRun.readyAssessment.reasons.join(', ')}.`
			);
		}
		if (
			recorderRun.process.child.exitCode !== null
			|| recorderRun.process.child.signalCode !== null
		) {
			throw new Error(
				'ETL recorder exited after ready evidence and before candidate creation.'
			);
		}

		operationSignal.throwIfAborted();
		const preLaunchCollisions =
			await listWindowsProcessesByExecutableName(executableName);
		if (preLaunchCollisions.length > 0) {
			throw new Error(
				`A ${executableName} process appeared before candidate launch; refusing to continue.`
			);
		}
		await reverifyFileImmediatelyBeforeUse(
			{
				path: candidate.executablePath,
				sha256: candidate.executableSha256,
				sizeBytes: candidate.executableSizeBytes
			},
			'Candidate executable'
		);
		processIsolationFailure = new Promise<never>((_resolve, reject) => {
			rejectProcessIsolation = reject;
		});
		candidateProcess = startWindowsJobProcess({
			arguments: launchPlan.arguments,
			cwd: dirname(candidate.executablePath),
			environment: launchPlan.environment,
			executable: {
				path: launchPlan.command,
				sha256: candidate.executableSha256,
				sizeBytes: candidate.executableSizeBytes
			},
			intervalMs: PROCESS_MONITOR_INTERVAL_MS,
			onSample(sample) {
				const violation = processImageViolation(
					sample.processes,
					candidate.executablePath
				);
				if (!violation || processIsolationFailed) return;
				processIsolationFailed = true;
				controllerViolations.push(violation);
				rejectProcessIsolation?.(new Error(
					'The candidate Windows job contains an image '
						+ 'outside the declared candidate runtime.'
				));
			}
		});
		const launched = await withTimeout(
			candidateProcess.started,
			startupTimeoutMs,
			'Candidate Windows job start',
			operationSignal
		);
		rootProcessId = launched.processId;
		rootProcessLifetimeIdentity = launched;
		rootProcessIdentity = {
			commandLine: '',
			creationTimeUtcTicks: launched.creationTimeUtcTicks,
			executableName: basename(launched.executablePath),
			executablePath: launched.executablePath,
			parentProcessId: 0,
			processId: launched.processId
		};
		const launchedRootImageViolation = processImageViolation(
			[rootProcessIdentity],
			candidate.executablePath
		);
		if (launchedRootImageViolation) {
			throw new Error(launchedRootImageViolation);
		}
		const firstProcessSample = await withTimeout(
			guardJobOperation(
				candidateProcess.firstSample,
				candidateProcess,
				processIsolationFailure
			),
			startupTimeoutMs,
			'Windows job first process sample',
			operationSignal
		);
		const launchedRootProcess = rootProcessIdentity;
		const sampledRootProcess =
			firstProcessSample.processes.find(
				process =>
					process.processId
					=== rootProcessId
			);
		if (sampledRootProcess === undefined) {
			throw new Error('Process monitor first sample did not contain the launched root process.');
		}
		if (
			!sameWindowsProcessIdentity(
				launchedRootProcess,
				sampledRootProcess
			)
		) {
			throw new Error(
				'The launched root process changed identity before the first monitor sample.'
			);
		}
		const firstSampleViolation = processImageViolation(firstProcessSample.processes, candidate.executablePath);
		if (firstSampleViolation) throw new Error(firstSampleViolation);
		const suspendedProcessIds = await guardJobOperation(
			candidateProcess.snapshotProcessIds({
				signal: operationSignal,
				timeoutMs: PROCESS_ID_SNAPSHOT_TIMEOUT_MS
			}),
			candidateProcess,
			processIsolationFailure
		);
		const suspendedMembershipViolation = exactJobMembershipViolation(
			suspendedProcessIds,
			firstProcessSample
		);
		if (suspendedMembershipViolation !== undefined) {
			throw new Error(suspendedMembershipViolation);
		}
		if (
			suspendedProcessIds.length !== 1
			|| suspendedProcessIds[0] !== rootProcessId
		) {
			throw new Error(
				'Suspended candidate Job membership must contain only the '
					+ 'launched root process.'
			);
		}
		if (
			recorderRun.process.child.exitCode !== null
			|| recorderRun.process.child.signalCode !== null
		) {
			throw new Error(
				'ETL recorder exited after ready evidence and before candidate resume.'
			);
		}
		await withTimeout(
			guardJobOperation(
				candidateProcess.resume(),
				candidateProcess,
				processIsolationFailure
			),
			startupTimeoutMs,
			'Candidate Windows job resume',
			operationSignal
		);

		const identityOutcome: Promise<{
			error?: string;
			identity?: ChromiumRuntimeIdentity;
		}> = launchPlan.kind === 'chromium' && candidate.manifest.capabilities.devToolsProtocol
			? (async () => {
				try {
					const endpoint = await waitForChromiumDevTools(launchPlan.profileDirectory, {
						signal: operationSignal,
						timeoutMs: startupTimeoutMs
					});
					return {
						identity: await fetchChromiumRuntimeIdentity(endpoint, {
							signal: operationSignal,
							timeoutMs: startupTimeoutMs
						})
					};
				} catch (error) {
					return { error: errorMessage(error) };
				}
			})()
			: Promise.resolve({});
		const candidateInterruption = Promise.race([
			processIsolationFailure,
			candidateProcess.completed.then(exit => {
				throw new UnexpectedWindowsJobExitError(exit);
			})
		]);
		void candidateInterruption.catch(() => {});

		if (processIsolationFailed) {
			throw new Error(
				'The candidate process tree escaped the executable-scoped '
					+ 'egress guard before benchmark release.'
			);
		}
		if (
			candidateProcess.child.exitCode !== null
			|| candidateProcess.child.signalCode !== null
		) {
			throw new Error(
				'The Windows job host exited before benchmark release.'
			);
		}
		await server.releaseBenchmark();

		const pageOrExit = await withTimeout(Promise.race([
			serverOutcome.then(outcome => ({ kind: 'page' as const, outcome })),
			candidateProcess.completed.then(exit => ({ exit, kind: 'exit' as const })),
			processIsolationFailure
		]), controllerTimeoutMs, 'Runtime Lab page result', operationSignal);
		if (pageOrExit.kind === 'exit') {
			unexpectedProcessExit = pageOrExit.exit;
			throw new Error(`Candidate exited before reporting a result (code=${pageOrExit.exit.exitCode ?? 'null'}, signal=${pageOrExit.exit.signal ?? 'null'}).`);
		}
		if (pageOrExit.outcome.error) throw pageOrExit.outcome.error;
		pageRun = pageOrExit.outcome.run;
		if (!pageRun) throw new Error('Runtime Lab server completed without a page result.');

		const statusBytes = await guardJobOperation(
			waitForEtlRecorderStatusBytes(
				recorderStatusPath,
				recorderRun.process,
				recorderDurationMs + 30_000,
				operationSignal
			),
			candidateProcess,
			processIsolationFailure
		);
		recorderRun.statusEvidence = {
			path: recorderStatusPath,
			sha256: sha256Hex(statusBytes),
			sizeBytes: statusBytes.byteLength
		};
		recorderRun.status = parseEtlRecorderStatusSidecar(
			statusBytes
		);
		recorderRun.statusAssessment = assessEtlRecorderStatus(
			recorderRun.status,
			expectedRecorderIdentity
		);
		recorderRun.pairAssessment = assessEtlRecorderPair(
			recorderRun.ready,
			recorderRun.status,
			expectedRecorderIdentity
		);
		if (!recorderRun.statusAssessment.valid) {
			throw new Error(
				'ETL recorder status evidence is invalid: '
					+ `${recorderRun.statusAssessment.reasons.join(', ')}.`
			);
		}
		if (!recorderRun.pairAssessment.valid) {
			throw new Error(
				'ETL recorder pair evidence is invalid: '
					+ `${recorderRun.pairAssessment.reasons.join(', ')}.`
			);
		}
		recorderRun.acceptedCapture = acceptEtlRecorderPair(
			recorderRun.ready,
			recorderRun.status,
			expectedRecorderIdentity
		);
		if (
			recorderRun.process.child.exitCode !== null
			|| recorderRun.process.child.signalCode !== null
		) {
			throw new Error(
				'ETL recorder exited before its restrictive read lease was accepted.'
			);
		}
		await verifyAcceptedEtlCapture(recorderRun.acceptedCapture);

		stableJobMembership = await captureStableJobMembership({
			candidateProcess,
			expectedExecutablePath: candidate.executablePath,
			launchedRootProcess,
			processIsolationFailure,
			rootProcessId,
			signal: operationSignal
		});
		const startTimestampMs =
			pageRun.result.timings.timeOriginEpochMs
			+ pageRun.result.timings.benchmarkInvokedMs;
		const endTimestampMs =
			pageRun.result.timings.timeOriginEpochMs
			+ pageRun.result.timings.benchmarkCompletedMs;
		const captureProcessStartTimestampMs =
			captureFileTimeUtcToUnixMs(
				recorderRun.acceptedCapture
					.captureStartFileTimeUtc,
				'start'
			);
		const captureProcessEndTimestampMs =
			captureFileTimeUtcToUnixMs(
				recorderRun.acceptedCapture
					.captureStopFileTimeUtc,
				'stop'
			);
		const captureTimezoneOffsetMinutes = new Date(
			captureProcessStartTimestampMs
		).getTimezoneOffset();

		const processNameLaunch = buildOfflinePresentMonArguments({
			acceptedCapture: recorderRun.acceptedCapture,
			outputCsvPath: processNameCsvPath,
			targetProcessName: executableName
		});
		processNameReplay = {
			expectation: {
				allowedProcessIds: stableJobMembership.processIds,
				expectedOutputPath: processNameCsvPath,
				minimumFrameRecords: 1,
				mode: 'process-name',
				targetProcessName: executableName
			},
			launch: processNameLaunch,
			name: 'presentmon-process-name',
			terminatedByController: false
		};
		await writeJson(
			join(logsDirectory, 'presentmon-process-name-launch.json'),
			processNameLaunch
		);
		await executeOfflinePresentMonReplay(
			processNameReplay,
			presentMon,
			offlineReplayTimeoutMs,
			operationSignal,
			candidateInterruption
		);
		await verifyAcceptedEtlCapture(recorderRun.acceptedCapture);
		const processNameCsv = decodeOfflineReplayOutput(
			processNameReplay
		);
		processNameAnalysis = analyzePresentMonCsv(processNameCsv, {
			captureProcessEndTimestampMs,
			captureProcessStartTimestampMs,
			captureTimezoneOffsetMinutes,
			endTimestampMs,
			minimumFrameSamples: 1,
			startTimestampMs,
			warmupMs: 0
		});
		if (!processNameAnalysis.valid) {
			throw new Error(
				'Offline process-name replay analysis is invalid: '
					+ `${processNameAnalysis.reasons.join(', ')}.`
			);
		}
		presentingProcessId = selectPresentingProcessId(
			processNameAnalysis,
			new Set(stableJobMembership.processIds)
		);
		const sampledPresentingProcess =
			stableJobMembership.sample.processes.find(
				process => process.processId === presentingProcessId
			);
		if (sampledPresentingProcess === undefined) {
			throw new Error(
				'Selected presenting process is absent from the identity-bearing Job sample.'
			);
		}
		presentingProcessSample = Object.freeze({
			commandLine: sampledPresentingProcess.commandLine,
			creationTimeUtcTicks:
				sampledPresentingProcess.creationTimeUtcTicks,
			executableName: sampledPresentingProcess.executableName,
			executablePath: sampledPresentingProcess.executablePath,
			parentProcessId: sampledPresentingProcess.parentProcessId,
			processId: sampledPresentingProcess.processId
		});
		const expectedPresentingProcess: ProcessLifetimeIdentityExpectation = {
			creationTimeUtcTicks:
				presentingProcessSample.creationTimeUtcTicks,
			executableName: presentingProcessSample.executableName,
			executablePath: presentingProcessSample.executablePath,
			processId: presentingProcessSample.processId
		};
		const processIdLaunch = buildOfflinePresentMonArguments({
			acceptedCapture: recorderRun.acceptedCapture,
			outputCsvPath: headlineCsvPath,
			targetProcessId: presentingProcessId
		});
		processIdReplay = {
			expectation: {
				expectedApplicationName: executableName,
				expectedOutputPath: headlineCsvPath,
				minimumFrameRecords: scenario.scenario.minSamples,
				mode: 'process-id',
				targetProcessId: presentingProcessId
			},
			launch: processIdLaunch,
			name: 'presentmon-process-id',
			terminatedByController: false
		};
		await writeJson(
			join(logsDirectory, 'presentmon-process-id-launch.json'),
			processIdLaunch
		);
		await executeOfflinePresentMonReplay(
			processIdReplay,
			presentMon,
			offlineReplayTimeoutMs,
			operationSignal,
			candidateInterruption
		);
		await verifyAcceptedEtlCapture(recorderRun.acceptedCapture);
		const processIdCsv = decodeOfflineReplayOutput(processIdReplay);
		const replayAgreementViolation =
			selectedPidReplayEvidenceViolation(
				processNameCsv,
				processIdCsv,
				presentingProcessId
			);
		if (replayAgreementViolation !== undefined) {
			controllerViolations.push(replayAgreementViolation);
			throw new Error(replayAgreementViolation);
		}
		headlineAnalysis = analyzePresentMonCsv(processIdCsv, {
			captureProcessEndTimestampMs,
			captureProcessStartTimestampMs,
			captureTimezoneOffsetMinutes,
			endTimestampMs,
			minimumFrameSamples: scenario.scenario.minSamples,
			startTimestampMs,
			warmupMs: 0
		});
		const headlinePidViolation = headlinePresentingProcessViolation(
			headlineAnalysis,
			presentingProcessId
		);
		if (headlinePidViolation) controllerViolations.push(headlinePidViolation);
		headlineStream = selectHeadlinePresentMonStream(
			headlineAnalysis,
			presentingProcessId
		);
		const headlineStreamViolation =
			headlinePresentMonStreamViolation(
				headlineStream,
				presentingProcessId
			);
		if (headlineStreamViolation) {
			controllerViolations.push(
				headlineStreamViolation
			);
		}

		const etlProcessInspectionLaunch =
			buildEtlProcessEventInspectionArguments({
				acceptedCapture: recorderRun.acceptedCapture,
				candidateId: candidate.manifest.id,
				runId,
				targetProcessId: presentingProcessId
			});
		etlProcessInspection = {
			launch: etlProcessInspectionLaunch,
			outputPath: etlProcessEventsPath,
			terminatedByController: false
		};
		await writeJson(
			join(logsDirectory, 'etl-process-inspector-launch.json'),
			etlProcessInspectionLaunch
		);
		await executeEtlProcessInspection(
			etlProcessInspection,
			etlRecorder,
			offlineReplayTimeoutMs,
			operationSignal,
			candidateInterruption
		);
		if (
			etlProcessInspection.evidence === undefined
			|| etlProcessInspection.evidenceRecord === undefined
		) {
			throw new Error(
				'ETL process inspection completed without accepted evidence.'
			);
		}
		etlProcessLifetime = deriveEtlProcessLifetimes({
			acceptedCapture: recorderRun.acceptedCapture,
			evidence: etlProcessInspection.evidence,
			expectedProcess: expectedPresentingProcess,
			processEventEvidenceSha256:
				etlProcessInspection.evidenceRecord.sha256
		});
		etlProcessLifetimeEvidence = await writeJsonArtifact(
			etlProcessLifetimesPath,
			etlProcessLifetime
		);
		presentMonProcessLifetimeBinding =
			bindSelectedPresentMonFramesToProcessLifetime({
				expectedProcess: expectedPresentingProcess,
				lifetimeArtifact: etlProcessLifetime,
				stream: headlineStream
			});
		presentMonProcessLifetimeBindingEvidence = await writeJsonArtifact(
			presentMonProcessLifetimeBindingPath,
			presentMonProcessLifetimeBinding
		);
		await verifyAcceptedEtlCapture(recorderRun.acceptedCapture);
		const recorderRelease = await releaseEtlRecorder({
			interruption: candidateInterruption,
			launch: recorderRun.launch,
			process: recorderRun.process,
			signal: operationSignal
		});
		recorderRun.exit = recorderRelease.exit;
		recorderRun.releaseAcknowledged =
			recorderRelease.releaseAcknowledged;
		recorderRun.terminatedByController =
			recorderRelease.terminatedByController;
		const identity = await withTimeout(
			guardJobOperation(identityOutcome, candidateProcess, processIsolationFailure),
			startupTimeoutMs + 5_000,
			'Chromium runtime identity',
			operationSignal
		);
		if (identity.identity) runtimeIdentity = identity.identity;
		else if (identity.error) runtimeIdentityError = identity.error;
		if (runtimeIdentityError) controllerViolations.push(`runtime-identity:${runtimeIdentityError}`);
	} catch (error) {
		if (error instanceof UnexpectedWindowsJobExitError) {
			unexpectedProcessExit = error.exit;
		}
		primaryError = error instanceof Error ? error : new Error(String(error));
		operationAbortController.abort(primaryError);
	} finally {
		operationAbortController.abort(new Error('Runtime Lab controlled operation entered cleanup.'));
		if (
			rootProcessId !== undefined
			&& rootProcessIdentity === undefined
		) {
			cleanupViolations.push(
				'candidate-cleanup:launched-root-identity-unavailable'
			);
		}
		if (candidateProcess) {
			try {
				candidateExit = await withTimeout(
					candidateProcess.terminate(),
					10_000,
					'Windows job cleanup'
				);
			} catch (error) {
				cleanupViolations.push(
					`candidate-cleanup:${errorMessage(error)}`
				);
				if (
					candidateProcess.child.exitCode === null
					&& candidateProcess.child.signalCode === null
				) {
					candidateProcess.child.kill();
				}
				try {
					candidateExit = await withTimeout(
						candidateProcess.completed,
						5_000,
						'Forced Windows job host closure'
					);
				} catch (closureError) {
					cleanupViolations.push(
						'candidate-cleanup-force-close:'
							+ errorMessage(closureError)
					);
				}
			}
		}
		for (const replay of [processNameReplay, processIdReplay]) {
			if (replay?.process === undefined || replay.exit !== undefined) {
				continue;
			}
			try {
				replay.terminatedByController =
					replay.process.child.exitCode === null
					&& replay.process.child.signalCode === null;
				replay.exit = await stopOwnedProcess(
					replay.process,
					replay.name
				);
				replay.evidence = await collectOfflineReplayEvidence({
					exit: replay.exit,
					outputCapture:
						replay.process.outputCapture,
					outputExistedBefore: false,
					outputPath: replay.launch.outputCsvPath,
					terminatedByController:
						replay.terminatedByController
				});
				replay.assessment = assessOfflinePresentMonReplay(
					replay.evidence,
					replay.expectation
				);
			} catch (error) {
				cleanupViolations.push(
					`${replay.name}-cleanup:${errorMessage(error)}`
				);
			}
		}
		if (
			etlProcessInspection?.process !== undefined
			&& etlProcessInspection.exit === undefined
		) {
			try {
				etlProcessInspection.terminatedByController =
					etlProcessInspection.process.child.exitCode === null
					&& etlProcessInspection.process.child.signalCode === null;
				etlProcessInspection.exit = await stopOwnedProcess(
					etlProcessInspection.process,
					'ETL process inspector'
				);
			} catch (error) {
				cleanupViolations.push(
					`etl-process-inspector-cleanup:${errorMessage(error)}`
				);
			}
		}
		if (recorderRun.process !== undefined && recorderRun.exit === undefined) {
			try {
				if (
					recorderRun.acceptedCapture !== undefined
					&& recorderRun.process.child.exitCode === null
					&& recorderRun.process.child.signalCode === null
				) {
					const release = await releaseEtlRecorder({
						launch: recorderRun.launch,
						process: recorderRun.process
					});
					recorderRun.exit = release.exit;
					recorderRun.releaseAcknowledged =
						release.releaseAcknowledged;
					recorderRun.terminatedByController =
						release.terminatedByController;
				} else {
					recorderRun.terminatedByController =
						recorderRun.process.child.exitCode === null
						&& recorderRun.process.child.signalCode === null;
					recorderRun.exit = await stopOwnedProcess(
						recorderRun.process,
						'ETL recorder'
					);
				}
			} catch (error) {
				cleanupViolations.push(
					`etl-recorder-cleanup:${errorMessage(error)}`
				);
				try {
					recorderRun.terminatedByController =
						recorderRun.process.child.exitCode === null
						&& recorderRun.process.child.signalCode === null;
					recorderRun.exit = await stopOwnedProcess(
						recorderRun.process,
						'ETL recorder forced cleanup'
					);
				} catch (stopError) {
					cleanupViolations.push(
						'etl-recorder-force-cleanup:'
							+ errorMessage(stopError)
					);
				}
			}
		}
		if (server) {
			try {
				await withTimeout(server.close(), 10_000, 'Loopback server cleanup');
			} catch (error) {
				cleanupViolations.push(`server-cleanup:${errorMessage(error)}`);
			}
		}
		if (candidateProcess) {
			try {
				candidateExit = await withTimeout(candidateProcess.completed, 5_000, 'Candidate process cleanup');
			} catch (error) {
				cleanupViolations.push(`candidate-exit:${errorMessage(error)}`);
			}
		}
		if (candidateExit !== undefined) {
			cleanup = buildWindowsJobCleanupResult(
				candidateExit,
				rootProcessId
			);
			if (cleanup.membership.status === 'unreconciled') {
				cleanupViolations.push(
					'candidate-cleanup:windows-job-membership-unreconciled:'
						+ cleanup.membership.reason
				);
			}
			if (!cleanup.jobClean) {
				cleanupViolations.push(
					'candidate-cleanup:windows-job-not-empty'
				);
			}
			if (candidateExit.launchError) {
				cleanupViolations.push(
					`candidate-cleanup:${candidateExit.launchError}`
				);
			}
		}
		for (const [label, evidence] of [
			['etl-recorder-ready-sidecar', recorderRun.readyEvidence],
			['etl-recorder-status-sidecar', recorderRun.statusEvidence],
			[
				'etl-process-event-evidence',
				etlProcessInspection?.evidenceRecord
			],
			['etl-process-lifetime-evidence', etlProcessLifetimeEvidence],
			[
				'presentmon-process-lifetime-binding-evidence',
				presentMonProcessLifetimeBindingEvidence
			]
		] as const) {
			if (evidence === undefined) continue;
			const violation = await exactArtifactRecordViolation(
				evidence,
				label
			);
			if (violation !== undefined) {
				cleanupViolations.push(violation);
			}
		}
		if (guard) {
			const candidateMayRemain =
				shouldRetainCandidateFirewall({
					...(candidateExit === undefined
						? {}
						: { candidateExit }),
					candidateHostStarted:
						candidateProcess !== undefined,
					...(rootProcessId === undefined
						? {}
						: { candidateProcessId: rootProcessId }),
					...(cleanup === undefined
						? {}
						: { cleanup })
				});
			if (candidateMayRemain) {
				cleanupViolations.push(`firewall-retained-active-candidate:${guard.rule.name}`);
			} else {
				try {
					await closeWindowsEgressGuardWithRetry(guard);
				} catch (error) {
					cleanupViolations.push(
						`firewall-cleanup:${guard.rule.name}:`
							+ errorMessage(error)
					);
				}
			}
		}
	}

	if (recorderRun.terminatedByController) {
		controllerViolations.push('etl-recorder-terminated-by-controller');
	}
	if (etlProcessInspection?.terminatedByController) {
		controllerViolations.push(
			'etl-process-inspector-terminated-by-controller'
		);
	}
	for (const replay of [processNameReplay, processIdReplay]) {
		if (replay?.terminatedByController) {
			controllerViolations.push(
				`${replay.name}-terminated-by-controller`
			);
		}
	}
	const executionIdentities: RuntimeLabExecutionIdentities = {
		...(rootProcessLifetimeIdentity === undefined
			? {}
			: { candidateRoot: rootProcessLifetimeIdentity }),
		...(recorderRun.processIdentity === undefined
			? {}
			: { etlRecorder: recorderRun.processIdentity }),
		...(etlProcessInspection?.processIdentity === undefined
			? {}
			: {
				etlProcessInspector:
					etlProcessInspection.processIdentity
			}),
		...(presentingProcessSample === undefined
			? {}
			: { presentingProcessSample }),
		...(processIdReplay?.processIdentity === undefined
			? {}
			: {
				presentMonProcessIdReplay:
					processIdReplay.processIdentity
			}),
		...(processNameReplay?.processIdentity === undefined
			? {}
			: {
				presentMonProcessNameReplay:
					processNameReplay.processIdentity
			})
	};
	const hasExecutionIdentities =
		Object.keys(executionIdentities).length > 0;
	const etlEvidence: RuntimeLabAcceptedEtlEvidence | undefined =
		recorderRun.acceptedCapture === undefined
		|| recorderRun.readyEvidence === undefined
		|| recorderRun.statusEvidence === undefined
		|| etlProcessInspection?.evidenceRecord === undefined
			? undefined
			: {
				acceptedCapture: recorderRun.acceptedCapture,
				captureArtifact: {
					path: recorderRun.launch.etlPath,
					sha256: recorderRun.acceptedCapture.etlSha256,
					sizeBytes: recorderRun.acceptedCapture.etlSizeBytes
				},
				processEventArtifact: etlProcessInspection.evidenceRecord,
				readySidecarArtifact: recorderRun.readyEvidence,
				recorderExpectedIdentity: {
					durationMs: recorderRun.launch.durationMs,
					etlPath: recorderRun.launch.etlPath,
					sessionName: recorderRun.launch.sessionName
				},
				statusSidecarArtifact: recorderRun.statusEvidence
			};
	if (hasExecutionIdentities) {
		await writeJson(
			join(capturesDirectory, 'executed-process-identities.json'),
			executionIdentities
		);
	}
	if (candidateProcess && launchPlan && candidateExit) {
		await persistProcessLogs(logsDirectory, 'candidate', launchPlan, candidateExit);
	}
	if (recorderRun.exit !== undefined) {
		await persistProcessLogs(
			logsDirectory,
			'etl-recorder',
			recorderRun.launch,
			recorderRun.exit
		);
	}
	if (etlProcessInspection?.exit !== undefined) {
		await persistProcessLogs(
			logsDirectory,
			'etl-process-inspector',
			etlProcessInspection.launch,
			etlProcessInspection.exit
		);
	}
	if (etlProcessInspection?.evidenceRecord !== undefined) {
		await writeJson(
			join(capturesDirectory, 'etl-process-events-evidence.json'),
			etlProcessInspection.evidenceRecord
		);
	}
	if (
		recorderRun.readyEvidence !== undefined
		|| recorderRun.statusEvidence !== undefined
	) {
		await writeJson(
			join(capturesDirectory, 'etl-recorder-sidecar-evidence.json'),
			{
				...(recorderRun.readyEvidence === undefined
					? {}
					: { ready: recorderRun.readyEvidence }),
				...(recorderRun.statusEvidence === undefined
					? {}
					: { status: recorderRun.statusEvidence })
			}
		);
	}
	for (const [name, assessment] of [
		['ready', recorderRun.readyAssessment],
		['status', recorderRun.statusAssessment],
		['pair', recorderRun.pairAssessment]
	] as const) {
		if (assessment !== undefined) {
			await writeJson(
				join(
					capturesDirectory,
					`etl-recorder-${name}-assessment.json`
				),
				assessment
			);
		}
	}
	if (recorderRun.acceptedCapture !== undefined) {
		await writeJson(
			join(capturesDirectory, 'etl-recorder-accepted.json'),
			recorderRun.acceptedCapture
		);
	}
	for (const replay of [processNameReplay, processIdReplay]) {
		if (replay === undefined) continue;
		if (replay.exit !== undefined) {
			await persistProcessLogs(
				logsDirectory,
				replay.name,
				replay.launch,
				replay.exit
			);
		}
		if (replay.assessment !== undefined) {
			await writeJson(
				join(
					capturesDirectory,
					`${replay.name}-assessment.json`
				),
				replay.assessment
			);
		}
		if (replay.evidence !== undefined) {
			await writeJson(
				join(
					capturesDirectory,
					`${replay.name}-evidence.json`
				),
				offlineReplayEvidenceRecord(replay.evidence)
			);
		}
	}
	if (stableJobMembership !== undefined) {
		await writeJson(
			join(capturesDirectory, 'exact-job-membership.json'),
			stableJobMembership
		);
	}
	if (processNameAnalysis !== undefined) {
		await writeJson(
			join(
				capturesDirectory,
				'presentmon-process-name-analysis.json'
			),
			processNameAnalysis
		);
	}
	if (candidateProcess) {
		await Promise.all([
			writeFile(
				join(logsDirectory, 'process-samples.jsonl'),
				candidateProcess.rawSampleLines.length > 0
					? `${candidateProcess.rawSampleLines.join('\n')}\n`
					: ''
			),
			writeJson(
				join(logsDirectory, 'process-monitor-errors.json'),
				candidateProcess.parseErrors
			)
		]);
	}
	if (headlineAnalysis) await writeJson(join(capturesDirectory, 'presentmon-headline-analysis.json'), headlineAnalysis);
	if (headlineStream) await writeJson(join(capturesDirectory, 'presentmon-headline-stream.json'), headlineStream);

	const benchmarkStartMs = pageRun
		? pageRun.result.timings.timeOriginEpochMs + pageRun.result.timings.benchmarkInvokedMs
		: undefined;
	const benchmarkEndMs = pageRun
		? pageRun.result.timings.timeOriginEpochMs + pageRun.result.timings.benchmarkCompletedMs
		: undefined;
	const benchmarkResourceSamples = candidateProcess && benchmarkStartMs !== undefined && benchmarkEndMs !== undefined
		? candidateProcess.samples.filter(sample => sample.capturedAtMs >= benchmarkStartMs && sample.capturedAtMs <= benchmarkEndMs)
		: [];
	const resources = summarizeProcessTreeResourceSamples(benchmarkResourceSamples);
	const resourceCoverage = candidateProcess && benchmarkStartMs !== undefined && benchmarkEndMs !== undefined
		? assessProcessTreeResourceCoverage(candidateProcess.samples, {
			endTimestampMs: benchmarkEndMs,
			intervalMs: PROCESS_MONITOR_INTERVAL_MS,
			startTimestampMs: benchmarkStartMs
		})
		: undefined;
	if (resourceCoverage && !resourceCoverage.valid) {
		controllerViolations.push(...resourceCoverage.reasons);
	}
	if (candidateProcess) {
		const finalImageViolation = processImageViolation(
			candidateProcess.samples.flatMap(sample => sample.processes),
			candidate.executablePath
		);
		if (finalImageViolation) controllerViolations.push(finalImageViolation);
		if (candidateProcess.parseErrors.length > 0) {
			controllerViolations.push(
				`process-monitor-parse-errors:${candidateProcess.parseErrors.length}:${candidateProcess.parseErrors[0]}`
			);
		}
	}
	const electronEvents = candidateExit
		? parseElectronHostEvents(candidateExit.stdout)
		: { events: [], violations: [] };
	controllerViolations.push(...electronEvents.violations);
	if (launchPlan?.kind === 'electron') {
		const rootIdentityViolation =
			electronHostRootIdentityViolation(
				electronEvents.events,
				rootProcessLifetimeIdentity
			);
		if (rootIdentityViolation !== undefined) {
			controllerViolations.push(rootIdentityViolation);
		}
		if (!runtimeIdentity) {
			runtimeIdentity = electronEvents.events.find(
				event => event.type === 'host-started'
			);
		}
	}
	if (candidateExit?.stdoutTruncated) controllerViolations.push('candidate-stdout-truncated');
	if (candidateExit?.stderrTruncated) controllerViolations.push('candidate-stderr-truncated');
	if (primaryError) controllerViolations.push(`controller-error:${primaryError.message}`);
	controllerViolations.push(...cleanupViolations);
	const serverViolations = pageRun?.violations ?? [];
	let violations = [...new Set([...serverViolations, ...controllerViolations])];
	const contextLost = pageRun?.result.benchmark.rejectionReasons.includes('webgl-context-lost') ?? false;
	let failures = classifyRuntimeLabFailures({
		...(pageRun === undefined
			? {}
			: {
				benchmark: {
					eventLoopP95Ms: pageRun.result.benchmark.eventLoopP95Ms,
					eventLoopWorstMs: pageRun.result.benchmark.eventLoopWorstMs,
					lowConfidenceReasons: pageRun.result.benchmark.lowConfidenceReasons,
					pageValid: pageRun.valid,
					rejected: pageRun.result.benchmark.rejected,
					rejectionReasons: pageRun.result.benchmark.rejectionReasons,
					success: pageRun.result.benchmark.success
				}
			}),
		capture: {
			analysisReasons: headlineAnalysis?.reasons,
			analysisValid: headlineAnalysis?.valid,
			completed: processIdReplay?.exit !== undefined,
			...(processIdReplay?.exit === undefined
				? {}
				: { exitCode: processIdReplay.exit.exitCode }),
			...(processIdReplay?.exit?.launchError === undefined
				? {}
				: { launchError: processIdReplay.exit.launchError }),
			rawCsvExists: await fileExists(headlineCsvPath),
			rawCsvPath: headlineCsvPath,
			started: processIdReplay?.process !== undefined
		},
		...(contextLost ? { contextLoss: { message: 'The benchmark reported WebGL context loss.', source: 'page-result' } } : {}),
		integrityViolations: violations,
		orphanProcessIds: cleanup?.orphanProcessIds ?? [],
		...(unexpectedProcessExit === undefined
			? {}
			: {
				processExit: {
					exitCode: unexpectedProcessExit.exitCode,
					expected: false,
					signal: unexpectedProcessExit.signal
				}
			}),
		...(violations.includes('run-timeout') || /timed out/iu.test(primaryError?.message ?? '')
			? {
				timeout: {
					elapsedMs: controllerTimeoutMs,
					limitMs: controllerTimeoutMs
				}
			}
			: {})
	});
	const fallbackViolation = unclassifiedInvalidResultViolation({
		failures,
		headlineAnalysisValid: headlineAnalysis?.valid,
		pageRunValid: pageRun?.valid,
		resourceCoverageValid: resourceCoverage?.valid,
		resourceSampleCount: resources.sampleCount,
		violations
	});
	if (fallbackViolation !== undefined) {
		violations = [...violations, fallbackViolation];
		failures = [
			...failures,
			...classifyRuntimeLabFailures({
				integrityViolations: [fallbackViolation]
			})
		];
	}
	const valid = Boolean(
		pageRun?.valid
		&& rootProcessLifetimeIdentity !== undefined
		&& recorderRun.processIdentity !== undefined
		&& recorderRun.acceptedCapture !== undefined
		&& etlEvidence !== undefined
		&& etlProcessInspection?.processIdentity !== undefined
		&& etlProcessInspection.evidence !== undefined
		&& etlProcessInspection.evidenceRecord !== undefined
		&& etlProcessLifetime !== undefined
		&& etlProcessLifetimeEvidence !== undefined
		&& processNameReplay?.processIdentity !== undefined
		&& processNameReplay.assessment?.valid
		&& processIdReplay?.processIdentity !== undefined
		&& processIdReplay.assessment?.valid
		&& presentingProcessSample !== undefined
		&& processNameAnalysis?.valid
		&& stableJobMembership !== undefined
		&& headlineAnalysis?.valid
		&& headlineStream?.valid
		&& presentMonProcessLifetimeBinding?.valid
		&& presentMonProcessLifetimeBindingEvidence !== undefined
		&& resourceCoverage?.valid
		&& resources.sampleCount > 0
		&& failures.length === 0
	);
	const completedAt = new Date().toISOString();
	const artifactManifestPath = join(runDirectory, 'artifact-manifest.json');
	const result: RuntimeLabSingleRunResult = {
		artifactManifestPath,
		candidate,
		...(cleanup === undefined ? {} : { cleanup }),
		completedAt,
		controllerSourceInventoryVersion:
			controllerSourceInventory.version,
		controllerSources,
		controllerVersion: CONTROLLER_RESULT_VERSION,
		...(electronEvents.events.length === 0
			? {}
			: { electronHostEvents: electronEvents.events }),
		...(etlEvidence === undefined ? {} : { etlEvidence }),
		...(etlProcessLifetime === undefined
			? {}
			: { etlProcessLifetime }),
		...(etlProcessLifetimeEvidence === undefined
			? {}
			: { etlProcessLifetimeEvidence }),
		...(hasExecutionIdentities ? { executionIdentities } : {}),
		failures,
		...(guard === undefined
			? {}
			: { firewallRule: guard.rule }),
		...(headlineAnalysis === undefined ? {} : { headlineAnalysis }),
		...(headlineStream === undefined
			? {}
			: {
				headlineStream,
				headlineStreamKey: headlineStream.key
			}),
		...(pageRun === undefined ? {} : { pageRun }),
		...(presentingProcessId === undefined ? {} : { presentingProcessId }),
		...(presentMonProcessLifetimeBinding === undefined
			? {}
			: { presentMonProcessLifetimeBinding }),
		...(presentMonProcessLifetimeBindingEvidence === undefined
			? {}
			: { presentMonProcessLifetimeBindingEvidence }),
		...(resourceCoverage === undefined ? {} : { resourceCoverage }),
		resources,
		runDirectory,
		runId,
		...(runtimeIdentity === undefined ? {} : { runtimeIdentity }),
		scenario,
		startedAt,
		valid,
		violations
	};
	await writeJson(join(runDirectory, 'controller-result.json'), {
		...result,
		candidate: {
			executablePath: candidate.executablePath,
			executableSha256: candidate.executableSha256,
			executableSizeBytes: candidate.executableSizeBytes,
			manifest: candidate.manifest,
			manifestPath: candidate.manifestPath,
			manifestSha256: candidate.manifestSha256
		},
		scenario,
		status: valid ? 'complete' : 'failed'
	});
	await writeJson(join(runDirectory, 'controller-manifest.json'), {
		...controllerManifestBase,
		completedAt,
		...(hasExecutionIdentities ? { executionIdentities } : {}),
		failures,
		...(guard === undefined
			? {}
			: { firewallRule: guard.rule }),
		...(headlineStream === undefined
			? {}
			: { headlineStreamKey: headlineStream.key }),
		status: valid ? 'complete' : 'failed',
		valid,
		violations
	});
	const artifactSealReasons =
		buildArtifactSealReasons(
			cleanupViolations,
			cleanup?.orphanProcessIds ?? [],
			cleanup?.membership
		);
	const artifactsSealed = artifactSealReasons.length === 0;
	const artifacts = artifactsSealed ? await collectArtifacts(runDirectory) : [];
	await writeJson(artifactManifestPath, {
		artifacts,
		artifactsSealed,
		artifactsSha256: sha256Hex(canonicalJson(artifacts)),
		completedAt,
		...(artifactSealReasons.length === 0 ? {} : { sealFailureReasons: artifactSealReasons }),
		runId,
		version: 1
	});
	return result;
}
