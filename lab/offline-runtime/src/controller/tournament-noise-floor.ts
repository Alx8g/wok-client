import {
	writeFile
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
	canonicalJson,
	sha256Hex
} from '../shared/hash.ts';
import {
	assertRuntimeLabIdentifier
} from '../shared/protocol.ts';
import type {
	RuntimeTournamentMetricId,
	RuntimeTournamentMetricPolicy,
	RuntimeTournamentResult
} from './tournament-controller.ts';
import {
	buildRuntimeTournamentPairedBlocks,
	measureRuntimeTournamentNoiseFloor,
	type RuntimeTournamentMetricObservation
} from './tournament-analysis.ts';
import {
	resolveRuntimeTournamentDryRunReport
} from './tournament-dry-run.ts';
import {
	resolveRuntimeTournamentResultEvidence
} from './tournament-result-evidence.ts';
import {
	RUNTIME_TOURNAMENT_MINIMUM_BLOCKS
} from './tournament-schedule.ts';

export const RUNTIME_TOURNAMENT_NOISE_FLOOR_VERSION = 2;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REQUIRED_METRICS = new Set<RuntimeTournamentMetricId>([
	'average-fps',
	'frame-time-p95-ms',
	'frame-time-p99-ms',
	'one-percent-low-fps'
]);

export interface RuntimeTournamentNoiseFloorMetric {
	blockCount: number;
	direction: RuntimeTournamentMetricPolicy['direction'];
	metricId: RuntimeTournamentMetricId;
	noiseFloor: number;
	practicalMargin: number;
}

export interface RuntimeTournamentNoiseFloorReport {
	candidateIds: [string, string];
	executableSha256: string;
	metricPolicies: RuntimeTournamentMetricPolicy[];
	metrics: RuntimeTournamentNoiseFloorMetric[];
	minimumPairedBlocks: number;
	percentile: number;
	reportSha256: string;
	tournamentId: string;
	tournamentResultPath: string;
	tournamentResultSha256: string;
	version: typeof RUNTIME_TOURNAMENT_NOISE_FLOOR_VERSION;
}

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

function validatePercentile(value: number): number {
	if (
		!Number.isFinite(value)
		|| value < 0.5
		|| value > 1
	) {
		throw new RangeError(
			'percentile must be from 0.5 through one.'
		);
	}
	return value;
}

function validateMinimumBlocks(value: number): number {
	if (
		!Number.isInteger(value)
		|| value < RUNTIME_TOURNAMENT_MINIMUM_BLOCKS
		|| value > 1_000
	) {
		throw new RangeError(
			'minimumPairedBlocks must be an integer '
				+ `from ${RUNTIME_TOURNAMENT_MINIMUM_BLOCKS} `
				+ 'through 1,000.'
		);
	}
	return value;
}

function verifyResultDigest(
	result: RuntimeTournamentResult
): void {
	if (!SHA256_PATTERN.test(result.resultSha256)) {
		throw new TypeError(
			'Tournament result SHA-256 is invalid.'
		);
	}
	const {
		resultSha256,
		...withoutHash
	} = result;
	const actual = sha256Hex(canonicalJson(withoutHash));
	if (actual !== resultSha256) {
		throw new Error(
			'Tournament result SHA-256 does not match '
				+ 'its canonical contents.'
		);
	}
	const actualScheduleSha256 = sha256Hex(
		canonicalJson(result.schedule.schedule)
	);
	if (
		actualScheduleSha256
		!== result.schedule.scheduleSha256
	) {
		throw new Error(
			'Tournament schedule SHA-256 does not match '
				+ 'its canonical contents.'
		);
	}
}

function sameBuildExecutableSha256(
	result: RuntimeTournamentResult
): string {
	if (
		!Array.isArray(result.candidateIds)
		|| result.candidateIds.length !== 2
	) {
		throw new TypeError(
			'Noise-floor calibration requires exactly '
				+ 'two logical candidates.'
		);
	}
	if (
		!Array.isArray(result.candidateIdentities)
		|| result.candidateIdentities.length !== 2
	) {
		throw new TypeError(
			'Tournament result must contain exactly two '
				+ 'candidate identities.'
		);
	}
	const identities = new Map(
		result.candidateIdentities.map(identity => {
			assertRuntimeLabIdentifier(
				identity.id,
				'candidate identity ID'
			);
			if (
				!SHA256_PATTERN.test(
					identity.executableSha256
				)
				|| !SHA256_PATTERN.test(
					identity.manifestSha256
				)
			) {
				throw new TypeError(
					'Candidate identity hashes must be '
						+ 'lowercase SHA-256 digests.'
				);
			}
			return [identity.id, identity] as const;
		})
	);
	if (identities.size !== 2) {
		throw new TypeError(
			'Candidate identity IDs must be unique.'
		);
	}
	const resolved = result.candidateIds.map(
		candidateId => {
			assertRuntimeLabIdentifier(
				candidateId,
				'candidate ID'
			);
			const identity = identities.get(candidateId);
			if (!identity) {
				throw new TypeError(
					`Candidate identity ${candidateId} is missing.`
				);
			}
			return identity;
		}
	);
	if (
		resolved[0].executableSha256
		!== resolved[1].executableSha256
	) {
		throw new Error(
			'Noise-floor calibration candidates do not '
				+ 'use the identical executable SHA-256.'
		);
	}
	return resolved[0].executableSha256;
}

function metricObservations(
	result: RuntimeTournamentResult,
	metricId: RuntimeTournamentMetricId
): RuntimeTournamentMetricObservation[] {
	return result.runRecords
		.filter(record => record.phase === 'measured')
		.map((record, index) => {
			if (
				!Number.isInteger(record.blockIndex)
				|| (record.blockIndex ?? -1) < 0
			) {
				throw new TypeError(
					`Measured run record ${index} has no `
						+ 'valid block index.'
				);
			}
			const value = record.metricValues[metricId];
			return {
				blockId:
					`block-${String(record.blockIndex).padStart(4, '0')}`,
				candidateId: record.candidateId,
				valid: record.valid && value !== undefined,
				...(value === undefined ? {} : { value })
			};
		});
}

function metricInputs(
	result: RuntimeTournamentResult
): Array<{
	direction: RuntimeTournamentMetricPolicy['direction'];
	metricId: RuntimeTournamentMetricId;
	practicalMargin: number;
}> {
	if (!Array.isArray(result.analyses)) {
		throw new TypeError(
			'Tournament analyses must be an array.'
		);
	}
	const inputs = result.analyses.map((entry, index) => {
		if (!entry.analysis) {
			throw new Error(
				`Tournament analysis ${index} is unavailable.`
			);
		}
		return {
			direction: entry.analysis.direction,
			metricId: entry.metricId,
			practicalMargin:
				entry.analysis.practicalMargin
		};
	});
	const unique = new Set(
		inputs.map(input => input.metricId)
	);
	if (
		unique.size !== REQUIRED_METRICS.size
		|| inputs.length !== REQUIRED_METRICS.size
		|| [...REQUIRED_METRICS].some(
			metricId => !unique.has(metricId)
		)
	) {
		throw new TypeError(
			'Noise-floor tournament must contain exactly one '
				+ 'analysis for every headline metric.'
		);
	}
	return inputs.sort((left, right) =>
		left.metricId.localeCompare(right.metricId));
}

export function buildRuntimeTournamentNoiseFloorReport(
	result: RuntimeTournamentResult,
	options: {
		minimumPairedBlocks?: number;
		percentile?: number;
		tournamentResultPath?: string;
	} = {}
): RuntimeTournamentNoiseFloorReport {
	expectRecord(result, 'tournament result');
	verifyResultDigest(result);
	if (
		result.executionMode !== 'attested-runtime'
		|| !result.valid
		|| result.fatalError !== undefined
	) {
		throw new Error(
			'Noise-floor evidence requires a complete '
				+ 'attested-runtime tournament.'
		);
	}
	assertRuntimeLabIdentifier(
		result.tournamentId,
		'tournamentId'
	);
	if (result.schedule.schedule.design !== 'abba-baab') {
		throw new Error(
			'Noise-floor calibration requires the '
				+ 'two-candidate ABBA/BAAB design.'
		);
	}
	if (
		!Array.isArray(result.runRecords)
		|| result.runRecords.some(record => !record.valid)
	) {
		throw new Error(
			'Noise-floor evidence cannot contain invalid '
				+ 'run records.'
		);
	}
	const percentile = validatePercentile(
		options.percentile ?? 0.95
	);
	const minimumPairedBlocks = validateMinimumBlocks(
		options.minimumPairedBlocks
			?? RUNTIME_TOURNAMENT_MINIMUM_BLOCKS
	);
	const executableSha256 =
		sameBuildExecutableSha256(result);
	const [baselineCandidateId, challengerCandidateId] =
		result.candidateIds as [string, string];
	const metrics = metricInputs(result).map(input => {
		const paired = buildRuntimeTournamentPairedBlocks(
			metricObservations(result, input.metricId),
			{
				baselineCandidateId,
				challengerCandidateId,
				expectedObservationsPerCandidate: 2
			}
		);
		if (paired.excludedBlocks.length > 0) {
			throw new Error(
				`${input.metricId} has excluded paired blocks.`
			);
		}
		if (paired.blocks.length < minimumPairedBlocks) {
			throw new Error(
				`${input.metricId} has ${paired.blocks.length} `
					+ 'clean paired blocks; at least '
					+ `${minimumPairedBlocks} are required.`
			);
		}
		return {
			blockCount: paired.blocks.length,
			direction: input.direction,
			metricId: input.metricId,
			noiseFloor:
				measureRuntimeTournamentNoiseFloor(
					paired.blocks,
					percentile
				),
			practicalMargin: input.practicalMargin
		};
	});
	const reportWithoutHash: Omit<
		RuntimeTournamentNoiseFloorReport,
		'reportSha256'
	> = {
		candidateIds: [
			baselineCandidateId,
			challengerCandidateId
		],
		executableSha256,
		metricPolicies: metrics.map(metric => ({
			direction: metric.direction,
			metricId: metric.metricId,
			noiseFloor: metric.noiseFloor,
			practicalMargin: metric.practicalMargin
		})),
		metrics,
		minimumPairedBlocks,
		percentile,
		tournamentId: result.tournamentId,
		tournamentResultPath: resolve(
			options.tournamentResultPath
				?? join(
					result.tournamentDirectory,
					'tournament-result.json'
				)
		),
		tournamentResultSha256: result.resultSha256,
		version: RUNTIME_TOURNAMENT_NOISE_FLOOR_VERSION
	};
	return {
		...reportWithoutHash,
		reportSha256: sha256Hex(
			canonicalJson(reportWithoutHash)
		)
	};
}

export async function deriveRuntimeTournamentNoiseFloorFile(
	options: {
		minimumPairedBlocks?: number;
		outputPath: string;
		percentile?: number;
		tournamentResultPath: string;
	}
): Promise<RuntimeTournamentNoiseFloorReport> {
	const {
		result,
		resultPath
	} = await resolveRuntimeTournamentResultEvidence(
		options.tournamentResultPath,
		resolveRuntimeTournamentDryRunReport
	);
	const report = buildRuntimeTournamentNoiseFloorReport(
		result,
		{
			...(options.minimumPairedBlocks === undefined
				? {}
				: {
					minimumPairedBlocks:
						options.minimumPairedBlocks
				}),
			...(options.percentile === undefined
				? {}
				: { percentile: options.percentile }),
			tournamentResultPath: resultPath
		}
	);
	await writeFile(
		resolve(options.outputPath),
		`${JSON.stringify(report, null, '\t')}\n`,
		{ flag: 'wx' }
	);
	return report;
}
