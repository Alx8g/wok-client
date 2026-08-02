import assert from 'node:assert/strict';
import test from 'node:test';
import {
	analyzeRuntimeTournamentMetric,
	buildRuntimeTournamentPairedBlocks,
	measureRuntimeTournamentNoiseFloor,
	type RuntimeTournamentPairedBlock
} from '../src/controller/tournament-analysis.ts';

function constantBlocks(
	delta: number,
	count = 7,
	baselineValue = 100
): RuntimeTournamentPairedBlock[] {
	return Array.from(
		{ length: count },
		(_value, index) => ({
			baselineValue,
			blockId: `block-${String(index).padStart(4, '0')}`,
			challengerValue: baselineValue + delta
		})
	);
}

function analyze(
	blocks: readonly RuntimeTournamentPairedBlock[],
	overrides: Partial<
		Parameters<
			typeof analyzeRuntimeTournamentMetric
		>[0]
	> = {}
) {
	return analyzeRuntimeTournamentMetric({
		baselineCandidateId: 'candidate-a',
		blocks,
		bootstrapIterations: 1_000,
		challengerCandidateId: 'candidate-b',
		direction: 'higher-is-better',
		noiseFloor: 1,
		practicalMargin: 2,
		seed: 'analysis-seed',
		...overrides
	});
}

test('paired block construction aggregates whole blocks and excludes contaminated pairs', () => {
	const paired = buildRuntimeTournamentPairedBlocks(
		[
			{
				blockId: 'block-0001',
				candidateId: 'candidate-a',
				valid: true,
				value: 100
			},
			{
				blockId: 'block-0001',
				candidateId: 'candidate-b',
				valid: true,
				value: 104
			},
			{
				blockId: 'block-0001',
				candidateId: 'candidate-b',
				valid: true,
				value: 106
			},
			{
				blockId: 'block-0001',
				candidateId: 'candidate-a',
				valid: true,
				value: 102
			},
			{
				blockId: 'block-0001',
				candidateId: 'candidate-c',
				valid: true,
				value: 103
			},
			{
				blockId: 'block-0002',
				candidateId: 'candidate-a',
				valid: true,
				value: 100
			},
			{
				blockId: 'block-0002',
				candidateId: 'candidate-b',
				valid: false,
				value: 105
			}
		],
		{
			baselineCandidateId: 'candidate-a',
			challengerCandidateId: 'candidate-b',
			expectedObservationsPerCandidate: 2
		}
	);
	assert.deepEqual(paired.blocks, [
		{
			baselineValue: 101,
			blockId: 'block-0001',
			challengerValue: 105
		}
	]);
	assert.equal(paired.excludedBlocks.length, 1);
	assert.deepEqual(
		paired.excludedBlocks[0].reasons,
		[
			'baseline-observation-count:1/2',
			'challenger-observation-count:1/2',
			'challenger-invalid-observation'
		]
	);
});

test('paired bootstrap declares a challenger only beyond practical and noise margins', () => {
	const result = analyze(constantBlocks(5));
	assert.equal(result.decision, 'challenger-better');
	assert.equal(result.equivalenceMargin, 2);
	assert.deepEqual(result.confidenceInterval, {
		confidenceLevel: 0.95,
		lower: 5,
		upper: 5
	});
	assert.equal(result.medianFavorableDelta, 5);
	assert.equal(result.meanFavorableDelta, 5);
	assert.equal(
		result.medianFavorablePercentChange,
		5
	);
	assert.match(result.analysisSha256, /^[a-f0-9]{64}$/u);
});

test('paired bootstrap can declare the baseline better', () => {
	const result = analyze(constantBlocks(-5));
	assert.equal(result.decision, 'baseline-better');
	assert.deepEqual(result.confidenceInterval, {
		confidenceLevel: 0.95,
		lower: -5,
		upper: -5
	});
});

test('lower-is-better metrics orient deltas, ratios and percentages toward improvement', () => {
	const blocks = Array.from(
		{ length: 7 },
		(_value, index) => ({
			baselineValue: 10,
			blockId: `block-${index}`,
			challengerValue: 9
		})
	);
	const result = analyze(blocks, {
		direction: 'lower-is-better',
		noiseFloor: 0.25,
		practicalMargin: 0.5
	});
	assert.equal(result.decision, 'challenger-better');
	assert.equal(result.medianFavorableDelta, 1);
	assert.equal(
		result.medianFavorablePercentChange,
		10
	);
	assert.ok(result.medianFavorableLogRatio > 0);
});

test('equivalent confidence intervals tie while crossing regions remain inconclusive', () => {
	const tied = analyze(constantBlocks(0.25), {
		noiseFloor: 1,
		practicalMargin: 0.5
	});
	assert.equal(tied.decision, 'tie');

	const deltas = [-5, -3, -1, 0, 1, 3, 5];
	const crossing = analyze(
		deltas.map((delta, index) => ({
			baselineValue: 100,
			blockId: `block-${index}`,
			challengerValue: 100 + delta
		})),
		{
			noiseFloor: 1,
			practicalMargin: 1
		}
	);
	assert.equal(crossing.decision, 'inconclusive');
	assert.ok(crossing.confidenceInterval.lower < -1);
	assert.ok(crossing.confidenceInterval.upper > 1);
});

test('minimum clean blocks and reliability gates prevent winner claims', () => {
	const insufficient = analyze(
		constantBlocks(10, 6)
	);
	assert.equal(
		insufficient.decision,
		'insufficient-data'
	);
	const unreliable = analyze(constantBlocks(10), {
		reliabilityFailures: [
			'candidate-b:gpu-process-crash'
		]
	});
	assert.equal(
		unreliable.decision,
		'reliability-failed'
	);
});

test('same-build noise floor uses the declared absolute-delta percentile', () => {
	const blocks = Array.from(
		{ length: 7 },
		(_value, index) => ({
			baselineValue: 100,
			blockId: `noise-${index}`,
			challengerValue: 101 + index
		})
	);
	assert.ok(
		Math.abs(
			measureRuntimeTournamentNoiseFloor(
				blocks
			) - 6.7
		) < Number.EPSILON * 8
	);
});

test('analysis is deterministic and rejects duplicate blocks or non-positive metrics', () => {
	const blocks = constantBlocks(5);
	assert.deepEqual(analyze(blocks), analyze(blocks));
	assert.throws(
		() => analyze([
			blocks[0],
			{ ...blocks[0] }
		]),
		/Duplicate paired block/u
	);
	assert.throws(
		() => analyze([
			{
				baselineValue: 0,
				blockId: 'bad-block',
				challengerValue: 1
			}
		]),
		/finite and positive/u
	);
});
