const MATCHMAKER_DEPENDENT_KEYS = new Set([
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
]);

export const SETTINGS_VISIBILITY_CONTROLLER_KEYS = new Set([
	'discordRPC',
	'immersiveSplash',
	'matchmaker',
	'motionBlur'
]);

/** Keep secondary controls out of the normal view until their parent feature is enabled. */
export function settingIsVisible(key: string, preferences: Readonly<Partial<UserPrefs>>): boolean {
	if (key === 'motionBlurStrength' || key === 'motionBlurQuality') return preferences.motionBlur === true;
	if (key === 'extendedRPC') return preferences.discordRPC === true;
	if (key === 'immersiveSplashBackgroundColor') return preferences.immersiveSplash === true;
	if (MATCHMAKER_DEPENDENT_KEYS.has(key)) return preferences.matchmaker === true;
	return true;
}
