/** biome-ignore-all lint/correctness/noUnusedVariables: .d.ts file */
type UserPrefs = {

	customIdentityRgbCycle?: boolean;

	wokMenuDeclutter?: boolean;

	wokPublicServerPingSort?: boolean;
	[preference: string]: UserPrefValue;
};

type MatchmakerMapScope = 'official' | 'selected' | 'all';

type KeybindUserPref = {
	shift: boolean,
	alt: boolean,
	ctrl: boolean,
	key: string
}

type UserPrefValue = boolean | string | string[] | number | KeybindUserPref;

interface InsertedCSS {
	[identifier: string]: string;
}

interface GraphicsRuntimeInfo {
	activeBackend: string;
	preference: string;
	recommendation: string;
	reason: string;
	source: string;
	features: Record<string, string>;

	gpuAdvisory?: string;

	gpuAdvisoryKind?: 'integrated-fallback' | 'manual-backend-failure';
}

interface CompetitiveModeRuntimeInfo {
	hasGameSettingsBackup: boolean;
}

interface PerformanceSnapshot {
	averageFps: number;
	currentFps: number;
	onePercentLowFps: number;
	p95FrameTimeMs: number;
	sampleCount: number;
	worstFrameTimeMs: number;
	windowSeconds: number;
}

type SettingsTab = {
	name: string;
	categories: string[];
};

interface Window {
	OffCliV: boolean;
	closeClient: Function;
	getGameActivity: Function;
	showWindow: Function;
	setSetting: (key: string, value: boolean | number | string) => void;
	instruction: { log: (type: number, message: string) => void };
	openHostWindow: (isCustom: boolean, type: number) => void;
	openServerWindow: (id: number) => void;
	playSelect: (volume?: number) => void;
	closeHostWindow: () => void;
	createPrivateRoom: () => void;
	windows: [{
		settingType: 'basic' | 'advanced';
		tabIndex: number;
		tabs: {
			basic: SettingsTab[];
			advanced: SettingsTab[];
		}
		getTabs: Function;
		changeTab: Function;
		genList: Function;
		toggleType: Function;
		getSettings: Function;
		searchList: Function;
	}, ...Object[]];
}

type Callbacks = 'normal' | Function;
type ValidTypes = 'bool' | 'heading' | 'text' | 'sel' | 'multisel' | 'color' | 'num' | 'keybind';

interface SettingExtraButton {
	icon: string,
	text: string,
	callback: (e?: MouseEvent) => void,
	customTitle?: string
}

interface SettingItemGeneric {
	title: string;
	desc?: string;

	safety: number;
	type: ValidTypes;
	button?: SettingExtraButton;

	cat?: number;

	instant?: boolean;

	refreshOnly?: boolean;
}

interface SelectSettingDescItem extends SettingItemGeneric { type: 'sel', opts?: string[], optLabels?: string[] }

interface KeybindSettingDescItem extends SettingItemGeneric { type: 'keybind' }

interface MultiselectSettingDescItem extends SettingItemGeneric {
	type: 'multisel',
	opts: string[],

	optDescriptions?: string[],
	cols: number
}

interface TextSettingDescItem extends SettingItemGeneric {
	type: 'text',
	placeholder?: string
}

interface NumSettingItem extends SettingItemGeneric { type: 'num', min?: number, max?: number }

type SettingsDescItem = (SettingItemGeneric | NumSettingItem | SelectSettingDescItem | MultiselectSettingDescItem | TextSettingDescItem | KeybindSettingDescItem);

interface SettingsDesc {
	[settingKey: string]: SettingsDescItem;
}

interface RenderReadySetting extends SettingItemGeneric {
	type: ValidTypes;

	opts?: string[];

	optLabels?: string[];
	cols?: number;

	optDescriptions?: string[];

	min?: number;
	max?: number;
	step?: number;

	placeholder?: string;

	key: string;
	callback: Callbacks;

	value: UserPrefValue;
}

interface CategoryName {
	name: string;
	cat: string;
	note?: string;
}

type RPCargs = { details: string, state: string };

interface GameInfo {

	id: string,

	time: number,

	user: string,
	class: {

		name: string,

		index?: string
	},

	map: string,

	mode: string,

	custom: boolean,

	skin?: string
}

interface IMatchmakerCriteria {
	minPlayers: number,
	maxPlayers: number,

	regions: string[],

	gameModes: string[],

	mapScope: MatchmakerMapScope,
	maps: string[],

	minRemainingTime: number,
}

interface IMatchmakerGame {
	gameID: string;
	region: string;
	playerCount: number;
	playerLimit: number;
	map: string;
	gamemode: string;
	remainingTime: number;
}
type ValidRequestTypes = 'mainFrame' | 'subFrame' | 'stylesheet' | 'script' | 'image' | 'font' | 'object' | 'xhr' | 'ping' | 'cspReport' | 'media' | 'webSocket';
interface WebRequestFilter {
	urls: string[];
	types?: ValidRequestTypes[];
}
