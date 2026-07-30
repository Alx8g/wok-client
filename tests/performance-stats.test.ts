import assert from 'node:assert/strict';
import test from 'node:test';
import {
	FRAME_TIME_BIN_WIDTH_MS,
	PERFORMANCE_TIME_BUCKET_MS,
	PERFORMANCE_WINDOW_MS,
	RollingPerformanceStats
} from '../src/performance-stats.ts';

function recordFrames(stats: RollingPerformanceStats, frameTimes: readonly number[], startTime = 0): number {
	let timestamp = startTime;
	for (const frameTime of frameTimes) {
		timestamp += frameTime;
		stats.recordFrame(timestamp, frameTime);
	}
	return timestamp;
}

test('calculates stable frame-rate diagnostics', () => {
	const stats = new RollingPerformanceStats();
	const timestamp = recordFrames(stats, Array.from({ length: 100 }, () => 10));
	const snapshot = stats.snapshot(timestamp);

	assert.deepEqual(snapshot, {
		averageFps: 100,
		currentFps: 100,
		onePercentLowFps: 100,
		p95FrameTimeMs: 10,
		sampleCount: 100,
		worstFrameTimeMs: 10,
		windowSeconds: 1
	});
});

test('surfaces a slow frame through 1% low and worst-frame metrics', () => {
	const stats = new RollingPerformanceStats();
	const samples = [...Array.from({ length: 99 }, () => 5), 50];
	const timestamp = recordFrames(stats, samples);
	const snapshot = stats.snapshot(timestamp);

	assert.equal(snapshot.averageFps, 183.5);
	assert.equal(snapshot.onePercentLowFps, 20);
	assert.equal(snapshot.p95FrameTimeMs, 5);
	assert.equal(snapshot.worstFrameTimeMs, 50);
	assert.equal(snapshot.sampleCount, 100);
});

test('keeps percentile approximations within the documented histogram error', () => {
	const stats = new RollingPerformanceStats();
	const samples = Array.from({ length: 1_000 }, (_, index) => 5 + ((index * 37) % 3_500) / 100);
	for (let index = 0; index < samples.length; index++) stats.recordFrame(index + 1, samples[index]);

	const sorted = [...samples].sort((left, right) => left - right);
	const exactP95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
	const slowSampleCount = Math.ceil(sorted.length * 0.01);
	const exactSlowFrameTime = sorted.slice(-slowSampleCount).reduce((total, frameTime) => total + frameTime, 0) / slowSampleCount;
	const snapshot = stats.snapshot(samples.length);
	const estimatedSlowFrameTime = 1000 / snapshot.onePercentLowFps;
	const roundingAllowanceMs = 0.1;

	assert.ok(Math.abs(snapshot.p95FrameTimeMs - exactP95) <= FRAME_TIME_BIN_WIDTH_MS / 2 + 0.01);
	assert.ok(Math.abs(estimatedSlowFrameTime - exactSlowFrameTime) <= FRAME_TIME_BIN_WIDTH_MS / 2 + roundingAllowanceMs);
});

test('expires the cutoff bucket within one bounded time bucket', () => {
	const stats = new RollingPerformanceStats();
	stats.recordFrame(1, 10);

	assert.equal(stats.snapshot(PERFORMANCE_WINDOW_MS + 1).sampleCount, 1);
	assert.equal(stats.snapshot(PERFORMANCE_WINDOW_MS + PERFORMANCE_TIME_BUCKET_MS).sampleCount, 0);
});

test('uses only the recent time buckets for current FPS', () => {
	const stats = new RollingPerformanceStats();
	let timestamp = recordFrames(stats, Array.from({ length: 100 }, () => 10));
	timestamp = recordFrames(stats, Array.from({ length: 100 }, () => 20), timestamp);

	const snapshot = stats.snapshot(timestamp);
	assert.equal(snapshot.averageFps, 66.7);
	assert.equal(snapshot.currentFps, 50);
});

test('reset and empty snapshots return zeroed diagnostics', () => {
	const stats = new RollingPerformanceStats();
	stats.recordFrame(10, 10);
	stats.reset();
	const snapshot = stats.snapshot(10);

	assert.deepEqual(snapshot, {
		averageFps: 0,
		currentFps: 0,
		onePercentLowFps: 0,
		p95FrameTimeMs: 0,
		sampleCount: 0,
		worstFrameTimeMs: 0,
		windowSeconds: 0
	});
});
