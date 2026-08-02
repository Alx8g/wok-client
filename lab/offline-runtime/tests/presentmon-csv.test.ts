import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzePresentMonCsv, parsePresentMonCsv } from '../src/host/presentmon-csv.ts';

const v2Csv = [
	'Application,ProcessID,SwapChainAddress,FrameType,CPUStartTime,FrameTime,DisplayedTime',
	'"Game, Client.exe",100,0xAAA,Application,0,8,8',
	'"Game, Client.exe",100,0xAAA,Application,50,10,NA',
	'"Game, Client.exe",100,0xAAA,Application,100,20,20',
	'"Game, Client.exe",100,0xAAA,Application,150,50,NA',
	'helper.exe,200,0xBBB,Application,0,5,5',
	'helper.exe,200,0xBBB,Application,120,25,25'
].join('\r\n');

test('PresentMon v2 analysis filters warmup and reports per-PID/swapchain pacing and drops', () => {
	const analysis = analyzePresentMonCsv(v2Csv, { frameBudgetMs: 20, minimumFrameSamples: 1, warmupMs: 100 });
	assert.equal(analysis.valid, true);
	assert.equal(analysis.schema, 'v2');
	assert.equal(analysis.timestampColumn, 'CPUStartTime');
	assert.equal(analysis.classificationSource, 'displayed-time-column');
	assert.equal(analysis.totalRecordCount, 6);
	assert.equal(analysis.postWarmupRecordCount, 3);
	assert.deepEqual(analysis.capturedProcessIds, [100, 200]);
	assert.deepEqual(analysis.presentingProcessIds, [100, 200]);
	assert.equal(analysis.streams.length, 2);

	const game = analysis.streams.find(stream => stream.processId === 100);
	assert.ok(game);
	assert.deepEqual(game.applicationNames, ['Game, Client.exe']);
	assert.equal(game.swapChainAddress, '0xAAA');
	assert.equal(game.sampleCount, 2);
	assert.equal(game.displayedFrameCount, 1);
	assert.equal(game.droppedFrameCount, 1);
	assert.equal(game.averageFps, 1_000 / 35);
	assert.equal(game.onePercentLowFps, 20);
	assert.equal(game.frameTimeP50Ms, 20);
	assert.equal(game.frameTimeP95Ms, 50);
	assert.equal(game.frameTimeP99Ms, 50);
	assert.equal(game.frameTimeWorstMs, 50);
	assert.equal(game.fixedBudgetMissCount, 1);
	assert.equal(game.fixedBudgetMissRatio, 0.5);
	assert.equal(game.stutterCount, 1);
	assert.equal(game.stutterRatio, 0.5);

	assert.equal(analysis.overall.sampleCount, 3);
	assert.equal(analysis.overall.displayedFrameCount, 2);
	assert.equal(analysis.overall.droppedFrameCount, 1);
	assert.equal(analysis.overall.frameTimeP50Ms, 25);
	assert.equal(analysis.overall.frameTimeWorstMs, 50);
	assert.equal(analysis.overall.fixedBudgetMissCount, 2);
});

test('PresentMon v1 analysis supports BOM, TimeInSeconds, legacy frame times and Dropped', () => {
	const csv = [
		'﻿Application,ProcessID,SwapChainAddress,Dropped,TimeInSeconds,msBetweenPresents,msUntilDisplayed',
		'app.exe,10,0x1,0,0,5,5',
		'app.exe,10,0x1,1,0.5,10,NA',
		'app.exe,10,0x1,0,1,16,16',
		'app.exe,10,0x1,1,1.1,34,NA'
	].join('\n');
	const parsed = parsePresentMonCsv(csv);
	assert.equal(parsed.schema, 'v1');
	assert.equal(parsed.records[0].timestampMs, 0);
	assert.equal(parsed.records[3].timestampMs, 1_100);

	const analysis = analyzePresentMonCsv(csv, { frameBudgetMs: 16, minimumFrameSamples: 2, warmupMs: 1_000 });
	assert.equal(analysis.valid, true);
	assert.equal(analysis.overall.sampleCount, 2);
	assert.equal(analysis.overall.averageFps, 40);
	assert.equal(analysis.overall.displayedFrameCount, 1);
	assert.equal(analysis.overall.droppedFrameCount, 1);
	assert.equal(analysis.overall.fixedBudgetMissCount, 1);
	assert.equal(analysis.overall.frameTimeP50Ms, 16);
	assert.equal(analysis.overall.frameTimeP95Ms, 34);
	assert.equal(analysis.overall.frameTimeWorstMs, 34);
});

test('PresentMon analysis computes slowest-one-percent FPS and nearest-rank percentiles', () => {
	const frameTimes = [...Array.from({ length: 99 }, () => 10), 100];
	const rows = frameTimes.map((frameTime, index) => `app.exe,10,0x1,0,${index},${frameTime}`);
	const csv = ['Application,ProcessID,SwapChainAddress,Dropped,TimeInMs,MsBetweenPresents', ...rows].join('\n');
	const analysis = analyzePresentMonCsv(csv, { frameBudgetMs: 16, minimumFrameSamples: 100, warmupMs: 0 });
	assert.equal(analysis.valid, true);
	assert.equal(analysis.overall.onePercentLowFps, 10);
	assert.equal(analysis.overall.frameTimeP50Ms, 10);
	assert.equal(analysis.overall.frameTimeP95Ms, 10);
	assert.equal(analysis.overall.frameTimeP99Ms, 10);
	assert.equal(analysis.overall.frameTimeWorstMs, 100);
	assert.equal(analysis.overall.fixedBudgetMissCount, 1);
	assert.equal(analysis.overall.stutterCount, 1);
	assert.equal(analysis.overall.stutterRatio, 0.01);
});

test('PresentMon analysis refuses to silently skip a requested warmup without timestamps', () => {
	const csv = ['Application,ProcessID,SwapChainAddress,FrameTime,DisplayedTime', 'app.exe,10,0x1,16,16'].join('\n');
	const analysis = analyzePresentMonCsv(csv, { minimumFrameSamples: 1, warmupMs: 1_000 });
	assert.equal(analysis.valid, false);
	assert.ok(analysis.reasons.includes('warmup-timestamp-column-unavailable'));
	assert.equal(analysis.postWarmupRecordCount, 0);
});

test('PresentMon analysis retains unknown display classification instead of claiming zero drops', () => {
	const csv = ['Application,ProcessID,SwapChainAddress,TimeInMs,MsBetweenPresents', 'app.exe,10,0x1,0,16'].join('\n');
	const analysis = analyzePresentMonCsv(csv, { minimumFrameSamples: 1, warmupMs: 0 });
	assert.equal(analysis.valid, true);
	assert.equal(analysis.classificationSource, 'unavailable');
	assert.equal(analysis.overall.displayedFrameCount, 0);
	assert.equal(analysis.overall.droppedFrameCount, 0);
	assert.equal(analysis.overall.unknownDisplayStatusCount, 1);
	assert.ok(analysis.warnings.includes('display-classification-unavailable'));
});

test('PresentMon warmup supports v2 ISO timestamps with nanosecond precision', () => {
	const csv = [
		'Application,ProcessID,SwapChainAddress,CPUStartDateTime,FrameTime,DisplayedTime',
		'app.exe,10,0x1,2026-08-01T12:00:00.000000000Z,10,10',
		'app.exe,10,0x1,2026-08-01T12:00:00.002000000Z,20,20'
	].join('\n');
	const analysis = analyzePresentMonCsv(csv, { minimumFrameSamples: 1, warmupMs: 2 });
	assert.equal(analysis.valid, true);
	assert.equal(analysis.postWarmupRecordCount, 1);
	assert.equal(analysis.overall.frameTimeP50Ms, 20);
});

test('PresentMon analysis aligns frames to the exact page benchmark epoch range', () => {
	const csv = [
		'Application,ProcessID,SwapChainAddress,CPUStartDateTime,FrameTime,DisplayedTime',
		'app.exe,10,0x1,2026-08-01T12:00:00.000000000Z,100,100',
		'app.exe,10,0x1,2026-08-01T12:00:01.000000000Z,10,10',
		'app.exe,10,0x1,2026-08-01T12:00:02.000000000Z,20,20',
		'app.exe,10,0x1,2026-08-01T12:00:03.000000000Z,200,200'
	].join('\n');
	const startTimestampMs = Date.parse('2026-08-01T12:00:00.500Z');
	const endTimestampMs = Date.parse('2026-08-01T12:00:02.500Z');
	const analysis = analyzePresentMonCsv(csv, {
		endTimestampMs,
		minimumFrameSamples: 2,
		startTimestampMs,
		warmupMs: 0
	});
	assert.equal(analysis.valid, true);
	assert.equal(analysis.startTimestampMs, startTimestampMs);
	assert.equal(analysis.endTimestampMs, endTimestampMs);
	assert.equal(analysis.postWarmupRecordCount, 2);
	assert.equal(
		analysis.captureFirstTimestampMs,
		Date.parse('2026-08-01T12:00:00.000Z')
	);
	assert.equal(
		analysis.captureLastTimestampMs,
		Date.parse('2026-08-01T12:00:03.000Z')
	);
	assert.equal(
		analysis.streams[0]?.firstTimestampMs,
		Date.parse('2026-08-01T12:00:01.000Z')
	);
	assert.equal(
		analysis.streams[0]?.lastTimestampMs,
		Date.parse('2026-08-01T12:00:02.000Z')
	);
	assert.equal(analysis.overall.frameTimeP50Ms, 10);
	assert.equal(analysis.overall.frameTimeWorstMs, 20);
});

test('PresentMon stream timestamp bounds are independent and order-insensitive', () => {
	const csv = [
		'Application,ProcessID,SwapChainAddress,CPUStartDateTime,FrameTime,DisplayedTime',
		'app.exe,10,0x1,2026-08-01T12:00:03.000000000Z,10,10',
		'app.exe,20,0x2,2026-08-01T12:00:04.000000000Z,10,10',
		'app.exe,10,0x1,2026-08-01T12:00:01.000000000Z,10,10',
		'app.exe,20,0x2,2026-08-01T12:00:02.000000000Z,10,10'
	].join('\n');
	const analysis = analyzePresentMonCsv(csv, {
		minimumFrameSamples: 1,
		warmupMs: 0
	});
	assert.equal(analysis.valid, true);
	const first = analysis.streams.find(stream => stream.processId === 10);
	const second = analysis.streams.find(stream => stream.processId === 20);
	assert.equal(
		first?.firstTimestampMs,
		Date.parse('2026-08-01T12:00:01.000Z')
	);
	assert.equal(
		first?.lastTimestampMs,
		Date.parse('2026-08-01T12:00:03.000Z')
	);
	assert.equal(
		second?.firstTimestampMs,
		Date.parse('2026-08-01T12:00:02.000Z')
	);
	assert.equal(
		second?.lastTimestampMs,
		Date.parse('2026-08-01T12:00:04.000Z')
	);
});

test('PresentMon aligns zone-less date-time output to the verified capture-process envelope', () => {
	const csv = [
		'Application,ProcessID,SwapChainAddress,CPUStartDateTime,FrameTime,DisplayedTime',
		'wok-electron-44.exe,30232,0x1,2026-8-2 6:46:27.442303200,100,100',
		'wok-electron-44.exe,30232,0x1,2026-8-2 6:46:30.000000000,10,10',
		'wok-electron-44.exe,30232,0x1,2026-8-2 6:46:35.000000000,20,20',
		'wok-electron-44.exe,30232,0x1,2026-8-2 6:46:37.334000000,200,200'
	].join('\n');
	const analysis = analyzePresentMonCsv(csv, {
		captureProcessEndTimestampMs: Date.parse('2026-08-01T06:46:37.439Z'),
		captureProcessStartTimestampMs: Date.parse('2026-08-01T06:46:27.368Z'),
		captureTimezoneOffsetMinutes: -720,
		endTimestampMs: Date.parse('2026-08-01T06:46:35.994Z'),
		minimumFrameSamples: 2,
		startTimestampMs: Date.parse('2026-08-01T06:46:29.607Z'),
		warmupMs: 0
	});
	assert.equal(analysis.valid, true);
	assert.equal(analysis.timestampAdjustmentMs, -86_400_000);
	assert.equal(analysis.captureFirstTimestampMs, Date.parse('2026-08-01T06:46:27.442Z'));
	assert.equal(analysis.captureLastTimestampMs, Date.parse('2026-08-01T06:46:37.334Z'));
	assert.deepEqual(analysis.capturedProcessIds, [30232]);
	assert.deepEqual(analysis.presentingProcessIds, [30232]);
	assert.equal(analysis.postWarmupRecordCount, 2);
	assert.equal(analysis.overall.frameTimeP50Ms, 10);
	assert.equal(analysis.overall.frameTimeWorstMs, 20);
});

test('PresentMon leaves explicit-zone timestamps unchanged during capture-envelope validation', () => {
	const timestampMs = Date.parse('2026-08-01T12:00:00.000Z');
	const csv = [
		'Application,ProcessID,SwapChainAddress,CPUStartDateTime,FrameTime,DisplayedTime',
		'app.exe,10,0x1,2026-08-01T12:00:00.000000000Z,10,10'
	].join('\n');
	const analysis = analyzePresentMonCsv(csv, {
		captureProcessEndTimestampMs: timestampMs + 1_000,
		captureProcessStartTimestampMs: timestampMs - 1_000,
		captureTimezoneOffsetMinutes: -720,
		minimumFrameSamples: 1,
		warmupMs: 0
	});
	assert.equal(analysis.valid, true);
	assert.equal(analysis.captureFirstTimestampMs, timestampMs);
	assert.equal(analysis.timestampAdjustmentMs, undefined);
});

test('PresentMon fails closed when zone-less clock alignment is ambiguous', () => {
	const csv = [
		'Application,ProcessID,SwapChainAddress,CPUStartDateTime,FrameTime,DisplayedTime',
		'app.exe,10,0x1,2026-08-02 06:46:30.000000000,10,10'
	].join('\n');
	const analysis = analyzePresentMonCsv(csv, {
		captureClockToleranceMs: 0,
		captureProcessEndTimestampMs: Date.parse('2026-08-02T07:00:00.000Z'),
		captureProcessStartTimestampMs: Date.parse('2026-08-01T06:00:00.000Z'),
		captureTimezoneOffsetMinutes: -720,
		minimumFrameSamples: 1,
		warmupMs: 0
	});
	assert.equal(analysis.valid, false);
	assert.ok(analysis.reasons.includes('capture-clock-alignment-ambiguous'));
});

test('PresentMon preserves raw captured PIDs when exact-range filtering yields no records', () => {
	const csv = [
		'Application,ProcessID,SwapChainAddress,CPUStartDateTime,FrameTime,DisplayedTime',
		'app.exe,10,0x1,2026-08-01T12:00:10.000000000Z,10,10'
	].join('\n');
	const analysis = analyzePresentMonCsv(csv, {
		endTimestampMs: Date.parse('2026-08-01T12:00:02.000Z'),
		minimumFrameSamples: 1,
		startTimestampMs: Date.parse('2026-08-01T12:00:01.000Z'),
		warmupMs: 0
	});
	assert.deepEqual(analysis.capturedProcessIds, [10]);
	assert.deepEqual(analysis.presentingProcessIds, []);
	assert.equal(analysis.valid, false);
});

test('PresentMon exact-range analysis fails when capture timestamps do not bracket the benchmark', () => {
	const csv = [
		'Application,ProcessID,SwapChainAddress,CPUStartDateTime,FrameTime,DisplayedTime',
		'app.exe,10,0x1,2026-08-01T12:00:01.000000000Z,10,10',
		'app.exe,10,0x1,2026-08-01T12:00:02.000000000Z,10,10'
	].join('\n');
	const analysis = analyzePresentMonCsv(csv, {
		coverageToleranceMs: 50,
		endTimestampMs: Date.parse('2026-08-01T12:00:03.000Z'),
		minimumFrameSamples: 1,
		startTimestampMs: Date.parse('2026-08-01T12:00:00.000Z'),
		warmupMs: 0
	});
	assert.equal(analysis.valid, false);
	assert.ok(analysis.reasons.some(reason => reason.startsWith('capture-start-coverage-missing:')));
	assert.ok(analysis.reasons.some(reason => reason.startsWith('capture-end-coverage-missing:')));
});

test('PresentMon prefers absolute date-time timestamps when relative and epoch columns both exist', () => {
	const csv = [
		'Application,ProcessID,SwapChainAddress,CPUStartTime,CPUStartDateTime,FrameTime,DisplayedTime',
		'app.exe,10,0x1,100,2026-08-01T12:00:00.000000000Z,10,10'
	].join('\n');
	const parsed = parsePresentMonCsv(csv);
	assert.equal(parsed.timestampColumn, 'CPUStartDateTime');
	assert.equal(parsed.records[0].timestampMs, Date.parse('2026-08-01T12:00:00.000Z'));
});

test('PresentMon analysis returns invalid reasons for malformed or unsupported CSV', () => {
	const malformed = analyzePresentMonCsv('Application,FrameTime\n"unterminated,16', { warmupMs: 0 });
	assert.equal(malformed.valid, false);
	assert.match(malformed.reasons[0], /^malformed-csv:/u);

	const unsupported = analyzePresentMonCsv('Application,TimeInMs\napp.exe,0', { minimumFrameSamples: 1, warmupMs: 0 });
	assert.equal(unsupported.valid, false);
	assert.ok(unsupported.reasons.includes('missing-frame-time-column'));

	const wrongWidth = analyzePresentMonCsv('Application,TimeInMs,FrameTime\napp.exe,0,16,extra', { minimumFrameSamples: 1, warmupMs: 0 });
	assert.equal(wrongWidth.valid, false);
	assert.ok(wrongWidth.reasons.includes('malformed-row-count:1'));
});
