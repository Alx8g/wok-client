import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
	open,
	readFile,
	realpath,
	stat
} from 'node:fs/promises';
import {
	basename,
	dirname,
	isAbsolute,
	join,
	resolve,
	win32
} from 'node:path';
import {
	bindSelectedPresentMonFramesToProcessLifetime,
	deriveEtlProcessLifetimes,
	ETL_PROCESS_EVENT_OUTPUT_ARTIFACT,
	parseEtlProcessEventEvidence,
	parseEtlProcessLifetimeArtifact,
	parsePresentMonProcessLifetimeBinding,
	sameEtlProcessInspectionInvocation,
	sameEtlProcessInspectorIdentity,
	type EtlProcessLifetimeArtifact,
	type EtlProcessLifetimeEnd,
	type EtlProcessLifetimeStart,
	type PresentMonProcessLifetimeBinding
} from '../host/etl-process-lifetimes.ts';
import {
	acceptEtlRecorderPair,
	parseEtlRecorderReadySidecar,
	parseEtlRecorderStatusSidecar,
	type AcceptedEtlRecorderCapture,
	type EtlRecorderExpectedIdentity
} from '../host/presentmon-etl.ts';
import {
	resolveRuntimeLabScenario
} from '../scenario/manifest.ts';
import {
	canonicalJson,
	sha256Hex
} from '../shared/hash.ts';
import {
	RUNTIME_TOURNAMENT_CONTROLLER_VERSION,
	type RuntimeTournamentResult,
	type RuntimeTournamentRunRecord
} from './tournament-controller.ts';
import {
	calculateEtlRecorderDurationMs,
	type ArtifactRecord,
	type RuntimeLabAcceptedEtlEvidence
} from './single-run.ts';
import type {
	ResolvedRuntimeTournamentDryRunReport,
	RuntimeTournamentDryRunResolveOptions
} from './tournament-dry-run.ts';
import {
	buildRuntimeTournamentPairAnalyses
} from './tournament-analysis.ts';
import type {
	RuntimeTournamentPlannedRun
} from './tournament-plan.ts';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RECORDER_SESSION_UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ResolvedRuntimeTournamentResultEvidence {
	result: RuntimeTournamentResult;
	resultBytes: Buffer;
	resultPath: string;
}

export type RuntimeTournamentDryRunEvidenceResolver = (
	path: string,
	options?: RuntimeTournamentDryRunResolveOptions
) => Promise<ResolvedRuntimeTournamentDryRunReport>;

function expectRecord(
	value: unknown,
	label: string
): Record<string, unknown> {
	if (
		value === null
		|| typeof value !== 'object'
		|| Array.isArray(value)
	) {
		throw new TypeError(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function expectExactKeys(
	record: Record<string, unknown>,
	expected: readonly string[],
	label: string
): void {
	const actual = Object.keys(record).sort();
	const expectedSorted = [...expected].sort();
	if (
		actual.length !== expectedSorted.length
		|| actual.some((key, index) => key !== expectedSorted[index])
	) {
		throw new TypeError(`${label} does not match the closed schema.`);
	}
}

function expectString(value: unknown, label: string): string {
	if (
		typeof value !== 'string'
		|| value.length < 1
		|| value.length > 32_767
	) {
		throw new TypeError(`${label} must be a nonempty bounded string.`);
	}
	return value;
}

function expectPositiveUint32(value: unknown, label: string): number {
	if (
		typeof value !== 'number'
		|| !Number.isInteger(value)
		|| value < 1
		|| value > 0xffff_ffff
	) {
		throw new TypeError(`${label} must be a positive uint32.`);
	}
	return value;
}

function expectCreationTimeUtcTicks(
	value: unknown,
	label: string
): string {
	const result = expectString(value, label);
	if (
		!/^[1-9][0-9]{0,18}$/u.test(result)
		|| BigInt(result) > 3_155_378_975_999_999_999n
		|| BigInt(result) % 10n !== 0n
	) {
		throw new TypeError(`${label} is not a canonical process creation time.`);
	}
	return result;
}

function comparablePath(value: string): string {
	let normalized = value.replaceAll('/', '\\');
	if (normalized.startsWith('\\\\?\\UNC\\')) {
		normalized = `\\\\${normalized.slice(8)}`;
	} else if (normalized.startsWith('\\\\?\\')) {
		normalized = normalized.slice(4);
	}
	return process.platform === 'win32'
		? normalized.toLowerCase()
		: resolve(value);
}

function samePath(left: string, right: string): boolean {
	return comparablePath(left) === comparablePath(right);
}

function comparableWindowsPath(value: string): string {
	return value
		.replaceAll('/', '\\')
		.replaceAll(/\\+/gu, '\\')
		.toLowerCase();
}

function sameExecutableName(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

function sameOpenFileMetadata(
	left: BigIntStats,
	right: BigIntStats
): boolean {
	return left.dev === right.dev
		&& left.ino === right.ino
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.ctimeNs === right.ctimeNs;
}

function parseArtifactRecord(
	value: unknown,
	label: string,
	maximumSizeBytes = 16 * 1024 * 1024
): ArtifactRecord {
	const record = expectRecord(value, label);
	expectExactKeys(record, ['path', 'sha256', 'sizeBytes'], label);
	const path = expectString(record.path, `${label}.path`);
	if (!isAbsolute(path)) {
		throw new TypeError(`${label}.path must be absolute.`);
	}
	const sha256 = expectString(record.sha256, `${label}.sha256`);
	if (!SHA256_PATTERN.test(sha256)) {
		throw new TypeError(`${label}.sha256 is invalid.`);
	}
	const sizeBytes = record.sizeBytes;
	if (
		typeof sizeBytes !== 'number'
		|| !Number.isSafeInteger(sizeBytes)
		|| sizeBytes < 1
		|| sizeBytes > maximumSizeBytes
	) {
		throw new TypeError(`${label}.sizeBytes is invalid.`);
	}
	return { path, sha256, sizeBytes };
}

async function readExactRunArtifact(
	value: unknown,
	expectedPath: string,
	label: string
): Promise<Buffer> {
	const record = parseArtifactRecord(value, label);
	if (!samePath(record.path, expectedPath)) {
		throw new Error(`${label}.path is not the expected run artifact path.`);
	}
	const [artifactPath, expectedRealPath] = await Promise.all([
		realpath(resolve(record.path)),
		realpath(resolve(expectedPath))
	]);
	if (!samePath(artifactPath, expectedRealPath)) {
		throw new Error(`${label}.path resolves to a different artifact.`);
	}
	const handle = await open(artifactPath, 'r');
	try {
		const metadataBefore = await handle.stat({ bigint: true });
		if (!metadataBefore.isFile()) {
			throw new TypeError(`${label} is not a regular file.`);
		}
		if (metadataBefore.size !== BigInt(record.sizeBytes)) {
			throw new Error(`${label} size changed after acceptance.`);
		}
		const bytes = await handle.readFile();
		const metadataAfter = await handle.stat({ bigint: true });
		const [pathAfter, pathMetadataAfter] = await Promise.all([
			realpath(resolve(record.path)),
			stat(artifactPath, { bigint: true })
		]);
		if (
			!sameOpenFileMetadata(metadataBefore, metadataAfter)
			|| !sameOpenFileMetadata(metadataAfter, pathMetadataAfter)
			|| !samePath(pathAfter, artifactPath)
		) {
			throw new Error(`${label} changed during exact-byte verification.`);
		}
		if (
			bytes.byteLength !== record.sizeBytes
			|| sha256Hex(bytes) !== record.sha256
		) {
			throw new Error(`${label} does not match its accepted size and SHA-256.`);
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

async function verifyExactRunArtifact(
	value: unknown,
	expectedPath: string,
	label: string,
	maximumSizeBytes: number
): Promise<ArtifactRecord> {
	const record = parseArtifactRecord(value, label, maximumSizeBytes);
	if (!samePath(record.path, expectedPath)) {
		throw new Error(`${label}.path is not the expected run artifact path.`);
	}
	const [artifactPath, expectedRealPath] = await Promise.all([
		realpath(resolve(record.path)),
		realpath(resolve(expectedPath))
	]);
	if (!samePath(artifactPath, expectedRealPath)) {
		throw new Error(`${label}.path resolves to a different artifact.`);
	}
	const handle = await open(artifactPath, 'r');
	try {
		const metadataBefore = await handle.stat({ bigint: true });
		if (!metadataBefore.isFile()) {
			throw new TypeError(`${label} is not a regular file.`);
		}
		if (metadataBefore.size !== BigInt(record.sizeBytes)) {
			throw new Error(`${label} size changed after acceptance.`);
		}
		const hash = createHash('sha256');
		const chunk = Buffer.allocUnsafe(1024 * 1024);
		let position = 0;
		while (position < record.sizeBytes) {
			const requested = Math.min(
				chunk.byteLength,
				record.sizeBytes - position
			);
			const { bytesRead } = await handle.read(
				chunk,
				0,
				requested,
				position
			);
			if (bytesRead !== requested) {
				throw new Error(`${label} ended before its accepted size.`);
			}
			hash.update(chunk.subarray(0, bytesRead));
			position += bytesRead;
		}
		const metadataAfter = await handle.stat({ bigint: true });
		const [pathAfter, pathMetadataAfter] = await Promise.all([
			realpath(resolve(record.path)),
			stat(artifactPath, { bigint: true })
		]);
		if (
			!sameOpenFileMetadata(metadataBefore, metadataAfter)
			|| !sameOpenFileMetadata(metadataAfter, pathMetadataAfter)
			|| !samePath(pathAfter, artifactPath)
		) {
			throw new Error(`${label} changed during exact-byte verification.`);
		}
		if (hash.digest('hex') !== record.sha256) {
			throw new Error(`${label} does not match its accepted SHA-256.`);
		}
		return record;
	} finally {
		await handle.close();
	}
}

function processLifetimeStartMs(start: EtlProcessLifetimeStart): number {
	return start.timestampMs;
}

function processLifetimeEndMs(end: EtlProcessLifetimeEnd): number {
	return end.kind === 'etl-process-stop'
		? end.timestampMs
		: end.captureStopTimestampMs;
}

function parseAcceptedEtlCapture(
	value: unknown,
	label: string
): AcceptedEtlRecorderCapture {
	const record = expectRecord(value, label);
	expectExactKeys(record, [
		'captureStartFileTimeUtc',
		'captureStopFileTimeUtc',
		'etlFileIndex',
		'etlReadLease',
		'etlSha256',
		'etlSizeBytes',
		'etlVolumeSerialNumber',
		'operationalEtlPath',
		'sessionName'
	], label);
	if (record.etlReadLease !== 'held-until-controller-release') {
		throw new TypeError(`${label}.etlReadLease is invalid.`);
	}
	const etlSha256 = expectString(record.etlSha256, `${label}.etlSha256`);
	if (!SHA256_PATTERN.test(etlSha256)) {
		throw new TypeError(`${label}.etlSha256 is invalid.`);
	}
	const etlSizeBytes = record.etlSizeBytes;
	if (
		typeof etlSizeBytes !== 'number'
		|| !Number.isSafeInteger(etlSizeBytes)
		|| etlSizeBytes < 1
	) {
		throw new TypeError(`${label}.etlSizeBytes is invalid.`);
	}
	const operationalEtlPath = expectString(
		record.operationalEtlPath,
		`${label}.operationalEtlPath`
	);
	if (!win32.isAbsolute(operationalEtlPath)) {
		throw new TypeError(
			`${label}.operationalEtlPath must be an absolute Windows path.`
		);
	}
	return {
		captureStartFileTimeUtc: expectString(
			record.captureStartFileTimeUtc,
			`${label}.captureStartFileTimeUtc`
		),
		captureStopFileTimeUtc: expectString(
			record.captureStopFileTimeUtc,
			`${label}.captureStopFileTimeUtc`
		),
		etlFileIndex: expectString(
			record.etlFileIndex,
			`${label}.etlFileIndex`
		),
		etlReadLease: 'held-until-controller-release',
		etlSha256,
		etlSizeBytes,
		etlVolumeSerialNumber: expectString(
			record.etlVolumeSerialNumber,
			`${label}.etlVolumeSerialNumber`
		),
		operationalEtlPath,
		sessionName: expectString(record.sessionName, `${label}.sessionName`)
	};
}

function parseRecorderExpectedIdentity(
	value: unknown,
	label: string
): EtlRecorderExpectedIdentity {
	const record = expectRecord(value, label);
	expectExactKeys(record, ['durationMs', 'etlPath', 'sessionName'], label);
	const durationMs = record.durationMs;
	if (
		typeof durationMs !== 'number'
		|| !Number.isInteger(durationMs)
		|| durationMs < 1
		|| durationMs > 600_000
	) {
		throw new TypeError(`${label}.durationMs is invalid.`);
	}
	const etlPath = expectString(record.etlPath, `${label}.etlPath`);
	if (!win32.isAbsolute(etlPath)) {
		throw new TypeError(`${label}.etlPath must be an absolute Windows path.`);
	}
	return {
		durationMs,
		etlPath,
		sessionName: expectString(record.sessionName, `${label}.sessionName`)
	};
}

function parseAcceptedEtlEvidence(
	value: unknown,
	label: string
): RuntimeLabAcceptedEtlEvidence {
	const record = expectRecord(value, label);
	expectExactKeys(record, [
		'acceptedCapture',
		'captureArtifact',
		'processEventArtifact',
		'readySidecarArtifact',
		'recorderExpectedIdentity',
		'statusSidecarArtifact'
	], label);
	return {
		acceptedCapture: parseAcceptedEtlCapture(
			record.acceptedCapture,
			`${label}.acceptedCapture`
		),
		captureArtifact: parseArtifactRecord(
			record.captureArtifact,
			`${label}.captureArtifact`,
			4 * 1024 * 1024 * 1024
		),
		processEventArtifact: parseArtifactRecord(
			record.processEventArtifact,
			`${label}.processEventArtifact`
		),
		readySidecarArtifact: parseArtifactRecord(
			record.readySidecarArtifact,
			`${label}.readySidecarArtifact`
		),
		recorderExpectedIdentity: parseRecorderExpectedIdentity(
			record.recorderExpectedIdentity,
			`${label}.recorderExpectedIdentity`
		),
		statusSidecarArtifact: parseArtifactRecord(
			record.statusSidecarArtifact,
			`${label}.statusSidecarArtifact`
		)
	};
}

async function verifyPersistedRunRecords(
	result: RuntimeTournamentResult,
	tournamentDirectory: string
): Promise<void> {
	const recordsPath = join(tournamentDirectory, 'run-records.json');
	const resolvedPath = await realpath(recordsPath);
	if (!samePath(resolvedPath, recordsPath)) {
		throw new Error('Tournament run-record evidence resolves unexpectedly.');
	}
	const metadata = await stat(resolvedPath);
	if (!metadata.isFile()) {
		throw new TypeError('Tournament run-record evidence is not a regular file.');
	}
	const expectedBytes = Buffer.from(
		`${JSON.stringify(result.runRecords, null, '\t')}\n`,
		'utf8'
	);
	const actualBytes = await readFile(resolvedPath);
	if (!actualBytes.equals(expectedBytes)) {
		throw new Error(
			'Tournament run-record evidence does not match the result records.'
		);
	}
}

async function verifyRunRecordLifetimeEvidence(options: {
	dryRun: ResolvedRuntimeTournamentDryRunReport;
	expectedRecorderDurationMs: number;
	record: RuntimeTournamentRunRecord;
	tournamentDirectory: string;
}): Promise<string> {
	const {
		dryRun,
		expectedRecorderDurationMs,
		record,
		tournamentDirectory
	} = options;
	const runDirectoryValue = expectString(
		record.runDirectory,
		`Run ${record.runId} directory`
	);
	const expectedRunDirectory = join(
		tournamentDirectory,
		'runs',
		record.runId
	);
	if (!samePath(runDirectoryValue, expectedRunDirectory)) {
		throw new Error(`Run ${record.runId} directory is not plan-bound.`);
	}
	const [runDirectory, expectedRunDirectoryRealPath] = await Promise.all([
		realpath(resolve(runDirectoryValue)),
		realpath(resolve(expectedRunDirectory))
	]);
	if (!samePath(runDirectory, expectedRunDirectoryRealPath)) {
		throw new Error(`Run ${record.runId} directory resolves unexpectedly.`);
	}
	const capturesDirectory = join(runDirectory, 'captures');
	const etlEvidence = parseAcceptedEtlEvidence(
		record.etlEvidence,
		`Run ${record.runId} accepted ETL evidence`
	);
	const expectedEtlPath = join(capturesDirectory, 'presentmon.etl');
	const expectedRecorderEtlSuffix = comparableWindowsPath(
		`\\${record.runId}\\captures\\presentmon.etl`
	);
	const expectedRecorderSessionPrefix =
		`WOKRuntimeLabFile-${record.runId.slice(0, 44)}-`;
	const recorderSessionSuffix =
		etlEvidence.recorderExpectedIdentity.sessionName.slice(
			expectedRecorderSessionPrefix.length
		);
	if (
		!comparableWindowsPath(
			etlEvidence.recorderExpectedIdentity.etlPath
		).endsWith(expectedRecorderEtlSuffix)
		|| !comparableWindowsPath(
			etlEvidence.acceptedCapture.operationalEtlPath
		).endsWith(expectedRecorderEtlSuffix)
		|| (
			process.platform === 'win32'
			&& !samePath(
				etlEvidence.recorderExpectedIdentity.etlPath,
				expectedEtlPath
			)
		)
		|| !etlEvidence.recorderExpectedIdentity.sessionName.startsWith(
			expectedRecorderSessionPrefix
		)
		|| !RECORDER_SESSION_UUID_PATTERN.test(recorderSessionSuffix)
		|| etlEvidence.acceptedCapture.sessionName
			!== etlEvidence.recorderExpectedIdentity.sessionName
	) {
		throw new Error(
			`Run ${record.runId} recorder identity is not bound to the planned run artifacts.`
		);
	}
	if (
		etlEvidence.recorderExpectedIdentity.durationMs
			!== expectedRecorderDurationMs
	) {
		throw new Error(
			`Run ${record.runId} recorder duration is not derived from the verified scenario.`
		);
	}
	const [
		readyBytes,
		statusBytes,
		processEventBytes,
		lifetimeBytes,
		bindingBytes
	] = await Promise.all([
		readExactRunArtifact(
			etlEvidence.readySidecarArtifact,
			join(capturesDirectory, 'etl-recorder-ready.json'),
			`Run ${record.runId} ETL recorder ready sidecar`
		),
		readExactRunArtifact(
			etlEvidence.statusSidecarArtifact,
			join(capturesDirectory, 'etl-recorder-status.json'),
			`Run ${record.runId} ETL recorder status sidecar`
		),
		readExactRunArtifact(
			etlEvidence.processEventArtifact,
			join(capturesDirectory, 'etl-process-events.json'),
			`Run ${record.runId} raw ETL process-event evidence`
		),
		readExactRunArtifact(
			record.etlProcessLifetimeEvidence,
			join(capturesDirectory, 'etl-process-lifetimes.json'),
			`Run ${record.runId} ETL process-lifetime evidence`
		),
		readExactRunArtifact(
			record.presentMonProcessLifetimeBindingEvidence,
			join(
				capturesDirectory,
				'presentmon-headline-process-lifetime-binding.json'
			),
			`Run ${record.runId} PresentMon process-lifetime binding evidence`
		)
	]);
	const captureRecord = await verifyExactRunArtifact(
		etlEvidence.captureArtifact,
		expectedEtlPath,
		`Run ${record.runId} accepted ETL capture`,
		4 * 1024 * 1024 * 1024
	);
	const ready = parseEtlRecorderReadySidecar(readyBytes);
	const status = parseEtlRecorderStatusSidecar(statusBytes);
	const acceptedCapture = acceptEtlRecorderPair(
		ready,
		status,
		etlEvidence.recorderExpectedIdentity
	);
	if (
		canonicalJson(acceptedCapture)
			!== canonicalJson(etlEvidence.acceptedCapture)
		|| captureRecord.sha256 !== acceptedCapture.etlSha256
		|| captureRecord.sizeBytes !== acceptedCapture.etlSizeBytes
	) {
		throw new Error(
			`Run ${record.runId} accepted ETL identity does not match its sidecars and exact capture bytes.`
		);
	}
	const processEventArtifact = parseEtlProcessEventEvidence(
		processEventBytes
	);
	const presentingProcessId = expectPositiveUint32(
		record.presentingProcessId,
		`Run ${record.runId} presentingProcessId`
	);
	if (
		!sameEtlProcessInspectionInvocation(
			processEventArtifact.inspectionInvocation,
			{
				candidateId: record.candidateId,
				etlFileIndex: acceptedCapture.etlFileIndex,
				etlPath: acceptedCapture.operationalEtlPath,
				etlSha256: acceptedCapture.etlSha256,
				etlSizeBytes: acceptedCapture.etlSizeBytes,
				etlVolumeSerialNumber:
					acceptedCapture.etlVolumeSerialNumber,
				outputArtifactRelativePath:
					ETL_PROCESS_EVENT_OUTPUT_ARTIFACT,
				role: 'etl-process-inspector',
				runId: record.runId,
				targetProcessId: presentingProcessId
			}
		)
	) {
		throw new Error(
			`Run ${record.runId} ETL process inspection invocation is not bound to the planned run, accepted ETL, and target process.`
		);
	}
	const lifetimeArtifact: EtlProcessLifetimeArtifact =
		parseEtlProcessLifetimeArtifact(lifetimeBytes);
	const binding: PresentMonProcessLifetimeBinding =
		parsePresentMonProcessLifetimeBinding(bindingBytes);
	if (
		record.presentMonProcessLifetimeBinding === undefined
		|| canonicalJson(record.presentMonProcessLifetimeBinding)
			!== canonicalJson(binding)
	) {
		throw new Error(
			`Run ${record.runId} embedded PresentMon binding does not match its exact artifact.`
		);
	}
	const headlineStreamKey = expectString(
		record.headlineStreamKey,
		`Run ${record.runId} headlineStreamKey`
	);
	const headlineStream = expectRecord(
		record.headlineStream,
		`Run ${record.runId} headlineStream`
	);
	if (
		headlineStream.valid !== true
		|| headlineStream.key !== headlineStreamKey
		|| headlineStream.processId !== presentingProcessId
		|| headlineStream.firstTimestampMs !== binding.firstFrameTimestampMs
		|| headlineStream.lastTimestampMs !== binding.lastFrameTimestampMs
		|| headlineStream.recordCount !== binding.recordCount
		|| binding.processId !== presentingProcessId
		|| binding.streamKey !== headlineStreamKey
	) {
		throw new Error(
			`Run ${record.runId} PresentMon binding does not match the selected headline stream.`
		);
	}
	const executionIdentities = expectRecord(
		record.executionIdentities,
		`Run ${record.runId} executionIdentities`
	);
	const presentingProcessSample = expectRecord(
		executionIdentities.presentingProcessSample,
		`Run ${record.runId} presentingProcessSample`
	);
	const presentingSampleProcessId = expectPositiveUint32(
		presentingProcessSample.processId,
		`Run ${record.runId} presentingProcessSample.processId`
	);
	const presentingSampleCreationTimeUtcTicks =
		expectCreationTimeUtcTicks(
			presentingProcessSample.creationTimeUtcTicks,
			`Run ${record.runId} presentingProcessSample.creationTimeUtcTicks`
		);
	const presentingSampleExecutableName = expectString(
		presentingProcessSample.executableName,
		`Run ${record.runId} presentingProcessSample.executableName`
	);
	const presentingSampleExecutablePath = expectString(
		presentingProcessSample.executablePath,
		`Run ${record.runId} presentingProcessSample.executablePath`
	);
	const expectedCandidate = dryRun.report.candidates.find(
		candidate => candidate.id === record.candidateId
	);
	if (
		expectedCandidate === undefined
		|| presentingSampleProcessId !== binding.processId
		|| presentingSampleCreationTimeUtcTicks !== binding.creationTimeUtcTicks
		|| !sameExecutableName(
			presentingSampleExecutableName,
			binding.executableName
		)
		|| !samePath(
			presentingSampleExecutablePath,
			binding.executablePath
		)
		|| !sameExecutableName(
			presentingSampleExecutableName,
			expectedCandidate.executableName
		)
		|| !samePath(
			presentingSampleExecutablePath,
			expectedCandidate.executablePath
		)
	) {
		throw new Error(
			`Run ${record.runId} PresentMon binding does not match the planned candidate and sampled presenting process.`
		);
	}
	const persistedInspectorIdentity =
		record.executionIdentities?.etlProcessInspector;
	const inspector = expectRecord(
		executionIdentities.etlProcessInspector,
		`Run ${record.runId} ETL process inspector identity`
	);
	const inspectorProcessId = expectPositiveUint32(
		inspector.processId,
		`Run ${record.runId} ETL process inspector processId`
	);
	const inspectorCreationTimeUtcTicks =
		expectCreationTimeUtcTicks(
			inspector.creationTimeUtcTicks,
			`Run ${record.runId} ETL process inspector creationTimeUtcTicks`
		);
	const inspectorExecutablePath = expectString(
		inspector.executablePath,
		`Run ${record.runId} ETL process inspector executablePath`
	);
	const inspectorExecutable = expectRecord(
		inspector.executable,
		`Run ${record.runId} ETL process inspector executable`
	);
	if (
		persistedInspectorIdentity === undefined
		|| !sameEtlProcessInspectorIdentity(
			processEventArtifact.inspectorProcessIdentity,
			persistedInspectorIdentity
		)
		|| canonicalJson(processEventArtifact.inspectorProcessIdentity)
			!== canonicalJson(inspector)
	) {
		throw new Error(
			`Run ${record.runId} ETL process-event evidence does not match its executed inspector identity.`
		);
	}
	const expectedRecorderPath = await realpath(
		resolve(dryRun.report.etlRecorder.path)
	);
	const actualRecorderPath = await realpath(resolve(inspectorExecutablePath));
	if (
		!samePath(actualRecorderPath, expectedRecorderPath)
		|| inspectorExecutable.sha256 !== dryRun.report.etlRecorder.sha256
		|| inspectorExecutable.sizeBytes !== dryRun.report.etlRecorder.sizeBytes
		|| !samePath(
			expectString(
				inspectorExecutable.finalPath,
				`Run ${record.runId} ETL process inspector finalPath`
			),
			expectedRecorderPath
		)
	) {
		throw new Error(
			`Run ${record.runId} ETL process inspector does not match the dry-run recorder attestation.`
		);
	}
	const derivedLifetimeArtifact = deriveEtlProcessLifetimes({
		acceptedCapture,
		evidence: processEventArtifact,
		expectedProcess: {
			creationTimeUtcTicks: presentingSampleCreationTimeUtcTicks,
			executableName: presentingSampleExecutableName,
			executablePath: presentingSampleExecutablePath,
			processId: presentingSampleProcessId
		},
		processEventEvidenceSha256: etlEvidence.processEventArtifact.sha256
	});
	if (
		canonicalJson(derivedLifetimeArtifact)
			!== canonicalJson(lifetimeArtifact)
	) {
		throw new Error(
			`Run ${record.runId} derived lifetime artifact does not reproduce from the exact accepted ETL process events.`
		);
	}
	if (record.headlineStream === undefined) {
		throw new Error(`Run ${record.runId} headline stream is unavailable.`);
	}
	const derivedBinding = bindSelectedPresentMonFramesToProcessLifetime({
		expectedProcess: {
			creationTimeUtcTicks: presentingSampleCreationTimeUtcTicks,
			executableName: presentingSampleExecutableName,
			executablePath: presentingSampleExecutablePath,
			processId: presentingSampleProcessId
		},
		lifetimeArtifact: derivedLifetimeArtifact,
		stream: record.headlineStream
	});
	if (canonicalJson(derivedBinding) !== canonicalJson(binding)) {
		throw new Error(
			`Run ${record.runId} PresentMon binding does not reproduce from the exact lifetime and selected stream.`
		);
	}
	if (
		lifetimeArtifact.targetProcessId !== binding.processId
		|| lifetimeArtifact.etlSha256 !== binding.etlSha256
		|| lifetimeArtifact.processEventEvidenceSha256
			!== binding.processEventEvidenceSha256
	) {
		throw new Error(
			`Run ${record.runId} ETL lifetime artifact does not identify the binding evidence.`
		);
	}
	const matchingLifetimes = lifetimeArtifact.lifetimes.filter(
		lifetime => lifetime.creationTimeUtcTicks
			=== binding.creationTimeUtcTicks
	);
	if (matchingLifetimes.length !== 1) {
		throw new Error(
			`Run ${record.runId} ETL lifetime artifact does not contain exactly one selected lifetime.`
		);
	}
	const lifetime = matchingLifetimes[0];
	if (
		lifetime === undefined
		|| lifetime.processId !== binding.processId
		|| !sameExecutableName(
			lifetime.executableName,
			binding.executableName
		)
		|| canonicalJson(lifetime.start)
			!== canonicalJson(binding.lifetimeStart)
		|| canonicalJson(lifetime.end)
			!== canonicalJson(binding.lifetimeEnd)
		|| binding.firstFrameTimestampMs
			< processLifetimeStartMs(lifetime.start)
		|| binding.lastFrameTimestampMs
			> processLifetimeEndMs(lifetime.end)
	) {
		throw new Error(
			`Run ${record.runId} PresentMon frames are not bound to the selected ETL lifetime.`
		);
	}
	return `${inspectorProcessId}|${inspectorCreationTimeUtcTicks}`;
}

function runRecordMatchesPlan(
	record: RuntimeTournamentRunRecord,
	plannedRun: RuntimeTournamentPlannedRun
): boolean {
	return record.blockIndex === plannedRun.blockIndex
		&& record.candidateId === plannedRun.candidateId
		&& record.cycleIndex === plannedRun.cycleIndex
		&& record.phase === plannedRun.phase
		&& record.runId === plannedRun.runId
		&& record.sequenceIndex === plannedRun.sequenceIndex;
}

function verifyResultDigest(
	result: RuntimeTournamentResult
): void {
	if (
		typeof result.resultSha256 !== 'string'
		|| !SHA256_PATTERN.test(result.resultSha256)
	) {
		throw new TypeError(
			'Tournament result SHA-256 is invalid.'
		);
	}
	const {
		resultSha256,
		...withoutHash
	} = result;
	if (
		sha256Hex(canonicalJson(withoutHash))
		!== resultSha256
	) {
		throw new Error(
			'Tournament result SHA-256 does not match its canonical contents.'
		);
	}
	if (
		sha256Hex(canonicalJson(result.schedule.schedule))
		!== result.schedule.scheduleSha256
	) {
		throw new Error(
			'Tournament schedule SHA-256 does not match its canonical contents.'
		);
	}
}

async function verifyControllerSourceEvidence(
	result: RuntimeTournamentResult,
	dryRun: ResolvedRuntimeTournamentDryRunReport
): Promise<void> {
	if (
		result.controllerSourceInventoryVersion
		!== dryRun.report.controllerSourceInventoryVersion
	) {
		throw new Error(
			'Tournament controller source inventory version changed after dry-run preparation.'
		);
	}
	const expectedEntries = Object.entries(
		dryRun.report.controllerSources
	);
	if (
		Object.keys(result.controllerSources).length
		!== expectedEntries.length
	) {
		throw new Error(
			'Tournament result controller source inventory is incomplete.'
		);
	}
	await Promise.all(expectedEntries.map(async ([name, expected]) => {
		const actual = result.controllerSources[name];
		if (
			actual === undefined
			|| actual.path !== expected.path
			|| actual.sha256 !== expected.sha256
			|| actual.sizeBytes !== expected.sizeBytes
		) {
			throw new Error(
				`Tournament controller source ${name} does not match the dry-run attestation.`
			);
		}
		const evidencePath = await realpath(
			resolve(actual.evidencePath)
		);
		const metadata = await stat(evidencePath);
		if (!metadata.isFile()) {
			throw new TypeError(
				`Tournament controller source evidence ${name} is not a regular file.`
			);
		}
		const bytes = await readFile(evidencePath);
		if (
			bytes.byteLength !== actual.sizeBytes
			|| sha256Hex(bytes) !== actual.sha256
		) {
			throw new Error(
				`Tournament controller source evidence ${name} changed after persistence.`
			);
		}
	}));
}

export async function resolveRuntimeTournamentResultEvidence(
	path: string,
	resolveDryRunReport: RuntimeTournamentDryRunEvidenceResolver
): Promise<ResolvedRuntimeTournamentResultEvidence> {
	const resultPath = await realpath(resolve(path));
	const metadata = await stat(resultPath);
	if (!metadata.isFile()) {
		throw new TypeError(
			'Tournament result path must resolve to a regular file.'
		);
	}
	if (basename(resultPath) !== 'tournament-result.json') {
		throw new Error(
			'Tournament result evidence must be named tournament-result.json.'
		);
	}
	const resultBytes = await readFile(resultPath);
	let parsed: unknown;
	try {
		parsed = JSON.parse(resultBytes.toString('utf8'));
	} catch (error) {
		throw new TypeError(
			'Tournament result is not valid JSON: '
				+ (
					error instanceof Error
						? error.message
						: String(error)
				)
		);
	}
	expectRecord(parsed, 'tournament result');
	const result = parsed as RuntimeTournamentResult;
	verifyResultDigest(result);
	if (
		result.controllerVersion
		!== RUNTIME_TOURNAMENT_CONTROLLER_VERSION
	) {
		throw new Error(
			'Tournament result controller version is not accepted.'
		);
	}
	if (
		result.executionMode !== 'attested-runtime'
		|| result.valid !== true
		|| result.fatalError !== undefined
	) {
		throw new Error(
			'Noise-floor evidence requires a complete attested-runtime tournament.'
		);
	}
	const tournamentDirectory = await realpath(
		resolve(result.tournamentDirectory)
	);
	if (dirname(resultPath) !== tournamentDirectory) {
		throw new Error(
			'Tournament result is not stored in its declared tournament directory.'
		);
	}
	const dryRun = await resolveDryRunReport(
		result.dryRunReport.path,
		{ completedTournamentDirectory: tournamentDirectory }
	);
	const resolvedScenario = await resolveRuntimeLabScenario(
		dryRun.report.scenario.manifestPath
	);
	if (
		resolvedScenario.scenario.id !== dryRun.report.scenario.id
		|| resolvedScenario.manifestPath
			!== dryRun.report.scenario.manifestPath
		|| resolvedScenario.manifestSha256
			!== dryRun.report.scenario.manifestSha256
	) {
		throw new Error(
			'Tournament scenario does not match the verified dry-run report.'
		);
	}
	const expectedRecorderDurationMs = calculateEtlRecorderDurationMs(
		resolvedScenario.scenario.benchmarkMs,
		dryRun.report.executionControls.startupTimeoutMs
	);
	const dryRunEvidencePath = await realpath(
		resolve(result.dryRunReport.evidencePath)
	);
	const dryRunEvidenceMetadata = await stat(
		dryRunEvidencePath
	);
	if (!dryRunEvidenceMetadata.isFile()) {
		throw new TypeError(
			'Tournament dry-run evidence is not a regular file.'
		);
	}
	const dryRunEvidenceBytes = await readFile(
		dryRunEvidencePath
	);
	if (!dryRunEvidenceBytes.equals(dryRun.reportBytes)) {
		throw new Error(
			'Tournament dry-run evidence is not the exact verified report.'
		);
	}
	if (
		result.dryRunReport.path !== dryRun.reportPath
		|| result.dryRunReport.reportSha256
			!== dryRun.report.reportSha256
		|| result.dryRunReport.plannedRunsSha256
			!== dryRun.report.plannedRunsSha256
		|| result.dryRunReport.version !== dryRun.report.version
	) {
		throw new Error(
			'Tournament dry-run provenance does not match the verified report.'
		);
	}
	const expectedCandidateIdentities =
		dryRun.report.candidates.map(candidate => ({
			executableSha256: candidate.executableSha256,
			id: candidate.id,
			manifestSha256: candidate.manifestSha256
		}));
	for (const [actual, expected, label] of [
		[
			result.analysisControls,
			dryRun.report.analysisControls,
			'analysis controls'
		],
		[
			result.candidateIds,
			dryRun.report.candidateIds,
			'candidate IDs'
		],
		[
			result.candidateIdentities,
			expectedCandidateIdentities,
			'candidate identities'
		],
		[
			result.executionControls,
			dryRun.report.executionControls,
			'execution controls'
		],
		[
			result.plannedRuns,
			dryRun.report.plannedRuns,
			'planned runs'
		],
		[
			result.schedule,
			dryRun.report.schedule,
			'schedule'
		]
	] as const) {
		if (canonicalJson(actual) !== canonicalJson(expected)) {
			throw new Error(
				`Tournament result ${label} do not match the verified dry-run report.`
			);
		}
	}
	if (
		result.tournamentId !== dryRun.report.tournamentId
		|| result.scenarioId !== dryRun.report.scenario.id
		|| tournamentDirectory
			!== await realpath(
				dryRun.report.output.tournamentDirectory
			)
	) {
		throw new Error(
			'Tournament result identity does not match the verified dry-run report.'
		);
	}
	if (
		!Array.isArray(result.runRecords)
		|| result.runRecords.length !== result.plannedRuns.length
		|| result.runRecords.some((record, index) =>
			!record.valid
			|| !runRecordMatchesPlan(
				record,
				result.plannedRuns[index]
			)
		)
	) {
		throw new Error(
			'Tournament run records do not execute the verified plan exactly.'
		);
	}
	await verifyPersistedRunRecords(result, tournamentDirectory);
	const inspectorLifetimeKeys = await Promise.all(
		result.runRecords.map(record =>
			verifyRunRecordLifetimeEvidence({
				dryRun,
				expectedRecorderDurationMs,
				record,
				tournamentDirectory
			})
		)
	);
	if (new Set(inspectorLifetimeKeys).size !== inspectorLifetimeKeys.length) {
		throw new Error(
			'Tournament runs reuse a creation-qualified ETL process inspector identity.'
		);
	}
	const expectedAnalyses =
		buildRuntimeTournamentPairAnalyses({
			analysisControls: dryRun.report.analysisControls,
			candidateIds: dryRun.report.candidateIds,
			metricPolicies:
				dryRun.report.metricPolicy.metricPolicies,
			runRecords: result.runRecords,
			seed: dryRun.report.seed
		});
	if (
		canonicalJson(result.analyses)
		!== canonicalJson(expectedAnalyses)
	) {
		throw new Error(
			'Tournament analyses do not reproduce from the verified dry-run controls and run records.'
		);
	}
	await verifyControllerSourceEvidence(result, dryRun);
	return {
		result,
		resultBytes,
		resultPath
	};
}
