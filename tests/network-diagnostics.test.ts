import assert from 'node:assert/strict';
import test from 'node:test';
import {
	MAX_REPORTED_PING_MS,
	MAX_REPORTED_PING_SAMPLES,
	parseKrunkerRegionCode,
	parseKrunkerReportedPing,
	parseKrunkerReportedTps,
	REPORTED_PING_WINDOW_MS,
	RollingReportedPingStats
} from '../src/network-diagnostics.ts';

test('calculates bounded Krunker-reported ping statistics without reinterpreting RTT', () => {
	const stats = new RollingReportedPingStats();
	stats.record(1_000, 24);
	stats.record(2_000, 26);
	stats.record(3_000, 25);
	stats.record(4_000, 80);
	const snapshot = stats.snapshot(5_000);

	assert.deepEqual(snapshot, {
		available: true,
		currentMs: 80,
		minimumMs: 24,
		medianMs: 25,
		p95Ms: 80,
		variationMs: 19.3,
		sampleAgeMs: 1_000,
		sampleCount: 4,
		windowSeconds: 4
	});
});

test('rejects invalid samples and expires old measurements', () => {
	const stats = new RollingReportedPingStats();
	for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, MAX_REPORTED_PING_MS + 1]) {
		stats.record(1, invalid);
	}
	stats.record(-1, 24);
	stats.record(Number.NaN, 24);
	assert.equal(stats.snapshot(10).available, false);

	stats.record(100, 24);
	assert.equal(stats.snapshot(100 + REPORTED_PING_WINDOW_MS - 1).sampleCount, 1);
	assert.equal(stats.snapshot(100 + REPORTED_PING_WINDOW_MS + 1).sampleCount, 0);
});

test('retains only the fixed-capacity newest reported-ping samples', () => {
	const stats = new RollingReportedPingStats();
	for (let index = 0; index < MAX_REPORTED_PING_SAMPLES + 10; index++) {
		stats.record(index, index + 1);
	}
	const snapshot = stats.snapshot(MAX_REPORTED_PING_SAMPLES + 10);

	assert.equal(snapshot.sampleCount, MAX_REPORTED_PING_SAMPLES);
	assert.equal(snapshot.minimumMs, 11);
	assert.equal(snapshot.currentMs, MAX_REPORTED_PING_SAMPLES + 10);
});

test('reset clears all reported-ping state', () => {
	const stats = new RollingReportedPingStats();
	stats.record(10, 24);
	stats.reset();
	assert.deepEqual(stats.snapshot(10), {
		available: false,
		currentMs: 0,
		minimumMs: 0,
		medianMs: 0,
		p95Ms: 0,
		variationMs: 0,
		sampleAgeMs: 0,
		sampleCount: 0,
		windowSeconds: 0
	});
});

test('parses only bounded Krunker telemetry values and game IDs', () => {
	assert.equal(parseKrunkerReportedPing('24'), 24);
	assert.equal(parseKrunkerReportedPing(' 24.5 ms'), 24.5);
	assert.equal(parseKrunkerReportedPing('0'), undefined);
	assert.equal(parseKrunkerReportedPing('not available'), undefined);
	assert.equal(parseKrunkerReportedPing(`${MAX_REPORTED_PING_MS + 1}`), undefined);

	assert.equal(parseKrunkerReportedTps('30 TPS'), 30);
	assert.equal(parseKrunkerReportedTps(' 59.5 tps '), 59.5);
	assert.equal(parseKrunkerReportedTps('30'), undefined);
	assert.equal(parseKrunkerReportedTps('1001 TPS'), undefined);

	assert.equal(parseKrunkerRegionCode('SYD:lk6tt'), 'SYD');
	assert.equal(parseKrunkerRegionCode('fra:2dkoy'), 'FRA');
	assert.equal(parseKrunkerRegionCode('missing-separator'), undefined);
	assert.equal(parseKrunkerRegionCode('TOO-LONG-CODE:abc'), undefined);
	assert.equal(parseKrunkerRegionCode({ id: 'SYD:lk6tt' }), undefined);
});
