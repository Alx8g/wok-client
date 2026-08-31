export const SETTINGS_TAB_SELECTOR = '#settingsTabs .tab, #settHolder .tab, .settingTab';

interface SettingsTabElement {
	textContent: string | null;
}

interface SettingsTabRoot {
	querySelectorAll(selector: string): Iterable<SettingsTabElement>;
}

export function renameClientSettingsTabs(root: SettingsTabRoot): number {
	let renamed = 0;
	for (const tab of root.querySelectorAll(SETTINGS_TAB_SELECTOR)) {
		if (tab.textContent?.trim() !== 'Client') continue;
		tab.textContent = 'WOK';
		renamed++;
	}
	return renamed;
}
