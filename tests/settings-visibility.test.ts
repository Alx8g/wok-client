import assert from 'node:assert/strict';
import test from 'node:test';
import {
	SETTINGS_VISIBILITY_CONTROLLER_KEYS,
	settingIsVisible
} from '../src/settings-visibility.ts';

test('secondary controls stay hidden until their parent feature is enabled', () => {
	const disabled = {};
	for (const key of ['motionBlurStrength', 'motionBlurQuality', 'extendedRPC', 'immersiveSplashBackgroundColor']) {
		assert.equal(settingIsVisible(key, disabled), false, key);
	}
	for (const key of [
		'matchmakerAcceptKey',
		'matchmakerCancelKey',
		'matchmakerKey',
		'matchmaker_gamemodes',
		'matchmaker_mapScope',
		'matchmaker_maps',
		'matchmaker_maxPlayers',
		'matchmaker_minPlayers',
		'matchmaker_minRemainingTime',
		'matchmaker_openServerWindow',
		'matchmaker_regions'
	]) {
		assert.equal(settingIsVisible(key, disabled), false, key);
	}

	assert.equal(settingIsVisible('motionBlurStrength', { motionBlur: true }), true);
	assert.equal(settingIsVisible('extendedRPC', { discordRPC: true }), true);
	assert.equal(settingIsVisible('immersiveSplashBackgroundColor', { immersiveSplash: true }), true);
	assert.equal(settingIsVisible('matchmaker_regions', { matchmaker: true }), true);
});

test('primary and unrelated controls stay visible', () => {
	for (const key of ['motionBlur', 'discordRPC', 'immersiveSplash', 'matchmaker', 'fpsUncap', 'hideAds']) {
		assert.equal(settingIsVisible(key, {}), true, key);
	}
	assert.deepEqual([...SETTINGS_VISIBILITY_CONTROLLER_KEYS].sort(), [
		'discordRPC',
		'immersiveSplash',
		'matchmaker',
		'motionBlur'
	]);
});
