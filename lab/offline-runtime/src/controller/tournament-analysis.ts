import {
	canonicalJson,
	sha256Hex
} from '../shared/hash.ts';
import {
	assertRuntimeLabIdentifier
} from '../shared/protocol.ts';
import type {
	RuntimeTournamentMetricPolicy,
	RuntimeTournamentPairMetricAnalysis,
	RuntimeTournamentRunRecord
} from './tournament-controller.ts';
import {
	RUNTIME_TOURNAMENT_MINIMUM_BLOCKS
} from './tournament-schedule.ts';

export const RUNTIME_TOURNAMENT_ANALYSIS_VERSION = 1;
export const RUNTIME_TOURNAMENT_BOOTSTRAP_ITERATIONS = 10_000;
export const RUNTIME_TOURNAMENT_CONFIDENCE_LEVEL = 0.95;

export type RuntimeTournamentMetricDirection =
	| 'higher-is-better'
	| 'lower-is-better';

export type RuntimeTournamentDecision =
	| 'baseline-better'
	| 'challenger-better'
	| 'inconclusive'
	| 'insufficient-data'
	| 'reliability-failed'
	| 'tie';

export interface RuntimeTournamentPairedBlock {
	baselineValue: number;
	blockId: string;
	challengerValue: number;
}

export interface RuntimeTournamentMetricObservation {
	blockId: string;
	candidateId: string;
	valid: boolean;
	value?: number;
}

export interface RuntimeTournamentExcludedBlock {
	blockId: string;
	reasons: string[];
}

export interface RuntimeTournamentPairedBlocks {
	blocks: RuntimeTournamentPairedBlock[];
	excludedBlocks: RuntimeTournamentExcludedBlock[];
}

export interface RuntimeTournamentConfidenceInterval {
	confidenceLevel: number;
	lower: number;
	upper: number;
}

export interface RuntimeTournamentMetricAnalysis {
	analysisSha256: string;
	baselineCandidateId: string;
	blockCount: number;
	bootstrapIterations: number;
	challengerCandidateId: string;
	confidenceInterval: RuntimeTournamentConfidenceInterval;
	decision: RuntimeTournamentDecision;
	direction: RuntimeTournamentMetricDirection;
	equivalenceMargin: number;
	favorableDeltas: number[];
	favorableLogRatios: number[];
	favorablePercentChanges: number[];
	meanFavorableDelta: number;
	medianFavorableDelta: number;
	medianFavorableLogRatio: number;
	medianFavorablePercentChange: number;
	minimumPairedBlocks: number;
	noiseFloor: number;
	practicalMargin: number;
	reliabilityFailures: string[];
	seed: string;
	version: typeof RUNTIME_TOURNAMENT_ANALYSIS_VERSION;
}

function assertFinitePositive(
	value: number,
	label: string
): void {
	if (
		typeof value !== 'number'
		|| !Number.isFinite(value)
		|| value <= 0
	) {
		throw new TypeError(
			`${label} must be finite and positive.`
		);
	}
}

function assertFiniteNonNegative(
	value: number,
	label: string
): void {
	if (
		typeof value !== 'number'
		|| !Number.isFinite(value)
		|| value < 0
	) {
		throw new TypeError(
			`${label} must be finite and non-negative.`
		);
	}
}

function median(values: readonly number[]): number {
	if (values.length === 0) {
		throw new RangeError(
			'Cannot calculate the median of an '
				+ 'empty sample.'
		);
	}
	const sorted = [...values].sort(
		(left, right) => left - right
	);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

function mean(values: readonly number[]): number {
	if (values.length === 0) {
		throw new RangeError(
			'Cannot calculate the mean of an '
				+ 'empty sample.'
		);
	}
	return values.reduce(
		(sum, value) => sum + value,
		0
	) / values.length;
}

function quantile(
	values: readonly number[],
	probability: number
): number {
	if (values.length === 0) {
		throw new RangeError(
			'Cannot calculate a quantile from '
				+ 'an empty sample.'
		);
	}
	if (
		!Number.isFinite(probability)
		|| probability < 0
		|| probability > 1
	) {
		throw new RangeError(
			'probability must be from zero '
				+ 'through one.'
		);
	}
	const sorted = [...values].sort(
		(left, right) => left - right
	);
	const position =
		(sorted.length - 1) * probability;
	const lowerIndex = Math.floor(position);
	const upperIndex = Math.ceil(position);
	if (lowerIndex === upperIndex) {
		return sorted[lowerIndex];
	}
	const weight = position - lowerIndex;
	return sorted[lowerIndex]
		+ (sorted[upperIndex] - sorted[lowerIndex])
			* weight;
}

function createSeededDraw(seed: string): () => number {
	assertRuntimeLabIdentifier(seed, 'seed');
	let state = Number.parseInt(
		sha256Hex(seed).slice(0, 8),
		16
	) >>> 0;
	if (state === 0) state = 0x9e37_79b9;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
}

function bootstrapMedianConfidenceInterval(
	values: readonly number[],
	options: {
		confidenceLevel: number;
		iterations: number;
		seed: string;
	}
): RuntimeTournamentConfidenceInterval {
	if (
		!Number.isFinite(options.confidenceLevel)
		|| options.confidenceLevel < 0.8
		|| options.confidenceLevel >= 1
	) {
		throw new RangeError(
			'confidenceLevel must be at least '
				+ '0.8 and less than one.'
		);
	}
	if (
		!Number.isInteger(options.iterations)
		|| options.iterations < 1_000
		|| options.iterations > 100_000
	) {
		throw new RangeError(
			'bootstrapIterations must be an '
				+ 'integer from 1,000 through '
				+ '100,000.'
		);
	}
	const draw = createSeededDraw(options.seed);
	const estimates = new Array<number>(
		options.iterations
	);
	const sample = new Array<number>(values.length);
	for (
		let iteration = 0;
		iteration < options.iterations;
		iteration += 1
	) {
		for (
			let index = 0;
			index < values.length;
			index += 1
		) {
			sample[index] = values[
				draw() % values.length
			];
		}
		estimates[iteration] = median(sample);
	}
	const tailProbability =
		(1 - options.confidenceLevel) / 2;
	return {
		confidenceLevel: options.confidenceLevel,
		lower: quantile(estimates, tailProbability),
		upper: quantile(
			estimates,
			1 - tailProbability
		)
	};
}

function validObservationValues(
	observations:
		readonly RuntimeTournamentMetricObservation[]
): number[] {
	return observations.map((observation, index) => {
		if (!observation.valid || observation.value === undefined) {
			throw new Error(
				`Observation ${index} was not valid `
					+ 'after block validation.'
			);
		}
		return observation.value;
	});
}

function favorableDelta(
	block: RuntimeTournamentPairedBlock,
	direction: RuntimeTournamentMetricDirection
): number {
	return direction === 'higher-is-better'
		? block.challengerValue - block.baselineValue
		: block.baselineValue - block.challengerValue;
}

function favorableLogRatio(
	block: RuntimeTournamentPairedBlock,
	direction: RuntimeTournamentMetricDirection
): number {
	return direction === 'higher-is-better'
		? Math.log(
			block.challengerValue
				/ block.baselineValue
		)
		: Math.log(
			block.baselineValue
				/ block.challengerValue
		);
}

function favorablePercentChange(
	block: RuntimeTournamentPairedBlock,
	direction: RuntimeTournamentMetricDirection
): number {
	const naturalPercentChange =
		(
			block.challengerValue
			- block.baselineValue
		) / block.baselineValue * 100;
	return direction === 'higher-is-better'
		? naturalPercentChange
		: -naturalPercentChange;
}

function decideMetric(options: {
	confidenceInterval: RuntimeTournamentConfidenceInterval;
	equivalenceMargin: number;
	hasEnoughBlocks: boolean;
	reliabilityFailures: readonly string[];
}): RuntimeTournamentDecision {
	if (options.reliabilityFailures.length > 0) {
		return 'reliability-failed';
	}
	if (!options.hasEnoughBlocks) {
		return 'insufficient-data';
	}
	const { lower, upper } = options.confidenceInterval;
	if (lower > options.equivalenceMargin) {
		return 'challenger-better';
	}
	if (upper < -options.equivalenceMargin) {
		return 'baseline-better';
	}
	if (
		lower >= -options.equivalenceMargin
		&& upper <= options.equivalenceMargin
	) {
		return 'tie';
	}
	return 'inconclusive';
}

export function buildRuntimeTournamentPairedBlocks(
	observations:
		readonly RuntimeTournamentMetricObservation[],
	options: {
		baselineCandidateId: string;
		challengerCandidateId: string;
		expectedObservationsPerCandidate?: number;
	}
): RuntimeTournamentPairedBlocks {
	assertRuntimeLabIdentifier(
		options.baselineCandidateId,
		'baselineCandidateId'
	);
	assertRuntimeLabIdentifier(
		options.challengerCandidateId,
		'challengerCandidateId'
	);
	if (
		options.baselineCandidateId
		=== options.challengerCandidateId
	) {
		throw new TypeError(
			'Baseline and challenger candidates '
				+ 'must be different.'
		);
	}
	const expectedCount =
		options.expectedObservationsPerCandidate ?? 1;
	if (
		!Number.isInteger(expectedCount)
		|| expectedCount < 1
		|| expectedCount > 16
	) {
		throw new RangeError(
			'expectedObservationsPerCandidate '
				+ 'must be from 1 through 16.'
		);
	}
	const byBlock = new Map<
		string,
		RuntimeTournamentMetricObservation[]
	>();
	for (const [index, observation] of
		observations.entries()) {
		assertRuntimeLabIdentifier(
			observation.blockId,
			`observations[${index}].blockId`
		);
		assertRuntimeLabIdentifier(
			observation.candidateId,
			`observations[${index}].candidateId`
		);
		if (typeof observation.valid !== 'boolean') {
			throw new TypeError(
				`observations[${index}].valid `
					+ 'must be boolean.'
			);
		}
		if (observation.value === undefined) {
			if (observation.valid) {
				throw new TypeError(
					`observations[${index}].value `
						+ 'is required for a valid '
						+ 'observation.'
				);
			}
		} else {
			assertFinitePositive(
				observation.value,
				`observations[${index}].value`
			);
		}
		const block = byBlock.get(observation.blockId);
		if (block) block.push(observation);
		else byBlock.set(observation.blockId, [observation]);
	}
	const blocks: RuntimeTournamentPairedBlock[] = [];
	const excludedBlocks: RuntimeTournamentExcludedBlock[] = [];
	for (const [blockId, blockObservations] of byBlock) {
		const baseline = blockObservations.filter(
			observation =>
				observation.candidateId
				=== options.baselineCandidateId
		);
		const challenger = blockObservations.filter(
			observation =>
				observation.candidateId
				=== options.challengerCandidateId
		);
		const reasons: string[] = [];
		if (baseline.length !== expectedCount) {
			reasons.push(
				`baseline-observation-count:${baseline.length}/${expectedCount}`
			);
		}
		if (challenger.length !== expectedCount) {
			reasons.push(
				`challenger-observation-count:${challenger.length}/${expectedCount}`
			);
		}
		if (
			baseline.some(observation => !observation.valid)
		) {
			reasons.push('baseline-invalid-observation');
		}
		if (
			challenger.some(observation => !observation.valid)
		) {
			reasons.push('challenger-invalid-observation');
		}
		const unrelatedInvalid =
			blockObservations.filter(
				observation =>
					observation.candidateId
					!== options.baselineCandidateId
					&& observation.candidateId
					!== options.challengerCandidateId
					&& !observation.valid
			);
		if (unrelatedInvalid.length > 0) {
			reasons.push(
				'unrelated-invalid-observations:'
					+ unrelatedInvalid.length
			);
		}
		if (reasons.length > 0) {
			excludedBlocks.push({ blockId, reasons });
			continue;
		}
		blocks.push({
			baselineValue: median(
				validObservationValues(baseline)
			),
			blockId,
			challengerValue: median(
				validObservationValues(challenger)
			)
		});
	}
	blocks.sort((left, right) =>
		left.blockId.localeCompare(right.blockId));
	excludedBlocks.sort((left, right) =>
		left.blockId.localeCompare(right.blockId));
	return { blocks, excludedBlocks };
}

export function measureRuntimeTournamentNoiseFloor(
	blocks: readonly RuntimeTournamentPairedBlock[],
	percentile = 0.95
): number {
	if (blocks.length === 0) {
		throw new RangeError(
			'At least one same-build paired block '
				+ 'is required.'
		);
	}
	const absoluteDeltas = blocks.map(
		(block, index) => {
			assertRuntimeLabIdentifier(
				block.blockId,
				`blocks[${index}].blockId`
			);
			assertFinitePositive(
				block.baselineValue,
				`blocks[${index}].baselineValue`
			);
			assertFinitePositive(
				block.challengerValue,
				`blocks[${index}].challengerValue`
			);
			return Math.abs(
				block.challengerValue
					- block.baselineValue
			);
		}
	);
	return quantile(absoluteDeltas, percentile);
}

export function analyzeRuntimeTournamentMetric(options: {
	baselineCandidateId: string;
	blocks: readonly RuntimeTournamentPairedBlock[];
	bootstrapIterations?: number;
	challengerCandidateId: string;
	confidenceLevel?: number;
	direction: RuntimeTournamentMetricDirection;
	minimumPairedBlocks?: number;
	noiseFloor: number;
	practicalMargin: number;
	reliabilityFailures?: readonly string[];
	seed: string;
}): RuntimeTournamentMetricAnalysis {
	assertRuntimeLabIdentifier(
		options.baselineCandidateId,
		'baselineCandidateId'
	);
	assertRuntimeLabIdentifier(
		options.challengerCandidateId,
		'challengerCandidateId'
	);
	if (
		options.baselineCandidateId
		=== options.challengerCandidateId
	) {
		throw new TypeError(
			'Baseline and challenger candidates '
				+ 'must be different.'
		);
	}
	if (
		options.direction !== 'higher-is-better'
		&& options.direction !== 'lower-is-better'
	) {
		throw new TypeError('direction is invalid.');
	}
	assertFiniteNonNegative(
		options.practicalMargin,
		'practicalMargin'
	);
	assertFiniteNonNegative(
		options.noiseFloor,
		'noiseFloor'
	);
	assertRuntimeLabIdentifier(options.seed, 'seed');
	const minimumPairedBlocks =
		options.minimumPairedBlocks
			?? RUNTIME_TOURNAMENT_MINIMUM_BLOCKS;
	if (
		!Number.isInteger(minimumPairedBlocks)
		|| minimumPairedBlocks
			< RUNTIME_TOURNAMENT_MINIMUM_BLOCKS
		|| minimumPairedBlocks > 1_000
	) {
		throw new RangeError(
			'minimumPairedBlocks must be an integer from '
				+ `${RUNTIME_TOURNAMENT_MINIMUM_BLOCKS} through 1,000.`
		);
	}
	if (options.blocks.length === 0) {
		throw new RangeError(
			'At least one paired block is required.'
		);
	}
	const seenBlockIds = new Set<string>();
	for (const [index, block] of options.blocks.entries()) {
		assertRuntimeLabIdentifier(
			block.blockId,
			`blocks[${index}].blockId`
		);
		if (seenBlockIds.has(block.blockId)) {
			throw new TypeError(
				`Duplicate paired block ${block.blockId}.`
			);
		}
		seenBlockIds.add(block.blockId);
		assertFinitePositive(
			block.baselineValue,
			`blocks[${index}].baselineValue`
		);
		assertFinitePositive(
			block.challengerValue,
			`blocks[${index}].challengerValue`
		);
	}
	const reliabilityFailures = [
		...(options.reliabilityFailures ?? [])
	];
	for (const [index, failure] of
		reliabilityFailures.entries()) {
		if (
			typeof failure !== 'string'
			|| failure.length === 0
			|| failure.length > 4_096
		) {
			throw new TypeError(
				`reliabilityFailures[${index}] `
					+ 'must be a non-empty bounded '
					+ 'string.'
			);
		}
	}
	const bootstrapIterations =
		options.bootstrapIterations
			?? RUNTIME_TOURNAMENT_BOOTSTRAP_ITERATIONS;
	const confidenceLevel =
		options.confidenceLevel
			?? RUNTIME_TOURNAMENT_CONFIDENCE_LEVEL;
	const favorableDeltas = options.blocks.map(
		block => favorableDelta(block, options.direction)
	);
	const favorableLogRatios = options.blocks.map(
		block => favorableLogRatio(
			block,
			options.direction
		)
	);
	const favorablePercentChanges = options.blocks.map(
		block => favorablePercentChange(
			block,
			options.direction
		)
	);
	const confidenceInterval =
		bootstrapMedianConfidenceInterval(
			favorableDeltas,
			{
				confidenceLevel,
				iterations: bootstrapIterations,
				seed: options.seed
			}
		);
	const equivalenceMargin = Math.max(
		options.practicalMargin,
		options.noiseFloor
	);
	const analysisWithoutHash: Omit<
		RuntimeTournamentMetricAnalysis,
		'analysisSha256'
	> = {
		baselineCandidateId:
			options.baselineCandidateId,
		blockCount: options.blocks.length,
		bootstrapIterations,
		challengerCandidateId:
			options.challengerCandidateId,
		confidenceInterval,
		decision: decideMetric({
			confidenceInterval,
			equivalenceMargin,
			hasEnoughBlocks:
				options.blocks.length
				>= minimumPairedBlocks,
			reliabilityFailures
		}),
		direction: options.direction,
		equivalenceMargin,
		favorableDeltas,
		favorableLogRatios,
		favorablePercentChanges,
		meanFavorableDelta: mean(favorableDeltas),
		medianFavorableDelta: median(favorableDeltas),
		medianFavorableLogRatio:
			median(favorableLogRatios),
		medianFavorablePercentChange:
			median(favorablePercentChanges),
		minimumPairedBlocks,
		noiseFloor: options.noiseFloor,
		practicalMargin: options.practicalMargin,
		reliabilityFailures,
		seed: options.seed,
		version:
			RUNTIME_TOURNAMENT_ANALYSIS_VERSION
	};
	return {
		analysisSha256: sha256Hex(
			canonicalJson(analysisWithoutHash)
		),
		...analysisWithoutHash
	};
}

/**
 * Deterministically reconstruct every pairwise analysis from the attested controls, metric policy,
 * run records, and tournament seed. Keeping this beside the metric analyzer lets both the producer
 * and evidence verifier use one implementation without introducing a controller/dry-run cycle.
 */
export function buildRuntimeTournamentPairAnalyses(options: {
	analysisControls: {
		bootstrapIterations: number;
		confidenceLevel: number;
		minimumPairedBlocks: number;
	};
	candidateIds: readonly string[];
	metricPolicies: readonly RuntimeTournamentMetricPolicy[];
	runRecords: readonly RuntimeTournamentRunRecord[];
	seed: string;
}): RuntimeTournamentPairMetricAnalysis[] {
	const analyses: RuntimeTournamentPairMetricAnalysis[] = [];
	const expectedObservationsPerCandidate =
		options.candidateIds.length === 2 ? 2 : 1;
	const reliabilityFailures = options.runRecords.flatMap(
		record => {
			if (record.valid) return [];
			return [
				`${record.runId}:`
					+ (
						record.error
						?? record.failureReasons[0]
						?? record.violations[0]
						?? 'invalid-run'
					)
			];
		}
	);
	for (
		let baselineIndex = 0;
		baselineIndex < options.candidateIds.length - 1;
		baselineIndex += 1
	) {
		for (
			let challengerIndex = baselineIndex + 1;
			challengerIndex < options.candidateIds.length;
			challengerIndex += 1
		) {
			const baselineCandidateId =
				options.candidateIds[baselineIndex];
			const challengerCandidateId =
				options.candidateIds[challengerIndex];
			for (const policy of options.metricPolicies) {
				const observations: RuntimeTournamentMetricObservation[] =
					options.runRecords
						.filter(record => record.phase === 'measured')
						.map(record => {
							const value =
								record.metricValues[policy.metricId];
							return {
								blockId:
									`block-${String(record.blockIndex).padStart(4, '0')}`,
								candidateId: record.candidateId,
								valid: record.valid
									&& value !== undefined,
								...(value === undefined
									? {}
									: { value })
							};
						});
				const paired = buildRuntimeTournamentPairedBlocks(
					observations,
					{
						baselineCandidateId,
						challengerCandidateId,
						expectedObservationsPerCandidate
					}
				);
				if (paired.blocks.length === 0) {
					analyses.push({
						baselineCandidateId,
						challengerCandidateId,
						metricId: policy.metricId,
						paired,
						unavailableReason:
							'No clean paired blocks were available.'
					});
					continue;
				}
				analyses.push({
					analysis: analyzeRuntimeTournamentMetric({
						baselineCandidateId,
						blocks: paired.blocks,
						bootstrapIterations:
							options.analysisControls.bootstrapIterations,
						challengerCandidateId,
						confidenceLevel:
							options.analysisControls.confidenceLevel,
						direction: policy.direction,
						minimumPairedBlocks:
							options.analysisControls.minimumPairedBlocks,
						noiseFloor: policy.noiseFloor,
						practicalMargin: policy.practicalMargin,
						reliabilityFailures,
						seed: `${options.seed}-${baselineIndex}-${challengerIndex}-${policy.metricId}`
					}),
					baselineCandidateId,
					challengerCandidateId,
					metricId: policy.metricId,
					paired
				});
			}
		}
	}
	return analyses;
}
