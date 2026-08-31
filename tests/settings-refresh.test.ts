import assert from 'node:assert/strict';
import test from 'node:test';
import { SettingsRefreshTracker } from '../src/settings-refresh.ts';
test('tracks refresh severity by changed key and restores lower outstanding requirements', () => {
	const tracker = new SettingsRefreshTracker();
	assert.equal(tracker.current(), 0);
	assert.equal(tracker.update('overlay', true, 1), 1);
	assert.equal(tracker.update('backend', true, 2), 2);
	assert.equal(tracker.update('backend', false, 2), 1);
	assert.equal(tracker.update('overlay', false, 1), 0);
});
test('instant settings never create a refresh requirement', () => {
	const tracker = new SettingsRefreshTracker();
	assert.equal(tracker.update('menuTimer', true, 0), 0);
	assert.equal(tracker.update('overlay', true, 1), 1);
	assert.equal(tracker.update('overlay', true, 0), 0);
});
test('reset removes all tracked dirty settings', () => {
	const tracker = new SettingsRefreshTracker();
	tracker.update('overlay', true, 1);
	tracker.update('backend', true, 2);
	tracker.reset();
	assert.equal(tracker.current(), 0);
});
