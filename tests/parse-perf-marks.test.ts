import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parsePerfMarks } from '../scripts/parse-perf-marks.mjs';

const fixturePath = join(import.meta.dirname, 'fixtures', 'perf-marks.log');
const scriptPath = join(import.meta.dirname, '..', 'scripts', 'parse-perf-marks.mjs');

test('computes per-mark medians across multiple captured runs', () => {
	const { marks } = parsePerfMarks(readFileSync(fixturePath, 'utf-8'));

	assert.deepEqual(Object.keys(marks).sort(), [
		'app-ready',
		'did-finish-load',
		'loadurl-called',
		'main-module-eval-start',
		'window-created'
	]);
	assert.deepEqual(marks['app-ready'], { count: 3, medianMs: 120.5, minMs: 118.5, maxMs: 131 });
	assert.deepEqual(marks['did-finish-load'], { count: 3, medianMs: 1201.5, minMs: 1150, maxMs: 1400 });
	// An even sample count takes the mean of the two central samples.
	assert.deepEqual(marks['loadurl-called'], { count: 2, medianMs: 200, minMs: 190, maxMs: 210 });
});

test('ignores non-mark lines, malformed values, and trailing garbage', () => {
	const { marks } = parsePerfMarks([
		'[wok-mark] bad-value notanumber',
		'[wok-mark] trailing-garbage 12.5 extra tokens',
		'plain log line',
		'[wok-mark] good 5'
	].join('\n'));

	assert.deepEqual(Object.keys(marks), ['good']);
	assert.deepEqual(marks.good, { count: 1, medianMs: 5, minMs: 5, maxMs: 5 });
});

test('returns an empty report for a log without marks', () => {
	assert.deepEqual(parsePerfMarks(''), { marks: {} });
	assert.deepEqual(parsePerfMarks('unrelated output\nanother line'), { marks: {} });
});

test('CLI reads a log file and prints the JSON summary', () => {
	const stdout = execFileSync(process.execPath, [scriptPath, fixturePath], { encoding: 'utf-8' });
	const summary = JSON.parse(stdout) as ReturnType<typeof parsePerfMarks>;

	assert.equal(summary.marks['app-ready'].count, 3);
	assert.equal(summary.marks['window-created'].medianMs, 155);
});
