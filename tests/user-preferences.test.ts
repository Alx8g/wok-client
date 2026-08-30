import assert from 'node:assert/strict';
import test from 'node:test';
import {
	containsObsoletePreferences,
	parseUserPreferencePatch,
	shouldMigrateMatchmakerMapScope
} from '../src/user-preferences.ts';

test('accepts bounded WOK preference values', () => {
	assert.deepEqual(parseUserPreferencePatch({
		competitiveMode: true,
		customIdentityRgbCycle: true,
		fullscreen: 'fullscreen',
		graphicsBackend: 'd3d11on12',
		hideAds: 'off',
		matchmakerKey: { alt: false, ctrl: true, key: 'F1', shift: false },
		matchmaker_mapScope: 'selected',
		matchmaker_maps: ['Krunk Plaza', 'Krunk Plaza', 'AIM_Room'],
		matchmaker_minPlayers: 2,
		matchmaker_regions: ['us-ca-s', 'de-fra'],
		motionBlur: true,
		motionBlurQuality: 'balanced',
		motionBlurStrength: 50,
		overrideURL: 'https://comp.krunker.io/?game=ABC:123',
		rawMouseInput: true,
		wokPublicServerPingSort: true
	}), {
		customIdentityRgbCycle: true,
		fullscreen: 'fullscreen',
		graphicsBackend: 'd3d11on12',
		hideAds: 'off',
		matchmakerKey: { alt: false, ctrl: true, key: 'F1', shift: false },
		matchmaker_mapScope: 'selected',
		matchmaker_maps: ['Krunk Plaza', 'AIM_Room'],
		matchmaker_minPlayers: 2,
		matchmaker_regions: ['us-ca-s', 'de-fra'],
		motionBlur: true,
		motionBlurQuality: 'balanced',
		motionBlurStrength: 50,
		overrideURL: 'https://comp.krunker.io/?game=ABC:123',
		rawMouseInput: true,
		wokPublicServerPingSort: true
	});
});

test('accepts only explicit booleans for Public region ping sorting', () => {
	assert.deepEqual(parseUserPreferencePatch({ wokPublicServerPingSort: true }), {
		wokPublicServerPingSort: true
	});
	assert.deepEqual(parseUserPreferencePatch({ wokPublicServerPingSort: false }), {
		wokPublicServerPingSort: false
	});
	assert.deepEqual(parseUserPreferencePatch({ wokPublicServerPingSort: 'true' }), {});
});

test('retains only legacy values needed by settings migration', () => {
	assert.deepEqual(parseUserPreferencePatch({ fullscreen: true, hideAds: false }), {
		fullscreen: true,
		hideAds: false
	});
});

test('detects parser-rejected obsolete settings for canonical rewrites', () => {
	const rawSettings = {
		competitiveMode: true,
		loadingSplashTitleCardBackgroundColor: '#363636'
	};
	assert.equal(containsObsoletePreferences(rawSettings), true);
	assert.deepEqual(parseUserPreferencePatch(rawSettings), {});
	assert.equal(containsObsoletePreferences({ motionBlurShutterAngle: 180 }), true);
	assert.equal(containsObsoletePreferences({ competitiveMode: true }), true);
	assert.equal(containsObsoletePreferences({ performanceOverlay: true }), true);
});

test('rejects unsafe URLs, paths, ranges, and malformed keybinds', () => {
	assert.deepEqual(parseUserPreferencePatch({
		theme: '../outside.css',
		fullscreen: 'invalid',
		graphicsBackend: 'swiftshader',
		matchmakerKey: { alt: false, ctrl: false, key: 'F1;rm', shift: false },
		matchmaker_mapScope: 'curated',
		matchmaker_maps: new Array(65).fill('Burg'),
		matchmaker_maxPlayers: 100,
		matchmaker_regions: new Array(100).fill('region'),
		motionBlurQuality: 'cinematic',
		motionBlurStrength: 101,
		overrideURL: 'https://evilkrunker.io/?game=owned',
		unknownSetting: true
	}), {});
});

test('normalizes duplicates and accepts clearing the Krunker override', () => {
	assert.deepEqual(parseUserPreferencePatch({
		matchmaker_gamemodes: ['ffa', 'ffa', 'tdm'],
		overrideURL: ''
	}), {
		matchmaker_gamemodes: ['ffa', 'tdm'],
		overrideURL: ''
	});
});

test('accepts only explicit matchmaker map scopes', () => {
	for (const scope of ['official', 'selected', 'all']) {
		assert.deepEqual(parseUserPreferencePatch({
			matchmaker_mapScope: scope
		}), {
			matchmaker_mapScope: scope
		});
	}
	assert.deepEqual(parseUserPreferencePatch({
		matchmaker_mapScope: 'curated'
	}), {});
});

test('registers the display preference so a saved monitor survives a reload', () => {
	assert.deepEqual(parseUserPreferencePatch({ display: 'auto' }), { display: 'auto' });
	assert.deepEqual(parseUserPreferencePatch({ display: 'd:22:lg-27gn950' }), { display: 'd:22:lg-27gn950' });
});

test('drops hand-edited display values instead of persisting an unresolvable monitor key', () => {
	assert.deepEqual(parseUserPreferencePatch({
		display: 'monitor 2'
	}), {});
	assert.deepEqual(parseUserPreferencePatch({ display: 22 }), {});
	assert.deepEqual(parseUserPreferencePatch({ display: { id: 22 } }), {});
});

test('detects settings that need legacy matchmaker map-scope migration', () => {
	assert.equal(shouldMigrateMatchmakerMapScope({ matchmaker: true }), true);
	assert.equal(shouldMigrateMatchmakerMapScope({ matchmaker_mapScope: 'all' }), false);
	assert.equal(shouldMigrateMatchmakerMapScope(null), false);
});
