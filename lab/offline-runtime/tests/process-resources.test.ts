import assert from 'node:assert/strict';
import test from 'node:test';
import {
	aggregateProcessTreeResourceSample,
	assessProcessTreeResourceCoverage,
	summarizeProcessTreeResourceSamples,
	type ProcessTreeResourceSample
} from '../src/host/process-resources.ts';

const first: ProcessTreeResourceSample = {
	capturedAtMs: 1_000,
	processes: [
		{ cpuPercent: 10, executableName: 'client.exe', privateBytes: 1_000, processId: 100, workingSetBytes: 1_500 },
		{ cpuPercent: 25, executableName: 'renderer.exe', parentProcessId: 100, privateBytes: 2_000, processId: 101, workingSetBytes: 2_500 }
	],
	rootProcessId: 100
};

const second: ProcessTreeResourceSample = {
	capturedAtMs: 2_000,
	processes: [
		{ cpuPercent: 20, executableName: 'client.exe', privateBytes: 1_500, processId: 100, workingSetBytes: 2_000 },
		{ cpuPercent: 40, executableName: 'renderer.exe', parentProcessId: 100, privateBytes: 2_500, processId: 101, workingSetBytes: 3_000 },
		{ cpuPercent: 5, executableName: 'gpu.exe', parentProcessId: 100, privateBytes: 500, processId: 102, workingSetBytes: 750 }
	],
	rootProcessId: 100
};

test('process-tree aggregation sums CPU and memory without performing OS sampling', () => {
	assert.deepEqual(aggregateProcessTreeResourceSample(first), {
		capturedAtMs: 1_000,
		processCount: 2,
		rootPresent: true,
		rootProcessId: 100,
		totalCpuPercent: 35,
		totalPrivateBytes: 3_000,
		totalWorkingSetBytes: 4_000
	});
});

test('process-tree summaries report average and peak resources and process counts', () => {
	const summary = summarizeProcessTreeResourceSamples([second, first]);
	assert.equal(summary.sampleCount, 2);
	assert.equal(summary.firstCapturedAtMs, 1_000);
	assert.equal(summary.lastCapturedAtMs, 2_000);
	assert.equal(summary.averageCpuPercent, 50);
	assert.equal(summary.peakCpuPercent, 65);
	assert.equal(summary.averageWorkingSetBytes, 4_875);
	assert.equal(summary.peakWorkingSetBytes, 5_750);
	assert.equal(summary.averagePrivateBytes, 3_750);
	assert.equal(summary.peakPrivateBytes, 4_500);
	assert.equal(summary.averageProcessCount, 2.5);
	assert.equal(summary.minimumProcessCount, 2);
	assert.equal(summary.maximumProcessCount, 3);
});

test('process-tree aggregation records a missing root and rejects duplicate process IDs', () => {
	const rootMissing = aggregateProcessTreeResourceSample({
		capturedAtMs: 1,
		processes: [{ cpuPercent: 0, executableName: 'renderer.exe', parentProcessId: 100, privateBytes: 0, processId: 101, workingSetBytes: 0 }],
		rootProcessId: 100
	});
	assert.equal(rootMissing.rootPresent, false);

	assert.throws(
		() => aggregateProcessTreeResourceSample({ capturedAtMs: 1, processes: [first.processes[0], first.processes[0]], rootProcessId: 100 }),
		/duplicate process ID/u
	);
});

test('resource coverage requires cadence, benchmark boundaries and the root process', () => {
	const samples = [1_000, 1_250, 1_500, 1_750, 2_000, 2_250, 2_500, 2_750, 3_000].map(capturedAtMs => ({
		...first,
		capturedAtMs
	}));
	const coverage = assessProcessTreeResourceCoverage(samples, {
		endTimestampMs: 3_000,
		intervalMs: 250,
		startTimestampMs: 1_000
	});
	assert.equal(coverage.valid, true);
	assert.equal(coverage.sampleCount, 9);

	const incomplete = assessProcessTreeResourceCoverage([samples[4]], {
		endTimestampMs: 3_000,
		intervalMs: 250,
		startTimestampMs: 1_000
	});
	assert.equal(incomplete.valid, false);
	assert.ok(incomplete.reasons.includes('resource-coverage-start-missing'));
	assert.ok(incomplete.reasons.includes('resource-coverage-end-missing'));

	const missingCounters = assessProcessTreeResourceCoverage(
		samples.map(sample => ({
			...sample,
			processes: sample.processes.map(process => ({
				...process,
				performanceCountersPresent: false
			}))
		})),
		{
			endTimestampMs: 3_000,
			intervalMs: 250,
			startTimestampMs: 1_000
		}
	);
	assert.equal(missingCounters.valid, false);
	assert.ok(missingCounters.reasons.includes('resource-performance-counters-missing'));
});

test('resource coverage uses the declared cadence and nearest boundary samples', () => {
	const startTimestampMs = 10_000;
	const endTimestampMs = startTimestampMs + 6_387;
	const offsets = [-314, 573, 1_567, 2_566, 3_512, 4_463, 5_494, 6_458];
	const samples = offsets.map(offset => ({
		...first,
		capturedAtMs: startTimestampMs + offset
	}));
	const coverage = assessProcessTreeResourceCoverage(samples, {
		endTimestampMs,
		intervalMs: 1_000,
		startTimestampMs
	});
	assert.equal(coverage.valid, true);
	assert.equal(coverage.expectedMinimumSamples, 5);
	assert.equal(coverage.sampleCount, 6);
	assert.equal(coverage.firstCapturedAtMs, startTimestampMs + 573);
	assert.equal(coverage.lastCapturedAtMs, startTimestampMs + 5_494);
	assert.equal(coverage.maximumGapMs, 1_031);

	const falselyDeclaredFastCadence = assessProcessTreeResourceCoverage(samples, {
		endTimestampMs,
		intervalMs: 250,
		startTimestampMs
	});
	assert.equal(falselyDeclaredFastCadence.valid, false);
	assert.equal(falselyDeclaredFastCadence.expectedMinimumSamples, 18);
	assert.ok(falselyDeclaredFastCadence.reasons.includes('insufficient-resource-samples:6/18'));
	assert.ok(falselyDeclaredFastCadence.reasons.includes('resource-sampling-gap:1031'));
});

test('resource coverage assesses a declared two-second monitor period without inflating in-range samples', () => {
	const startTimestampMs = 20_000;
	const endTimestampMs = startTimestampMs + 6_292;
	const offsets = [-1_476, 375, 2_289, 4_060, 5_877, 7_634];
	const samples = offsets.map(offset => ({
		...first,
		capturedAtMs: startTimestampMs + offset
	}));
	const coverage = assessProcessTreeResourceCoverage(samples, {
		endTimestampMs,
		intervalMs: 2_000,
		startTimestampMs
	});
	assert.equal(coverage.valid, true);
	assert.equal(coverage.expectedMinimumSamples, 3);
	assert.equal(coverage.sampleCount, 4);
	assert.equal(coverage.maximumGapMs, 1_914);

	const falselyDeclaredOneSecondCadence = assessProcessTreeResourceCoverage(samples, {
		endTimestampMs,
		intervalMs: 1_000,
		startTimestampMs
	});
	assert.equal(falselyDeclaredOneSecondCadence.valid, false);
	assert.ok(falselyDeclaredOneSecondCadence.reasons.includes('insufficient-resource-samples:4/5'));
});

test('empty process-tree summaries remain explicit', () => {
	assert.deepEqual(summarizeProcessTreeResourceSamples([]), { sampleCount: 0 });
});
