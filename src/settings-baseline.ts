/**
 * One-time settings baselines. Existing settings.json files can carry defaults this project no
 * longer ships: Terms-sensitive features that legacy Crankshaft profiles had enabled, and
 * safeFlags_gpuRasterizing from its default-on era (--enable-gpu-rasterization is a no-op on
 * modern Chromium except for forcing past the driver blocklist, audit A5).
 *
 * Each baseline version applies exactly once per install. The persisted marker records the
 * version already applied, so a value the user explicitly sets afterwards - including turning
 * safeFlags_gpuRasterizing back on - is never touched again. Pure and Electron-free; main.ts
 * owns reading and writing the marker file (historically named safety-baseline-v1.json; the
 * version lives inside the document, not in the file name).
 */

export const SETTINGS_BASELINE_VERSION = 2;

export interface SettingsBaselineMarker {
	appliedAt: number;
	version: number;
}

/** Baseline 1: Terms-sensitive features reset once for pre-baseline (legacy Crankshaft/WOK) profiles. */
const SAFE_FEATURE_DEFAULTS: ReadonlyArray<readonly [string, UserPrefValue]> = [
	['competitionAutomation', false],
	['customFilters', false],
	['hideAds', 'off'],
	['matchmaker', false],
	['resourceSwapper', false]
];

export interface SettingsBaselinePlan {
	/** Marker to persist after applying the patch; undefined when the install is already current. */
	marker?: SettingsBaselineMarker;
	/** Preference overrides to apply before this launch consumes them. Empty when nothing changes. */
	patch: Partial<UserPrefs>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSettingsBaselineMarker(value: unknown): SettingsBaselineMarker | undefined {
	if (!isRecord(value) || !Number.isInteger(value.version) || Number(value.version) < 1) return undefined;
	return {
		appliedAt: typeof value.appliedAt === 'number' && Number.isFinite(value.appliedAt) ? value.appliedAt : 0,
		version: Number(value.version)
	};
}

/**
 * Computes the preference resets still owed to this install and the marker to persist. A missing
 * marker means a pre-baseline profile (or a fresh install whose skeleton already matches every
 * baseline, in which case the patch is empty and only the marker is written).
 */
export function planSettingsBaseline(
	marker: SettingsBaselineMarker | undefined,
	prefs: Readonly<Partial<UserPrefs>>,
	now: number = Date.now()
): SettingsBaselinePlan {
	const appliedVersion = marker?.version ?? 0;
	if (appliedVersion >= SETTINGS_BASELINE_VERSION) return { patch: {} };

	const patch: Partial<UserPrefs> = {};
	if (appliedVersion < 1) {
		for (const [key, value] of SAFE_FEATURE_DEFAULTS) {
			if (prefs[key] !== value) patch[key] = value;
		}
	}
	if (appliedVersion < 2 && prefs.safeFlags_gpuRasterizing === true) {
		// The old default, not (yet) an observed user choice. Flip it off once; the marker below
		// makes any later re-enable an explicit decision that survives every future launch.
		patch.safeFlags_gpuRasterizing = false;
	}

	return {
		marker: {
			// The original application time is kept: the marker records when this install was
			// first baselined, and the version says how far.
			appliedAt: marker && marker.appliedAt > 0 ? marker.appliedAt : now,
			version: SETTINGS_BASELINE_VERSION
		},
		patch
	};
}
