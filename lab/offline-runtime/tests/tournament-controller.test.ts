import assert from 'node:assert/strict';
import {
	mkdir,
	mkdtemp,
	readFile,
	writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type {
	RuntimeCandidateManifest
} from '../src/candidate/manifest.ts';
import type {
	RuntimeLabFailure
} from '../src/host/failure-classification.ts';
import type {
	PresentMonCsvAnalysis,
	PresentMonStreamAnalysis
} from '../src/host/presentmon-csv.ts';
import {
	resolveTournamentHeadlineStreamEvidence,
	runRuntimeTournament,
	type RuntimeTournamentDependencies,
	type RuntimeTournamentOptions,
	type RuntimeTournamentRunRecord,
	type RuntimeTournamentRunResult
} from '../src/controller/tournament-controller.ts';
import {
	prepareRuntimeTournamentDryRun,
	writeRuntimeTournamentDryRunReport,
	type RuntimeTournamentDryRunOptions
} from '../src/controller/tournament-dry-run.ts';
import {
	RUNTIME_CONTROLLER_SOURCE_INVENTORY,
	RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION
} from '../src/controller/source-attestation.ts';
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
const testOutputRoot = join(
	repositoryRoot,
	'.working',
	'runtime-lab',
	'tests'
);
await mkdir(testOutputRoot, { recursive: true });

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

interface TournamentFixture {
	candidateByManifestPath: Map<string, string>;
	candidateManifestPaths: string[];
	directory: string;
	etlRecorderPath: string;
	etlRecorderSha256: string;
	outputRootDirectory: string;
	presentMonPath: string;
	presentMonSha256: string;
}

async function createFixture(): Promise<TournamentFixture> {
	const directory = await mkdtemp(
		join(testOutputRoot, 'tournament-controller-')
	);
	const candidateByManifestPath = new Map<
		string,
		string
	>();
	const candidateManifestPaths: string[] = [];
	for (const candidateId of [
		'candidate-a',
		'candidate-b'
	]) {
		const executableName = `${candidateId}.exe`;
		const executableContent =
			'runtime-binary-shared';
		const executablePath = join(
			directory,
			executableName
		);
		await writeFile(
			executablePath,
			executableContent
		);
		const manifest: RuntimeCandidateManifest = {
			adapterVersion: 1,
			build: {
				distribution: 'WOK test runtime',
				version: '1.0.0'
			},
			capabilities: {
				devToolsProtocol: false,
				presentMon: true
			},
			executable: {
				path: `./${executableName}`,
				sha256: sha256Hex(executableContent)
			},
			graphics: {
				requestedBackend: 'd3d11'
			},
			id: candidateId,
			label: candidateId,
			launch: {
				additionalArguments: []
			},
			protocolVersion: 1,
			runtimeKind: 'electron'
		};
		const manifestPath = join(
			directory,
			`${candidateId}.json`
		);
		await writeFile(
			manifestPath,
			JSON.stringify(manifest)
		);
		candidateByManifestPath.set(
			manifestPath,
			candidateId
		);
		candidateManifestPaths.push(manifestPath);
	}
	const etlRecorderContent = 'etl-recorder-fixture';
	const etlRecorderPath = join(directory, 'EtlRecorder.exe');
	await writeFile(etlRecorderPath, etlRecorderContent);
	const presentMonContent = 'presentmon-fixture';
	const presentMonPath = join(directory, 'PresentMon.exe');
	await writeFile(presentMonPath, presentMonContent);
	return {
		candidateByManifestPath,
		candidateManifestPaths,
		directory,
		etlRecorderPath,
		etlRecorderSha256: sha256Hex(etlRecorderContent),
		outputRootDirectory: join(directory, 'output'),
		presentMonPath,
		presentMonSha256: sha256Hex(presentMonContent)
	};
}

async function tournamentOptions(
	fixture: TournamentFixture,
	overrides: Partial<RuntimeTournamentDryRunOptions> = {}
): Promise<RuntimeTournamentOptions> {
	const report = await prepareRuntimeTournamentDryRun({
		candidateManifestPaths:
			fixture.candidateManifestPaths,
		electronHostDirectory,
		etlRecorderPath: fixture.etlRecorderPath,
		etlRecorderSha256: fixture.etlRecorderSha256,
		metricPolicyPath,
		outputRootDirectory:
			fixture.outputRootDirectory,
		presentMonPath: fixture.presentMonPath,
		presentMonSha256: fixture.presentMonSha256,
		quietBaselineMs: 25,
		requestedBlockCount: 7,
		scenarioManifestPath,
		seed: 'controller-test-seed',
		tournamentId: 'controller-test',
		warmupRunsPerCandidate: 1,
		...overrides
	});
	const dryRunReportPath =
		await writeRuntimeTournamentDryRunReport(
			report,
			join(fixture.directory, 'preparations')
		);
	return {
		confirmIdleSystem: true,
		dryRunReportPath
	};
}

function headlineStream(
	candidateId: string
): PresentMonStreamAnalysis {
	const challenger = candidateId === 'candidate-b';
	const averageFps = challenger ? 110 : 100;
	return {
		applicationNames: [`${candidateId}.exe`],
		averageFps,
		displayedFrameCount: 100,
		droppedFrameCount: 0,
		fixedBudgetMissCount: 0,
		fixedBudgetMissRatio: 0,
		frameTimeP50Ms: 1_000 / averageFps,
		frameTimeP95Ms: challenger ? 9 : 10,
		frameTimeP99Ms: challenger ? 11 : 12,
		frameTimeTotalMs: 100_000 / averageFps,
		frameTimeWorstMs: challenger ? 12 : 13,
		firstTimestampMs: 2_000,
		key: 'pid:200/swapchain:0xselected',
		lastTimestampMs: 7_000,
		onePercentLowFps: challenger ? 90 : 80,
		processId: 200,
		reasons: [],
		recordCount: 100,
		sampleCount: 100,
		stutterCount: 0,
		stutterRatio: 0,
		swapChainAddress: '0xSELECTED',
		unknownDisplayStatusCount: 0,
		valid: true
	};
}

function headlineAnalysis(
	candidateId: string,
	stream: PresentMonStreamAnalysis
): PresentMonCsvAnalysis {
	const challenger = candidateId === 'candidate-b';
	return {
		overall: {
			averageFps: challenger ? 1 : 1_000,
			frameTimeP95Ms: challenger ? 900 : 1,
			frameTimeP99Ms: challenger ? 1_100 : 2,
			onePercentLowFps: challenger ? 0.9 : 900
		},
		streams: [
			{
				...stream,
				averageFps: 500,
				key: 'pid:999/swapchain:0xunrelated',
				processId: 999
			},
			stream
		],
		valid: true
	} as PresentMonCsvAnalysis;
}

function successfulRunResult(
	options: Parameters<
		RuntimeTournamentDependencies['runSingle']
	>[0],
	candidateId: string
): RuntimeTournamentRunResult {
	const stream = headlineStream(candidateId);
	const runDirectory = join(
		options.outputRootDirectory,
		options.runId
	);
	const etlSha256 = '1'.repeat(64);
	const processEventEvidenceSha256 = '2'.repeat(64);
	return {
		cleanup: {
			orphanProcessIds: []
		},
		etlEvidence: {
			acceptedCapture: {
				captureStartFileTimeUtc: '133801632000000000',
				captureStopFileTimeUtc: '133801632100000000',
				etlFileIndex: '0000000000000001',
				etlReadLease: 'held-until-controller-release',
				etlSha256,
				etlSizeBytes: 1_024,
				etlVolumeSerialNumber: '1',
				operationalEtlPath: String.raw`\\?\Volume{11111111-1111-4111-8111-111111111111}\runtime-lab\presentmon.etl`,
				sessionName: `WOKRuntimeLabFile-${options.runId}`
			},
			captureArtifact: {
				path: join(runDirectory, 'captures', 'presentmon.etl'),
				sha256: etlSha256,
				sizeBytes: 1_024
			},
			processEventArtifact: {
				path: join(
					runDirectory,
					'captures',
					'etl-process-events.json'
				),
				sha256: processEventEvidenceSha256,
				sizeBytes: 1_024
			},
			readySidecarArtifact: {
				path: join(
					runDirectory,
					'captures',
					'etl-recorder-ready.json'
				),
				sha256: '5'.repeat(64),
				sizeBytes: 1_024
			},
			recorderExpectedIdentity: {
				durationMs: 60_000,
				etlPath: join(runDirectory, 'captures', 'presentmon.etl'),
				sessionName: `WOKRuntimeLabFile-${options.runId}`
			},
			statusSidecarArtifact: {
				path: join(
					runDirectory,
					'captures',
					'etl-recorder-status.json'
				),
				sha256: '6'.repeat(64),
				sizeBytes: 1_024
			}
		},
		etlProcessLifetimeEvidence: {
			path: join(
				runDirectory,
				'captures',
				'etl-process-lifetimes.json'
			),
			sha256: '3'.repeat(64),
			sizeBytes: 1_024
		},
		executionIdentities: {
			etlProcessInspector: {
				creationTimeUtcTicks: '638900000001000000',
				executable: {
					fileIdHex: '0'.repeat(32),
					finalPath: options.etlRecorderPath,
					sha256: options.etlRecorderSha256,
					sizeBytes: 1_024,
					volumeSerialNumberHex: '00000001'
				},
				executablePath: options.etlRecorderPath,
				processId: 300
			},
			presentingProcessSample: {
				commandLine: '',
				creationTimeUtcTicks: '638900000000000000',
				executableName: 'candidate.exe',
				executablePath: 'C:\\runtime\\candidate.exe',
				parentProcessId: 100,
				processId: 200
			}
		},
		headlineAnalysis: headlineAnalysis(
			candidateId,
			stream
		),
		headlineStream: stream,
		headlineStreamKey: stream.key,
		presentingProcessId: 200,
		presentMonProcessLifetimeBinding: {
			creationTimeUtcTicks: '638900000000000000',
			etlSha256,
			executableName: 'candidate.exe',
			executablePath: 'C:\\runtime\\candidate.exe',
			firstFrameTimestampMs: 2_000,
			lastFrameTimestampMs: 7_000,
			lifetimeEnd: {
				captureStopTimestampMs: 10_000,
				kind: 'active-at-capture-stop'
			},
			lifetimeStart: {
				kind: 'etl-process-start',
				timestampMs: 1_000
			},
			processEventEvidenceSha256,
			processId: 200,
			recordCount: 100,
			streamKey: stream.key,
			valid: true,
			version: 1
		},
		presentMonProcessLifetimeBindingEvidence: {
			path: join(
				runDirectory,
				'captures',
				'presentmon-headline-process-lifetime-binding.json'
			),
			sha256: '4'.repeat(64),
			sizeBytes: 1_024
		},
		runDirectory,
		runId: options.runId,
		valid: true,
		violations: []
	};
}

test('tournament requires matching valid selected-stream evidence', () => {
	const stream = headlineStream('candidate-a');
	const result: RuntimeTournamentRunResult = {
		headlineAnalysis: headlineAnalysis(
			'candidate-a',
			stream
		),
		headlineStream: stream,
		headlineStreamKey: stream.key,
		presentingProcessId: 200,
		runDirectory: 'run-directory',
		runId: 'run-id',
		valid: true,
		violations: []
	};
	assert.equal(
		resolveTournamentHeadlineStreamEvidence(
			result
		).stream?.key,
		stream.key
	);

	const missing = { ...result };
	delete missing.headlineStreamKey;
	assert.ok(
		resolveTournamentHeadlineStreamEvidence(
			missing
		).violations.includes(
			'tournament-headline-stream-key-missing'
		)
	);
	assert.ok(
		resolveTournamentHeadlineStreamEvidence({
			...result,
			headlineStreamKey:
				'pid:200/swapchain:0xmissing'
		}).violations.includes(
			'tournament-headline-stream-missing'
		)
	);
	assert.ok(
		resolveTournamentHeadlineStreamEvidence({
			...result,
			presentingProcessId: 201
		}).violations.includes(
			'tournament-headline-stream-pid-mismatch'
		)
	);

	const invalidStream = {
		...stream,
		reasons: ['insufficient-frame-time-samples:1/50'],
		valid: false
	};
	assert.ok(
		resolveTournamentHeadlineStreamEvidence({
			...result,
			headlineAnalysis: headlineAnalysis(
				'candidate-a',
				invalidStream
			),
			headlineStream: invalidStream
		}).violations.includes(
			'tournament-headline-stream-invalid'
		)
	);
	assert.ok(
		resolveTournamentHeadlineStreamEvidence({
			...result,
			headlineStream: {
				...stream,
				averageFps: 999
			}
		}).violations.includes(
			'tournament-headline-stream-evidence-mismatch'
		)
	);
});

function benchmarkFailure(reason: string): RuntimeLabFailure {
	return {
		details: {
			pageValid: false,
			reasons: [reason, 'benchmark-unsuccessful'],
			rejected: true,
			success: false
		},
		kind: 'benchmark-failure',
		message: `The benchmark rejected the page result: ${reason}.`
	};
}

function candidateIdForRun(
	fixture: TournamentFixture,
	manifestPath: string
): string {
	const candidateId =
		fixture.candidateByManifestPath.get(
			manifestPath
		);
	assert.ok(candidateId);
	return candidateId;
}

test('tournament refuses every launch without explicit idle-system confirmation', async () => {
	let launched = false;
	await assert.rejects(
		runRuntimeTournament(
			{
				confirmIdleSystem: false,
				dryRunReportPath: 'missing-report.json'
			},
			{
				runSingle: async () => {
					launched = true;
					throw new Error('must not launch');
				},
				wait: async () => undefined
			}
		),
		/idle-system confirmation/u
	);
	assert.equal(launched, false);
});

test('tournament persists its plan before strictly serial warmups and measured runs', async () => {
	const fixture = await createFixture();
	const tournamentId = 'serial-plan-test';
	let activeRuns = 0;
	let maximumActiveRuns = 0;
	let runCountAtWait = -1;
	let planObservedBeforeFirstRun = false;
	const launchedOptions: Parameters<
		RuntimeTournamentDependencies['runSingle']
	>[0][] = [];
	const dependencies: RuntimeTournamentDependencies = {
		runSingle: async options => {
			activeRuns += 1;
			maximumActiveRuns = Math.max(
				maximumActiveRuns,
				activeRuns
			);
			if (launchedOptions.length === 0) {
				const plan = JSON.parse(
					await readFile(
						join(
							fixture.outputRootDirectory,
							tournamentId,
							'planned-runs.json'
						),
						'utf8'
					)
				) as {
					plannedRuns: unknown[];
				};
				planObservedBeforeFirstRun =
					plan.plannedRuns.length === 30;
			}
			launchedOptions.push(options);
			await Promise.resolve();
			activeRuns -= 1;
			const candidateId = candidateIdForRun(
				fixture,
				options.candidateManifestPath
			);
			return successfulRunResult(
				options,
				candidateId
			);
		},
		wait: async milliseconds => {
			assert.equal(milliseconds, 25);
			runCountAtWait = launchedOptions.length;
		}
	};
	const result = await runRuntimeTournament(
		await tournamentOptions(fixture, {
			tournamentId
		}),
		dependencies
	);

	assert.equal(planObservedBeforeFirstRun, true);
	assert.equal(maximumActiveRuns, 1);
	assert.equal(runCountAtWait, 2);
	assert.equal(launchedOptions.length, 30);
	assert.ok(
		launchedOptions.every(
			options => options.confirmIdleSystem
		)
	);
	assert.ok(
		launchedOptions.every(options =>
			options.etlRecorderPath
				=== fixture.etlRecorderPath
			&& options.etlRecorderSha256
				=== fixture.etlRecorderSha256
			&& options.expectedAttestation?.etlRecorder.path
				=== fixture.etlRecorderPath
			&& options.expectedAttestation?.etlRecorder.sha256
				=== fixture.etlRecorderSha256
		)
	);
	const sharedRuntimeControllerAttestation =
		launchedOptions[0]?.runtimeControllerAttestation;
	assert.notEqual(sharedRuntimeControllerAttestation, undefined);
	assert.ok(
		launchedOptions.every(options =>
			options.runtimeControllerAttestation
				=== sharedRuntimeControllerAttestation
		)
	);
	assert.equal(result.dryRunReport.version, 3);
	assert.deepEqual(
		await readFile(result.dryRunReport.evidencePath),
		await readFile(result.dryRunReport.path)
	);
	assert.equal(result.plannedRuns.length, 30);
	assert.equal(result.runRecords.length, 30);
	for (const record of result.runRecords) {
		assert.equal(
			record.metricValues['average-fps'],
			record.candidateId === 'candidate-b'
				? 110
				: 100
		);
		assert.equal(
			record.headlineStreamKey,
			'pid:200/swapchain:0xselected'
		);
		assert.equal(record.presentingProcessId, 200);
		assert.equal(record.headlineStream?.firstTimestampMs, 2_000);
		assert.equal(record.headlineStream?.lastTimestampMs, 7_000);
		assert.equal(
			record.etlEvidence?.acceptedCapture.etlSha256,
			'1'.repeat(64)
		);
		assert.equal(
			record.etlEvidence?.processEventArtifact.sha256,
			'2'.repeat(64)
		);
		assert.equal(
			record.etlProcessLifetimeEvidence?.sha256,
			'3'.repeat(64)
		);
		assert.equal(
			record.executionIdentities
				?.etlProcessInspector
				?.processId,
			300
		);
		assert.equal(
			record.executionIdentities
				?.presentingProcessSample
				?.creationTimeUtcTicks,
			'638900000000000000'
		);
		assert.equal(
			record.presentMonProcessLifetimeBinding?.streamKey,
			record.headlineStreamKey
		);
		assert.equal(
			record.presentMonProcessLifetimeBindingEvidence?.sha256,
			'4'.repeat(64)
		);
	}
	assert.equal(result.controllerVersion, 6);
	const persistedRunRecords = JSON.parse(
		await readFile(
			join(result.tournamentDirectory, 'run-records.json'),
			'utf8'
		)
	) as RuntimeTournamentRunRecord[];
	assert.deepEqual(persistedRunRecords, result.runRecords);
	assert.equal(
		persistedRunRecords[0]
			?.executionIdentities
			?.etlProcessInspector
			?.processId,
		300
	);
	assert.equal(
		persistedRunRecords[0]
			?.presentMonProcessLifetimeBindingEvidence
			?.sha256,
		'4'.repeat(64)
	);
	assert.equal(result.valid, false);
	assert.equal(result.executionMode, 'injected-test');
	assert.equal(
		result.fatalError,
		'Injected tournament dependencies cannot produce attested runtime evidence.'
	);
	assert.equal(
		result.analyses[0].analysis?.decision,
		'challenger-better'
	);
	assert.equal(
		result.controllerSourceInventoryVersion,
		RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION
	);
	assert.deepEqual(
		Object.keys(result.controllerSources),
		Object.keys(RUNTIME_CONTROLLER_SOURCE_INVENTORY.files)
	);
	for (const source of Object.values(result.controllerSources)) {
		const evidence = await readFile(source.evidencePath);
		assert.equal(evidence.byteLength, source.sizeBytes);
		assert.equal(sha256Hex(evidence), source.sha256);
	}
	const {
		resultSha256,
		...withoutHash
	} = result;
	assert.equal(
		resultSha256,
		sha256Hex(canonicalJson(withoutHash))
	);
});

test('an invalid measured run is persisted with normalized failure evidence before fail-fast stop', async () => {
	const fixture = await createFixture();
	let launchCount = 0;
	const tournamentId = 'invalid-measured-stop-test';
	const result = await runRuntimeTournament(
		await tournamentOptions(fixture, {
			quietBaselineMs: 0,
			requestedBlockCount: 7,
			tournamentId,
			warmupRunsPerCandidate: 0
		}),
		{
			runSingle: async options => {
				launchCount += 1;
				const candidateId = candidateIdForRun(
					fixture,
					options.candidateManifestPath
				);
				return {
					...successfulRunResult(options, candidateId),
					failures: [benchmarkFailure('window-blurred')],
					valid: false
				};
			},
			wait: async () => undefined
		}
	);

	assert.equal(launchCount, 1);
	assert.equal(result.valid, false);
	assert.match(
		result.fatalError ?? '',
		/^Measured run .* was invalid: window-blurred\.$/u
	);
	assert.equal(result.runRecords.length, 1);
	assert.deepEqual(
		result.runRecords[0].failureReasons,
		['window-blurred', 'benchmark-unsuccessful']
	);
	assert.equal(
		result.runRecords[0].failures[0]?.kind,
		'benchmark-failure'
	);
	assert.equal(
		result.analyses[0].unavailableReason,
		'No clean paired blocks were available.'
	);
	const persisted = JSON.parse(await readFile(join(
		fixture.outputRootDirectory,
		tournamentId,
		'run-records.json'
	), 'utf8')) as { failureReasons: string[] }[];
	assert.deepEqual(
		persisted[0]?.failureReasons,
		['window-blurred', 'benchmark-unsuccessful']
	);
});

test('an invalid warmup is persisted and stops before baseline wait or measured launches', async () => {
	const fixture = await createFixture();
	let launchCount = 0;
	let waited = false;
	const tournamentId = 'invalid-warmup-stop-test';
	const result = await runRuntimeTournament(
		await tournamentOptions(fixture, {
			quietBaselineMs: 25,
			requestedBlockCount: 7,
			tournamentId,
			warmupRunsPerCandidate: 1
		}),
		{
			runSingle: async options => {
				launchCount += 1;
				const candidateId = candidateIdForRun(
					fixture,
					options.candidateManifestPath
				);
				return {
					...successfulRunResult(options, candidateId),
					failures: [
						benchmarkFailure(
							'severe-event-loop-disturbance'
						)
					],
					valid: false
				};
			},
			wait: async () => {
				waited = true;
			}
		}
	);

	assert.equal(launchCount, 1);
	assert.equal(waited, false);
	assert.equal(result.runRecords.length, 1);
	assert.equal(result.runRecords[0].phase, 'warmup');
	assert.deepEqual(
		result.runRecords[0].failureReasons,
		[
			'severe-event-loop-disturbance',
			'benchmark-unsuccessful'
		]
	);
	assert.match(
		result.fatalError ?? '',
		/^Warmup run .* was invalid: severe-event-loop-disturbance\.$/u
	);
	const persisted = JSON.parse(await readFile(join(
		fixture.outputRootDirectory,
		tournamentId,
		'run-records.json'
	), 'utf8')) as { valid: boolean }[];
	assert.equal(persisted.length, 1);
	assert.equal(persisted[0]?.valid, false);
});

test('missing required headline metrics invalidate evidence without fabricating values', async () => {
	const fixture = await createFixture();
	let launchCount = 0;
	const result = await runRuntimeTournament(
		await tournamentOptions(fixture, {
			quietBaselineMs: 0,
			requestedBlockCount: 7,
			tournamentId: 'missing-metric-test',
			warmupRunsPerCandidate: 0
		}),
		{
			runSingle: async options => {
				launchCount += 1;
				const stream = {
					...headlineStream('candidate-a')
				};
				delete stream.averageFps;
				return {
					...successfulRunResult(
						options,
						'candidate-a'
					),
					headlineAnalysis: headlineAnalysis(
						'candidate-a',
						stream
					),
					headlineStream: stream
				};
			},
			wait: async () => undefined
		}
	);

	assert.equal(launchCount, 1);
	assert.equal(result.valid, false);
	assert.match(
		result.fatalError ?? '',
		/was invalid: tournament-metric-missing:average-fps\.$/u
	);
	assert.ok(
		result.runRecords[0]?.violations.includes(
			'tournament-metric-missing:average-fps'
		)
	);
	assert.equal(
		result.analyses[0].unavailableReason,
		'No clean paired blocks were available.'
	);
});

test('single-run identity mismatches stop the tournament before another launch', async () => {
	const fixture = await createFixture();
	let launchCount = 0;
	const result = await runRuntimeTournament(
		await tournamentOptions(fixture, {
			quietBaselineMs: 0,
			requestedBlockCount: 7,
			tournamentId: 'identity-stop-test',
			warmupRunsPerCandidate: 0
		}),
		{
			runSingle: async options => {
				launchCount += 1;
				const candidateId = candidateIdForRun(
					fixture,
					options.candidateManifestPath
				);
				return {
					...successfulRunResult(
						options,
						candidateId
					),
					runId: 'wrong-run-id'
				};
			},
			wait: async () => undefined
		}
	);

	assert.equal(launchCount, 1);
	assert.equal(result.valid, false);
	assert.match(
		result.fatalError ?? '',
		/result identity mismatch/u
	);
});

test('tournament stops immediately when verified candidate cleanup is uncertain', async () => {
	const fixture = await createFixture();
	let launchCount = 0;
	const result = await runRuntimeTournament(
		await tournamentOptions(fixture, {
			quietBaselineMs: 0,
			requestedBlockCount: 7,
			tournamentId: 'cleanup-stop-test',
			warmupRunsPerCandidate: 0
		}),
		{
			runSingle: async options => {
				launchCount += 1;
				const candidateId = candidateIdForRun(
					fixture,
					options.candidateManifestPath
				);
				return {
					...successfulRunResult(
						options,
						candidateId
					),
					cleanup: {
						orphanProcessIds: [4321]
					}
				};
			},
			wait: async () => undefined
		}
	);

	assert.equal(launchCount, 1);
	assert.equal(result.valid, false);
	assert.match(
		result.fatalError ?? '',
		/was invalid: tournament-cleanup-uncertain\.$/u
	);
	assert.deepEqual(
		result.runRecords[0].violations,
		['tournament-cleanup-uncertain']
	);
	assert.equal(
		result.analyses[0].unavailableReason,
		'No clean paired blocks were available.'
	);
});
