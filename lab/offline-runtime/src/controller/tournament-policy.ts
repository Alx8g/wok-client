import {
	readFile,
	realpath
} from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
	canonicalJson,
	sha256Hex
} from '../shared/hash.ts';
import type {
	RuntimeTournamentMetricId,
	RuntimeTournamentMetricPolicy
} from './tournament-controller.ts';
import type {
	RuntimeTournamentNoiseFloorReport
} from './tournament-noise-floor.ts';
import {
	RUNTIME_TOURNAMENT_MINIMUM_BLOCKS
} from './tournament-schedule.ts';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SUPPORTED_METRICS = new Set<RuntimeTournamentMetricId>([
	'average-fps',
	'frame-time-p95-ms',
	'frame-time-p99-ms',
	'one-percent-low-fps'
]);

export interface RuntimeTournamentPracticalMarginMetric {
	direction: RuntimeTournamentMetricPolicy['direction'];
	metricId: RuntimeTournamentMetricId;
	practicalMargin: number;
}

export interface RuntimeTournamentPracticalMarginPolicy {
	bootstrapIterations: number;
	confidenceLevel: number;
	metrics: RuntimeTournamentPracticalMarginMetric[];
	minimumPairedBlocks: number;
	noisePercentile: number;
	targetPairedBlocks: number;
	version: 1;
}

export interface ResolvedRuntimeTournamentMetricPolicyFile {
	filePath: string;
	fileSha256: string;
	kind: 'noise-floor-report' | 'raw-policy';
	metricPolicies: RuntimeTournamentMetricPolicy[];
	noiseFloorReport?: RuntimeTournamentNoiseFloorReport;
	reportSha256?: string;
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

function expectExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
	label: string
): void {
	const expected = new Set(keys);
	for (const key of Object.keys(value)) {
		if (!expected.has(key)) {
			throw new TypeError(
				`${label}.${key} is not supported.`
			);
		}
	}
	for (const key of keys) {
		if (!(key in value)) {
			throw new TypeError(
				`${label}.${key} is required.`
			);
		}
	}
}

function expectedDirection(
	metricId: RuntimeTournamentMetricId
): RuntimeTournamentMetricPolicy['direction'] {
	return metricId === 'average-fps'
		|| metricId === 'one-percent-low-fps'
		? 'higher-is-better'
		: 'lower-is-better';
}

function validateMetricIdentity(
	value: Record<string, unknown>,
	label: string
): {
	direction: RuntimeTournamentMetricPolicy['direction'];
	metricId: RuntimeTournamentMetricId;
} {
	if (
		typeof value.metricId !== 'string'
		|| !SUPPORTED_METRICS.has(
			value.metricId as RuntimeTournamentMetricId
		)
	) {
		throw new TypeError(
			`${label}.metricId is not supported.`
		);
	}
	const metricId =
		value.metricId as RuntimeTournamentMetricId;
	const direction = expectedDirection(metricId);
	if (value.direction !== direction) {
		throw new TypeError(
			`${label}.direction must be ${direction}.`
		);
	}
	return { direction, metricId };
}

function finiteNonNegative(
	value: unknown,
	label: string
): number {
	if (
		typeof value !== 'number'
		|| !Number.isFinite(value)
		|| value < 0
	) {
		throw new TypeError(
			`${label} must be finite and non-negative.`
		);
	}
	return value;
}

function boundedInteger(
	value: unknown,
	label: string,
	minimum: number,
	maximum: number
): number {
	if (
		!Number.isInteger(value)
		|| (value as number) < minimum
		|| (value as number) > maximum
	) {
		throw new TypeError(
			`${label} must be an integer from ${minimum} `
				+ `through ${maximum}.`
		);
	}
	return value as number;
}

function boundedNumber(
	value: unknown,
	label: string,
	minimum: number,
	maximum: number
): number {
	if (
		typeof value !== 'number'
		|| !Number.isFinite(value)
		|| value < minimum
		|| value > maximum
	) {
		throw new TypeError(
			`${label} must be a number from ${minimum} `
				+ `through ${maximum}.`
		);
	}
	return value;
}

export function validateRuntimeTournamentMetricPolicies(
	value: unknown
): RuntimeTournamentMetricPolicy[] {
	if (
		!Array.isArray(value)
		|| value.length < 1
		|| value.length > SUPPORTED_METRICS.size
	) {
		throw new TypeError(
			'Metric policies must contain from 1 through '
				+ `${SUPPORTED_METRICS.size} entries.`
		);
	}
	const seen = new Set<RuntimeTournamentMetricId>();
	return value.map((entry, index) => {
		const label = `metricPolicies[${index}]`;
		const metric = expectRecord(entry, label);
		expectExactKeys(
			metric,
			[
				'direction',
				'metricId',
				'noiseFloor',
				'practicalMargin'
			],
			label
		);
		const identity = validateMetricIdentity(
			metric,
			label
		);
		if (seen.has(identity.metricId)) {
			throw new TypeError(
				`Duplicate metric policy ${identity.metricId}.`
			);
		}
		seen.add(identity.metricId);
		return {
			...identity,
			noiseFloor: finiteNonNegative(
				metric.noiseFloor,
				`${label}.noiseFloor`
			),
			practicalMargin: finiteNonNegative(
				metric.practicalMargin,
				`${label}.practicalMargin`
			)
		};
	});
}

function validateRuntimeTournamentNoiseFloorReport(
	value: unknown
): RuntimeTournamentNoiseFloorReport {
	const root = expectRecord(value, 'noise-floor report');
	expectExactKeys(
		root,
		[
			'candidateIds',
			'executableSha256',
			'metricPolicies',
			'metrics',
			'minimumPairedBlocks',
			'percentile',
			'reportSha256',
			'tournamentId',
			'tournamentResultPath',
			'tournamentResultSha256',
			'version'
		],
		'noise-floor report'
	);
	if (root.version !== 2) {
		throw new TypeError(
			'Noise-floor report version must be 2.'
		);
	}
	if (
		!Array.isArray(root.candidateIds)
		|| root.candidateIds.length !== 2
		|| root.candidateIds.some(candidateId =>
			typeof candidateId !== 'string'
			|| !/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(candidateId)
		)
		|| new Set(root.candidateIds).size !== 2
	) {
		throw new TypeError(
			'Noise-floor report must identify two unique candidates.'
		);
	}
	for (const [valueToCheck, label] of [
		[root.executableSha256, 'executableSha256'],
		[root.reportSha256, 'reportSha256'],
		[root.tournamentResultSha256, 'tournamentResultSha256']
	] as const) {
		if (
			typeof valueToCheck !== 'string'
			|| !SHA256_PATTERN.test(valueToCheck)
		) {
			throw new TypeError(
				`Noise-floor report ${label} is invalid.`
			);
		}
	}
	if (
		typeof root.tournamentId !== 'string'
		|| !/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(
			root.tournamentId
		)
	) {
		throw new TypeError(
			'Noise-floor report tournamentId is invalid.'
		);
	}
	if (
		typeof root.tournamentResultPath !== 'string'
		|| root.tournamentResultPath.length < 1
		|| root.tournamentResultPath.length > 4_096
		|| root.tournamentResultPath.includes('\0')
		|| !isAbsolute(root.tournamentResultPath)
	) {
		throw new TypeError(
			'Noise-floor report tournamentResultPath must be an absolute bounded path.'
		);
	}
	const minimumPairedBlocks = boundedInteger(
		root.minimumPairedBlocks,
		'noise-floor report.minimumPairedBlocks',
		RUNTIME_TOURNAMENT_MINIMUM_BLOCKS,
		1_000
	);
	const percentile = boundedNumber(
		root.percentile,
		'noise-floor report.percentile',
		0.5,
		1
	);
	const metricPolicies =
		validateRuntimeTournamentMetricPolicies(
			root.metricPolicies
		);
	if (
		metricPolicies.length !== SUPPORTED_METRICS.size
		|| [...SUPPORTED_METRICS].some(metricId =>
			!metricPolicies.some(policy =>
				policy.metricId === metricId
			)
		)
	) {
		throw new TypeError(
			'Noise-floor report must define every headline metric exactly once.'
		);
	}
	if (
		!Array.isArray(root.metrics)
		|| root.metrics.length !== SUPPORTED_METRICS.size
	) {
		throw new TypeError(
			'Noise-floor report metrics must define every headline metric.'
		);
	}
	const policiesByMetric = new Map(
		metricPolicies.map(policy => [policy.metricId, policy])
	);
	const seen = new Set<RuntimeTournamentMetricId>();
	const metrics = root.metrics.map((entry, index) => {
		const label = `noise-floor report.metrics[${index}]`;
		const metric = expectRecord(entry, label);
		expectExactKeys(
			metric,
			[
				'blockCount',
				'direction',
				'metricId',
				'noiseFloor',
				'practicalMargin'
			],
			label
		);
		const identity = validateMetricIdentity(metric, label);
		if (seen.has(identity.metricId)) {
			throw new TypeError(
				`Duplicate noise-floor metric ${identity.metricId}.`
			);
		}
		seen.add(identity.metricId);
		const resolved = {
			blockCount: boundedInteger(
				metric.blockCount,
				`${label}.blockCount`,
				minimumPairedBlocks,
				10_000
			),
			...identity,
			noiseFloor: finiteNonNegative(
				metric.noiseFloor,
				`${label}.noiseFloor`
			),
			practicalMargin: finiteNonNegative(
				metric.practicalMargin,
				`${label}.practicalMargin`
			)
		};
		const policy = policiesByMetric.get(identity.metricId);
		if (
			policy === undefined
			|| canonicalJson(policy) !== canonicalJson({
				direction: resolved.direction,
				metricId: resolved.metricId,
				noiseFloor: resolved.noiseFloor,
				practicalMargin: resolved.practicalMargin
			})
		) {
			throw new Error(
				`${label} does not match its metric policy.`
			);
		}
		return resolved;
	});
	if (seen.size !== SUPPORTED_METRICS.size) {
		throw new TypeError(
			'Noise-floor report metrics are incomplete.'
		);
	}
	const {
		reportSha256,
		...withoutHash
	} = root;
	if (
		sha256Hex(canonicalJson(withoutHash))
		!== reportSha256
	) {
		throw new Error(
			'Noise-floor report SHA-256 does not match its canonical contents.'
		);
	}
	return {
		candidateIds: root.candidateIds as [string, string],
		executableSha256: root.executableSha256 as string,
		metricPolicies,
		metrics,
		minimumPairedBlocks,
		percentile,
		reportSha256: reportSha256 as string,
		tournamentId: root.tournamentId,
		tournamentResultPath: root.tournamentResultPath,
		tournamentResultSha256:
			root.tournamentResultSha256 as string,
		version: 2
	};
}

export function validateRuntimeTournamentPracticalMarginPolicy(
	value: unknown
): RuntimeTournamentPracticalMarginPolicy {
	const root = expectRecord(
		value,
		'practical margin policy'
	);
	expectExactKeys(
		root,
		[
			'bootstrapIterations',
			'confidenceLevel',
			'metrics',
			'minimumPairedBlocks',
			'noisePercentile',
			'targetPairedBlocks',
			'version'
		],
		'practical margin policy'
	);
	if (root.version !== 1) {
		throw new TypeError(
			'Practical margin policy version must be 1.'
		);
	}
	if (!Array.isArray(root.metrics)) {
		throw new TypeError(
			'Practical margin policy metrics must be an array.'
		);
	}
	const seen = new Set<RuntimeTournamentMetricId>();
	const metrics = root.metrics.map((entry, index) => {
		const label = `metrics[${index}]`;
		const metric = expectRecord(entry, label);
		expectExactKeys(
			metric,
			[
				'direction',
				'metricId',
				'practicalMargin'
			],
			label
		);
		const identity = validateMetricIdentity(
			metric,
			label
		);
		if (seen.has(identity.metricId)) {
			throw new TypeError(
				`Duplicate practical margin ${identity.metricId}.`
			);
		}
		seen.add(identity.metricId);
		return {
			...identity,
			practicalMargin: finiteNonNegative(
				metric.practicalMargin,
				`${label}.practicalMargin`
			)
		};
	});
	if (metrics.length !== SUPPORTED_METRICS.size) {
		throw new TypeError(
			'Practical margin policy must define every '
				+ 'headline metric exactly once.'
		);
	}
	const minimumPairedBlocks = boundedInteger(
		root.minimumPairedBlocks,
		'minimumPairedBlocks',
		RUNTIME_TOURNAMENT_MINIMUM_BLOCKS,
		1_000
	);
	const targetPairedBlocks = boundedInteger(
		root.targetPairedBlocks,
		'targetPairedBlocks',
		minimumPairedBlocks,
		1_000
	);
	return {
		bootstrapIterations: boundedInteger(
			root.bootstrapIterations,
			'bootstrapIterations',
			1_000,
			100_000
		),
		confidenceLevel: boundedNumber(
			root.confidenceLevel,
			'confidenceLevel',
			0.8,
			0.999_999
		),
		metrics,
		minimumPairedBlocks,
		noisePercentile: boundedNumber(
			root.noisePercentile,
			'noisePercentile',
			0.5,
			1
		),
		targetPairedBlocks,
		version: 1
	};
}

async function readJsonFile(
	path: string,
	label: string
): Promise<{
	filePath: string;
	fileSha256: string;
	parsed: unknown;
}> {
	const filePath = await realpath(resolve(path));
	const source = await readFile(filePath);
	try {
		return {
			filePath,
			fileSha256: sha256Hex(source),
			parsed: JSON.parse(source.toString('utf8'))
		};
	} catch (error) {
		throw new TypeError(
			`${label} is not valid JSON: `
				+ (
					error instanceof Error
						? error.message
						: String(error)
				)
		);
	}
}

export async function resolveRuntimeTournamentMetricPolicyFileWithProvenance(
	path: string
): Promise<ResolvedRuntimeTournamentMetricPolicyFile> {
	const {
		filePath,
		fileSha256,
		parsed
	} = await readJsonFile(path, 'Metric policy file');
	if (Array.isArray(parsed)) {
		return {
			filePath,
			fileSha256,
			kind: 'raw-policy',
			metricPolicies:
				validateRuntimeTournamentMetricPolicies(parsed)
		};
	}
	const report = validateRuntimeTournamentNoiseFloorReport(
		parsed
	);
	return {
		filePath,
		fileSha256,
		kind: 'noise-floor-report',
		metricPolicies: report.metricPolicies,
		noiseFloorReport: report,
		reportSha256: report.reportSha256
	};
}

export async function resolveRuntimeTournamentMetricPolicyFile(
	path: string
): Promise<RuntimeTournamentMetricPolicy[]> {
	return (
		await resolveRuntimeTournamentMetricPolicyFileWithProvenance(
			path
		)
	).metricPolicies;
}

export async function resolveRuntimeTournamentPracticalMarginPolicy(
	path: string
): Promise<RuntimeTournamentPracticalMarginPolicy> {
	return validateRuntimeTournamentPracticalMarginPolicy(
		(
			await readJsonFile(
				path,
				'Practical margin policy'
			)
		).parsed
	);
}
