import assert from 'node:assert/strict';
import test from 'node:test';
import {
	detectImportCandidates,
	diffImportedPreferences,
	hasImportableCandidate,
	mapImportedSettings
} from '../src/onboarding-import.ts';

const KCC_PATH = '/appdata/krunker-civilian-client/krunker-civilian-config.json';
const GATO_PATH = '/documents/GatoclientLite/settings.json';

function probe(overrides: Partial<Parameters<typeof detectImportCandidates>[0]> = {}) {
	return {
		crankshaftMigrated: false,
		gatoclientLiteSettingsPath: GATO_PATH,
		kccConfigPath: KCC_PATH,
		...overrides
	};
}

const nothingExists = () => false;
const everythingExists = () => true;

test('a machine with no other client offers nothing', () => {
	const candidates = detectImportCandidates(probe(), nothingExists);
	assert.deepEqual(candidates, []);
	assert.equal(hasImportableCandidate(candidates), false);
});

test('an installed Krunker Civilian Client config is offered as an import', () => {
	const candidates = detectImportCandidates(probe(), path => path === KCC_PATH);
	assert.deepEqual(candidates, [{ id: 'kcc', kind: 'importable', label: 'Krunker Civilian Client', path: KCC_PATH }]);
	assert.equal(hasImportableCandidate(candidates), true);
});

test('a migrated Crankshaft profile is reported as already imported, not offered again', () => {
	const candidates = detectImportCandidates(probe({ crankshaftMigrated: true }), nothingExists);
	assert.deepEqual(candidates, [{ id: 'crankshaft', kind: 'already-imported', label: 'Crankshaft', path: '' }]);
	assert.equal(hasImportableCandidate(candidates), false);
});

test('every detected source is listed together', () => {
	const candidates = detectImportCandidates(probe({ crankshaftMigrated: true }), everythingExists);
	assert.deepEqual(candidates.map(candidate => candidate.id), ['kcc', 'gatoclient-lite', 'crankshaft']);
});

test('a probe that throws is not a candidate rather than a crash', () => {
	const candidates = detectImportCandidates(probe(), () => { throw new Error('EPERM'); });
	assert.deepEqual(candidates, []);
});

// Shape verified against a real Krunker Civilian Client 1.1.0 krunker-civilian-config.json.
const KCC_CONFIG = {
	advanced: { angleBackend: 'default', perfTweaks: true, removeUselessFeatures: true, verboseLogging: false },
	discord: { enabled: true, showClass: true, showMapMode: true },
	game: { betterChat: true, chatHistorySize: 200, rawInput: true, showPing: true },
	keystrokes: { enabled: false, size: 2.5 },
	matchmaker: { enabled: true, gamemodes: [] as string[], maxPlayers: 6, minPlayers: 1, regions: [] as string[] },
	performance: { fpsUnlocked: true, higherMaxFps: true, processPriority: 'High' },
	swapper: { enabled: true, path: '' },
	ui: { menuTimer: true, watermark: true },
	window: { fullscreen: false, height: 1096, maximized: true, width: 1936 }
};

test('a real Krunker Civilian Client config maps onto the settings WOK has an equivalent for', () => {
	const mapping = mapImportedSettings('kcc', KCC_CONFIG);
	assert.deepEqual(mapping.preferences, {
		discordRPC: true,
		fpsUncap: true,
		fullscreen: 'maximized',
		menuTimer: true
	});
});

test('an untouched Krunker Civilian Client backend never overrides adaptive graphics selection', () => {
	assert.equal(mapImportedSettings('kcc', KCC_CONFIG).preferences.graphicsBackend, undefined);
});

test('an explicitly chosen Krunker Civilian Client backend is carried across', () => {
	const mapping = mapImportedSettings('kcc', { ...KCC_CONFIG, advanced: { angleBackend: 'vulkan' } });
	assert.equal(mapping.preferences.graphicsBackend, 'vulkan');
});

test('a backend WOK does not offer is dropped instead of written', () => {
	const mapping = mapImportedSettings('kcc', { ...KCC_CONFIG, advanced: { angleBackend: 'd3d9' } });
	assert.equal(mapping.preferences.graphicsBackend, undefined);
});

test('fullscreen wins over maximized, and neither leaves the mode unset', () => {
	assert.equal(mapImportedSettings('kcc', { window: { fullscreen: true, maximized: true } }).preferences.fullscreen, 'fullscreen');
	assert.equal(mapImportedSettings('kcc', { window: { fullscreen: false, maximized: false } }).preferences.fullscreen, 'windowed');
	assert.equal(mapImportedSettings('kcc', { window: {} }).preferences.fullscreen, undefined);
});

test('terms-sensitive features are refused and reported rather than imported', () => {
	const mapping = mapImportedSettings('gatoclient-lite', {
		clientSplash: true,
		customFilters: true,
		hideAds: 'block',
		matchmaker: true,
		resourceSwapper: true
	});
	assert.deepEqual(mapping.preferences, { clientSplash: true });
	assert.deepEqual(mapping.skippedTermsSensitive.sort(), ['customFilters', 'hideAds', 'matchmaker', 'resourceSwapper']);
});

test("Krunker Civilian Client's enabled swapper and matchmaker never arrive switched on", () => {
	const mapping = mapImportedSettings('kcc', KCC_CONFIG);
	assert.equal(mapping.preferences.resourceSwapper, undefined);
	assert.equal(mapping.preferences.matchmaker, undefined);
});

test('the Gatoclient Lite settings file maps through, including its pre-rename backend key', () => {
	const mapping = mapImportedSettings('gatoclient-lite', {
		'angle-backend': 'd3d11',
		clientSplash: false,
		fpsUncap: true,
		fullscreen: true,
		logDebugToConsole: true
	});
	assert.deepEqual(mapping.preferences, {
		clientSplash: false,
		fpsUncap: true,
		// Kept as the legacy boolean the existing settings.json migration in main.ts already converts.
		fullscreen: true,
		graphicsBackend: 'd3d11'
	});
});

test('a hostile or corrupt source file cannot write an unvalidated value', () => {
	const mapping = mapImportedSettings('gatoclient-lite', {
		cssSwapper: '../../etc/passwd',
		fpsUncap: 'true',
		matchmaker_maxPlayers: 9_999,
		overrideURL: 'https://evil.example.com',
		__proto__: { polluted: true }
	});
	assert.deepEqual(mapping.preferences, {});
});

test('non-object source contents import nothing', () => {
	assert.deepEqual(mapImportedSettings('kcc', null).preferences, {});
	assert.deepEqual(mapImportedSettings('gatoclient-lite', 'settings').preferences, {});
	assert.deepEqual(mapImportedSettings('gatoclient-lite', [1, 2]).preferences, {});
});

test('an import that changes nothing writes nothing', () => {
	assert.deepEqual(
		diffImportedPreferences({ fpsUncap: true, menuTimer: true }, { fpsUncap: true, menuTimer: false }),
		{ menuTimer: true }
	);
});
