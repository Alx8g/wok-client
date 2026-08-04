import {
	isCustomIdentityPreferenceKey,
	parseCustomIdentityPreference
} from './custom-identity.ts';
import { parseThemePreference } from './themes.ts';
import { isDisplayPreference } from './display-selection.ts';

const OBSOLETE_PREFERENCE_KEYS = new Set([
	// Superseded by 'theme', which also selects the bundled themes. See migrateThemePreference.
	'cssSwapper',
	// Placebo-with-downside: raised a renderer-process ceiling a one-origin app never reaches.
	'experimentalFlags_increaseLimits',
	'inProcessGPU',
	'loadingSplashTitleCardBackgroundColor',
	'userscripts'
]);

export function containsObsoletePreferences(value: unknown): boolean {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	return [...OBSOLETE_PREFERENCE_KEYS].some(key => Object.hasOwn(value, key));
}

const BOOLEAN_PREFERENCE_KEYS = new Set([
	'alwaysWaitForDevTools',
	'clientSplash',
	'competitionAutomation',
	'competitiveMode',
	'customFilters',
	'discordRPC',
	'experimentalFlags_experimental',
	'extendedRPC',
	'fpsUncap',
	'immersiveSplash',
	'introAnimation',
	'introAudio',
	'matchmaker',
	'matchmaker_openServerWindow',
	'menuTimer',
	'performanceOverlay',
	'quickClassPicker',
	'regionTimezones',
	'resourceSwapper',
	'safeFlags_disableBackgrounding',
	'safeFlags_gpuRasterizing',
	'safeFlags_highPerformanceGpu',
	'saveMatchResultJSONButton'
]);

const KEYBIND_PREFERENCE_KEYS = new Set([
	'matchmakerAcceptKey',
	'matchmakerCancelKey',
	'matchmakerKey'
]);

const STRING_ARRAY_PREFERENCE_KEYS = new Set([
	'matchmaker_gamemodes',
	'matchmaker_maps',
	'matchmaker_regions'
]);

const ENUM_PREFERENCES: Readonly<Record<string, readonly string[]>> = {
	fullscreen: ['windowed', 'maximized', 'fullscreen', 'borderless'],
	graphicsBackend: ['auto', 'default', 'd3d11', 'd3d11on12', 'vulkan'],
	hideAds: ['off', 'hide', 'block'],
	matchmaker_mapScope: ['official', 'selected', 'all']
};

const NUMBER_PREFERENCES: Readonly<Record<string, readonly [number, number]>> = {
	matchmaker_maxPlayers: [0, 7],
	matchmaker_minPlayers: [0, 7],
	matchmaker_minRemainingTime: [0, 480]
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function shouldMigrateMatchmakerMapScope(value: unknown): boolean {
	return isRecord(value) && !Object.hasOwn(value, 'matchmaker_mapScope');
}

function parseKeybind(value: unknown): KeybindUserPref | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.alt !== 'boolean' || typeof value.ctrl !== 'boolean' || typeof value.shift !== 'boolean') return undefined;
	if (typeof value.key !== 'string' || !/^[A-Za-z0-9]{1,32}$/u.test(value.key)) return undefined;
	return {
		alt: value.alt,
		ctrl: value.ctrl,
		key: value.key,
		shift: value.shift
	};
}

function parseStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length > 64) return undefined;
	if (value.some(entry => typeof entry !== 'string' || entry.length === 0 || entry.length > 64)) return undefined;
	return [...new Set(value as string[])];
}

function parseKrunkerOverrideUrl(value: unknown): string | undefined {
	if (value === '') return '';
	if (typeof value !== 'string' || value.length > 2_048) return undefined;
	try {
		const url = new URL(value);
		if (
			url.protocol !== 'https:'
			|| (url.hostname !== 'krunker.io' && !url.hostname.endsWith('.krunker.io'))
			|| url.username
			|| url.password
		) return undefined;
		return url.toString();
	} catch (_error) {
		return undefined;
	}
}

function parsePreferenceValue(key: string, value: unknown): UserPrefValue | undefined {
	if (BOOLEAN_PREFERENCE_KEYS.has(key)) return typeof value === 'boolean' ? value : undefined;
	if (KEYBIND_PREFERENCE_KEYS.has(key)) return parseKeybind(value);
	if (STRING_ARRAY_PREFERENCE_KEYS.has(key)) return parseStringArray(value);

	const enumValues = ENUM_PREFERENCES[key];
	if (enumValues) {
		if ((key === 'fullscreen' || key === 'hideAds') && typeof value === 'boolean') return value;
		return typeof value === 'string' && enumValues.includes(value) ? value : undefined;
	}

	const numberRange = NUMBER_PREFERENCES[key];
	if (numberRange) {
		return typeof value === 'number'
			&& Number.isInteger(value)
			&& value >= numberRange[0]
			&& value <= numberRange[1]
			? value
			: undefined;
	}

	// 'None', a bundled theme id, or a bare .css filename in the user's css folder. Anything with
	// a path separator is rejected, so a selection can never escape that folder.
	if (key === 'theme') return parseThemePreference(value);

	// Local-only display identity. Stored and validated like any other preference; never sent.
	if (isCustomIdentityPreferenceKey(key)) {
		return parseCustomIdentityPreference(key, value);
	}

	if (key === 'immersiveSplashBackgroundColor') {
		return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/u.test(value) ? value : undefined;
	}

	// Not an enum: the option set is whatever monitors are attached right now. The key format is
	// validated instead, and an unattached display resolves to primary at launch.
	if (key === 'display') return isDisplayPreference(value) ? value : undefined;

	if (key === 'overrideURL') return parseKrunkerOverrideUrl(value);
	return undefined;
}

export function parseUserPreferencePatch(value: unknown): Partial<UserPrefs> {
	if (!isRecord(value)) return {};
	const patch: Partial<UserPrefs> = {};
	for (const [key, candidate] of Object.entries(value)) {
		const parsed = parsePreferenceValue(key, candidate);
		if (parsed !== undefined) patch[key] = parsed;
	}
	return patch;
}
