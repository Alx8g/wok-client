import assert from 'node:assert/strict';
import test from 'node:test';
import { containsObsoletePreferences, parseUserPreferencePatch } from '../src/user-preferences.ts';

test('accepts bounded WOK preference values', () => {
	assert.deepEqual(parseUserPreferencePatch({
		competitiveMode: true,
		fullscreen: 'fullscreen',
		graphicsBackend: 'd3d11on12',
		hideAds: 'off',
		matchmakerKey: { alt: false, ctrl: true, key: 'F1', shift: false },
		matchmaker_minPlayers: 2,
		matchmaker_regions: ['us-ca-s', 'de-fra'],
		overrideURL: 'https://comp.krunker.io/?game=ABC:123'
	}), {
		competitiveMode: true,
		fullscreen: 'fullscreen',
		graphicsBackend: 'd3d11on12',
		hideAds: 'off',
		matchmakerKey: { alt: false, ctrl: true, key: 'F1', shift: false },
		matchmaker_minPlayers: 2,
		matchmaker_regions: ['us-ca-s', 'de-fra'],
		overrideURL: 'https://comp.krunker.io/?game=ABC:123'
	});
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
	assert.deepEqual(parseUserPreferencePatch(rawSettings), { competitiveMode: true });
	assert.equal(containsObsoletePreferences({ competitiveMode: true }), false);
});

test('rejects unsafe URLs, paths, ranges, and malformed keybinds', () => {
	assert.deepEqual(parseUserPreferencePatch({
		cssSwapper: '../outside.css',
		fullscreen: 'invalid',
		graphicsBackend: 'swiftshader',
		matchmakerKey: { alt: false, ctrl: false, key: 'F1;rm', shift: false },
		matchmaker_maxPlayers: 100,
		matchmaker_regions: new Array(100).fill('region'),
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
