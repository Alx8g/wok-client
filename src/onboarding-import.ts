/**
 * Detecting other Krunker clients on this machine and mapping their settings onto WOK preferences.
 *
 * Pure and Electron-free: the caller supplies the paths, an existence probe, and the parsed file
 * contents. Every mapping ends in parseUserPreferencePatch, so a hand-edited or hostile config from
 * another client can only ever produce values WOK already accepts from its own settings UI.
 *
 * Only formats verified against a primary source are mapped. Guessing another client's schema would
 * either silently import nothing or, worse, import the wrong thing:
 *
 * - Crankshaft (%APPDATA%/crankshaft/config, Documents/Crankshaft) already migrates automatically
 *   in config-migration.ts before this module is ever consulted; it appears here only so the user is
 *   told it happened.
 * - Krunker Civilian Client writes a single krunker-civilian-config.json in its Electron userData
 *   directory, with the sectioned shape mapped below (window / performance / ui / discord /
 *   advanced). Verified against a real 1.1.0 installation's file; the client's source is
 *   https://github.com/bigjakk/Krunker-Civilian-Client, already cited in src/preload.ts.
 * - Gatoclient Lite kept Documents/GatoclientLite/settings.json, the file Crankshaft was originally
 *   built to read (see this repository's first commit, app/main.js) - the same flat settings.json
 *   shape WOK still parses, plus the pre-rename `angle-backend` key.
 *
 * Glorp, idkr and Gatoclient proper are deliberately absent: their config layouts could not be
 * confirmed from a primary source offline, and inventing one is worse than not offering the import.
 */

import { TERMS_SENSITIVE_PREFERENCE_KEYS } from './settings-baseline.ts';
import { parseUserPreferencePatch } from './user-preferences.ts';

export const IMPORT_CLIENT_IDS = ['crankshaft', 'gatoclient-lite', 'kcc'] as const;

export type ImportClientId = (typeof IMPORT_CLIENT_IDS)[number];

export interface ImportCandidate {
	id: ImportClientId;
	/** 'already-imported' is shown as a statement, not an offer: nothing is left to do. */
	kind: 'already-imported' | 'importable';
	label: string;
	/** File this import reads. Empty for candidates that are only reported. */
	path: string;
}

export interface ImportProbe {
	/** True once config-migration.ts has copied (or previously completed copying) a Crankshaft profile. */
	crankshaftMigrated: boolean;
	gatoclientLiteSettingsPath: string;
	kccConfigPath: string;
}

const IMPORT_LABELS: Record<ImportClientId, string> = {
	crankshaft: 'Crankshaft',
	'gatoclient-lite': 'Gatoclient Lite',
	kcc: 'Krunker Civilian Client'
};

/**
 * Backends both this client and the others can name. 'auto' is WOK's own adaptive choice and
 * 'default' is another client's untouched default, so neither is treated as a deliberate pick worth
 * carrying across; importing either would only switch WOK's adaptive selection off.
 */
const EXPLICIT_GRAPHICS_BACKENDS: readonly string[] = ['d3d11', 'd3d11on12', 'vulkan'];

export function detectImportCandidates(probe: ImportProbe, exists: (path: string) => boolean): ImportCandidate[] {
	const candidates: ImportCandidate[] = [];
	const add = (id: ImportClientId, path: string) => {
		let found = false;
		try {
			found = exists(path);
		} catch (_error) {
			// An unreadable path is simply not a candidate; setup must never fail on a probe.
			found = false;
		}
		if (found) candidates.push({ id, kind: 'importable', label: IMPORT_LABELS[id], path });
	};

	add('kcc', probe.kccConfigPath);
	add('gatoclient-lite', probe.gatoclientLiteSettingsPath);
	if (probe.crankshaftMigrated) {
		candidates.push({ id: 'crankshaft', kind: 'already-imported', label: IMPORT_LABELS.crankshaft, path: '' });
	}
	return candidates;
}

export function hasImportableCandidate(candidates: readonly ImportCandidate[]): boolean {
	return candidates.some(candidate => candidate.kind === 'importable');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function section(value: unknown, key: string): Record<string, unknown> {
	if (!isRecord(value)) return {};
	const nested = value[key];
	return isRecord(nested) ? nested : {};
}

/**
 * Krunker Civilian Client's sectioned config. Only the settings with an unambiguous WOK equivalent
 * are carried: frame cap, window mode, menu timer, Discord presence, and an explicitly chosen
 * graphics backend. Its keystrokes, translator, themes, tabs and account entries have no WOK
 * counterpart and are left behind rather than approximated.
 */
function mapKccConfig(raw: unknown): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	const windowSection = section(raw, 'window');
	const performance = section(raw, 'performance');
	const ui = section(raw, 'ui');
	const discord = section(raw, 'discord');
	const advanced = section(raw, 'advanced');

	if (typeof performance.fpsUnlocked === 'boolean') patch.fpsUncap = performance.fpsUnlocked;
	// KCC records fullscreen and maximized independently; WOK has one mode, so fullscreen wins.
	if (windowSection.fullscreen === true) patch.fullscreen = 'fullscreen';
	else if (windowSection.maximized === true) patch.fullscreen = 'maximized';
	else if (windowSection.fullscreen === false) patch.fullscreen = 'windowed';
	if (typeof ui.menuTimer === 'boolean') patch.menuTimer = ui.menuTimer;
	if (typeof discord.enabled === 'boolean') patch.discordRPC = discord.enabled;
	if (typeof advanced.angleBackend === 'string' && EXPLICIT_GRAPHICS_BACKENDS.includes(advanced.angleBackend)) {
		patch.graphicsBackend = advanced.angleBackend;
	}
	return patch;
}

/**
 * The flat settings.json shape Crankshaft inherited from Gatoclient Lite. Keys already match WOK's
 * own, so the file passes straight through validation; only the pre-rename `angle-backend` key
 * needs moving, and only when it names a backend WOK still offers (its `gl` and `d3d9` options do
 * not exist here and are dropped).
 */
function mapCrankshaftStyleSettings(raw: unknown): Record<string, unknown> {
	if (!isRecord(raw)) return {};
	const patch: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key !== 'angle-backend') patch[key] = value;
	}
	const legacyBackend = raw['angle-backend'];
	if (
		patch.graphicsBackend === undefined
		&& typeof legacyBackend === 'string'
		&& EXPLICIT_GRAPHICS_BACKENDS.includes(legacyBackend)
	) {
		patch.graphicsBackend = legacyBackend;
	}
	return patch;
}

export interface ImportMapping {
	/** Validated patch, safe to merge into userPrefs as-is. */
	preferences: Partial<UserPrefs>;
	/** Terms-sensitive keys the source had set, refused on purpose and reported rather than hidden. */
	skippedTermsSensitive: string[];
}

export function mapImportedSettings(id: ImportClientId, raw: unknown): ImportMapping {
	const mapped = id === 'kcc' ? mapKccConfig(raw) : mapCrankshaftStyleSettings(raw);
	const skippedTermsSensitive: string[] = [];
	const allowed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(mapped)) {
		// Resource swapping, ad controls, custom filters, matchmaker and competition automation ship
		// off here and stay off: an import is consent to move settings, not to enable those.
		if (TERMS_SENSITIVE_PREFERENCE_KEYS.includes(key)) skippedTermsSensitive.push(key);
		else allowed[key] = value;
	}
	return { preferences: parseUserPreferencePatch(allowed), skippedTermsSensitive };
}

/** Drops imported values that already match, so an import that changes nothing writes nothing. */
export function diffImportedPreferences(
	preferences: Readonly<Partial<UserPrefs>>,
	current: Readonly<Partial<UserPrefs>>
): Partial<UserPrefs> {
	const patch: Partial<UserPrefs> = {};
	for (const [key, value] of Object.entries(preferences)) {
		if (current[key] !== value) patch[key] = value;
	}
	return patch;
}
