import { join } from 'path';
import { readdirSync } from 'fs';
import { readFile } from 'fs/promises';
import * as os from "os";
import { ipcRenderer, shell } from 'electron'; // add app if crashes
import { createElement, haveSameContents, toggleSettingCSS, parseKeybindSettingDisplay, turnKeyboardEventIntoSettingValue, objectsAreEqual } from './utils.ts';
import { UPSTREAM_REPO_URL, WEBSITE_URL } from './branding.ts';
import { styleSettingsCSS, getTimezoneByRegionKey, strippedConsole } from './preload.ts';
import { MATCHMAKER_GAMEMODES, MATCHMAKER_REGIONS } from './matchmaker-data.ts';
import { SettingsRefreshTracker, type SettingsRefreshRequirement } from './settings-refresh.ts';

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

// Swapper options are declared here so that TS knows they are the correct type for modifications under the m_userPrefs_for_settingUI message
const cssSwapperOption: SelectSettingDescItem = {
	title: 'CSS Swapper',
	type: 'sel',
	desc: 'Load and swap between CSS files',
	safety: 0,
	cat: 1,
	instant: true,
	opts: [],
	button: {
		icon: 'folder',
		text: 'CSS',
		callback: e => openPath(e, paths.cssPath)
	}
}

ipcRenderer.on('m_userPrefs_for_settingsUI', (_event, received_paths: IPaths, received_userPrefs: UserPrefs) => {
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

	settingsDesc.competitiveMode.button = { icon: 'speed', text: 'Run calibration', callback: () => ipcRenderer.send('calibration_request_rerun') };
	settingsDesc.resourceSwapper.button = { icon: 'folder', text: 'Swapper', callback: e => openPath(e, paths.swapperPath) };
	settingsDesc.customFilters.button = { icon: 'filter_list', text: 'Filters file', callback: e => openPath(e, paths.filtersPath) };

	cssSwapperOption.opts = ['None', ...readdirSync(paths.cssPath).filter(path => path.endsWith('.css'))];
	if (!cssSwapperOption.opts.includes(`${userPrefs.cssSwapper}`)) userPrefs.cssSwapper = 'None';
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

let customCssLoadGeneration = 0;

async function applyCustomCssSelection(value: string) {
	const generation = ++customCssLoadGeneration;
	const cssElement = document.getElementById('crankshaftCustomCSS');
	if (!cssElement) return;
	if (value === 'None') {
		cssElement.textContent = '';
		return;
	}

	try {
		const cssFile = await readFile(join(paths.cssPath, value), { encoding: 'utf-8' });
		if (generation === customCssLoadGeneration && userPrefs.cssSwapper === value) {
			cssElement.textContent = cssFile;
		}
	} catch (error) {
		strippedConsole.error(`Failed to load custom CSS: ${value}`, error);
	}
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
	competitiveMode: { title: 'Competitive Mode', type: 'bool', desc: 'Applies the calibrated graphics and frame-delivery profile plus a reversible set of safe Krunker performance settings. Calibration runs only with your consent, never blocks first play, and applies its profile provisionally while your next play sessions confirm it. Original game settings are backed up before modification.', safety: 0, cat: 0 },
	fpsUncap: { title: 'Manual Un-cap FPS', type: 'bool', desc: 'Used when Competitive mode is off. Competitive mode uses the frame policy selected by calibration.', safety: 0, cat: 0 },
	graphicsBackend: { title: 'Manual Graphics Backend', type: 'sel', desc: 'Used when Competitive mode is off. Auto selects a conservative hardware profile. D3D11on12 is tuned for Intel-only Windows systems; Vulkan is experimental.', safety: 1, cat: 0, opts: ['auto', 'default', 'd3d11', 'd3d11on12', 'vulkan'] },
	performanceOverlay: { title: 'Performance Diagnostics', type: 'bool', desc: 'Shows lightweight renderer FPS/frame-time diagnostics plus Krunker-reported ping, variation, assigned region, TPS, and the game\'s lag warning. Reported ping is shown as-is and is not claimed to be RTT. Alt+F8 toggles visibility.', safety: 0, cat: 0, refreshOnly: true },
	fullscreen: { title: 'Start in Windowed/Fullscreen mode', type: 'sel', desc: "Use 'borderless' if you have client-capped fps and unstable fps in fullscreen", safety: 0, cat: 0, opts: ['windowed', 'maximized', 'fullscreen', ...(process.platform !== "win32" ? ['borderless'] : [])] },
	resourceSwapper: { title: 'Legacy Resource Swapper', type: 'bool', desc: 'Disabled by default. Prefer Krunker\'s official resource-pack and mod APIs; unofficial replacement may conflict with current service rules.', safety: 3, cat: 0 },
	discordRPC: { title: 'Legacy Discord Rich Presence', type: 'bool', desc: 'Uses the upstream Crankshaft Discord application until WOK Client receives its own Discord application ID.', safety: 0, cat: 0 },
	extendedRPC: { title: 'Extended Discord RPC', type: 'bool', desc: 'Adds WOK Client and upstream source buttons. No effect if RPC is off.', safety: 0, cat: 0, instant: true },
	hideAds: { title: 'Legacy Ad Controls', type: 'sel', desc: 'Disabled by default. Blocking or hiding advertisements may conflict with current service requirements. Changing network blocking requires an app restart.', safety: 4, cat: 0, opts: ['off', 'hide', 'block'] },
	customFilters: { title: 'Custom Network Filters', type: 'bool', desc: 'Disabled by default. Filters can modify or cancel game requests and may conflict with current service rules. Changes require an app restart.', safety: 4, cat: 0 },
	saveMatchResultJSONButton: { title: 'Match Result To Clipboard', type: 'bool', desc: 'New button on match end which copies the match results JSON.', safety: 0, cat: 0, refreshOnly: true },

	cssSwapper: cssSwapperOption,
	menuTimer: { title: 'Menu Timer', type: 'bool', safety: 0, cat: 1, instant: true },
	quickClassPicker: { title: 'Quick Class Picker', type: 'bool', safety: 0, cat: 1, instant: true },
	introAnimation: { title: 'Launch Animation', type: 'bool', desc: 'Plays the WOK identity animation over your desktop while the game loads. Takes effect on the next launch.', safety: 0, cat: 1 },
	introAudio: { title: 'Launch Animation Sound', type: 'bool', desc: 'Plays the launch sting. Has no effect if Launch Animation is off. Takes effect on the next launch.', safety: 0, cat: 1 },
	clientSplash: { title: 'Client Splash Screen', type: 'bool', safety: 0, cat: 1, refreshOnly: true },
	immersiveSplash: { title: 'Immersive Splash Screen', type: 'bool', desc: 'Adds a background that covers the Krunker loading skeleton. Has no effect if Client Splash Screen is off.', safety: 0, cat: 1, refreshOnly: true },
	immersiveSplashBackgroundColor: { title: 'Immersive Splash Screen BG Color', desc: 'Changes the color of the immersive splash screen background. Has no effect if Immersive Splash Screen is off.', safety: 0, cat: 1, refreshOnly: true, type: 'color'},
	regionTimezones: { title: 'Region Picker Timezones', type: 'bool', desc: 'Adds local time to all region pickers', safety: 0, cat: 1, refreshOnly: true },

	matchmaker: { title: 'Custom Matchmaker', type: 'bool', desc: "Disabled by default. Selects servers but does not automate gameplay; unofficial matchmaking may conflict with current service rules.", safety: 2, cat: 2, refreshOnly: true },
	competitionAutomation: { title: 'Competition Host Automation', type: 'bool', desc: 'Disabled by default. Allows confirmed WOK links to fill and create private competition rooms. Webhook secrets must be pasted manually; unofficial automation may conflict with current service rules.', safety: 4, cat: 2, refreshOnly: true },
	matchmakerKey: { title: 'Matchmaker Hotkey', type: 'keybind', desc: 'Change the hotkey for the matchmaker', safety: 0, cat: 2, refreshOnly: true },
	matchmaker_openServerWindow: { title: 'Open Server Window On Cancel', type: 'bool', safety: 0, cat: 2, instant: true },
	matchmaker_regions: { title: 'Whitelisted regions', type: 'multisel', desc: '', safety: 0, cat: 2, opts: MATCHMAKER_REGIONS, cols: 16, instant: true },
	matchmaker_gamemodes: { title: 'Whitelisted gamemodes', type: 'multisel', desc: '', safety: 0, cat: 2, opts: MATCHMAKER_GAMEMODES, cols: 4, instant: true },
	matchmaker_minRemainingTime: { title: 'Minimum remaining seconds', type: 'num', min: 0, max: 480, safety: 0, cat: 2, instant: true },
	matchmaker_minPlayers: { title: 'Minimum players in Lobby', type: 'num', min: 0, max: 7, safety: 0, cat: 2, instant: true },
	matchmaker_maxPlayers: { title: 'Maximum players in Lobby', type: 'num', min: 0, max: 7, safety: 0, cat: 2, instant: true, desc: 'if you set the criteria too strictly, matchmaker won\'t find anything' },
	matchmakerAcceptKey: { title: 'Matchmaker Accept Hotkey', type: 'keybind', desc: 'Change the hotkey that accepts a game from the custom matchmaker.', safety: 0, cat: 2, instant: true },
	matchmakerCancelKey: { title: 'Matchmaker Cancel Hotkey', type: 'keybind', desc: 'Change the hotkey that rejects a game from the custom matchmaker.', safety: 0, cat: 2, instant: true },

	overrideURL: { title: 'Override URL', desc: 'Advanced testing override. Only HTTPS URLs on krunker.io or its subdomains are accepted.', type: 'text', placeholder: 'https://krunker.io', safety: 3, cat: 3 },
	alwaysWaitForDevTools: { title: 'Always wait for DevTools', desc: 'WOK Client uses an alternative method to open DevTools in a new window if they take too long. This disables that. Might cause DevTools to not work', type: 'bool', safety: 3, cat: 3 },
	safeFlags_gpuRasterizing: { title: 'GPU Rasterization', type: 'bool', desc: 'Requests Chromium GPU page rasterization without bypassing driver protections. Krunker WebGL is already GPU rendered.', safety: 2, cat: 3 },
	safeFlags_disableBackgrounding: { title: 'Disable background optimizations', type: 'bool', desc: 'When tabbed out, keep the game running as if you were tabbed in. Uses more resources, but avoids catch-up', safety: 2, cat: 3 },
	experimentalFlags_increaseLimits: { title: 'Increase Renderer Limit', type: 'bool', desc: 'Raises the renderer-process ceiling. It does not bypass the GPU blocklist or guarantee better performance.', safety: 4, cat: 3 },
	experimentalFlags_experimental: { title: 'Unsupported Experimental Flags', type: 'bool', desc: 'May increase power use or reduce stability. No Krunker performance benefit has been proven.', safety: 4, cat: 3 }
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
	{ name: 'Client Settings', cat: 'mainSettings' },
	{ name: 'Visual Settings', cat: 'styleSettings' },
	{ name: 'Matchmaker', cat: 'matchmakerSettings' },
	{ name: 'Advanced Settings', cat: 'advSettings' }
];

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
			case 'sel':
				this.HTML += `<span class="setting-title">${sanitize(props.title)}</span>
          			<select class="s-update inputGrey2">
						${props.opts.map(opt => `<option value="${opt}">${opt}</option>`).join('')}
					</select>`;
				this.updateKey = 'value';
				this.updateMethod = 'onchange';
				break;
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

			if (this.props.key === 'cssSwapper') void applyCustomCssSelection(String(value));

			// you can add custom instant refresh callbacks for settings here
			if (typeof value === 'boolean') {
				if (this.props.key === 'menuTimer') toggleSettingCSS(styleSettingsCSS.menuTimer, this.props.key, value);
				if (this.props.key === 'quickClassPicker') toggleSettingCSS(styleSettingsCSS.quickClassPicker, this.props.key, value);
			}
			updateRefreshNeededForKey(this.props.key);
			updateRefreshNotification();
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
		innerHTML: `<span class="material-icons plusOrMinus">keyboard_arrow_down</span> ${title}`
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
		.filter(setting => settingSearchFilter(setting, filter));
	const categoryBodies = new Map<number, HTMLElement>();
	const ensureCategory = (categoryIndex: number): HTMLElement => {
		const existing = categoryBodies.get(categoryIndex);
		if (existing) return existing;
		const category = categoryNames[categoryIndex];
		const body = skeleton.catBodElem(category.cat, category.note ? skeleton.notice(category.note) : '');
		crankshaftSettingsHolder.append(skeleton.catHedElem(category.name), body);
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

	const mainCategory = ensureCategory(0);
	const supportHolder = createElement('div', { class: ['crankshaft-button-holder', 'setting', 'settName'], innerHTML: '<span class="buttons-title">Links:</span>'});
	supportHolder.appendChild(skeleton.settingButton('language', 'Website', _ => shell.openExternal(WEBSITE_URL)));
	supportHolder.appendChild(skeleton.settingButton('code', 'Crankshaft upstream', _ => shell.openExternal(UPSTREAM_REPO_URL)));

	const buttonsHolder = createElement('div', { class: ['crankshaft-button-holder', 'setting', 'settName'], innerHTML: '<span class="buttons-title">Quick open:</span>' });
	buttonsHolder.appendChild(skeleton.settingButton('file_open', 'Settings file', e => openPath(e, userPrefsPath)));
	buttonsHolder.appendChild(skeleton.settingButton('folder', 'WOK Client folder', e => openPath(e, paths.configPath)));
	mainCategory.prepend(buttonsHolder, supportHolder);

	document.getElementById('settHolder').appendChild(crankshaftSettingsHolder);
}
