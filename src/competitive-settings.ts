export type CompetitiveGameSettingValue = boolean | number | string;
export type CompetitiveGameSettings = Record<string, CompetitiveGameSettingValue>;

export const COMPETITIVE_GAME_SETTINGS: Readonly<CompetitiveGameSettings> = Object.freeze({
	antiAlias: false,
	ambientShading: false,
	bloom: false,
	highResShad: false,
	muzzleFlash: false,
	particles: false,
	postProcessing: false,
	reflection: '0',
	screenShake: false,
	shadows: false,
	shadowsDynamic: false,
	softShad: false,
	ssao: false,
	weaponShine: false
});

function settingsValuesEqual(left: CompetitiveGameSettingValue, right: CompetitiveGameSettingValue): boolean {
	if (typeof left === 'boolean' || typeof right === 'boolean') return left === right;
	return String(left) === String(right);
}

export function createChangedSettingsPatch(
	current: CompetitiveGameSettings,
	desired: CompetitiveGameSettings
): CompetitiveGameSettings {
	return Object.fromEntries(
		Object.entries(desired).filter(([key, desiredValue]) => {
			const currentValue = current[key];
			return currentValue === undefined || !settingsValuesEqual(currentValue, desiredValue);
		})
	);
}
