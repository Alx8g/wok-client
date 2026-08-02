import assert from 'node:assert/strict';
import {
	mkdir,
	mkdtemp,
	writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type {
	RuntimeTournamentMetricPolicy
} from '../src/controller/tournament-controller.ts';
import {
	resolveRuntimeTournamentMetricPolicyFile,
	resolveRuntimeTournamentPracticalMarginPolicy,
	validateRuntimeTournamentMetricPolicies,
	validateRuntimeTournamentPracticalMarginPolicy
} from '../src/controller/tournament-policy.ts';
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

const policiesDirectory = join(
	repositoryRoot,
	'lab',
	'offline-runtime',
	'policies'
);

test('checked-in practical margins define every headline metric and statistical gate', async () => {
	const policy =
		await resolveRuntimeTournamentPracticalMarginPolicy(
			join(
				policiesDirectory,
				'practical-margins-v1.json'
			)
		);
	assert.equal(policy.version, 1);
	assert.equal(policy.metrics.length, 4);
	assert.equal(policy.minimumPairedBlocks, 7);
	assert.equal(policy.targetPairedBlocks, 10);
	assert.equal(policy.noisePercentile, 0.95);
	assert.equal(policy.confidenceLevel, 0.95);
	assert.equal(policy.bootstrapIterations, 10_000);
});

test('same-build capture policy is a strict controller-compatible metric policy', async () => {
	const policies =
		await resolveRuntimeTournamentMetricPolicyFile(
			join(
				policiesDirectory,
				'same-build-noise-capture-v1.json'
			)
		);
	assert.equal(policies.length, 4);
	assert.ok(
		policies.every(policy => policy.noiseFloor === 0)
	);
	assert.deepEqual(
		policies.map(policy => policy.metricId).sort(),
		[
			'average-fps',
			'frame-time-p95-ms',
			'frame-time-p99-ms',
			'one-percent-low-fps'
		]
	);
});

test('content-addressed noise reports can feed final tournament policies directly', async () => {
	const directory = await mkdtemp(
		join(testOutputRoot, 'policy-report-')
	);
	const metricPolicies: RuntimeTournamentMetricPolicy[] = [
		{
			direction: 'higher-is-better',
			metricId: 'average-fps',
			noiseFloor: 1.25,
			practicalMargin: 2
		},
		{
			direction: 'lower-is-better',
			metricId: 'frame-time-p95-ms',
			noiseFloor: 0.4,
			practicalMargin: 0.5
		},
		{
			direction: 'lower-is-better',
			metricId: 'frame-time-p99-ms',
			noiseFloor: 0.8,
			practicalMargin: 1
		},
		{
			direction: 'higher-is-better',
			metricId: 'one-percent-low-fps',
			noiseFloor: 1.5,
			practicalMargin: 2
		}
	];
	const reportWithoutHash = {
		candidateIds: ['candidate-a', 'candidate-b'],
		executableSha256: sha256Hex('same-runtime'),
		metricPolicies,
		metrics: metricPolicies.map(policy => ({
			blockCount: 7,
			...policy
		})),
		minimumPairedBlocks: 7,
		percentile: 0.95,
		tournamentId: 'noise-floor-policy',
		tournamentResultPath: join(
			directory,
			'tournament-result.json'
		),
		tournamentResultSha256: sha256Hex(
			'tournament-result'
		),
		version: 2
	};
	const report = {
		...reportWithoutHash,
		reportSha256: sha256Hex(
			canonicalJson(reportWithoutHash)
		)
	};
	const reportPath = join(directory, 'noise-report.json');
	await writeFile(reportPath, JSON.stringify(report));
	assert.deepEqual(
		await resolveRuntimeTournamentMetricPolicyFile(
			reportPath
		),
		metricPolicies
	);

	report.metricPolicies[0].noiseFloor = 9;
	report.metrics[0].noiseFloor = 9;
	await writeFile(reportPath, JSON.stringify(report));
	await assert.rejects(
		resolveRuntimeTournamentMetricPolicyFile(reportPath),
		/report SHA-256 does not match/u
	);
});

test('policy validation rejects wrong metric direction, unsupported fields and incomplete margins', () => {
	assert.throws(
		() => validateRuntimeTournamentMetricPolicies([
			{
				direction: 'lower-is-better',
				metricId: 'average-fps',
				noiseFloor: 1,
				practicalMargin: 2
			}
		]),
		/direction must be higher-is-better/u
	);
	assert.throws(
		() => validateRuntimeTournamentMetricPolicies([
			{
				direction: 'higher-is-better',
				metricId: 'average-fps',
				noiseFloor: 1,
				practicalMargin: 2,
				unexpected: true
			}
		]),
		/unexpected is not supported/u
	);
	assert.throws(
		() => validateRuntimeTournamentPracticalMarginPolicy({
			bootstrapIterations: 10_000,
			confidenceLevel: 0.95,
			metrics: [],
			minimumPairedBlocks: 7,
			noisePercentile: 0.95,
			targetPairedBlocks: 10,
			version: 1
		}),
		/define every headline metric/u
	);
});
