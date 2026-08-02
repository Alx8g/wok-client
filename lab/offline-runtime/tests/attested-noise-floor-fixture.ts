import {
	mkdir,
	readFile,
	writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import type {
	RuntimeCandidateManifest
} from '../src/candidate/manifest.ts';
import {
	analyzeRuntimeTournamentMetric,
	buildRuntimeTournamentPairedBlocks
} from '../src/controller/tournament-analysis.ts';
import {
	RUNTIME_TOURNAMENT_CONTROLLER_VERSION,
	type RuntimeTournamentResult,
	type RuntimeTournamentRunRecord
} from '../src/controller/tournament-controller.ts';
import {
	calculateEtlRecorderDurationMs,
	type ArtifactRecord
} from '../src/controller/single-run.ts';
import type {
	EtlProcessLifetimeArtifact,
	PresentMonProcessLifetimeBinding
} from '../src/host/etl-process-lifetimes.ts';
import type {
	PresentMonStreamAnalysis
} from '../src/host/presentmon-csv.ts';
import {
	acceptEtlRecorderPair,
	parseEtlRecorderReadySidecar,
	parseEtlRecorderStatusSidecar
} from '../src/host/presentmon-etl.ts';
import {
	prepareRuntimeTournamentDryRun,
	resolveRuntimeTournamentDryRunReport,
	writeRuntimeTournamentDryRunReport
} from '../src/controller/tournament-dry-run.ts';
import {
	buildRuntimeTournamentNoiseFloorReport,
	type RuntimeTournamentNoiseFloorReport
} from '../src/controller/tournament-noise-floor.ts';
import {
	persistAttestedRuntimeControllerSources
} from '../src/controller/source-attestation.ts';
import {
	resolveRuntimeLabScenario
} from '../src/scenario/manifest.ts';
import {
	canonicalJson,
	sha256Hex
} from '../src/shared/hash.ts';

const repositoryRoot = join(
	import.meta.dirname,
	'..',
	'..',
	'..'
);
const electronHostDirectory = join(
	repositoryRoot,
	'lab',
	'offline-runtime',
	'hosts',
	'electron'
);
const metricPolicyPath = join(
	repositoryRoot,
	'lab',
	'offline-runtime',
	'policies',
	'same-build-noise-capture-v1.json'
);
const scenarioManifestPath = join(
	repositoryRoot,
	'lab',
	'offline-runtime',
	'scenarios',
	'tier1-calibration-v1.json'
);
const DOTNET_FILETIME_EPOCH_OFFSET_TICKS = 504_911_232_000_000_000n;
const FILETIME_UNIX_EPOCH_TICKS = 116_444_736_000_000_000n;

function fileTimeFromUnixMs(timestampMs: number): string {
	return (
		BigInt(timestampMs) * 10_000n
		+ FILETIME_UNIX_EPOCH_TICKS
	).toString(10);
}

function creationTicksFromUnixMs(timestampMs: number): string {
	const fileTime = BigInt(fileTimeFromUnixMs(timestampMs));
	const ticks = fileTime + DOTNET_FILETIME_EPOCH_OFFSET_TICKS;
	return (ticks - ticks % 10n).toString(10);
}

export interface AttestedNoiseFloorFixture {
	executableSha256: string;
	noiseFloorReport: RuntimeTournamentNoiseFloorReport;
	noiseFloorReportPath: string;
	tournamentResult: RuntimeTournamentResult;
	tournamentResultPath: string;
}

async function writeCandidate(options: {
	directory: string;
	executableBytes: Buffer;
	executableName: string;
	id: string;
}): Promise<string> {
	await mkdir(options.directory, { recursive: true });
	const executablePath = join(
		options.directory,
		options.executableName
	);
	await writeFile(executablePath, options.executableBytes);
	const manifest: RuntimeCandidateManifest = {
		adapterVersion: 1,
		build: {
			distribution: 'WOK attested noise fixture',
			version: '1.0.0'
		},
		capabilities: {
			devToolsProtocol: false,
			presentMon: true
		},
		executable: {
			path: `./${options.executableName}`,
			sha256: sha256Hex(options.executableBytes)
		},
		graphics: {
			requestedBackend: 'd3d11'
		},
		id: options.id,
		label: options.id,
		launch: {
			additionalArguments: []
		},
		protocolVersion: 1,
		runtimeKind: 'electron'
	};
	const manifestPath = join(
		options.directory,
		`${options.id}.json`
	);
	await writeFile(manifestPath, JSON.stringify(manifest));
	return manifestPath;
}

function metricValues(
	baseline: boolean
): RuntimeTournamentRunRecord['metricValues'] {
	return {
		'average-fps': baseline ? 100 : 102,
		'frame-time-p95-ms': baseline ? 10 : 9,
		'frame-time-p99-ms': baseline ? 15 : 13,
		'one-percent-low-fps': baseline ? 80 : 82
	};
}

async function writeArtifact(
	path: string,
	value: unknown
): Promise<ArtifactRecord> {
	const bytes = Buffer.from(
		`${JSON.stringify(value, null, '\t')}\n`,
		'utf8'
	);
	await writeFile(path, bytes, { flag: 'wx' });
	return {
		path,
		sha256: sha256Hex(bytes),
		sizeBytes: bytes.byteLength
	};
}

async function writeBytesArtifact(
	path: string,
	bytes: Uint8Array
): Promise<ArtifactRecord> {
	await writeFile(path, bytes, { flag: 'wx' });
	return {
		path,
		sha256: sha256Hex(bytes),
		sizeBytes: bytes.byteLength
	};
}

function recorderSnapshot(
	buffersWritten = 0
): Record<string, number> {
	return {
		queryStatus: 0,
		bufferSizeKiB: 64,
		minimumBuffers: 256,
		maximumBuffers: 1024,
		numberOfBuffers: 256,
		freeBuffers: 255,
		eventsLost: 0,
		buffersWritten,
		logBuffersLost: 0,
		realTimeBuffersLost: 0
	};
}

function headlineStream(options: {
	applicationName: string;
	averageFps: number;
	firstTimestampMs: number;
	frameTimeP95Ms: number;
	frameTimeP99Ms: number;
	lastTimestampMs: number;
	onePercentLowFps: number;
	processId: number;
	streamKey: string;
}): PresentMonStreamAnalysis {
	return {
		applicationNames: [options.applicationName],
		averageFps: options.averageFps,
		displayedFrameCount: 2,
		droppedFrameCount: 0,
		firstTimestampMs: options.firstTimestampMs,
		fixedBudgetMissCount: 0,
		fixedBudgetMissRatio: 0,
		frameTimeP50Ms: Math.min(8, options.frameTimeP95Ms),
		frameTimeP95Ms: options.frameTimeP95Ms,
		frameTimeP99Ms: options.frameTimeP99Ms,
		frameTimeTotalMs: 2_000 / options.averageFps,
		frameTimeWorstMs: options.frameTimeP99Ms,
		key: options.streamKey,
		lastTimestampMs: options.lastTimestampMs,
		onePercentLowFps: options.onePercentLowFps,
		processId: options.processId,
		reasons: [],
		recordCount: 2,
		sampleCount: 2,
		stutterCount: 0,
		stutterRatio: 0,
		swapChainAddress: '0x1',
		unknownDisplayStatusCount: 0,
		valid: true
	};
}

export async function createAttestedNoiseFloorFixture(
	directory: string
): Promise<AttestedNoiseFloorFixture> {
	await mkdir(directory, { recursive: true });
	const executableBytes = Buffer.from(
		'runtime-a',
		'utf8'
	);
	const executableSha256 = sha256Hex(executableBytes);
	const candidateManifestPaths = await Promise.all([
		writeCandidate({
			directory: join(directory, 'noise-candidate-a'),
			executableBytes,
			executableName: 'noise-runtime-a.exe',
			id: 'noise-lane-a'
		}),
		writeCandidate({
			directory: join(directory, 'noise-candidate-b'),
			executableBytes,
			executableName: 'noise-runtime-b.exe',
			id: 'noise-lane-b'
		})
	]);
	const etlRecorderPath = join(
		directory,
		'NoiseEtlRecorder.exe'
	);
	const presentMonPath = join(
		directory,
		'NoisePresentMon.exe'
	);
	const etlRecorderBytes = Buffer.from(
		'noise-etl-recorder',
		'utf8'
	);
	const presentMonBytes = Buffer.from(
		'noise-presentmon',
		'utf8'
	);
	await Promise.all([
		writeFile(etlRecorderPath, etlRecorderBytes),
		writeFile(presentMonPath, presentMonBytes)
	]);
	const dryRunReport = await prepareRuntimeTournamentDryRun({
		bootstrapIterations: 1_000,
		candidateManifestPaths,
		confidenceLevel: 0.95,
		electronHostDirectory,
		etlRecorderPath,
		etlRecorderSha256: sha256Hex(etlRecorderBytes),
		metricPolicyPath,
		minimumPairedBlocks: 7,
		outputRootDirectory: join(directory, 'tournaments'),
		presentMonPath,
		presentMonSha256: sha256Hex(presentMonBytes),
		quietBaselineMs: 0,
		requestedBlockCount: 7,
		scenarioManifestPath,
		seed: 'attested-noise-floor-fixture',
		startupTimeoutMs: 15_000,
		tournamentId: 'attested-noise-floor-source',
		warmupRunsPerCandidate: 0
	});
	const dryRunReportPath =
		await writeRuntimeTournamentDryRunReport(
			dryRunReport,
			join(directory, 'preparations')
		);
	const {
		runtimeControllerAttestation
	} = await resolveRuntimeTournamentDryRunReport(
		dryRunReportPath
	);
	const resolvedScenario = await resolveRuntimeLabScenario(
		scenarioManifestPath
	);
	const recorderDurationMs = calculateEtlRecorderDurationMs(
		resolvedScenario.scenario.benchmarkMs,
		dryRunReport.executionControls.startupTimeoutMs
	);
	const tournamentDirectory =
		dryRunReport.output.tournamentDirectory;
	await mkdir(tournamentDirectory, { recursive: true });
	const dryRunEvidencePath = join(
		tournamentDirectory,
		'dry-run-report.json'
	);
	await writeFile(
		dryRunEvidencePath,
		await readFile(dryRunReportPath),
		{ flag: 'wx' }
	);
	const sourceEvidenceDirectory = join(
		tournamentDirectory,
		'controller-sources'
	);
	await mkdir(sourceEvidenceDirectory);
	const controllerSourceInventory =
		await persistAttestedRuntimeControllerSources(
			runtimeControllerAttestation,
			sourceEvidenceDirectory
		);
	const baselineCandidateId = dryRunReport.candidateIds[0];
	const challengerCandidateId = dryRunReport.candidateIds[1];
	if (
		baselineCandidateId === undefined
		|| challengerCandidateId === undefined
	) {
		throw new Error(
			'Attested noise fixture requires two candidates.'
		);
	}
	const runRecords: RuntimeTournamentRunRecord[] = await Promise.all(
		dryRunReport.plannedRuns.map(
			async (plannedRun): Promise<RuntimeTournamentRunRecord> => {
				const sequenceOffset = plannedRun.sequenceIndex + 1;
				const candidate = dryRunReport.candidates.find(
					entry => entry.id === plannedRun.candidateId
				);
				if (candidate === undefined) {
					throw new Error(
						`Missing fixture candidate ${plannedRun.candidateId}.`
					);
				}
				const runDirectory = join(
					tournamentDirectory,
					'runs',
					plannedRun.runId
				);
				const capturesDirectory = join(runDirectory, 'captures');
				await mkdir(capturesDirectory, { recursive: true });
				const processId = 40_000 + sequenceOffset;
				const inspectorProcessId = 80_000 + sequenceOffset;
				const captureStartTimestampMs =
					1_775_000_000_000 + sequenceOffset * 100_000;
				const captureStopTimestampMs =
					captureStartTimestampMs + 10_000;
				const processStartTimestampMs =
					captureStartTimestampMs + 1_000;
				const creationTimeUtcTicks = creationTicksFromUnixMs(
					processStartTimestampMs
				);
				const inspectorCreationTimeUtcTicks =
					creationTicksFromUnixMs(captureStartTimestampMs - 1_000);
				const firstFrameTimestampMs =
					captureStartTimestampMs + 2_000;
				const lastFrameTimestampMs =
					captureStartTimestampMs + 7_000;
				const etlPath = join(capturesDirectory, 'presentmon.etl');
				const recorderEtlPath = process.platform === 'win32'
					? etlPath
					: `C:\\runtime-lab\\${plannedRun.runId}\\captures\\presentmon.etl`;
				const etlBytes = Buffer.from(
					`etl:${plannedRun.runId}`,
					'utf8'
				);
				const etlSha256 = sha256Hex(etlBytes);
				const operationalEtlPath = `\\\\?\\Volume{11111111-1111-4111-8111-111111111111}\\runtime-lab\\${plannedRun.runId}\\captures\\presentmon.etl`;
				const etlVolumeSerialNumber = '305419896';
				const etlFileIndex = sequenceOffset
					.toString(16)
					.padStart(16, '0');
				const sessionName =
					`WOKRuntimeLabFile-${plannedRun.runId.slice(0, 44)}-00000000-0000-4000-8000-${sequenceOffset.toString(16).padStart(12, '0')}`;
				const captureStartFileTimeUtc = fileTimeFromUnixMs(
					captureStartTimestampMs
				);
				const captureStopFileTimeUtc = fileTimeFromUnixMs(
					captureStopTimestampMs
				);
				const recorderExpectedIdentity = {
					durationMs: recorderDurationMs,
					etlPath: recorderEtlPath,
					sessionName
				};
				const readyBytes = Buffer.from(`${JSON.stringify({
					version: 5,
					phase: 'ready',
					captureStartFileTimeUtc,
					sessionName,
					etlPath: recorderEtlPath,
					operationalEtlPath,
					etlVolumeSerialNumber,
					etlFileIndex,
					etlIdentityVerifiedForCapture: true,
					durationMs: recorderDurationMs,
					filterEventIds: true,
					processEventsRequired: true,
					processEventsEnabled: true,
					processRundownRequested: false,
					isWin11OrGreater: true,
					requested: {
						bufferSizeKiB: 64,
						minimumBuffers: 256,
						maximumBuffers: 1024,
						flushTimerSeconds: 0
					},
					effective: recorderSnapshot()
				})}\r\n`, 'utf8');
				const statusBytes = Buffer.from(`${JSON.stringify({
					version: 5,
					phase: 'completed',
					valid: true,
					captureStartFileTimeUtc,
					captureStopFileTimeUtc,
					sessionName,
					etlPath: recorderEtlPath,
					operationalEtlPath,
					etlVolumeSerialNumber,
					etlFileIndex,
					etlIdentityVerifiedForCapture: true,
					etlIdentityVerifiedAfterStop: true,
					durationMs: recorderDurationMs,
					filterEventIds: true,
					processEventsRequired: true,
					processEventsEnabled: true,
					processRundownRequested: false,
					startStatus: 0,
					providerStatus: 0,
					initial: recorderSnapshot(),
					waitStatus: 258,
					beforeStop: recorderSnapshot(1),
					stopStatus: 0,
					cleanupStopStatus: 0,
					stopAttemptStatuses: [0],
					etlFinalized: true,
					stopped: recorderSnapshot(1),
					etlExists: true,
					etlSizeBytes: etlBytes.byteLength,
					etlSha256,
					etlReadLease: 'held-until-controller-release'
				})}\r\n`, 'utf8');
				const acceptedCapture = acceptEtlRecorderPair(
					parseEtlRecorderReadySidecar(readyBytes),
					parseEtlRecorderStatusSidecar(statusBytes),
					recorderExpectedIdentity
				);
				const inspectorProcessIdentity = {
					creationTimeUtcTicks:
						inspectorCreationTimeUtcTicks,
					executable: {
						fileIdHex: sequenceOffset
							.toString(16)
							.padStart(16, '0'),
						finalPath: etlRecorderPath,
						sha256: sha256Hex(etlRecorderBytes),
						sizeBytes: etlRecorderBytes.byteLength,
						volumeSerialNumberHex: '00000001'
					},
					executablePath: etlRecorderPath,
					processId: inspectorProcessId
				};
				const processEventBytes = Buffer.from(`${JSON.stringify({
					version: 2,
					phase: 'etl-process-events',
					etlPath: operationalEtlPath,
					etlVolumeSerialNumber,
					etlFileIndex,
					etlSizeBytes: etlBytes.byteLength,
					etlSha256,
					targetProcessId: processId,
					inspectionInvocation: {
						candidateId: plannedRun.candidateId,
						etlFileIndex,
						etlPath: operationalEtlPath,
						etlSha256,
						etlSizeBytes: etlBytes.byteLength,
						etlVolumeSerialNumber,
						outputArtifactRelativePath:
							'captures/etl-process-events.json',
						role: 'etl-process-inspector',
						runId: plannedRun.runId,
						targetProcessId: processId
					},
					inspectorProcessIdentity,
					events: [{
						kind: 'start',
						sequence: 0,
						processId,
						eventVersion: 3,
						eventTimestampFileTimeUtc:
							fileTimeFromUnixMs(processStartTimestampMs),
						createTimeFileTimeUtc:
							fileTimeFromUnixMs(processStartTimestampMs),
						creationTimeUtcTicks,
						parentProcessId: 1,
						executableName: candidate.executableName
					}]
				})}\r\n`, 'utf8');
				const processEventEvidenceSha256 =
					sha256Hex(processEventBytes);
				const lifetimeArtifact: EtlProcessLifetimeArtifact = {
					captureStartTimestampMs,
					captureStopTimestampMs,
					etlSha256,
					lifetimes: [{
						creationTimeUtcTicks,
						end: {
							captureStopTimestampMs,
							kind: 'active-at-capture-stop'
						},
						executableName: candidate.executableName,
						processId,
						start: {
							kind: 'etl-process-start',
							timestampMs: processStartTimestampMs
						}
					}],
					processEventEvidenceSha256,
					targetProcessId: processId,
					version: 1
				};
				const streamKey = `pid:${processId}/swapchain:0x1`;
				const binding: PresentMonProcessLifetimeBinding = {
					creationTimeUtcTicks,
					etlSha256,
					executableName: candidate.executableName,
					executablePath: candidate.executablePath,
					firstFrameTimestampMs,
					lastFrameTimestampMs,
					lifetimeEnd: lifetimeArtifact.lifetimes[0]?.end
						?? {
							captureStopTimestampMs,
							kind: 'active-at-capture-stop'
						},
					lifetimeStart: lifetimeArtifact.lifetimes[0]?.start
						?? {
							kind: 'etl-process-start',
							timestampMs: processStartTimestampMs
						},
					processEventEvidenceSha256,
					processId,
					recordCount: 2,
					streamKey,
					valid: true,
					version: 1
				};
				const [
					captureArtifact,
					processEventArtifact,
					readySidecarArtifact,
					statusSidecarArtifact,
					etlProcessLifetimeEvidence,
					presentMonProcessLifetimeBindingEvidence
				] = await Promise.all([
					writeBytesArtifact(etlPath, etlBytes),
					writeBytesArtifact(
						join(capturesDirectory, 'etl-process-events.json'),
						processEventBytes
					),
					writeBytesArtifact(
						join(capturesDirectory, 'etl-recorder-ready.json'),
						readyBytes
					),
					writeBytesArtifact(
						join(capturesDirectory, 'etl-recorder-status.json'),
						statusBytes
					),
					writeArtifact(
						join(
							capturesDirectory,
							'etl-process-lifetimes.json'
						),
						lifetimeArtifact
					),
					writeArtifact(
						join(
							capturesDirectory,
							'presentmon-headline-process-lifetime-binding.json'
						),
						binding
					)
				]);
				const values = metricValues(
					plannedRun.candidateId === baselineCandidateId
				);
				const stream = headlineStream({
					applicationName: candidate.executableName,
					averageFps: values['average-fps'] ?? 0,
					firstTimestampMs: firstFrameTimestampMs,
					frameTimeP95Ms:
						values['frame-time-p95-ms'] ?? 0,
					frameTimeP99Ms:
						values['frame-time-p99-ms'] ?? 0,
					lastTimestampMs: lastFrameTimestampMs,
					onePercentLowFps:
						values['one-percent-low-fps'] ?? 0,
					processId,
					streamKey
				});
				return {
					blockIndex: plannedRun.blockIndex,
					candidateId: plannedRun.candidateId,
					cycleIndex: plannedRun.cycleIndex,
					etlEvidence: {
						acceptedCapture,
						captureArtifact,
						processEventArtifact,
						readySidecarArtifact,
						recorderExpectedIdentity,
						statusSidecarArtifact
					},
					etlProcessLifetimeEvidence,
					executionIdentities: {
						etlProcessInspector:
							inspectorProcessIdentity,
						presentingProcessSample: {
							commandLine: candidate.executablePath,
							creationTimeUtcTicks,
							executableName: candidate.executableName,
							executablePath: candidate.executablePath,
							parentProcessId: 1,
							processId
						}
					},
					failureReasons: [],
					failures: [],
					headlineStream: stream,
					headlineStreamKey: streamKey,
					metricValues: values,
					phase: plannedRun.phase,
					presentingProcessId: processId,
					presentMonProcessLifetimeBinding: binding,
					presentMonProcessLifetimeBindingEvidence,
					runDirectory,
					runId: plannedRun.runId,
					sequenceIndex: plannedRun.sequenceIndex,
					valid: true,
					violations: []
				};
			}
		)
	);
	const analyses = dryRunReport.metricPolicy.metricPolicies.map(
		policy => {
			const paired = buildRuntimeTournamentPairedBlocks(
				runRecords.map(record => ({
					blockId:
						`block-${String(record.blockIndex).padStart(4, '0')}`,
					candidateId: record.candidateId,
					valid: record.valid,
					value: record.metricValues[policy.metricId]
				})),
				{
					baselineCandidateId,
					challengerCandidateId,
					expectedObservationsPerCandidate: 2
				}
			);
			return {
				analysis: analyzeRuntimeTournamentMetric({
					baselineCandidateId,
					blocks: paired.blocks,
					bootstrapIterations:
						dryRunReport.analysisControls.bootstrapIterations,
					challengerCandidateId,
					direction: policy.direction,
					noiseFloor: policy.noiseFloor,
					practicalMargin: policy.practicalMargin,
					seed: `${dryRunReport.seed}-0-1-${policy.metricId}`
				}),
				baselineCandidateId,
				challengerCandidateId,
				metricId: policy.metricId,
				paired
			};
		}
	);
	const resultWithoutHash: Omit<
		RuntimeTournamentResult,
		'resultSha256'
	> = {
		analyses,
		analysisControls: dryRunReport.analysisControls,
		candidateIds: dryRunReport.candidateIds,
		candidateIdentities: dryRunReport.candidates.map(
			candidate => ({
				executableSha256: candidate.executableSha256,
				id: candidate.id,
				manifestSha256: candidate.manifestSha256
			})
		),
		completedAt: '2026-08-02T00:30:00.000Z',
		controllerSourceInventoryVersion:
			controllerSourceInventory.version,
		controllerSources: controllerSourceInventory.sources,
		controllerVersion:
			RUNTIME_TOURNAMENT_CONTROLLER_VERSION,
		dryRunReport: {
			evidencePath: dryRunEvidencePath,
			path: dryRunReportPath,
			plannedRunsSha256:
				dryRunReport.plannedRunsSha256,
			reportSha256: dryRunReport.reportSha256,
			version: dryRunReport.version
		},
		executionControls: dryRunReport.executionControls,
		executionMode: 'attested-runtime',
		plannedRuns: dryRunReport.plannedRuns,
		runRecords,
		scenarioId: dryRunReport.scenario.id,
		schedule: dryRunReport.schedule,
		startedAt: '2026-08-02T00:00:00.000Z',
		tournamentDirectory,
		tournamentId: dryRunReport.tournamentId,
		valid: true
	};
	const tournamentResult: RuntimeTournamentResult = {
		...resultWithoutHash,
		resultSha256: sha256Hex(
			canonicalJson(resultWithoutHash)
		)
	};
	await writeFile(
		join(tournamentDirectory, 'run-records.json'),
		`${JSON.stringify(runRecords, null, '\t')}\n`,
		{ flag: 'wx' }
	);
	const tournamentResultPath = join(
		tournamentDirectory,
		'tournament-result.json'
	);
	await writeFile(
		tournamentResultPath,
		`${JSON.stringify(tournamentResult, null, '\t')}\n`,
		{ flag: 'wx' }
	);
	const noiseFloorReport =
		buildRuntimeTournamentNoiseFloorReport(
			tournamentResult,
			{ tournamentResultPath }
		);
	const noiseFloorReportPath = join(
		directory,
		'noise-floor-report.json'
	);
	await writeFile(
		noiseFloorReportPath,
		`${JSON.stringify(noiseFloorReport, null, '\t')}\n`,
		{ flag: 'wx' }
	);
	return {
		executableSha256,
		noiseFloorReport,
		noiseFloorReportPath,
		tournamentResult,
		tournamentResultPath
	};
}
