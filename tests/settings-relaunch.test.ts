import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRelaunchArguments, parseReopenSettingsCategory } from '../src/settings-relaunch.ts';

test('parses only a bounded settings category', () => {
	assert.equal(parseReopenSettingsCategory(['app', '--wok-reopen-settings=4']), 4);
	for (const value of ['-1', '6', '2.5', 'junk', '']) {
		assert.equal(parseReopenSettingsCategory(['app', `--wok-reopen-settings=${value}`]), undefined);
	}
});

test('relaunch arguments replace stale state and drop recovery mode', () => {
	assert.deepEqual(
		buildRelaunchArguments(['app', '--safe-graphics', '--wok-reopen-settings=2', '--trace'], 3),
		['app', '--trace', '--wok-reopen-settings=3']
	);
	assert.deepEqual(buildRelaunchArguments(['app', '--wok-reopen-settings=2']), ['app']);
});
