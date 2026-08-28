import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeCpuProfile, formatCpuProfileAnalysis } from '../scripts/analyze-runtime-profile.mjs';

const profile = {
	endTime: 10_000,
	nodes: [
		{ callFrame: { columnNumber: 2, functionName: 'gameLoop', lineNumber: 10, url: '' }, children: [3], id: 1 },
		{ callFrame: { columnNumber: 0, functionName: '(garbage collector)', lineNumber: 0, url: '' }, id: 2 },
		{ callFrame: { columnNumber: 4, functionName: 'wokHook', lineNumber: 20, url: 'file:///Wok/preload.mjs' }, id: 3 }
	],
	samples: [1, 2, 1, 3],
	startTime: 0,
	timeDeltas: [1_000, 2_000, 1_000, 6_000]
};

test('ranks CPU-profile nodes by measured self-time and separates runtime categories', () => {
	const analysis = analyzeCpuProfile(profile, 10);

	assert.equal(analysis.durationMs, 10);
	assert.equal(analysis.attributedMs, 10);
	assert.equal(analysis.sampleCount, 4);
	assert.equal(analysis.usedRecordedTimeDeltas, true);
	assert.deepEqual(analysis.topInclusive.slice(0, 2).map(entry => [entry.functionName, entry.inclusiveMs, entry.inclusivePercent]), [
		['gameLoop', 8, 80],
		['wokHook', 6, 60]
	]);
	assert.deepEqual(analysis.top.map(entry => ({
		category: entry.category,
		functionName: entry.functionName,
		selfMs: entry.selfMs,
		selfPercent: entry.selfPercent
	})), [
		{ category: 'wok', functionName: 'wokHook', selfMs: 6, selfPercent: 60 },
		{ category: 'page', functionName: 'gameLoop', selfMs: 2, selfPercent: 20 },
		{ category: 'garbage-collector', functionName: '(garbage collector)', selfMs: 2, selfPercent: 20 }
	]);
});

test('falls back to profile duration when recorded sample deltas are unavailable', () => {
	const analysis = analyzeCpuProfile({ ...profile, timeDeltas: undefined }, 2);

	assert.equal(analysis.usedRecordedTimeDeltas, false);
	assert.equal(analysis.attributedMs, 10);
	assert.deepEqual(analysis.top.map(entry => [entry.functionName, entry.selfMs]), [
		['gameLoop', 5],
		['(garbage collector)', 2.5]
	]);
});

test('formats a readable report with anonymous-script locations', () => {
	const report = formatCpuProfileAnalysis(analyzeCpuProfile(profile, 10));

	assert.match(report, /Duration: 10\.0 ms/);
	assert.match(report, /60\.00%\s+6\.0 ms\s+wokHook/);
	assert.match(report, /gameLoop\s+<anonymous-script>:11:3/);
});

test('rejects malformed profiles and unsafe output limits', () => {
	assert.throws(() => analyzeCpuProfile({}, 10), /nodes and samples/);
	assert.throws(() => analyzeCpuProfile({ nodes: [], samples: [] }, 10), /no valid nodes/);
	assert.throws(() => analyzeCpuProfile(profile, 0), /limit/);
});
