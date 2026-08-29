/** biome-ignore-all lint/correctness/noUnusedVariables: .d.ts file */
type UserPrefs = {
	/** Local-only rewritten identity styling; disabled by default. */
	customIdentityRgbCycle?: boolean;
	/** Sort Public server regions by measured latency and show ping; enabled by default. */
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
	/**
	 * Present when something about the GPU setup deserves the user's attention: the active
	 * adapter looks integrated while a discrete adapter exists, or a manually selected backend
	 * keeps crashing its GPU process (manual choices are never quarantined).
	 */
	gpuAdvisory?: string;
	/** Machine-readable advisory category for compact surfaces such as the overlay. */
	gpuAdvisoryKind?: 'integrated-fallback' | 'manual-backend-failure';
}

interface CompetitiveModeRuntimeInfo {
	adaptiveValidationState?: unknown;
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

interface NetworkDiagnosticsSnapshot {
	available: boolean;
	currentReportedPingMs: number;
	minimumReportedPingMs: number;
	medianReportedPingMs: number;
	p95ReportedPingMs: number;
	reportedPingVariationMs: number;
	reportedPingSampleAgeMs: number;
	reportedPingSampleCount: number;
	reportedPingWindowSeconds: number;
	regionCode: string;
	reportedTps: number;
	networkLagWarning: boolean;
}

interface WokPerformanceAPI {
	networkSnapshot: () => NetworkDiagnosticsSnapshot;
	reset: () => void;
	setVisible: (visible: boolean) => void;
	snapshot: () => PerformanceSnapshot;
}

// stuff krunker adds
type SettingsTab = {
	name: string;
	categories: string[];
};

interface Window {
	OffCliV: boolean;
	closeClient: Function;
	wokPerformance?: WokPerformanceAPI;
	crankshaftPerformance?: WokPerformanceAPI;
	getGameActivity: Function;
	showWindow: Function;
	setSetting: (key: string, value: boolean | number | string) => void;
	instruction: { log: (type: number, message: string) => void };
	openHostWindow: (isCustom: boolean, type: number) => void;
	openServerWindow: (id: number) => void;
	playSelect: (volume?: number) => void;
	closeHostWindow: () => void;
	createPrivateRoom: () => void;
	windows: [{ // settings window
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

/*
 *	these setting type defs do look complicated but they just ensure a noob can easily create a new setting.
 *	basically, settings are SettingItemGeneric + a type: string. some types have extra fields, as you can see
 */

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

	// This is for the (!) display on settings, describing if they are safe to use, and at what level they are safe.
	safety: number;
	type: ValidTypes;
	button?: SettingExtraButton;

	/** category */
	cat?: number;

	/** applies instantly */
	instant?: boolean;

	/** only refresh, not full restart required */
	refreshOnly?: boolean;
}

/**
 * sel has to have an opts with a string array.
 * optLabels, when present, must be the same length as opts: opts holds the values persisted in
 * settings.json and optLabels the text shown for each, so a label can change without migrating.
 *
 * `optLabels` is optional and, when present, must be the same length as `opts`: it lets the stored
 * value differ from the text the player reads. Needed wherever the persisted value is an opaque
 * key rather than a word - the display picker stores a monitor key but shows a resolution.
 */
interface SelectSettingDescItem extends SettingItemGeneric { type: 'sel', opts?: string[], optLabels?: string[] }

interface KeybindSettingDescItem extends SettingItemGeneric { type: 'keybind' }

interface MultiselectSettingDescItem extends SettingItemGeneric {
	type: 'multisel',
	opts: string[],

	/** optDescriptions.length must equal opts.length! */
	optDescriptions?: string[],
	cols: number
}

interface TextSettingDescItem extends SettingItemGeneric {
	type: 'text',
	placeholder?: string
}

// num has to have a min and max
interface NumSettingItem extends SettingItemGeneric { type: 'num', min?: number, max?: number }

type SettingsDescItem = (SettingItemGeneric | NumSettingItem | SelectSettingDescItem | MultiselectSettingDescItem | TextSettingDescItem | KeybindSettingDescItem);

/** array of SettingDescItem objects */
interface SettingsDesc {
	[settingKey: string]: SettingsDescItem;
}

/** a render-ready setting. contains a SettingsDescItem + value, callback and key */
interface RenderReadySetting extends SettingItemGeneric {
	type: ValidTypes;

	// for sel
	opts?: string[];

	/** Display text per opt; when omitted the opt itself is shown. Must match opts.length. */
	optLabels?: string[];
	cols?: number;

	// for multisel
	/** optDescriptions.length must equal opts.length! */
	optDescriptions?: string[];

	// for num
	min?: number;
	max?: number;
	step?: number;

	// for text
	placeholder?: string;

	// the data
	key: string;
	callback: Callbacks;

	value: UserPrefValue;
}

interface CategoryName {
	name: string;
	cat: string;
	note?: string;
}

// discord rpc
type RPCargs = { details: string, state: string };

/**
 * return type of window.getGameActivity()
 * we can't ensure krunker doesen't change or fail to return this exact object
 * this should be consumed as `Partial<GameInfo>` with fallbacks from elements for properties you are using
 */
interface GameInfo {

	/** example: FRA:h83cx */
	id: string,

	/** example: 126 */
	time: number,

	/** example: KraXen72 */
	user: string,
	class: {

		/** example: Triggerman */
		name: string,

		/** example: "0"*/
		index?: string
	},

	/** example: Subzero */
	map: string,

	/** example: Free for All */
	mode: string,

	/** example: false */
	custom: boolean,

	/** added by us, example: Baller */
	skin?: string
}

interface IMatchmakerCriteria {
	minPlayers: number,
	maxPlayers: number,

	/** e.g. FRA */
	regions: string[],

	/** e.g. 'Free for All' */
	gameModes: string[],

	mapScope: MatchmakerMapScope,
	maps: string[],

	/** remaining time in seconds */
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
