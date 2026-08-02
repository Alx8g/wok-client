import assert from 'node:assert/strict';
import {
	mkdir,
	mkdtemp,
	readFile,
	writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
	RUNTIME_TOURNAMENT_CONTROLLER_VERSION,
	type RuntimeTournamentResult,
	type RuntimeTournamentRunRecord
} from '../src/controller/tournament-controller.ts';
import {
	analyzeRuntimeTournamentMetric,
	buildRuntimeTournamentPairedBlocks,
	buildRuntimeTournamentPairAnalyses
} from '../src/controller/tournament-analysis.ts';
import {
	buildRuntimeTournamentNoiseFloorReport,
	deriveRuntimeTournamentNoiseFloorFile
} from '../src/controller/tournament-noise-floor.ts';
import {
	buildRuntimeTournamentSchedule
} from '../src/controller/tournament-schedule.ts';
import {
	RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION
} from '../src/controller/source-attestation.ts';
import {
	canonicalJson,
	sha256Hex
} from '../src/shared/hash.ts';
import {
	createAttestedNoiseFloorFixture,
	type AttestedNoiseFloorFixture
} from './attested-noise-floor-fixture.ts';

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

const executableSha256 = sha256Hex(
	'identical-runtime-binary'
);

const metricFixtures = [
	{
		direction: 'higher-is-better' as const,
		metricId: 'average-fps' as const,
		practicalMargin: 1
	},
	{
		direction: 'lower-is-better' as const,
		metricId: 'frame-time-p95-ms' as const,
		practicalMargin: 0.5
	},
	{
		direction: 'lower-is-better' as const,
		metricId: 'frame-time-p99-ms' as const,
		practicalMargin: 1
	},
	{
		direction: 'higher-is-better' as const,
		metricId: 'one-percent-low-fps' as const,
		practicalMargin: 2
	}
];

function buildResult(
	blockCount = 7
): RuntimeTournamentResult {
	const candidateIds = [
		'noise-lane-a',
		'noise-lane-b'
	];
	const schedule = buildRuntimeTournamentSchedule({
		candidateIds,
		requestedBlockCount: blockCount,
		seed: 'noise-floor-test-seed'
	});
	let sequenceIndex = 0;
	const runRecords: RuntimeTournamentRunRecord[] = [];
	for (const block of schedule.schedule.blocks) {
		for (const candidateId of block.order) {
			const baseline = candidateId === 'noise-lane-a';
			runRecords.push({
				blockIndex: block.blockIndex,
				candidateId,
				cycleIndex: block.cycleIndex,
				failureReasons: [],
				failures: [],
				metricValues: {
					'average-fps': baseline ? 100 : 102,
					'frame-time-p95-ms': baseline ? 10 : 9,
					'frame-time-p99-ms': baseline ? 15 : 13,
					'one-percent-low-fps': baseline ? 80 : 82
				},
				phase: 'measured',
				runDirectory:
					`C:\\evidence\\run-${sequenceIndex}`,
				runId: `noise-run-${sequenceIndex}`,
				sequenceIndex,
				valid: true,
				violations: []
			});
			sequenceIndex += 1;
		}
	}
	const analyses = metricFixtures.map(metric => {
		const observations = runRecords.map(record => ({
			blockId:
				`block-${String(record.blockIndex).padStart(4, '0')}`,
			candidateId: record.candidateId,
			valid: true,
			value: record.metricValues[metric.metricId]
		}));
		const paired = buildRuntimeTournamentPairedBlocks(
			observations,
			{
				baselineCandidateId: 'noise-lane-a',
				challengerCandidateId: 'noise-lane-b',
				expectedObservationsPerCandidate: 2
			}
		);
		const analysis = analyzeRuntimeTournamentMetric({
			baselineCandidateId: 'noise-lane-a',
			blocks: paired.blocks,
			bootstrapIterations: 1_000,
			challengerCandidateId: 'noise-lane-b',
			direction: metric.direction,
			noiseFloor: 0,
			practicalMargin: metric.practicalMargin,
			seed: `noise-floor-${metric.metricId}`
		});
		return {
			analysis,
			baselineCandidateId: 'noise-lane-a',
			challengerCandidateId: 'noise-lane-b',
			metricId: metric.metricId,
			paired
		};
	});
	const plannedRuns = runRecords.map(record => ({
		blockIndex: record.blockIndex,
		candidateId: record.candidateId,
		cycleIndex: record.cycleIndex,
		phase: record.phase,
		runId: record.runId,
		sequenceIndex: record.sequenceIndex
	}));
	const resultWithoutHash: Omit<
		RuntimeTournamentResult,
		'resultSha256'
	> = {
		analyses,
		analysisControls: {
			bootstrapIterations: 1_000,
			confidenceLevel: 0.95,
			minimumPairedBlocks: 7
		},
		candidateIds,
		candidateIdentities: [
			{
				executableSha256,
				id: 'noise-lane-a',
				manifestSha256: sha256Hex('manifest-a')
			},
			{
				executableSha256,
				id: 'noise-lane-b',
				manifestSha256: sha256Hex('manifest-b')
			}
		],
		completedAt: '2026-08-01T00:30:00.000Z',
		controllerSourceInventoryVersion:
			RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION,
		controllerSources: {},
		controllerVersion: RUNTIME_TOURNAMENT_CONTROLLER_VERSION,
		dryRunReport: {
			evidencePath: 'C:\\evidence\\noise\\dry-run-report.json',
			path: 'C:\\evidence\\preparations\\report.json',
			plannedRunsSha256: sha256Hex(
				canonicalJson(plannedRuns)
			),
			reportSha256: sha256Hex('dry-run-report'),
			version: 3
		},
		executionControls: {
			quietBaselineMs: 0,
			startupTimeoutMs: 15_000,
			warmupRunsPerCandidate: 0
		},
		executionMode: 'attested-runtime',
		plannedRuns,
		runRecords,
		scenarioId: 'tier1-calibration-v1',
		schedule,
		startedAt: '2026-08-01T00:00:00.000Z',
		tournamentDirectory: 'C:\\evidence\\noise',
		tournamentId: 'noise-floor-test',
		valid: true
	};
	return {
		...resultWithoutHash,
		resultSha256: sha256Hex(
			canonicalJson(resultWithoutHash)
		)
	};
}

function rehashResult(
	result: RuntimeTournamentResult
): RuntimeTournamentResult {
	const {
		resultSha256: _oldHash,
		...withoutHash
	} = result;
	return {
		...withoutHash,
		resultSha256: sha256Hex(
			canonicalJson(withoutHash)
		)
	};
}

async function rewriteJsonArtifact(
	path: string,
	value: unknown
): Promise<{ path: string; sha256: string; sizeBytes: number }> {
	const bytes = Buffer.from(
		`${JSON.stringify(value, null, '\t')}\n`,
		'utf8'
	);
	await writeFile(path, bytes);
	return {
		path,
		sha256: sha256Hex(bytes),
		sizeBytes: bytes.byteLength
	};
}

async function rewriteCompactCrLfJsonArtifact(
	path: string,
	value: unknown
): Promise<{ path: string; sha256: string; sizeBytes: number }> {
	const bytes = Buffer.from(
		`${JSON.stringify(value)}\r\n`,
		'utf8'
	);
	await writeFile(path, bytes);
	return {
		path,
		sha256: sha256Hex(bytes),
		sizeBytes: bytes.byteLength
	};
}

async function copyArtifactBytes(
	sourcePath: string,
	targetPath: string
): Promise<{ path: string; sha256: string; sizeBytes: number }> {
	const bytes = await readFile(sourcePath);
	await writeFile(targetPath, bytes);
	return {
		path: targetPath,
		sha256: sha256Hex(bytes),
		sizeBytes: bytes.byteLength
	};
}

async function persistFixtureResult(
	fixture: AttestedNoiseFloorFixture,
	result: RuntimeTournamentResult,
	syncRunRecords = true
): Promise<void> {
	const rehashed = rehashResult(result);
	if (syncRunRecords) {
		await writeFile(
			join(
			rehashed.tournamentDirectory,
			'run-records.json'
			),
			`${JSON.stringify(rehashed.runRecords, null, '\t')}\n`
		);
	}
	await writeFile(
		fixture.tournamentResultPath,
		`${JSON.stringify(rehashed, null, '\t')}\n`
	);
}

test('same-build report derives a content-addressed compatible metric policy', () => {
	const report = buildRuntimeTournamentNoiseFloorReport(
		buildResult()
	);
	assert.deepEqual(report.candidateIds, [
		'noise-lane-a',
		'noise-lane-b'
	]);
	assert.equal(report.executableSha256, executableSha256);
	assert.equal(report.metrics.length, metricFixtures.length);
	const averageFpsMetric = report.metrics.find(
		metric => metric.metricId === 'average-fps'
	);
	assert.ok(averageFpsMetric);
	assert.equal(averageFpsMetric.blockCount, 7);
	assert.equal(averageFpsMetric.noiseFloor, 2);
	assert.equal(
		report.metricPolicies.length,
		metricFixtures.length
	);
	assert.deepEqual(
		report.metricPolicies.find(
			policy => policy.metricId === 'average-fps'
		),
		{
			direction: 'higher-is-better',
			metricId: 'average-fps',
			noiseFloor: 2,
			practicalMargin: 1
		}
	);
	const {
		reportSha256,
		...withoutHash
	} = report;
	assert.equal(
		reportSha256,
		sha256Hex(canonicalJson(withoutHash))
	);
});

test('noise-floor evidence rejects different executables, tampering and insufficient blocks', () => {
	const mismatched = buildResult();
	mismatched.candidateIdentities[1] = {
		...mismatched.candidateIdentities[1],
		executableSha256: sha256Hex('different-runtime')
	};
	assert.throws(
		() => buildRuntimeTournamentNoiseFloorReport(
			rehashResult(mismatched)
		),
		/identical executable/u
	);

	const tampered = buildResult();
	tampered.runRecords[0].metricValues['average-fps'] =
		999;
	assert.throws(
		() => buildRuntimeTournamentNoiseFloorReport(
			tampered
		),
		/result SHA-256 does not match/u
	);

	assert.throws(
		() => buildRuntimeTournamentNoiseFloorReport(
			buildResult(),
			{ minimumPairedBlocks: 6 }
		),
		/from 7 through 1,000/u
	);
	assert.throws(
		() => buildRuntimeTournamentNoiseFloorReport(
			buildResult(),
			{ minimumPairedBlocks: 8 }
		),
		/at least 8 are required/u
	);

	const injected = buildResult();
	injected.executionMode = 'injected-test';
	assert.throws(
		() => buildRuntimeTournamentNoiseFloorReport(
			rehashResult(injected)
		),
		/requires a complete attested-runtime tournament/iu
	);
});

test('noise-floor derivation rejects altered result, dry-run copy, plan order and injected execution', async () => {
	const directory = await mkdtemp(
		join(testOutputRoot, 'noise-floor-adversarial-')
	);

	const alteredResultFixture =
		await createAttestedNoiseFloorFixture(
			join(directory, 'altered-result')
		);
	await writeFile(
		alteredResultFixture.tournamentResultPath,
		JSON.stringify({
			...alteredResultFixture.tournamentResult,
			tournamentId: 'altered-result-id'
		})
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'altered-result.json'),
			tournamentResultPath:
				alteredResultFixture.tournamentResultPath
		}),
		/result SHA-256 does not match/iu
	);

	const alteredDryRunFixture =
		await createAttestedNoiseFloorFixture(
			join(directory, 'altered-dry-run')
		);
	await writeFile(
		alteredDryRunFixture.tournamentResult.dryRunReport
			.evidencePath,
		'altered dry-run evidence'
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'altered-dry-run.json'),
			tournamentResultPath:
				alteredDryRunFixture.tournamentResultPath
		}),
		/not the exact verified report/iu
	);

	const forgedMarginFixture =
		await createAttestedNoiseFloorFixture(
			join(directory, 'forged-margin')
		);
	const forgedMarginResult = structuredClone(
		forgedMarginFixture.tournamentResult
	);
	const forgedMarginEntry = forgedMarginResult.analyses.find(
		entry => entry.metricId === 'average-fps'
	);
	assert.ok(forgedMarginEntry?.analysis);
	forgedMarginEntry.analysis = analyzeRuntimeTournamentMetric({
		baselineCandidateId:
			forgedMarginEntry.baselineCandidateId,
		blocks: forgedMarginEntry.paired.blocks,
		bootstrapIterations:
			forgedMarginResult.analysisControls.bootstrapIterations,
		challengerCandidateId:
			forgedMarginEntry.challengerCandidateId,
		confidenceLevel:
			forgedMarginResult.analysisControls.confidenceLevel,
		direction: forgedMarginEntry.analysis.direction,
		minimumPairedBlocks:
			forgedMarginResult.analysisControls.minimumPairedBlocks,
		noiseFloor: forgedMarginEntry.analysis.noiseFloor,
		practicalMargin: 999,
		reliabilityFailures:
			forgedMarginEntry.analysis.reliabilityFailures,
		seed: forgedMarginEntry.analysis.seed
	});
	await writeFile(
		forgedMarginFixture.tournamentResultPath,
		JSON.stringify(rehashResult(forgedMarginResult))
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'forged-margin.json'),
			tournamentResultPath:
				forgedMarginFixture.tournamentResultPath
		}),
		/analyses do not reproduce from the verified dry-run controls/iu
	);

	const planMismatchFixture =
		await createAttestedNoiseFloorFixture(
			join(directory, 'plan-mismatch')
		);
	const planMismatch = structuredClone(
		planMismatchFixture.tournamentResult
	);
	const firstRecord = planMismatch.runRecords[0];
	assert.ok(firstRecord);
	const replacementCandidateId =
		planMismatch.candidateIds.find(
			candidateId =>
				candidateId !== firstRecord.candidateId
		);
	assert.ok(replacementCandidateId);
	firstRecord.candidateId = replacementCandidateId;
	await writeFile(
		planMismatchFixture.tournamentResultPath,
		JSON.stringify(rehashResult(planMismatch))
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'plan-mismatch.json'),
			tournamentResultPath:
				planMismatchFixture.tournamentResultPath
		}),
		/do not execute the verified plan exactly/iu
	);

	const injectedFixture =
		await createAttestedNoiseFloorFixture(
			join(directory, 'injected-result')
		);
	const injectedResult = structuredClone(
		injectedFixture.tournamentResult
	);
	injectedResult.executionMode = 'injected-test';
	await writeFile(
		injectedFixture.tournamentResultPath,
		JSON.stringify(rehashResult(injectedResult))
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'injected-result.json'),
			tournamentResultPath:
				injectedFixture.tournamentResultPath
		}),
		/requires a complete attested-runtime tournament/iu
	);
});

test('noise-floor evidence independently verifies process lifetimes and executed inspector identity', async () => {
	const directory = await mkdtemp(
		join(testOutputRoot, 'noise-floor-lifetime-adversarial-')
	);

	const missingLifetimeFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'missing-lifetime')
	);
	const missingLifetimeResult = structuredClone(
		missingLifetimeFixture.tournamentResult
	);
	const missingLifetimeRecord = missingLifetimeResult.runRecords[0];
	assert.ok(missingLifetimeRecord);
	delete missingLifetimeRecord.etlProcessLifetimeEvidence;
	await persistFixtureResult(
		missingLifetimeFixture,
		missingLifetimeResult
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'missing-lifetime.json'),
			tournamentResultPath:
				missingLifetimeFixture.tournamentResultPath
		}),
		/ETL process-lifetime evidence must be an object/iu
	);

	const changedLifetimeBytesFixture =
		await createAttestedNoiseFloorFixture(
			join(directory, 'changed-lifetime-bytes')
		);
	const changedLifetimeRecord =
		changedLifetimeBytesFixture.tournamentResult.runRecords[0];
	assert.ok(changedLifetimeRecord?.etlProcessLifetimeEvidence);
	await writeFile(
		changedLifetimeRecord.etlProcessLifetimeEvidence.path,
		'changed lifetime bytes'
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'changed-lifetime-bytes.json'),
			tournamentResultPath:
				changedLifetimeBytesFixture.tournamentResultPath
		}),
		/size changed after acceptance/iu
	);

	const wrongLifetimeFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'wrong-lifetime')
	);
	const wrongLifetimeResult = structuredClone(
		wrongLifetimeFixture.tournamentResult
	);
	const wrongLifetimeRecord = wrongLifetimeResult.runRecords[0];
	assert.ok(
		wrongLifetimeRecord?.etlProcessLifetimeEvidence
		&& wrongLifetimeRecord.presentMonProcessLifetimeBinding
	);
	const wrongLifetimeArtifact = JSON.parse(
		await readFile(
			wrongLifetimeRecord.etlProcessLifetimeEvidence.path,
			'utf8'
		)
	) as {
		lifetimes: Array<{ creationTimeUtcTicks: string }>;
	};
	const wrongLifetime = wrongLifetimeArtifact.lifetimes[0];
	assert.ok(wrongLifetime);
	wrongLifetime.creationTimeUtcTicks = (
		BigInt(
			wrongLifetimeRecord
				.presentMonProcessLifetimeBinding
				.creationTimeUtcTicks
		) + 10n
	).toString(10);
	wrongLifetimeRecord.etlProcessLifetimeEvidence =
		await rewriteJsonArtifact(
			wrongLifetimeRecord.etlProcessLifetimeEvidence.path,
			wrongLifetimeArtifact
		);
	await persistFixtureResult(wrongLifetimeFixture, wrongLifetimeResult);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'wrong-lifetime.json'),
			tournamentResultPath:
				wrongLifetimeFixture.tournamentResultPath
		}),
		/does not reproduce from the exact accepted ETL process events/iu
	);

	const bindingCopyFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'binding-copy-mismatch')
	);
	const bindingCopyResult = structuredClone(
		bindingCopyFixture.tournamentResult
	);
	const bindingCopyRecord = bindingCopyResult.runRecords[0];
	assert.ok(
		bindingCopyRecord?.presentMonProcessLifetimeBinding
		&& bindingCopyRecord.presentMonProcessLifetimeBindingEvidence
	);
	const changedBindingCopy = {
		...bindingCopyRecord.presentMonProcessLifetimeBinding,
		streamKey:
			`${bindingCopyRecord.presentMonProcessLifetimeBinding.streamKey}-changed`
	};
	bindingCopyRecord.presentMonProcessLifetimeBindingEvidence =
		await rewriteJsonArtifact(
			bindingCopyRecord.presentMonProcessLifetimeBindingEvidence.path,
			changedBindingCopy
		);
	await persistFixtureResult(bindingCopyFixture, bindingCopyResult);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'binding-copy-mismatch.json'),
			tournamentResultPath:
				bindingCopyFixture.tournamentResultPath
		}),
		/embedded PresentMon binding does not match its exact artifact/iu
	);

	const streamMismatchFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'stream-mismatch')
	);
	const streamMismatchResult = structuredClone(
		streamMismatchFixture.tournamentResult
	);
	const streamMismatchRecord = streamMismatchResult.runRecords[0];
	assert.ok(
		streamMismatchRecord?.presentMonProcessLifetimeBinding
		&& streamMismatchRecord.presentMonProcessLifetimeBindingEvidence
	);
	const streamMismatchBinding = {
		...streamMismatchRecord.presentMonProcessLifetimeBinding,
		streamKey: 'pid:999999/swapchain:0xdifferent'
	};
	streamMismatchRecord.presentMonProcessLifetimeBinding =
		streamMismatchBinding;
	streamMismatchRecord.presentMonProcessLifetimeBindingEvidence =
		await rewriteJsonArtifact(
			streamMismatchRecord.presentMonProcessLifetimeBindingEvidence.path,
			streamMismatchBinding
		);
	await persistFixtureResult(
		streamMismatchFixture,
		streamMismatchResult
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'stream-mismatch.json'),
			tournamentResultPath:
				streamMismatchFixture.tournamentResultPath
		}),
		/does not match the selected headline stream/iu
	);

	const sampleMismatchFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'sample-mismatch')
	);
	const sampleMismatchResult = structuredClone(
		sampleMismatchFixture.tournamentResult
	);
	const sampleMismatchRecord = sampleMismatchResult.runRecords[0];
	assert.ok(
		sampleMismatchRecord?.presentMonProcessLifetimeBinding
		&& sampleMismatchRecord.presentMonProcessLifetimeBindingEvidence
	);
	const sampleMismatchBinding = {
		...sampleMismatchRecord.presentMonProcessLifetimeBinding,
		executablePath: join(
			'C:\\different-runtime',
			sampleMismatchRecord.presentMonProcessLifetimeBinding
				.executableName
		)
	};
	sampleMismatchRecord.presentMonProcessLifetimeBinding =
		sampleMismatchBinding;
	sampleMismatchRecord.presentMonProcessLifetimeBindingEvidence =
		await rewriteJsonArtifact(
			sampleMismatchRecord.presentMonProcessLifetimeBindingEvidence.path,
			sampleMismatchBinding
		);
	await persistFixtureResult(
		sampleMismatchFixture,
		sampleMismatchResult
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'sample-mismatch.json'),
			tournamentResultPath:
				sampleMismatchFixture.tournamentResultPath
		}),
		/does not match the planned candidate and sampled presenting process/iu
	);

	const rewrittenMetricsFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'rewritten-metrics')
	);
	const rewrittenMetricsResult = structuredClone(
		rewrittenMetricsFixture.tournamentResult
	);
	const rewrittenMetricsRecord = rewrittenMetricsResult.runRecords[0];
	assert.ok(rewrittenMetricsRecord);
	rewrittenMetricsRecord.metricValues['average-fps'] =
		(rewrittenMetricsRecord.metricValues['average-fps'] ?? 0) + 25;
	const rewrittenMetricsDryRun = JSON.parse(
		await readFile(
			rewrittenMetricsResult.dryRunReport.evidencePath,
			'utf8'
		)
	) as {
		metricPolicy: {
			metricPolicies: Parameters<
				typeof buildRuntimeTournamentPairAnalyses
			>[0]['metricPolicies'];
		};
		seed: string;
	};
	rewrittenMetricsResult.analyses =
		buildRuntimeTournamentPairAnalyses({
			analysisControls: rewrittenMetricsResult.analysisControls,
			candidateIds: rewrittenMetricsResult.candidateIds,
			metricPolicies:
				rewrittenMetricsDryRun.metricPolicy.metricPolicies,
			runRecords: rewrittenMetricsResult.runRecords,
			seed: rewrittenMetricsDryRun.seed
		});
	await persistFixtureResult(
		rewrittenMetricsFixture,
		rewrittenMetricsResult
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'rewritten-metrics.json'),
			tournamentResultPath:
				rewrittenMetricsFixture.tournamentResultPath
		}),
		/metric values do not reproduce from the selected headline stream/iu
	);

	const inspectorMismatchFixture =
		await createAttestedNoiseFloorFixture(
			join(directory, 'inspector-mismatch')
		);
	const inspectorMismatchResult = structuredClone(
		inspectorMismatchFixture.tournamentResult
	);
	const inspectorMismatchRecord = inspectorMismatchResult.runRecords[0];
	const inspectorIdentity = inspectorMismatchRecord
		?.executionIdentities?.etlProcessInspector;
	assert.ok(inspectorIdentity && inspectorMismatchRecord.etlEvidence);
	inspectorIdentity.executable.sha256 = 'f'.repeat(64);
	const inspectorProcessEvents = JSON.parse(
		await readFile(
			inspectorMismatchRecord.etlEvidence.processEventArtifact.path,
			'utf8'
		)
	) as {
		inspectorProcessIdentity: {
			executable: { sha256: string };
		};
	};
	inspectorProcessEvents.inspectorProcessIdentity.executable.sha256 =
		'f'.repeat(64);
	inspectorMismatchRecord.etlEvidence.processEventArtifact =
		await rewriteCompactCrLfJsonArtifact(
			inspectorMismatchRecord.etlEvidence.processEventArtifact.path,
			inspectorProcessEvents
		);
	await persistFixtureResult(
		inspectorMismatchFixture,
		inspectorMismatchResult
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'inspector-mismatch.json'),
			tournamentResultPath:
				inspectorMismatchFixture.tournamentResultPath
		}),
		/does not match the dry-run recorder attestation/iu
	);

	const embeddedInspectorMismatchFixture =
		await createAttestedNoiseFloorFixture(
			join(directory, 'embedded-inspector-mismatch')
		);
	const embeddedInspectorMismatchResult = structuredClone(
		embeddedInspectorMismatchFixture.tournamentResult
	);
	const embeddedInspectorMismatchRecord =
		embeddedInspectorMismatchResult.runRecords[0];
	assert.ok(embeddedInspectorMismatchRecord?.etlEvidence);
	const embeddedInspectorProcessEvents = JSON.parse(
		await readFile(
			embeddedInspectorMismatchRecord.etlEvidence
				.processEventArtifact.path,
			'utf8'
		)
	) as {
		inspectorProcessIdentity: {
			executable: { sha256: string };
		};
	};
	embeddedInspectorProcessEvents.inspectorProcessIdentity
		.executable.sha256 = 'f'.repeat(64);
	embeddedInspectorMismatchRecord.etlEvidence.processEventArtifact =
		await rewriteCompactCrLfJsonArtifact(
			embeddedInspectorMismatchRecord.etlEvidence
				.processEventArtifact.path,
			embeddedInspectorProcessEvents
		);
	await persistFixtureResult(
		embeddedInspectorMismatchFixture,
		embeddedInspectorMismatchResult
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(
				directory,
				'embedded-inspector-mismatch.json'
			),
			tournamentResultPath:
				embeddedInspectorMismatchFixture.tournamentResultPath
		}),
		/does not match its executed inspector identity/iu
	);

	const swappedInspectorFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'swapped-inspector-identity')
	);
	const swappedInspectorResult = structuredClone(
		swappedInspectorFixture.tournamentResult
	);
	const swappedInspectorTarget = swappedInspectorResult.runRecords[0];
	const swappedInspectorSource = swappedInspectorResult.runRecords[1];
	assert.ok(
		swappedInspectorTarget?.executionIdentities
			?.etlProcessInspector
		&& swappedInspectorSource?.executionIdentities
			?.etlProcessInspector
	);
	swappedInspectorTarget.executionIdentities.etlProcessInspector =
		structuredClone(
			swappedInspectorSource.executionIdentities.etlProcessInspector
		);
	await persistFixtureResult(
		swappedInspectorFixture,
		swappedInspectorResult
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'swapped-inspector-identity.json'),
			tournamentResultPath:
				swappedInspectorFixture.tournamentResultPath
		}),
		/does not match its executed inspector identity/iu
	);

	const inspectorInvocationMismatchFixture =
		await createAttestedNoiseFloorFixture(
			join(directory, 'inspector-invocation-mismatch')
		);
	const inspectorInvocationMismatchResult = structuredClone(
		inspectorInvocationMismatchFixture.tournamentResult
	);
	const inspectorInvocationMismatchRecord =
		inspectorInvocationMismatchResult.runRecords[0];
	assert.ok(inspectorInvocationMismatchRecord?.etlEvidence);
	const inspectorInvocationProcessEvents = JSON.parse(
		await readFile(
			inspectorInvocationMismatchRecord.etlEvidence
				.processEventArtifact.path,
			'utf8'
		)
	) as { inspectionInvocation: { runId: string } };
	inspectorInvocationProcessEvents.inspectionInvocation.runId =
		'different-run';
	inspectorInvocationMismatchRecord.etlEvidence.processEventArtifact =
		await rewriteCompactCrLfJsonArtifact(
			inspectorInvocationMismatchRecord.etlEvidence
				.processEventArtifact.path,
			inspectorInvocationProcessEvents
		);
	await persistFixtureResult(
		inspectorInvocationMismatchFixture,
		inspectorInvocationMismatchResult
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(
				directory,
				'inspector-invocation-mismatch.json'
			),
			tournamentResultPath:
				inspectorInvocationMismatchFixture.tournamentResultPath
		}),
		/inspection invocation is not bound to the planned run, accepted ETL, and target process/iu
	);

	const inspectorTargetMismatchFixture =
		await createAttestedNoiseFloorFixture(
			join(directory, 'inspector-target-mismatch')
		);
	const inspectorTargetMismatchResult = structuredClone(
		inspectorTargetMismatchFixture.tournamentResult
	);
	const inspectorTargetMismatchRecord =
		inspectorTargetMismatchResult.runRecords[0];
	assert.ok(inspectorTargetMismatchRecord?.etlEvidence);
	const inspectorTargetProcessEvents = JSON.parse(
		await readFile(
			inspectorTargetMismatchRecord.etlEvidence
				.processEventArtifact.path,
			'utf8'
		)
	) as {
		events: Array<{ processId: number }>;
		inspectionInvocation: { targetProcessId: number };
		targetProcessId: number;
	};
	inspectorTargetProcessEvents.targetProcessId += 1;
	inspectorTargetProcessEvents.inspectionInvocation.targetProcessId =
		inspectorTargetProcessEvents.targetProcessId;
	for (const event of inspectorTargetProcessEvents.events) {
		event.processId = inspectorTargetProcessEvents.targetProcessId;
	}
	inspectorTargetMismatchRecord.etlEvidence.processEventArtifact =
		await rewriteCompactCrLfJsonArtifact(
			inspectorTargetMismatchRecord.etlEvidence
				.processEventArtifact.path,
			inspectorTargetProcessEvents
		);
	await persistFixtureResult(
		inspectorTargetMismatchFixture,
		inspectorTargetMismatchResult
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'inspector-target-mismatch.json'),
			tournamentResultPath:
				inspectorTargetMismatchFixture.tournamentResultPath
		}),
		/inspection invocation is not bound to the planned run, accepted ETL, and target process/iu
	);

	const reusedInspectorFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'reused-inspector-lifetime')
	);
	const reusedInspectorResult = structuredClone(
		reusedInspectorFixture.tournamentResult
	);
	const reusedInspectorSource = reusedInspectorResult.runRecords[0];
	const reusedInspectorTarget = reusedInspectorResult.runRecords[1];
	const reusedInspectorIdentity = reusedInspectorSource
		?.executionIdentities?.etlProcessInspector;
	assert.ok(
		reusedInspectorIdentity
		&& reusedInspectorTarget?.executionIdentities?.etlProcessInspector
		&& reusedInspectorTarget.etlEvidence
	);
	reusedInspectorTarget.executionIdentities.etlProcessInspector =
		structuredClone(reusedInspectorIdentity);
	const reusedInspectorProcessEvents = JSON.parse(
		await readFile(
			reusedInspectorTarget.etlEvidence.processEventArtifact.path,
			'utf8'
		)
	) as { inspectorProcessIdentity: typeof reusedInspectorIdentity };
	reusedInspectorProcessEvents.inspectorProcessIdentity =
		structuredClone(reusedInspectorIdentity);
	reusedInspectorTarget.etlEvidence.processEventArtifact =
		await rewriteCompactCrLfJsonArtifact(
			reusedInspectorTarget.etlEvidence.processEventArtifact.path,
			reusedInspectorProcessEvents
		);
	assert.ok(
		reusedInspectorTarget.etlProcessLifetimeEvidence
		&& reusedInspectorTarget.presentMonProcessLifetimeBinding
		&& reusedInspectorTarget.presentMonProcessLifetimeBindingEvidence
	);
	const reusedInspectorProcessEventSha256 =
		reusedInspectorTarget.etlEvidence.processEventArtifact.sha256;
	const reusedInspectorLifetime = JSON.parse(
		await readFile(
			reusedInspectorTarget.etlProcessLifetimeEvidence.path,
			'utf8'
		)
	) as { processEventEvidenceSha256: string };
	reusedInspectorLifetime.processEventEvidenceSha256 =
		reusedInspectorProcessEventSha256;
	reusedInspectorTarget.etlProcessLifetimeEvidence =
		await rewriteJsonArtifact(
			reusedInspectorTarget.etlProcessLifetimeEvidence.path,
			reusedInspectorLifetime
		);
	const reusedInspectorBinding = {
		...reusedInspectorTarget.presentMonProcessLifetimeBinding,
		processEventEvidenceSha256: reusedInspectorProcessEventSha256
	};
	reusedInspectorTarget.presentMonProcessLifetimeBinding =
		reusedInspectorBinding;
	reusedInspectorTarget.presentMonProcessLifetimeBindingEvidence =
		await rewriteJsonArtifact(
			reusedInspectorTarget
				.presentMonProcessLifetimeBindingEvidence.path,
			reusedInspectorBinding
		);
	await persistFixtureResult(
		reusedInspectorFixture,
		reusedInspectorResult
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'reused-inspector-lifetime.json'),
			tournamentResultPath:
				reusedInspectorFixture.tournamentResultPath
		}),
		/reuse a creation-qualified ETL process inspector identity/iu
	);

	const divergentRecordsFixture =
		await createAttestedNoiseFloorFixture(
			join(directory, 'divergent-run-records')
		);
	await writeFile(
		join(
			divergentRecordsFixture.tournamentResult.tournamentDirectory,
			'run-records.json'
		),
		'[]\n'
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'divergent-run-records.json'),
			tournamentResultPath:
				divergentRecordsFixture.tournamentResultPath
		}),
		/run-record evidence does not match the result records/iu
	);

	const crossRunFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'cross-run-artifact')
	);
	const crossRunResult = structuredClone(
		crossRunFixture.tournamentResult
	);
	const firstCrossRunRecord = crossRunResult.runRecords[0];
	const secondCrossRunRecord = crossRunResult.runRecords[1];
	assert.ok(
		firstCrossRunRecord
		&& secondCrossRunRecord?.etlProcessLifetimeEvidence
	);
	firstCrossRunRecord.etlProcessLifetimeEvidence =
		secondCrossRunRecord.etlProcessLifetimeEvidence;
	await persistFixtureResult(crossRunFixture, crossRunResult);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'cross-run-artifact.json'),
			tournamentResultPath:
				crossRunFixture.tournamentResultPath
		}),
		/not the expected run artifact path/iu
	);

	const oldVersionFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'old-controller-version')
	);
	const oldVersionResult = structuredClone(
		oldVersionFixture.tournamentResult
	);
	(oldVersionResult as { controllerVersion: number }).controllerVersion = 5;
	await persistFixtureResult(oldVersionFixture, oldVersionResult);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'old-controller-version.json'),
			tournamentResultPath:
				oldVersionFixture.tournamentResultPath
		}),
		/controller version is not accepted/iu
	);
});

test('noise-floor evidence anchors derived lifetimes to raw ETL artifacts and the planned candidate', async () => {
	const directory = await mkdtemp(
		join(testOutputRoot, 'noise-floor-raw-etl-adversarial-')
	);

	const missingStartFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'missing-process-start')
	);
	const missingStartResult = structuredClone(
		missingStartFixture.tournamentResult
	);
	const missingStartRecord = missingStartResult.runRecords[0];
	assert.ok(missingStartRecord?.etlEvidence);
	const missingStartEvents = JSON.parse(
		await readFile(
			missingStartRecord.etlEvidence.processEventArtifact.path,
			'utf8'
		)
	) as { events: unknown[] };
	missingStartEvents.events = [];
	missingStartRecord.etlEvidence.processEventArtifact =
		await rewriteCompactCrLfJsonArtifact(
			missingStartRecord.etlEvidence.processEventArtifact.path,
			missingStartEvents
		);
	await persistFixtureResult(missingStartFixture, missingStartResult);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'missing-process-start.json'),
			tournamentResultPath:
				missingStartFixture.tournamentResultPath
		}),
		/exactly one selected process lifetime/iu
	);

	const changedCaptureFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'changed-capture-bytes')
	);
	const changedCaptureRecord =
		changedCaptureFixture.tournamentResult.runRecords[0];
	assert.ok(changedCaptureRecord?.etlEvidence);
	const changedCaptureBytes = Buffer.from(
		await readFile(changedCaptureRecord.etlEvidence.captureArtifact.path)
	);
	changedCaptureBytes[0] = (changedCaptureBytes[0] ?? 0) ^ 0xff;
	await writeFile(
		changedCaptureRecord.etlEvidence.captureArtifact.path,
		changedCaptureBytes
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'changed-capture-bytes.json'),
			tournamentResultPath:
				changedCaptureFixture.tournamentResultPath
		}),
		/accepted ETL capture does not match its accepted SHA-256/iu
	);

	const changedReadyFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'changed-ready-sidecar')
	);
	const changedReadyResult = structuredClone(
		changedReadyFixture.tournamentResult
	);
	const changedReadyRecord = changedReadyResult.runRecords[0];
	assert.ok(changedReadyRecord?.etlEvidence);
	const changedReadySidecar = JSON.parse(
		await readFile(
			changedReadyRecord.etlEvidence.readySidecarArtifact.path,
			'utf8'
		)
	) as { durationMs: number };
	changedReadySidecar.durationMs += 1;
	changedReadyRecord.etlEvidence.readySidecarArtifact =
		await rewriteCompactCrLfJsonArtifact(
			changedReadyRecord.etlEvidence.readySidecarArtifact.path,
			changedReadySidecar
		);
	await persistFixtureResult(changedReadyFixture, changedReadyResult);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'changed-ready-sidecar.json'),
			tournamentResultPath:
				changedReadyFixture.tournamentResultPath
		}),
		/ETL recorder pair is not acceptable:.*duration/iu
	);

	const changedStatusFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'changed-status-sidecar')
	);
	const changedStatusResult = structuredClone(
		changedStatusFixture.tournamentResult
	);
	const changedStatusRecord = changedStatusResult.runRecords[0];
	assert.ok(changedStatusRecord?.etlEvidence);
	const changedStatusSidecar = JSON.parse(
		await readFile(
			changedStatusRecord.etlEvidence.statusSidecarArtifact.path,
			'utf8'
		)
	) as { etlSizeBytes: number };
	changedStatusSidecar.etlSizeBytes += 1;
	changedStatusRecord.etlEvidence.statusSidecarArtifact =
		await rewriteCompactCrLfJsonArtifact(
			changedStatusRecord.etlEvidence.statusSidecarArtifact.path,
			changedStatusSidecar
		);
	await persistFixtureResult(changedStatusFixture, changedStatusResult);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'changed-status-sidecar.json'),
			tournamentResultPath:
				changedStatusFixture.tournamentResultPath
		}),
		/accepted ETL identity does not match its sidecars and exact capture bytes/iu
	);

	const changedAcceptedCaptureFixture =
		await createAttestedNoiseFloorFixture(
			join(directory, 'changed-accepted-capture')
		);
	const changedAcceptedCaptureResult = structuredClone(
		changedAcceptedCaptureFixture.tournamentResult
	);
	const changedAcceptedCaptureRecord =
		changedAcceptedCaptureResult.runRecords[0];
	assert.ok(changedAcceptedCaptureRecord?.etlEvidence);
	changedAcceptedCaptureRecord.etlEvidence.acceptedCapture.etlSizeBytes += 1;
	await persistFixtureResult(
		changedAcceptedCaptureFixture,
		changedAcceptedCaptureResult
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'changed-accepted-capture.json'),
			tournamentResultPath:
				changedAcceptedCaptureFixture.tournamentResultPath
		}),
		/accepted ETL identity does not match its sidecars and exact capture bytes/iu
	);

	const wrongDurationFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'wrong-recorder-duration')
	);
	const wrongDurationResult = structuredClone(
		wrongDurationFixture.tournamentResult
	);
	const wrongDurationRecord = wrongDurationResult.runRecords[0];
	assert.ok(wrongDurationRecord?.etlEvidence);
	wrongDurationRecord.etlEvidence.recorderExpectedIdentity.durationMs += 1;
	await persistFixtureResult(wrongDurationFixture, wrongDurationResult);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'wrong-recorder-duration.json'),
			tournamentResultPath:
				wrongDurationFixture.tournamentResultPath
		}),
		/recorder duration is not derived from the verified scenario/iu
	);

	const wrongPathFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'wrong-recorder-path')
	);
	const wrongPathResult = structuredClone(
		wrongPathFixture.tournamentResult
	);
	const wrongPathRecord = wrongPathResult.runRecords[0];
	assert.ok(wrongPathRecord?.etlEvidence);
	wrongPathRecord.etlEvidence.recorderExpectedIdentity.etlPath =
		String.raw`C:\runtime-lab\wrong\captures\presentmon.etl`;
	await persistFixtureResult(wrongPathFixture, wrongPathResult);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'wrong-recorder-path.json'),
			tournamentResultPath:
				wrongPathFixture.tournamentResultPath
		}),
		/recorder identity is not bound to the planned run artifacts/iu
	);

	const substitutedArtifactFixture =
		await createAttestedNoiseFloorFixture(
			join(directory, 'substituted-ready-artifact')
		);
	const substitutedArtifactResult = structuredClone(
		substitutedArtifactFixture.tournamentResult
	);
	const substitutedArtifactTarget = substitutedArtifactResult.runRecords[0];
	const substitutedArtifactSource = substitutedArtifactResult.runRecords[1];
	assert.ok(
		substitutedArtifactTarget?.etlEvidence
		&& substitutedArtifactSource?.etlEvidence
	);
	substitutedArtifactTarget.etlEvidence.readySidecarArtifact =
		substitutedArtifactSource.etlEvidence.readySidecarArtifact;
	await persistFixtureResult(
		substitutedArtifactFixture,
		substitutedArtifactResult
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'substituted-ready-artifact.json'),
			tournamentResultPath:
				substitutedArtifactFixture.tournamentResultPath
		}),
		/not the expected run artifact path/iu
	);

	const rewrittenDigestFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'rewritten-etl-digest')
	);
	const rewrittenDigestResult = structuredClone(
		rewrittenDigestFixture.tournamentResult
	);
	const rewrittenDigestRecord = rewrittenDigestResult.runRecords[0];
	assert.ok(
		rewrittenDigestRecord?.etlEvidence
		&& rewrittenDigestRecord.etlProcessLifetimeEvidence
		&& rewrittenDigestRecord.presentMonProcessLifetimeBinding
		&& rewrittenDigestRecord.presentMonProcessLifetimeBindingEvidence
	);
	const forgedEtlSha256 = 'f'.repeat(64);
	const rewrittenProcessEvents = JSON.parse(
		await readFile(
			rewrittenDigestRecord.etlEvidence.processEventArtifact.path,
			'utf8'
		)
	) as { etlSha256: string };
	rewrittenProcessEvents.etlSha256 = forgedEtlSha256;
	rewrittenDigestRecord.etlEvidence.processEventArtifact =
		await rewriteCompactCrLfJsonArtifact(
			rewrittenDigestRecord.etlEvidence.processEventArtifact.path,
			rewrittenProcessEvents
		);
	const rewrittenProcessEventSha256 =
		rewrittenDigestRecord.etlEvidence.processEventArtifact.sha256;
	const rewrittenStatus = JSON.parse(
		await readFile(
			rewrittenDigestRecord.etlEvidence.statusSidecarArtifact.path,
			'utf8'
		)
	) as { etlSha256: string };
	rewrittenStatus.etlSha256 = forgedEtlSha256;
	rewrittenDigestRecord.etlEvidence.statusSidecarArtifact =
		await rewriteCompactCrLfJsonArtifact(
			rewrittenDigestRecord.etlEvidence.statusSidecarArtifact.path,
			rewrittenStatus
		);
	const rewrittenLifetime = JSON.parse(
		await readFile(
			rewrittenDigestRecord.etlProcessLifetimeEvidence.path,
			'utf8'
		)
	) as {
		etlSha256: string;
		processEventEvidenceSha256: string;
	};
	rewrittenLifetime.etlSha256 = forgedEtlSha256;
	rewrittenLifetime.processEventEvidenceSha256 =
		rewrittenProcessEventSha256;
	rewrittenDigestRecord.etlProcessLifetimeEvidence =
		await rewriteJsonArtifact(
			rewrittenDigestRecord.etlProcessLifetimeEvidence.path,
			rewrittenLifetime
		);
	const rewrittenBinding = {
		...rewrittenDigestRecord.presentMonProcessLifetimeBinding,
		etlSha256: forgedEtlSha256,
		processEventEvidenceSha256: rewrittenProcessEventSha256
	};
	rewrittenDigestRecord.presentMonProcessLifetimeBinding =
		rewrittenBinding;
	rewrittenDigestRecord.presentMonProcessLifetimeBindingEvidence =
		await rewriteJsonArtifact(
			rewrittenDigestRecord
				.presentMonProcessLifetimeBindingEvidence.path,
			rewrittenBinding
		);
	rewrittenDigestRecord.etlEvidence.acceptedCapture.etlSha256 =
		forgedEtlSha256;
	rewrittenDigestRecord.etlEvidence.captureArtifact.sha256 =
		forgedEtlSha256;
	await persistFixtureResult(
		rewrittenDigestFixture,
		rewrittenDigestResult
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'rewritten-etl-digest.json'),
			tournamentResultPath:
				rewrittenDigestFixture.tournamentResultPath
		}),
		/accepted ETL capture does not match its accepted SHA-256/iu
	);

	const crossCandidateFixture = await createAttestedNoiseFloorFixture(
		join(directory, 'cross-candidate-copy')
	);
	const crossCandidateResult = structuredClone(
		crossCandidateFixture.tournamentResult
	);
	const targetRecord = crossCandidateResult.runRecords[0];
	const sourceRecord = crossCandidateResult.runRecords.find(
		record => record.candidateId !== targetRecord?.candidateId
	);
	assert.ok(
		targetRecord?.runDirectory
		&& targetRecord.etlEvidence
		&& sourceRecord?.etlEvidence
		&& sourceRecord.etlProcessLifetimeEvidence
		&& sourceRecord.executionIdentities
		&& sourceRecord.headlineStream
		&& sourceRecord.headlineStreamKey
		&& sourceRecord.presentingProcessId
		&& sourceRecord.presentMonProcessLifetimeBinding
		&& sourceRecord.presentMonProcessLifetimeBindingEvidence
	);
	const targetCapturesDirectory = join(
		targetRecord.runDirectory,
		'captures'
	);
	const [
		copiedCapture,
		copiedProcessEvents,
		copiedReady,
		copiedStatus,
		copiedLifetime,
		copiedBinding
	] = await Promise.all([
		copyArtifactBytes(
			sourceRecord.etlEvidence.captureArtifact.path,
			join(targetCapturesDirectory, 'presentmon.etl')
		),
		copyArtifactBytes(
			sourceRecord.etlEvidence.processEventArtifact.path,
			join(targetCapturesDirectory, 'etl-process-events.json')
		),
		copyArtifactBytes(
			sourceRecord.etlEvidence.readySidecarArtifact.path,
			join(targetCapturesDirectory, 'etl-recorder-ready.json')
		),
		copyArtifactBytes(
			sourceRecord.etlEvidence.statusSidecarArtifact.path,
			join(targetCapturesDirectory, 'etl-recorder-status.json')
		),
		copyArtifactBytes(
			sourceRecord.etlProcessLifetimeEvidence.path,
			join(targetCapturesDirectory, 'etl-process-lifetimes.json')
		),
		copyArtifactBytes(
			sourceRecord.presentMonProcessLifetimeBindingEvidence.path,
			join(
				targetCapturesDirectory,
				'presentmon-headline-process-lifetime-binding.json'
			)
		)
	]);
	targetRecord.etlEvidence = {
		acceptedCapture: sourceRecord.etlEvidence.acceptedCapture,
		captureArtifact: copiedCapture,
		processEventArtifact: copiedProcessEvents,
		readySidecarArtifact: copiedReady,
		recorderExpectedIdentity:
			sourceRecord.etlEvidence.recorderExpectedIdentity,
		statusSidecarArtifact: copiedStatus
	};
	targetRecord.etlProcessLifetimeEvidence = copiedLifetime;
	targetRecord.executionIdentities = sourceRecord.executionIdentities;
	targetRecord.headlineStream = sourceRecord.headlineStream;
	targetRecord.headlineStreamKey = sourceRecord.headlineStreamKey;
	targetRecord.presentingProcessId = sourceRecord.presentingProcessId;
	targetRecord.presentMonProcessLifetimeBinding =
		sourceRecord.presentMonProcessLifetimeBinding;
	targetRecord.presentMonProcessLifetimeBindingEvidence = copiedBinding;
	await persistFixtureResult(
		crossCandidateFixture,
		crossCandidateResult
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath: join(directory, 'cross-candidate-copy.json'),
			tournamentResultPath:
				crossCandidateFixture.tournamentResultPath
		}),
		/recorder identity is not bound to the planned run artifacts/iu
	);
});

test('noise-floor file derivation writes once and refuses to overwrite evidence', async () => {
	const directory = await mkdtemp(
		join(testOutputRoot, 'noise-floor-file-')
	);
	const fixture = await createAttestedNoiseFloorFixture(
		join(directory, 'source')
	);
	const outputPath = join(directory, 'noise-floor.json');
	const report = await deriveRuntimeTournamentNoiseFloorFile({
		outputPath,
		tournamentResultPath: fixture.tournamentResultPath
	});
	assert.deepEqual(
		JSON.parse(await readFile(outputPath, 'utf8')),
		report
	);
	await assert.rejects(
		deriveRuntimeTournamentNoiseFloorFile({
			outputPath,
			tournamentResultPath:
				fixture.tournamentResultPath
		}),
		/EEXIST/u
	);
});
