import { ipcRenderer } from 'electron';
import { COMPETITIVE_GAME_SETTINGS, createChangedSettingsPatch, type CompetitiveGameSettings } from './competitive-settings.ts';
export { COMPETITIVE_GAME_SETTINGS } from './competitive-settings.ts';
export type { CompetitiveGameSettingValue, CompetitiveGameSettings } from './competitive-settings.ts';
interface CompetitiveModeBackup {
	createdAt: number;
	settings: CompetitiveGameSettings;
	version: 1;
}
function waitForGameSettings(timeoutMs = 15000): Promise<void> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const check = () => {
			const settingsWindow = window.windows?.[0];
			if (typeof window.setSetting === 'function' && settingsWindow && typeof settingsWindow.getSettings === 'function') {
				resolve();
				return;
			}
			if (Date.now() - startedAt >= timeoutMs) {
				reject(new Error('Krunker settings did not become available before the Competitive mode timeout.'));
				return;
			}
			window.setTimeout(check, 150);
		};
		check();
	});
}
function getRenderSettingsMarkup(): string {
	const settingsWindow = window.windows[0];
	const previousType = settingsWindow.settingType;
	const previousTab = settingsWindow.tabIndex;
	const renderTab = settingsWindow.tabs.advanced.findIndex((tab) => tab.name === 'Render' || tab.categories.includes('quality'));
	if (renderTab < 0) throw new Error('Krunker Render settings tab was not found.');
	try {
		settingsWindow.settingType = 'advanced';
		settingsWindow.tabIndex = renderTab;
		return String(settingsWindow.getSettings());
	} finally {
		settingsWindow.settingType = previousType;
		settingsWindow.tabIndex = previousTab;
	}
}
function findSettingControl(root: HTMLElement, key: string): HTMLInputElement | HTMLSelectElement | undefined {
	const exactInput = root.querySelector<HTMLInputElement>(`#slid_input_${CSS.escape(key)}`);
	if (exactInput) return exactInput;
	return [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].find((element) => {
		const handlers = ['onclick', 'onchange', 'oninput', 'onkeypress'].map((attribute) => element.getAttribute(attribute) ?? '').join(' ');
		return handlers.includes(`"${key}"`) || handlers.includes(`'${key}'`);
	});
}
function readCurrentGameSettings(): CompetitiveGameSettings {
	const holder = document.createElement('div');
	holder.innerHTML = getRenderSettingsMarkup();
	const settings: CompetitiveGameSettings = {};
	for (const key of Object.keys(COMPETITIVE_GAME_SETTINGS)) {
		const control = findSettingControl(holder, key);
		if (!control) continue;
		if (control instanceof HTMLInputElement && control.type === 'checkbox') {
			settings[key] = control.checked;
		} else if (control instanceof HTMLInputElement && (control.type === 'number' || control.type === 'range')) {
			const value = control.valueAsNumber;
			if (Number.isFinite(value)) settings[key] = value;
		} else {
			settings[key] = control.value;
		}
	}
	return settings;
}
function applyChangedGameSettings(current: CompetitiveGameSettings, desired: CompetitiveGameSettings): number {
	const patch = createChangedSettingsPatch(current, desired);
	for (const [key, value] of Object.entries(patch)) window.setSetting(key, value);
	return Object.keys(patch).length;
}
async function enableCompetitiveGameSettings() {
	const currentSettings = readCurrentGameSettings();
	if (Object.keys(currentSettings).length === 0) throw new Error('No compatible Krunker performance settings were found.');
	let backup = (await ipcRenderer.invoke('competitiveMode_getBackup')) as CompetitiveModeBackup | undefined;
	if (!backup) backup = (await ipcRenderer.invoke('competitiveMode_storeBackup', currentSettings)) as CompetitiveModeBackup;
	const reversibleSettings = Object.fromEntries(Object.entries(COMPETITIVE_GAME_SETTINGS).filter(([key]) => Object.hasOwn(backup.settings, key)));
	applyChangedGameSettings(currentSettings, reversibleSettings);
}
async function disableCompetitiveGameSettings(backup: CompetitiveModeBackup) {
	const currentSettings = readCurrentGameSettings();
	applyChangedGameSettings(currentSettings, backup.settings);
	await ipcRenderer.invoke('competitiveMode_clearBackup');
}
export async function synchronizeCompetitiveMode(enabled: boolean, hasBackup: boolean) {
	if (!enabled && !hasBackup) return;
	await waitForGameSettings();
	if (enabled) {
		await enableCompetitiveGameSettings();
		return;
	}
	const backup = (await ipcRenderer.invoke('competitiveMode_getBackup')) as CompetitiveModeBackup | undefined;
	if (backup) await disableCompetitiveGameSettings(backup);
}
