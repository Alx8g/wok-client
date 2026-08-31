export const SETTINGS_BASELINE_VERSION = 2;
export interface SettingsBaselineMarker {
	appliedAt: number;
	version: number;
}
const SAFE_FEATURE_DEFAULTS: ReadonlyArray<readonly [string, UserPrefValue]> = [
	['competitionAutomation', false],
	['customFilters', false],
	['hideAds', 'off'],
	['matchmaker', false],
	['resourceSwapper', false]
];
export interface SettingsBaselinePlan {
	marker?: SettingsBaselineMarker;
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
export function planSettingsBaseline(marker: SettingsBaselineMarker | undefined, prefs: Readonly<Partial<UserPrefs>>, now: number = Date.now()): SettingsBaselinePlan {
	const appliedVersion = marker?.version ?? 0;
	if (appliedVersion >= SETTINGS_BASELINE_VERSION) return { patch: {} };
	const patch: Partial<UserPrefs> = {};
	if (appliedVersion < 1) {
		for (const [key, value] of SAFE_FEATURE_DEFAULTS) {
			if (prefs[key] !== value) patch[key] = value;
		}
	}
	if (appliedVersion < 2 && prefs.safeFlags_gpuRasterizing === true) {
		patch.safeFlags_gpuRasterizing = false;
	}
	return {
		marker: {
			appliedAt: marker && marker.appliedAt > 0 ? marker.appliedAt : now,
			version: SETTINGS_BASELINE_VERSION
		},
		patch
	};
}
