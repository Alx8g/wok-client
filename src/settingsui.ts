import { readdirSync } from 'fs';
import { DISPLAY_PREFERENCE_AUTO, type DisplayOption } from './display-selection.ts';
import * as os from "os";
import { ipcRenderer, shell } from 'electron'; // add app if crashes
import { createElement, haveSameContents, toggleSettingCSS, parseKeybindSettingDisplay, turnKeyboardEventIntoSettingValue, objectsAreEqual } from './utils.ts';
import { UPSTREAM_REPO_URL, WEBSITE_URL, REPO_URL } from './branding.ts';
import { applyClientMatchmakerSettings, applyClientMotionBlurSettings, applyPublicServerPingSortSettings, applyTheme, styleSettingsCSS, getTimezoneByRegionKey, strippedConsole } from './preload.ts';
import { applyMenuDeclutterSettings } from './menu-declutter.ts';
import { buildThemeOptions, normalizeThemeSelection } from './themes.ts';
import {
	MATCHMAKER_GAMEMODES,
	MATCHMAKER_MAP_SCOPES,
	MATCHMAKER_OFFICIAL_MAPS,
	MATCHMAKER_REGIONS
} from './matchmaker-data.ts';
import { SettingsRefreshTracker, type SettingsRefreshRequirement } from './settings-refresh.ts';
import { SETTINGS_VISIBILITY_CONTROLLER_KEYS, settingIsVisible } from './settings-visibility.ts';
import {
	CUSTOM_CLAN_PREFERENCE_KEY,
	isCustomIdentityPreferenceKey,
	isCustomIdentityTextPreferenceKey,
	REAL_CLAN_PREFERENCE_KEY,
	sanitizeCustomClan,
	sanitizeCustomName
} from './custom-identity.ts';
import { applyCustomIdentity } from './custom-identity-display.ts';

const RefreshEnum = {
	notNeeded: 0,
	refresh: 1,
	reloadApp: 2
} as const;

interface IPaths { [path: string]: string }
let userPrefs: UserPrefs;
let userPrefsPath: string;
let userPrefsCache: UserPrefs; // the userprefs on path
let refreshNeeded: SettingsRefreshRequirement = RefreshEnum.notNeeded;
let displayedRefreshNeeded: SettingsRefreshRequirement = RefreshEnum.notNeeded;
let refreshNotifElement: HTMLElement | undefined;
const settingsRefreshTracker = new SettingsRefreshTracker();
let paths: IPaths;
let resolveSettingsReady: () => void;
export const settingsReady = new Promise<void>(resolve => { resolveSettingsReady = resolve; });

const requestUserPrefs = () => { ipcRenderer.send('settingsUI_requests_userPrefs'); };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', requestUserPrefs, { once: true });
else requestUserPrefs();

// Theme options are declared here so that TS knows they are the correct type for modifications under the m_userPrefs_for_settingUI message
/**
 * The monitor list is whatever is attached right now, so main enumerates it and sends it with the
 * preferences; this declaration exists up front only so TS knows the type being mutated. Values are
 * opaque display keys (src/display-selection.ts), which is why this select needs optLabels.
 */
const displayOption: SelectSettingDescItem = {
	title: 'Display',
	type: 'sel',
	desc: 'Which monitor the game opens on. Falls back to primary if unplugged.',
	safety: 0,
	cat: 0,
	opts: [DISPLAY_PREFERENCE_AUTO],
	optLabels: ['Automatic (primary display)']
};

const themeOption: SelectSettingDescItem = {
	title: 'Theme',
	type: 'sel',
	desc: 'Restyles the whole client: menus, HUD, scoreboard, chat and shop. Your own .css files appear here too.',
	safety: 0,
	cat: 2,
	instant: true,
	opts: [],
	optLabels: [],
	button: {
		icon: 'folder',
		text: 'Themes',
		callback: e => openPath(e, paths.cssPath)
	}
}

ipcRenderer.on('m_userPrefs_for_settingsUI', (_event, received_paths: IPaths, received_userPrefs: UserPrefs, received_displays: DisplayOption[]) => {
	// A missing list (older main, or an enumeration failure) leaves the picker on Automatic only.
	// The stored key is never rewritten from here: main already appends an entry for a remembered
	// monitor that is not attached, so unplugging one shows the truth without discarding the choice.
	const displayOptions = Array.isArray(received_displays) && received_displays.length > 0
		? received_displays
		: [{ value: DISPLAY_PREFERENCE_AUTO, label: 'Automatic (primary display)' }];
	displayOption.opts = displayOptions.map(option => option.value);
	displayOption.optLabels = displayOptions.map(option => option.label);

	// main sends us the path to settings and also settings themselves on initial load.
	userPrefsPath = received_paths.settingsPath;
	paths = received_paths;
	userPrefs = received_userPrefs;
	userPrefsCache = { ...received_userPrefs }; // cache userprefs
	settingsRefreshTracker.reset();
	refreshNeeded = RefreshEnum.notNeeded;
	displayedRefreshNeeded = RefreshEnum.notNeeded;
	refreshNotifElement?.remove();
	refreshNotifElement = undefined;

	settingsDesc.graphicsBackend.button = { icon: 'speed', text: 'Run calibration', callback: () => ipcRenderer.send('calibration_request_rerun') };
	settingsDesc.resourceSwapper.button = { icon: 'folder', text: 'Swapper', callback: e => openPath(e, paths.swapperPath) };
	settingsDesc.customFilters.button = { icon: 'filter_list', text: 'Filters file', callback: e => openPath(e, paths.filtersPath) };

	const userThemeFiles = readdirSync(paths.cssPath).filter(path => path.endsWith('.css'));
	const themeOptions = buildThemeOptions(userThemeFiles);
	themeOption.opts = themeOptions.values;
	themeOption.optLabels = themeOptions.labels;
	// A file the user deleted since last launch must not stay selected in a dropdown that no
	// longer lists it, or the picker would show a value it cannot apply.
	userPrefs.theme = normalizeThemeSelection(userPrefs.theme, userThemeFiles);
	resolveSettingsReady();
});

/** joins the data: userPrefs and Desc: SettingsDesc into one array of objects */
function transformMarrySettings(data: UserPrefs, desc: SettingsDesc, callback: Callbacks): RenderReadySetting[] {
	const renderReadySettings = Object.keys(desc)
		.map(key => ({ key, ...desc[key] })) // embeds key into the original object: hideAds: {title: 'Hide Ads', ...} => {key: 'hideAds', title: 'Hide Ads', ...}
		.map(obj => ({ callback, value: data[obj.key], ...obj })); // adds value (from the data object) and callback ('normal' by default)

	return renderReadySettings;
}

function openPath(e: MouseEvent, path: string) {
	e.stopPropagation();
	shell.openPath(path).catch(err => strippedConsole.error(err));
}

/**
 * Live theme switching. The settings UI shares a renderer with the injector, so it reuses the
 * preload's applier rather than keeping a second copy of the mounting, caching and race handling.
 */
function applyThemeSelection(value: string) {
	void applyTheme(value, paths.cssPath)
		.catch(error => { strippedConsole.error(`Failed to apply the theme ${value}`, error); });
}

/**
 * each setting is defined here as a SettingsDesc object. check typescript intelliSense to see if you have all required props.
 * some setting types, like 'sel' will have more required props, for example 'opts'.
 * note: for each key in userPrefs, there should exist an entry under the same key here.
 *
 * optional props and their defaults:
 * desc (description): omitting it or leaving it "" will not render any description
 * cat (category): omitting will put the setting in the first (0th) category
 * instant: ommiting will not render an instant icon.
 * refreshOnly: ommiting will not render a refresh-only icon
 *
 * note: instant and refreshOnly are exclusive. only use one at a time
 *
 * note: settings will get rendered in the order you define them.
 * based on my generative settings from https://github.com/KraXen72/glide, precisely https://github.com/KraXen72/glide/blob/master/settings.js
 */
const settingsDesc: SettingsDesc = {
	wokMenuDeclutter: { title: 'Clean Menu UI', type: 'bool', desc: "Hides Wallet while preserving your KR balance, plus Custom Games, Community & Events, Guide, What's New, Store promo badges, and the Contact/Terms/Changelog footer.", safety: 0, cat: 1, instant: true },
	wokPublicServerPingSort: { title: 'Sort Public Regions by Ping', type: 'bool', desc: 'Pins fixed Public categories, shows numeric regional ping, and sorts measured geographic regions from lowest to highest latency.', safety: 0, cat: 1, instant: true },
	fpsUncap: { title: 'Un-cap FPS', type: 'bool', desc: 'Render as fast as the current system allows.', safety: 0, cat: 0 },
	rawMouseInput: { title: 'High-Polling Mouse Fix', type: 'bool', desc: 'Uses unadjusted Pointer Lock input to avoid Windows Chromium camera jumps and OS mouse acceleration. Restart required.', safety: 0, cat: 0 },
	graphicsBackend: { title: 'Graphics Backend', type: 'sel', desc: 'Leave on auto or use Run calibration to measure the available renderer profiles.', safety: 1, cat: 0, opts: ['auto', 'default', 'd3d11', 'd3d11on12', 'vulkan'] },
	fullscreen: { title: 'Window Mode', type: 'sel', desc: 'Fullscreen gives the smoothest frames.', safety: 0, cat: 0, opts: ['windowed', 'maximized', 'fullscreen', ...(process.platform !== "win32" ? ['borderless'] : [])] },
	display: displayOption,

	menuTimer: { title: 'Menu Timer', type: 'bool', desc: 'Countdown to the next match on the menu.', safety: 0, cat: 1, instant: true },
	quickClassPicker: { title: 'Quick Class Picker', type: 'bool', desc: 'Shows every class icon above the play buttons for one-click class switching.', safety: 0, cat: 1, instant: true },
	customName: { title: 'Custom Name', type: 'text', desc: 'Shows this name instead of yours in chat, the scoreboard, the kill feed and the menu. Only on your screen; Krunker still gets your real one.', placeholder: 'Leave empty for your real name', safety: 0, cat: 1, instant: true },
	customClan: { title: 'Custom Clan', type: 'text', desc: 'Shows this clan tag instead of yours, everywhere the game prints it. Only on your screen.', placeholder: 'Leave empty for your real clan', safety: 0, cat: 1, instant: true },
	customIdentityRgbCycle: { title: 'RGB Custom Identity', type: 'bool', desc: 'Cycles your whole local name and clan through fast RGB colours. Custom Name and Clan override the text; blank fields keep your real identity. Only visible on your screen.', safety: 0, cat: 1, instant: true },
	regionTimezones: { title: 'Region Timezones', type: 'bool', desc: 'Shows local time next to each region.', safety: 0, cat: 1, refreshOnly: true },
	discordRPC: { title: 'Discord Rich Presence', type: 'bool', desc: 'Shows what you are playing on your Discord profile.', safety: 0, cat: 1 },
	extendedRPC: { title: 'Discord Buttons', type: 'bool', desc: 'Adds links to your Discord status.', safety: 0, cat: 1, instant: true },

	motionBlur: { title: 'Motion Blur', type: 'bool', desc: 'Blends recent game frames only while turning for montage-style trails. The HUD stays sharp.', safety: 0, cat: 2, instant: true },
	motionBlurStrength: { title: 'Motion Blur Strength', type: 'num', min: 0, max: 100, desc: 'Controls the trail while turning. 50 is recommended; higher values feel dreamier.', safety: 0, cat: 2, instant: true },
	motionBlurQuality: { title: 'Motion Blur Quality', type: 'sel', desc: 'Native preserves full sharpness. Lower resolutions reduce GPU work but soften the image while turning.', safety: 0, cat: 2, instant: true, opts: ['native', 'balanced', 'performance'], optLabels: ['Native (100%)', 'Balanced (75%)', 'Performance (50%)'] },
	theme: themeOption,
	introAnimation: { title: 'Launch Animation', type: 'bool', desc: 'Plays the WOK animation while the game loads.', safety: 0, cat: 2 },
	introAudio: { title: 'Launch Sound', type: 'bool', desc: 'Sound for the launch animation.', safety: 0, cat: 2 },
	clientSplash: { title: 'Splash Screen', type: 'bool', desc: 'WOK screen while Krunker loads.', safety: 0, cat: 2, refreshOnly: true },
	immersiveSplash: { title: 'Full-Screen Splash', type: 'bool', desc: 'Covers the Krunker loading screen behind it.', safety: 0, cat: 2, refreshOnly: true },
	immersiveSplashBackgroundColor: { title: 'Splash Colour', type: 'color', desc: 'Background colour for the full-screen splash.', safety: 0, cat: 2, refreshOnly: true },

	matchmaker: { title: 'Custom Matchmaker', type: 'bool', desc: 'Finds lobbies matching your filters. Unofficial matchmaking may conflict with game rules.', safety: 2, cat: 3, instant: true },
	matchmakerKey: { title: 'Search Hotkey', type: 'keybind', desc: 'Starts a search.', safety: 0, cat: 3, instant: true },
	matchmakerAcceptKey: { title: 'Accept Hotkey', type: 'keybind', desc: 'Joins the found lobby.', safety: 0, cat: 3, instant: true },
	matchmakerCancelKey: { title: 'Cancel Hotkey', type: 'keybind', desc: 'Rejects the found lobby.', safety: 0, cat: 3, instant: true },
	matchmaker_regions: { title: 'Regions', type: 'multisel', desc: 'Leave empty for any region.', safety: 0, cat: 3, opts: MATCHMAKER_REGIONS, cols: 16, instant: true },
	matchmaker_gamemodes: { title: 'Gamemodes', type: 'multisel', desc: 'Leave empty for any mode.', safety: 0, cat: 3, opts: MATCHMAKER_GAMEMODES, cols: 4, instant: true },
	matchmaker_mapScope: { title: 'Map Scope', type: 'sel', desc: 'Which maps to accept.', safety: 0, cat: 3, opts: MATCHMAKER_MAP_SCOPES, instant: true },
	matchmaker_maps: { title: 'Maps', type: 'multisel', desc: 'Narrows Official or Selected scope to these maps. Leave empty with Official scope to allow every official map.', safety: 0, cat: 3, opts: MATCHMAKER_OFFICIAL_MAPS, cols: 4, instant: true },
	matchmaker_minPlayers: { title: 'Minimum Players', type: 'num', min: 0, max: 7, safety: 0, cat: 3, instant: true },
	matchmaker_maxPlayers: { title: 'Maximum Players', type: 'num', min: 0, max: 7, desc: 'Strict filters may find nothing.', safety: 0, cat: 3, instant: true },
	matchmaker_minRemainingTime: { title: 'Minimum Time Left', type: 'num', min: 0, max: 480, desc: 'Seconds remaining in the match.', safety: 0, cat: 3, instant: true },
	matchmaker_openServerWindow: { title: 'Open Servers On Cancel', type: 'bool', safety: 0, cat: 3, instant: true },

	safeFlags_highPerformanceGpu: { title: 'Prefer High-Performance GPU', type: 'bool', desc: 'On laptops with two GPUs, uses the fast one. If diagnostics still show integrated graphics, set it for WOK in your OS graphics settings too.', safety: 1, cat: 4 },
	safeFlags_disableBackgrounding: { title: 'Keep Running When Tabbed Out', type: 'bool', desc: 'Uses more power, avoids catch-up when you return.', safety: 2, cat: 4 },
	safeFlags_gpuRasterizing: { title: 'Force GPU Rasterization', type: 'bool', desc: 'Only forces it where your driver disabled it for safety. Leave off.', safety: 3, cat: 5 },
	experimentalFlags_experimental: { title: 'Experimental Flags', type: 'bool', desc: 'Linux only. No proven benefit; may reduce stability.', safety: 4, cat: 5 },
	alwaysWaitForDevTools: { title: 'Always Wait For DevTools', type: 'bool', desc: 'Disables the fallback that opens DevTools in a separate window.', safety: 3, cat: 5 },
	overrideURL: { title: 'Override URL', desc: 'Testing only. HTTPS krunker.io addresses only.', type: 'text', placeholder: 'https://krunker.io', safety: 3, cat: 5 },

	resourceSwapper: { title: 'Resource Swapper', type: 'bool', desc: 'Replaces game files from a local folder. Krunker has official mod support; prefer that. May conflict with game rules.', safety: 3, cat: 5 },
	hideAds: { title: 'Ad Controls', type: 'sel', desc: 'Hides or blocks ads. May conflict with game rules. Restart required.', safety: 4, cat: 4, opts: ['off', 'hide', 'block'] },
	customFilters: { title: 'Custom Network Filters', type: 'bool', desc: 'Your own rules can change or cancel game requests. May conflict with game rules. Restart required.', safety: 4, cat: 5 },
	competitionAutomation: { title: 'Competition Host Automation', type: 'bool', desc: 'Lets confirmed WOK links create and fill private rooms. May conflict with game rules.', safety: 4, cat: 5, refreshOnly: true }
};

/** index-based safety descriptions. goes in title attribute */
const safetyDesc = [
	'This setting is safe/standard',
	'Proceed with caution',
	'This setting is not recommended',
	'This setting is experimental',
	'This setting is experimental and unstable. Use at your own risk.'
];

/** index-based category names. n = name, c = class */
const categoryNames: CategoryName[] = [
	{ name: 'Performance', cat: 'mainSettings' },
	{ name: 'Game', cat: 'gameSettings' },
	{ name: 'Visuals', cat: 'styleSettings' },
	{ name: 'Matchmaker', cat: 'matchmakerSettings' },
	{ name: 'Advanced', cat: 'advSettings' },
	{ name: 'Developer', cat: 'developerSettings' },
	{ name: 'About', cat: 'aboutSettings' }
];

/** About holds links and file shortcuts rather than settings, so the renderer must mount it explicitly. */
const ABOUT_CATEGORY_INDEX = categoryNames.length - 1;

const pendingSettingsUpdates: Record<string, UserPrefs[keyof UserPrefs]> = {};
let settingsUpdateFrame: number | undefined;

function flushSettingsUpdates() {
	settingsUpdateFrame = undefined;
	if (Object.keys(pendingSettingsUpdates).length === 0) return;
	ipcRenderer.send('settingsUI_updates_userPrefs', { ...pendingSettingsUpdates });
	for (const key of Object.keys(pendingSettingsUpdates)) delete pendingSettingsUpdates[key];
}

function saveSettings(key: string, value: UserPrefs[keyof UserPrefs]) {
	// Send at most one settings patch per frame and persist it asynchronously in the main process.
	pendingSettingsUpdates[key] = value;
	if (settingsUpdateFrame === undefined) settingsUpdateFrame = requestAnimationFrame(flushSettingsUpdates);
}

window.addEventListener('beforeunload', () => {
	if (settingsUpdateFrame !== undefined) cancelAnimationFrame(settingsUpdateFrame);
	flushSettingsUpdates();
});

function settingValuesEqual(
	setting: UserPrefs[keyof UserPrefs],
	cachedSetting: UserPrefs[keyof UserPrefs]
): boolean {
	if (Array.isArray(setting) || Array.isArray(cachedSetting)) {
		return Array.isArray(setting) && Array.isArray(cachedSetting) && haveSameContents(setting, cachedSetting);
	}
	if (setting !== null && cachedSetting !== null && typeof setting === 'object' && typeof cachedSetting === 'object') {
		return objectsAreEqual(setting, cachedSetting);
	}
	return setting === cachedSetting;
}

function refreshRequirementForKey(key: string): SettingsRefreshRequirement {
	const description = settingsDesc[key];
	if (description?.instant) return RefreshEnum.notNeeded;
	if (description?.refreshOnly) return RefreshEnum.refresh;
	return RefreshEnum.reloadApp;
}

function updateRefreshNeededForKey(key: string) {
	refreshNeeded = settingsRefreshTracker.update(
		key,
		!settingValuesEqual(userPrefs[key], userPrefsCache[key]),
		refreshRequirementForKey(key)
	);
}

function updateRefreshNotification() {
	if (refreshNeeded === RefreshEnum.notNeeded) {
		refreshNotifElement?.remove();
		refreshNotifElement = undefined;
		displayedRefreshNeeded = RefreshEnum.notNeeded;
		return;
	}

	if (!refreshNotifElement) {
		refreshNotifElement = createElement('div', {
			class: ['crankshaft-holder-update', 'refresh-popup'],
			innerHTML: skeleton.refreshElem(refreshNeeded)
		});
		document.body.appendChild(refreshNotifElement);
		displayedRefreshNeeded = refreshNeeded;
		return;
	}

	if (displayedRefreshNeeded !== refreshNeeded) {
		refreshNotifElement.innerHTML = skeleton.refreshElem(refreshNeeded);
		displayedRefreshNeeded = refreshNeeded;
	}
}

function sanitizeString(string: string) {
	const map = {
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#x27;',
		'/': '&#x2F;',
	};
	const reg = /[&<>"'/]/ig;
	return string.replace(reg, (match: string) => (map[match as keyof typeof map]));
}

/** creates a new Setting element */
class SettingElem {

	// s-update is the class for element to watch
	props: RenderReadySetting;

	type: ValidTypes;

	HTML: string;

	updateMethod: 'onchange' | 'oninput' | '';

	updateKey: 'value' | 'checked' | 'valueAsNumber' | '';

	#wrapper: HTMLElement | false;

	#disabled: boolean;

	constructor(props: RenderReadySetting, trusted: boolean = true) {
		/** @type {Object} save the props from constructor to this class (instance) */
		this.props = props;

		/** @type {String} type of this settingElem, can be {'bool' | 'sel' | 'heading' | 'text' | 'num'} */
		this.type = props.type;

		/** @type {String} innerHTML for settingElement */
		this.HTML = '';

		/** @type {String} is the eventlistener to use. for checkbox its be onclick, for select its be onchange etc. */
		this.updateMethod = '';

		/** @type {String} is the key to get checked when writing an update, for checkboxes it's checked, for selects its value etc.*/
		this.updateKey = '';

		this.#wrapper = false;

		this.#disabled = false;

		// general stuff that every setting has
		if (this.props.safety > 0) this.HTML += skeleton.safetyIcon(safetyDesc[this.props.safety]);
		else if (this.props.instant || this.props.refreshOnly) this.HTML += skeleton.refreshIcon(this.props.instant ? 'instant' : 'refresh-icon');

		if (this.props.key === 'matchmaker_regions' && userPrefs.regionTimezones) {
			this.props.cols = 8;
			this.props.optDescriptions = MATCHMAKER_REGIONS.map(regionCode => getTimezoneByRegionKey('code', regionCode));
		}

		function sanitize(string: string) {
			if (trusted) return string;
			return sanitizeString(string);
		}

		switch (props.type) {
			case 'bool':
				this.HTML += `<span class="setting-title">${sanitize(props.title)}</span>
					<label class="switch">
							<input class="s-update" type="checkbox" ${props.value ? 'checked' : ''} ${this.#disabled ? 'disabled' : ''}/>
							<div class="slider round"></div>
					</label>`;
				this.updateKey = 'checked';
				this.updateMethod = 'onchange';
				break;
			case 'text':
				this.HTML += `<span class="setting-title">${sanitize(props.title)}</span>
					<span class="setting-input-wrapper">
							<input type="text" class="rb-input s-update inputGrey2" name="${props.key}" autocomplete="off" placeholder="${props.placeholder ?? ''}" value="${props.value ?? ''}"/>
					</span>`;
				this.updateKey = 'value';
				this.updateMethod = 'oninput';
				break;
			case 'num':
				this.HTML += `<span class="setting-title">${sanitize(props.title)}</span>
				<span class="setting-input-wrapper">
					<div class="slidecontainer">
						<input type="range" class="sliderM s-update-secondary" name="${props.key}"
							value="${props.value}" min="${props.min}" max="${props.max}" step="${props?.step ?? 1}"
						/>
					</div>
					<input type="number" class="rb-input s-update sliderVal" name="${props.key}"
						autocomplete="off" value="${props.value}" min="${props.min}" max="${props.max}" step="${props?.step ?? 1}"
					/>
				</span>`;
				this.updateKey = 'valueAsNumber';
				this.updateMethod = 'oninput';
				break;
			case 'heading':
				this.HTML = `<h1 class="setting-title">${sanitize(props.title)}</h1>`;
				break;
			case 'sel': {
				// Option values are persisted ids and labels are display text, so a theme can be
				// renamed without invalidating anyone's settings.json. Both are always escaped:
				// user theme filenames reach this string and settings render as trusted.
				const optionLabels = props.optLabels ?? props.opts;
				this.HTML += `<span class="setting-title">${sanitize(props.title)}</span>
          			<select class="s-update inputGrey2">
						${props.opts.map((opt, i) => `<option value="${sanitizeString(opt)}">${sanitizeString(optionLabels[i] ?? opt)}</option>`).join('')}
					</select>`;
				this.updateKey = 'value';
				this.updateMethod = 'onchange';
				break;
			}
			case 'multisel': {
				const hasValidDescriptions = Object.hasOwn(this.props, 'optDescriptions') && this.props.opts.length === this.props.optDescriptions.length;
				if (Object.hasOwn(this.props, 'optDescriptions') && !hasValidDescriptions) throw new Error(`Setting '${this.props.key}' declared 'optDescriptions', but a different amount than 'opts'!`);
				this.HTML += `<span class="setting-title">${sanitize(props.title)}</span>
					<div class="crankshaft-multisel-parent s-update" ${props?.cols ? `style="grid-template-columns:repeat(${props.cols}, 1fr)"` : ''}>
						${props.opts.map((opt, i) => `<label class="hostOpt">
							<span class="optName">${sanitize(opt)}</span>
							${hasValidDescriptions ? `<span class="optDescription">${sanitize(this.props.optDescriptions[i])}</span>` : ''}
							<input type="checkbox" name="${opt}" ${(props.value as string[]).includes(opt) ? 'checked' : ''} />
							<div class="optCheck"></div>
						</label>`).join('')}
					</div>`;
				this.updateKey = 'value'; // this is bypassed anyway, because type === 'multisel'. '' throws
				this.updateMethod = 'onchange';
				break;
			}
			case 'color':
				this.HTML += `<span class="setting-title">${sanitize(props.title)}</span>
					<label class="setting-input-wrapper">
							<input class="s-update" type="color" value="${props.value ? props.value : ''}" ${this.#disabled ? 'disabled' : ''}/>
					</label>`;
				this.updateKey = 'value';
				this.updateMethod = 'onchange'; // oninput works too, but will fire each frame the selector is dragged, causing performance drops. onchange will fire when the selector is closed, ultimately achieving the same effect.
				break;
			case 'keybind':
				this.HTML += `<span class="setting-title">${sanitize(props.title)}</span>
					<label class="setting-input-wrapper crankshaftKeybindSettingWrapper">
							<input class="s-update keybinddummyinput" type="text" />
							<span class="material-icons crankshaftKeybindConflict" title="This keybind conflicts with '_'.">warning</span>
							<span class="keyIcon crankshaftKeyIcon">${ parseKeybindSettingDisplay(props.value as KeybindUserPref) }</span>
							<span class="material-icons crankshaftUnbindButton">delete_forever</span>
					</label>`;
				this.updateKey = 'value';
				this.updateMethod = 'onchange';
				break;
			default:
				this.HTML = `<span class="setting-title">${sanitize(props.title)}</span><span>Unknown setting type</span>`;
		}

		// add desc
		if (props.desc && props.desc !== '') this.HTML += `<div class="setting-desc-new">${sanitize(props.desc)}</div>`;
	}


	/**
	 * update the settings when you change something in the gui
	 * not sure if you can currently synthetically update the settings, but at that point just change userPrefs and re-render?
	 */
	update(elem: HTMLElement, callback: Callbacks, event?: InputEvent) {
		if (this.updateKey === '') throw new Error('Invalid update key');
		const target = elem.querySelector('.s-update') as HTMLInputElement;

		// parse & sanitize the value from our input element
		let dirtyValue: UserPrefs[keyof UserPrefs] = target[this.updateKey];

		if (this.props.type === 'multisel') {
			dirtyValue = [...target.children]
				.filter(child => child.querySelector('input:checked'))
				.map(child => child.querySelector('.optName').textContent);
		}

		if (this.props.type === 'num') {
			dirtyValue = event ? (event.target as HTMLInputElement).valueAsNumber : target.valueAsNumber;
			const slider = elem.querySelector('.s-update-secondary') as HTMLInputElement;
			const setVal = (val: string) => { target.value = val; slider.value = val; };
			const updateUI = () => setVal(dirtyValue.toString());
			if (Number.isNaN(dirtyValue)) {
				setVal(userPrefs[this.props.key].toString());
				return; // revert UI and don't apply this change;
			}
			if (Object.hasOwn(this.props, 'min') && dirtyValue < this.props.min) { dirtyValue = this.props.min; updateUI(); }
			if (Object.hasOwn(this.props, 'max') && dirtyValue > this.props.max) { dirtyValue = this.props.max; updateUI(); }
			updateUI(); // synchronize slider and number inputs visually
		}

		// Local display identity: coerce while typing so the stored value is always one the
		// preference loader accepts, and reflect dropped characters straight back into the input.
		if (isCustomIdentityTextPreferenceKey(this.props.key)) {
			const isClanKey = this.props.key === CUSTOM_CLAN_PREFERENCE_KEY || this.props.key === REAL_CLAN_PREFERENCE_KEY;
			const sanitized = isClanKey ? sanitizeCustomClan(dirtyValue) : sanitizeCustomName(dirtyValue);
			if (sanitized !== target.value) target.value = sanitized;
			dirtyValue = sanitized;
		}

		const value = (this.props.type === "keybind") ? JSON.parse(`${dirtyValue}`) : dirtyValue; // so we don't accidentally mutate it later

		if (this.props.type === "keybind") {
			elem.querySelector('.keyIcon').innerHTML = parseKeybindSettingDisplay(value);

			// Calculate whether or not this conflicts with any other keybinds
			if (callback === "normal") {				const warningElement = elem.querySelector('.crankshaftKeybindConflict');
				updateKeybindConflictDisplay(this.props.key, value, userPrefs[this.props.key] as KeybindUserPref, warningElement);
			}
		}

		if (callback === 'normal') {
			userPrefs[this.props.key] = value;
			saveSettings(this.props.key, value);
			if (this.props.key === 'hideAds') {
				const adsHidden = value === 'hide' || value === 'block';
				toggleSettingCSS(styleSettingsCSS.hideAds, this.props.key, adsHidden);
				document.getElementById('hiddenClasses').classList.toggle('hiddenClasses-hideAds-bottomOffset', adsHidden);
			}

			if (this.props.key === 'theme') applyThemeSelection(String(value));
			if (this.props.key === 'matchmaker' || this.props.key === 'matchmakerKey') {
				applyClientMatchmakerSettings(userPrefs);
			}
			if (this.props.key === 'motionBlur' || this.props.key === 'motionBlurStrength' || this.props.key === 'motionBlurQuality') {
				applyClientMotionBlurSettings(userPrefs);
			}
			if (this.props.key === 'wokMenuDeclutter') applyMenuDeclutterSettings(userPrefs);
			if (this.props.key === 'wokPublicServerPingSort') applyPublicServerPingSortSettings(userPrefs);

			// Live-applies: the replacement engine runs in this renderer, so there is nothing to
			// reload. Clearing the values puts the game's own text straight back.
			if (isCustomIdentityPreferenceKey(this.props.key)) applyCustomIdentity(userPrefs);

			// you can add custom instant refresh callbacks for settings here
			if (typeof value === 'boolean') {
				if (this.props.key === 'menuTimer') toggleSettingCSS(styleSettingsCSS.menuTimer, this.props.key, value);
				if (this.props.key === 'quickClassPicker') toggleSettingCSS(styleSettingsCSS.quickClassPicker, this.props.key, value);
			}
			updateRefreshNeededForKey(this.props.key);
			updateRefreshNotification();
			if (SETTINGS_VISIBILITY_CONTROLLER_KEYS.has(this.props.key)) queueMicrotask(renderSettings);
		} else {
			callback(value);
		}
	}


	/** this initializes the element and its eventlisteners.*/
	get elem() {
		if (this.#wrapper !== false) return this.#wrapper; // return the element if already initialized

		// i only create the element after .elem is called so i don't pollute the dom with virutal elements when making settings
		const classes = ['setting', 'settName', `safety-${this.props.safety}`, this.type];
		if (this.props.button) classes.push('has-button');

		const wrapper = createElement('div', {
			class: classes,
			id: `settingElem-${this.props.key}`,
			innerHTML: this.HTML
		});

		if (this.props.button) {
			const { icon, text, callback } = this.props.button;
			wrapper.appendChild(skeleton.settingButton(icon, text, callback, this.props.button.customTitle ?? void 0));
		}
		if (this.type === 'sel') wrapper.querySelector('select').value = String(this.props.value);

		if (this.type === 'keybind') {
			wrapper.querySelector('.keyIcon').addEventListener('mousedown', () => {
				triggerKeybindSettingDialog(this);
			})
			// The reason we do this is to transmit the value when updating the value, since there's no <input> for JS objects themselves.
			wrapper.querySelector('input').setAttribute("value", JSON.stringify(this.props.value));

			wrapper.querySelector('.crankshaftUnbindButton').addEventListener('mousedown', () => {
				setKeybindSetting(this, {
					shift: false,
					alt: false,
					ctrl: false,
					key: 'NONE'
				})
			})

			const warningElement = wrapper.querySelector('.crankshaftKeybindConflict') as HTMLElement;
			if (this.props.callback === "normal") {				updateKeybindConflictDisplay(this.props.key, this.props.value as KeybindUserPref, this.props.value as KeybindUserPref, warningElement);
			} else {
				warningElement.style.display = "none";
			}
		}

		if (typeof this.props.callback === 'undefined') this.props.callback = 'normal'; // default callback

		// @ts-ignore
		wrapper[this.updateMethod] = (event: InputEvent) => {
			this.update(wrapper, this.props.callback, event);
		};

		this.#wrapper = wrapper;
		return wrapper; // return the element
	}

}

/**
 * Updates the displayed keybinding conflict elements
 * @param key the object key of the setting that was changed
 * @param value the value of the setting after the change
 * @param oldValue the value of the setting before the change
 * @param baseWarningElement the initiator's baseWarningElement
 */
function updateKeybindConflictDisplay(key: string, value: KeybindUserPref, oldValue: KeybindUserPref, baseWarningElement: Element) {
	const conflictingOptions: string[] = [];
	const warningElementsToModify: Element[] = [baseWarningElement];
	Object.keys(settingsDesc).forEach((settingKey: keyof typeof settingsDesc) => {
		// If the setting type is a keybind, and the setting isn't the initiator, and the keybind change matches another setting before/after the change
		if (settingsDesc[settingKey].type === "keybind" && settingKey !== key && (objectsAreEqual(userPrefs[settingKey] as KeybindUserPref, value) || objectsAreEqual(userPrefs[settingKey] as KeybindUserPref, oldValue))) {
			if (settingElementPairs[settingKey]) warningElementsToModify.push(settingElementPairs[settingKey].elem.querySelector('.crankshaftKeybindConflict'));
			if (objectsAreEqual(userPrefs[settingKey] as KeybindUserPref, value)) conflictingOptions.push(settingsDesc[settingKey].title);
		}
	})
	for (const warningElement of warningElementsToModify) {
		if (warningElement) {
			if (conflictingOptions.length > 0) {
				warningElement.classList.remove('hidden');
				warningElement.setAttribute("title", `This keybind conflicts with ${conflictingOptions.join(', ')}. Things may not work as intended.`)
			} else {
				warningElement.classList.add('hidden');
			}
		}
	}
}

let capturingKeybindSetting: false | SettingElem = false;

/**
 * True while the keybind-capture dialog is on screen. The preload's gameplay keydown handler
 * checks this instead of scanning the document for the dialog class on every keypress.
 */
export const isKeybindCaptureActive = (): boolean => capturingKeybindSetting !== false;

// Construct keybind overlay
const keybindSettingDialogElement = createElement('div', {
	class: ['customKeybindSettingWrapper']
})
const keybindSettingDialogCard = createElement('div', {
	class: ['customKeybindSettingDialogCard']
})
const keybindSettingDialogTitle = createElement('div', {
	class: ['customKeybindSettingDialogTitle'],
	innerText: 'Edit Keybind: Setting Name'
})
const keybindSettingDialogSubTitle = createElement('div', {
	class: ['customKeybindSettingDialogSubTitle'],
	innerHTML: 'Press any key on your keyboard. Press <code>Shift+Escape</code> to cancel.'
})
const keybindSettingDialogContent = createElement('div', {
	class: ['customKeybindSettingDialogContent']
})
const keybindSettingDialogShiftIndicator = createElement('div', {
	class: ['customKeybindSettingDialogIndicator'],
	innerText: 'Shift'
})
const keybindSettingDialogCtrlIndicator = createElement('div', {
	class: ['customKeybindSettingDialogIndicator'],
	innerText: 'Control'
})
const keybindSettingDialogAltIndicator = createElement('div', {
	class: ['customKeybindSettingDialogIndicator'],
	innerText: 'Alt'
})
const keybindSettingDialogCancelButton = createElement('div', {
	class: ['customKeybindSettingDialogCancelButton'],
	innerText: 'Cancel'
})
keybindSettingDialogCancelButton.addEventListener('click', removeKeybindSettingDialog);

keybindSettingDialogContent.appendChild(keybindSettingDialogShiftIndicator);
keybindSettingDialogContent.appendChild(keybindSettingDialogCtrlIndicator);
keybindSettingDialogContent.appendChild(keybindSettingDialogAltIndicator);

keybindSettingDialogCard.appendChild(keybindSettingDialogCancelButton);
keybindSettingDialogCard.appendChild(keybindSettingDialogTitle);
keybindSettingDialogCard.appendChild(keybindSettingDialogSubTitle);
keybindSettingDialogCard.appendChild(keybindSettingDialogContent);

keybindSettingDialogElement.appendChild(keybindSettingDialogCard);

/**
 * Stores class name for active modifier elements
*/
const activeIndicatorClass = 'activeIndicator';

function setKeybindSetting(settingElem: SettingElem, setting: KeybindUserPref) {
	// We transmit the change through the <input> element to keep the flow the same; there's no <input> for JS objects themselves.
	settingElem.elem.querySelector('input').setAttribute("value", JSON.stringify(setting));
	settingElem.update(settingElem.elem, settingElem.props.callback);
}

/**
 * The handler for key rebinding. This is where the setting is updated and the reset function is called.
 * @param event KeyboardEvent that triggered the keybind dialog listener
 */
function keybindSettingDialogListener(event: KeyboardEvent) {
	event.stopImmediatePropagation();
	event.preventDefault();
	if (capturingKeybindSetting !== false) {
		if (event.key === "Escape" && event.shiftKey) {
			removeKeybindSettingDialog();
		} else {
			const capturedSetting = turnKeyboardEventIntoSettingValue(event);
			setKeybindSetting(capturingKeybindSetting, capturedSetting);
			removeKeybindSettingDialog();
		}
	}
}

document.addEventListener('keydown', (event) => {
	if (capturingKeybindSetting !== false) {
		// These event stoppers are here to prevent other keys being accessed while rebinding something.
		event.stopImmediatePropagation();
		event.preventDefault();

		switch (event.key) {
			case "Control":
				keybindSettingDialogCtrlIndicator.classList.add(activeIndicatorClass);
				break;
			case "Shift":
				keybindSettingDialogShiftIndicator.classList.add(activeIndicatorClass);
				break;
			case "Alt":
				keybindSettingDialogAltIndicator.classList.add(activeIndicatorClass);
				break;
			default:
				break;
		}
	}
})

/**
 * Resets the classLists of the key modifier elements
 */
function resetKeybindModifierIndicators() {
	keybindSettingDialogCtrlIndicator.classList.remove(activeIndicatorClass);
	keybindSettingDialogShiftIndicator.classList.remove(activeIndicatorClass);
	keybindSettingDialogAltIndicator.classList.remove(activeIndicatorClass);
}

/**
 * Removes the keybind dialog, resets the auxilary variable, and removes the event listener.
 */
function removeKeybindSettingDialog() {
	resetKeybindModifierIndicators();
	document.removeEventListener('keyup', keybindSettingDialogListener, true);
	keybindSettingDialogElement.remove();
	capturingKeybindSetting = false;
}

/**
 * Shows the rebind dialog, element is the SettingElem that requires the dialog.
 * @param element The setting that the dialog should use for rebinding.
 */
function triggerKeybindSettingDialog(element: SettingElem) {
	if (capturingKeybindSetting === false) {
		capturingKeybindSetting = element;
		keybindSettingDialogTitle.innerText = `Edit Keybind: ${element.props.title}`;
		resetKeybindModifierIndicators();
		document.addEventListener('keyup', keybindSettingDialogListener, true);
		document.getElementById("uiBase").appendChild(keybindSettingDialogElement);
	}
}

/** a settings generation helper. has some skeleton elements and methods that make them. purpose: prevents code duplication */
const skeleton = {
	/** make a setting cateogry */
	category: (title: string, innerHTML: string, elemClass = 'mainSettings') => `
	<div class="setHed Crankshaft-setHed"><span class="material-icons plusOrMinus">keyboard_arrow_down</span> ${title}</div>
	<div class="setBodH Crankshaft-setBodH ${elemClass}">
			${innerHTML}
	</div>`,

	/**
	 * make a setting with some text (notice)
	 * @param desc description of the notice
	 * @param opts desc => description, iconHTML => icon's html, generate through skeleton's *icon methods
	 */
	notice: (notice: string, opts?: { desc?: string, iconHTML?: string }) => `
	<div class="settName setting">
		${(opts?.iconHTML ?? false) ? opts.iconHTML : ''}
		<span class="setting-title crankshaft-gray">${notice}</span>
		${(opts?.desc ?? false) ? `<div class="setting-desc-new">${opts.desc}</div>` : ''}
	</div>`,

	/** wrapped safety warning icon (color gets applied through css) */
	safetyIcon: (safety: string) => `
	<span class="desc-icon" title="${safety}">
		<svg xmlns="http://www.w3.org/2000/svg" height="24" width="24"><path d="M12 12.5ZM3.425 20.5Q2.9 20.5 2.65 20.05Q2.4 19.6 2.65 19.15L11.2 4.35Q11.475 3.9 12 3.9Q12.525 3.9 12.8 4.35L21.35 19.15Q21.6 19.6 21.35 20.05Q21.1 20.5 20.575 20.5ZM12 10.2Q11.675 10.2 11.463 10.412Q11.25 10.625 11.25 10.95V14.45Q11.25 14.75 11.463 14.975Q11.675 15.2 12 15.2Q12.325 15.2 12.538 14.975Q12.75 14.75 12.75 14.45V10.95Q12.75 10.625 12.538 10.412Q12.325 10.2 12 10.2ZM12 17.8Q12.35 17.8 12.575 17.575Q12.8 17.35 12.8 17Q12.8 16.65 12.575 16.425Q12.35 16.2 12 16.2Q11.65 16.2 11.425 16.425Q11.2 16.65 11.2 17Q11.2 17.35 11.425 17.575Q11.65 17.8 12 17.8ZM4.45 19H19.55L12 6Z"/></svg>
	</span>`,

	/** wrapped refresh icon (color gets applied through css) */
	refreshIcon: (mode: 'instant' | 'refresh-icon') => `
	<span class="desc-icon ${mode}" title="${mode === 'instant' ? 'Applies instantly! (No refresh of page required)' : 'Refresh page to see changes'}">
		<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="#000000"><path d="M12 6v1.79c0 .45.54.67.85.35l2.79-2.79c.2-.2.2-.51 0-.71l-2.79-2.79c-.31-.31-.85-.09-.85.36V4c-4.42 0-8 3.58-8 8 0 1.04.2 2.04.57 2.95.27.67 1.13.85 1.64.34.27-.27.38-.68.23-1.04C6.15 13.56 6 12.79 6 12c0-3.31 2.69-6 6-6zm5.79 2.71c-.27.27-.38.69-.23 1.04.28.7.44 1.46.44 2.25 0 3.31-2.69 6-6 6v-1.79c0-.45-.54-.67-.85-.35l-2.79 2.79c-.2.2-.2.51 0 .71l2.79 2.79c.31.31.85.09.85-.35V20c4.42 0 8-3.58 8-8 0-1.04-.2-2.04-.57-2.95-.27-.67-1.13-.85-1.64-.34z"/></svg>
	</span>`,

	/** make a settings category header element */
	catHedElem: (title: string) => createElement('div', {
		class: 'setHed Crankshaft-setHed'.split(' '),
		innerHTML: `${title}`
	}),

	/** make a settings category body element */
	catBodElem: (elemClass: string, content: string) => createElement('div', {
		class: `setBodH Crankshaft-setBodH ${elemClass}`.split(' '),
		innerHTML: content
	}),

	refreshElem: (level: (typeof RefreshEnum)[keyof typeof RefreshEnum]) => {
		switch (level) {
			case RefreshEnum.reloadApp:
				return '<span class="restart-msg">Restart client fully to see changes</span>';
			case RefreshEnum.refresh:
				return `<span class="reload-msg">${skeleton.refreshIcon('refresh-icon')}Reload page with <code>F5</code> or <code>${os.platform() === "darwin" ? "CMD" : "CTRL"} + R</code> to see changes</span>`;
			case RefreshEnum.notNeeded:
			default:
				return '';
		}
	},

	settingButton: (icon: string, text: string, callback: (e?: MouseEvent) => void, customTitle?: string) => {
		const button = createElement('div', {
			innerHTML: `<span class="material-icons">${icon}</span> ${text}`,
			class: ['settingsBtn'],
			title: customTitle ?? text
		});
		button.addEventListener('click', callback);
		return button;
	}
};

/**
 * The function used to filter settings to match the search term
 * @param setting The setting that may be filtered out
 * @param query The search term
 * @returns Whether or not the setting meets the search term
 */
function settingSearchFilter(setting: RenderReadySetting, query: string) {
	return `${setting.title}${setting.desc ?? ""}`.toLowerCase().includes(query);
}

/**
 * HTML Element that holds all of crankshaft's setting elements
 */
const crankshaftSettingsHolder = createElement('div', {
	class: ['Crankshaft-settings']
})

/**
 * Stores setting/element key pairs. Used for when setting changes affect different settings. (e.g. keybinding conflicts)
 */
let settingElementPairs: { [key: string]: SettingElem } = {};

/** Sidebar section the user last opened; survives re-renders so a refresh never dumps them back to the top. */
let activeSettingsCategory = 0;

function toggleSettingsCategory(header: Element) {
	const sibling = header.nextElementSibling;
	if (!sibling) return;
	sibling.classList.toggle('setting-category-collapsed');

	const iconElement = header.querySelector('.material-icons');
	if (!iconElement) return;
	iconElement.textContent = iconElement.textContent === 'keyboard_arrow_down'
		? 'keyboard_arrow_right'
		: 'keyboard_arrow_down';
}

crankshaftSettingsHolder.addEventListener('click', event => {
	if (!(event.target instanceof Element)) return;
	const header = event.target.closest('.Crankshaft-setHed');
	if (header && crankshaftSettingsHolder.contains(header)) toggleSettingsCategory(header);
});

export function renderSettings() {
	const filter = ((document.getElementById('settSearch') as (HTMLInputElement | undefined))?.value ?? '').toLowerCase();
	Array.from(document.querySelectorAll('.setHed')).filter(element => element.innerHTML === 'No settings found').forEach(element => element.remove());

	crankshaftSettingsHolder.remove();
	crankshaftSettingsHolder.replaceChildren();
	settingElementPairs = {};

	const settings = transformMarrySettings(userPrefs, settingsDesc, 'normal')
		.filter(setting => settingIsVisible(setting.key, userPrefs))
		.filter(setting => settingSearchFilter(setting, filter));
	const categoryBodies = new Map<number, HTMLElement>();
	const categorySections = new Map<number, HTMLElement>();
	// Sidebar layout: sections are chosen from a persistent nav rather than hunted for by
	// scrolling through stacked collapsibles. One section is visible at a time, so the list the
	// user is reading is never buried under the ones they are not.
	const nav = createElement('div', { class: ['Crankshaft-settings-nav'] });
	const pane = createElement('div', { class: ['Crankshaft-settings-pane'] });
	crankshaftSettingsHolder.append(nav, pane);
	const navButtons = new Map<number, HTMLElement>();
	const showCategory = (categoryIndex: number) => {
		activeSettingsCategory = categoryIndex;
		for (const [index, button] of navButtons) button.classList.toggle('active', index === categoryIndex);
		for (const [index, section] of categorySections) section.classList.toggle('hidden', index !== categoryIndex);
	};
	const ensureCategory = (categoryIndex: number): HTMLElement => {
		const existing = categoryBodies.get(categoryIndex);
		if (existing) return existing;
		const category = categoryNames[categoryIndex];
		const body = skeleton.catBodElem(category.cat, category.note ? skeleton.notice(category.note) : '');
		const section = createElement('div', { class: ['Crankshaft-settings-section'] });
		section.append(skeleton.catHedElem(category.name), body);
		pane.append(section);
		const button = createElement('div', { class: ['Crankshaft-settings-navitem'], innerHTML: category.name });
		button.addEventListener('click', () => { showCategory(categoryIndex); });
		nav.append(button);
		navButtons.set(categoryIndex, button);
		categorySections.set(categoryIndex, section);
		categoryBodies.set(categoryIndex, body);
		return body;
	};

	// Preserve the basic client category even when a search filters out all of its settings.
	if (!settings.some(setting => setting.cat === 0)) ensureCategory(0);

	for (const setting of settings) {
		const settingElement = new SettingElem(setting);
		settingElementPairs[setting.key] = settingElement;
		ensureCategory(setting.cat ?? 0).appendChild(settingElement.elem);
	}

	// Links and file shortcuts live in About: they are reference material, not things anyone
	// came into settings to change, so they must not sit above the settings people did come for.
	const aboutCategory = ensureCategory(ABOUT_CATEGORY_INDEX);
	const supportHolder = createElement('div', { class: ['crankshaft-button-holder', 'setting', 'settName'], innerHTML: '<span class="buttons-title">Links:</span>'});
	supportHolder.appendChild(skeleton.settingButton('language', 'Website', _ => shell.openExternal(WEBSITE_URL)));
	supportHolder.appendChild(skeleton.settingButton('code', 'WOK on GitHub', _ => shell.openExternal(REPO_URL)));
	supportHolder.appendChild(skeleton.settingButton('code', 'Crankshaft (upstream)', _ => shell.openExternal(UPSTREAM_REPO_URL)));

	const buttonsHolder = createElement('div', { class: ['crankshaft-button-holder', 'setting', 'settName'], innerHTML: '<span class="buttons-title">Quick open:</span>' });
	buttonsHolder.appendChild(skeleton.settingButton('file_open', 'Settings file', e => openPath(e, userPrefsPath)));
	buttonsHolder.appendChild(skeleton.settingButton('folder', 'WOK folder', e => openPath(e, paths.configPath)));
	aboutCategory.append(supportHolder, buttonsHolder);

	showCategory(categorySections.has(activeSettingsCategory) ? activeSettingsCategory : [...categorySections.keys()][0] ?? 0);

	document.getElementById('settHolder').appendChild(crankshaftSettingsHolder);
}
