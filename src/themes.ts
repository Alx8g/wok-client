export const THEME_NONE = 'None';
export const THEME_BASE_ASSET = 'theme-base.css';
export const THEME_GAME_ASSET = 'theme-game.css';
export const THEME_LAYER_ASSETS: readonly string[] = [THEME_BASE_ASSET, THEME_GAME_ASSET];
export const THEME_TEMPLATE_FILE = 'theme-template.css';
const MAX_SELECTION_LENGTH = 128;
const USER_THEME_FILE = /^[^/\\]+\.css$/u;
const BUNDLED_THEME_ID = /^[a-z][a-z0-9-]{1,31}$/u;
export interface BundledTheme {
	id: string;
	label: string;
	summary: string;
}
export const BUNDLED_THEMES: readonly BundledTheme[] = [
	{
		id: 'wok',
		label: 'WOK',
		summary: 'The house identity: near-black surfaces, hairline borders and the WOK yellow.'
	},
	{
		id: 'silk',
		label: 'Silk',
		summary: 'Light, generously spaced and softly shadowed, with translucent floating panels.'
	},
	{
		id: 'ember',
		label: 'Ember',
		summary: 'Warm charcoal browns lit by a burnt orange accent.'
	},
	{
		id: 'frost',
		label: 'Frost',
		summary: 'Cool blue-grey surfaces with a bright cyan accent.'
	},
	{
		id: 'paper',
		label: 'Paper',
		summary: 'Light warm paper surfaces with dark ink text and a deep gold accent.'
	},
	{
		id: 'terminal',
		label: 'Terminal',
		summary: 'Black, square-cornered and monospaced, with phosphor green text.'
	}
];
export interface ThemeVariable {
	name: string;
	description: string;
}
export const THEME_VARIABLES: readonly ThemeVariable[] = [
	{ name: '--wok-bg', description: 'Deepest background: the page behind the game, the settings backdrop and the splash.' },
	{ name: '--wok-surface', description: 'Panel and card background sitting on top of --wok-bg: the menu window, modals, popups.' },
	{ name: '--wok-surface-raised', description: 'Inputs, buttons and sub-cards that need to sit above --wok-surface.' },
	{ name: '--wok-border', description: 'Hairline separators and default control borders.' },
	{ name: '--wok-border-strong', description: 'Emphasised borders: hover states, focused controls, dialog edges.' },
	{ name: '--wok-accent', description: 'Primary accent: active tabs, group headings, action buttons, progress and focus.' },
	{ name: '--wok-accent-contrast', description: 'Text and icon colour drawn on top of a solid --wok-accent fill.' },
	{ name: '--wok-accent-soft', description: 'Translucent accent wash behind selected rows. Should keep some alpha.' },
	{ name: '--wok-text', description: 'Primary text colour.' },
	{ name: '--wok-text-muted', description: 'Secondary text: setting titles, tabs, table rows, toasts.' },
	{ name: '--wok-text-faint', description: 'Tertiary text: setting descriptions and captions.' },
	{ name: '--wok-text-on-art', description: 'Text drawn over artwork: class cards, map tiles, the click-to-play prompt. Keep it light even on a light theme, because what is behind it is a screenshot.' },
	{ name: '--wok-danger', description: 'Destructive and cancel affordances.' },
	{ name: '--wok-success', description: 'Confirm and accept affordances.' },
	{ name: '--wok-radius', description: 'Corner radius for controls, rows and small cards. 0 for a squared-off look.' },
	{ name: '--wok-radius-lg', description: 'Corner radius for the big floating surfaces: the menu window, modals, popups.' },
	{ name: '--wok-shadow', description: 'box-shadow applied to floating surfaces (dialogs, toasts, popups, the menu).' },
	{ name: '--wok-shadow-soft', description: 'Resting elevation for cards and rows. Keep it cheap: it is used many times per screen.' },
	{ name: '--wok-ease', description: 'transition-timing-function for menu interactions.' },
	{ name: '--wok-blur', description: 'backdrop-filter for menu-only surfaces. Leave at none unless the look needs glass.' },
	{ name: '--wok-font', description: "UI font stack. Applied game-wide, so it replaces Krunker's GameFont." },
	{ name: '--wok-font-mono', description: 'Monospace stack for keys, codes and metrics.' },
	{ name: '--wok-heading-transform', description: 'text-transform for group and section headings: uppercase or none.' },
	{ name: '--wok-heading-spacing', description: 'letter-spacing for group and section headings.' },
	{ name: '--wok-hud-bg', description: 'In-game panel background: killfeed, weapon list, scoreboard, chat, ammo.' },
	{ name: '--wok-hud-bg-inner', description: 'The inner fill Krunker layers inside a HUD panel. Keep it readable over gameplay.' },
	{ name: '--wok-hud-border', description: 'HUD panel border. transparent is a valid answer.' },
	{ name: '--wok-hud-text', description: 'Neutral HUD text. Never used for anything colour-coded.' },
	{ name: '--wok-scrollbar-track', description: 'Scrollbar trough.' },
	{ name: '--wok-scrollbar-thumb', description: 'Scrollbar thumb.' }
];
export function themeAssetName(id: string): string {
	return `theme-${id}.css`;
}
export function isBundledThemeId(value: unknown): value is string {
	return typeof value === 'string' && BUNDLED_THEME_ID.test(value) && BUNDLED_THEMES.some((theme) => theme.id === value);
}
export function isUserThemeFile(value: unknown): value is string {
	return typeof value === 'string' && value.length <= MAX_SELECTION_LENGTH && USER_THEME_FILE.test(value);
}
export type ThemeSource =
	| {
			kind: 'none';
	  }
	| {
			kind: 'bundled';
			id: string;
			assets: string[];
	  }
	| {
			kind: 'user';
			file: string;
	  };
export function resolveTheme(selection: unknown): ThemeSource {
	if (isBundledThemeId(selection)) {
		return { assets: [...THEME_LAYER_ASSETS, themeAssetName(selection)], id: selection, kind: 'bundled' };
	}
	if (isUserThemeFile(selection) && selection !== THEME_TEMPLATE_FILE) return { file: selection, kind: 'user' };
	return { kind: 'none' };
}
export function normalizeThemeSelection(selection: unknown, userThemeFiles: readonly string[]): string {
	const source = resolveTheme(selection);
	if (source.kind === 'bundled') return source.id;
	if (source.kind === 'user' && userThemeFiles.includes(source.file)) return source.file;
	return THEME_NONE;
}
export interface ThemeOptions {
	values: string[];
	labels: string[];
}
export function buildThemeOptions(userThemeFiles: readonly string[]): ThemeOptions {
	const seen = new Set<string>([THEME_NONE, ...BUNDLED_THEMES.map((theme) => theme.id)]);
	const values = [THEME_NONE, ...BUNDLED_THEMES.map((theme) => theme.id)];
	const labels = ['None', ...BUNDLED_THEMES.map((theme) => theme.label)];
	for (const file of userThemeFiles) {
		if (!isUserThemeFile(file) || file === THEME_TEMPLATE_FILE || seen.has(file)) continue;
		seen.add(file);
		values.push(file);
		labels.push(file);
	}
	return { labels, values };
}
export function parseThemePreference(value: unknown): string | undefined {
	if (value === THEME_NONE) return THEME_NONE;
	if (isBundledThemeId(value)) return value;
	if (isUserThemeFile(value)) return value;
	return undefined;
}
export function migrateThemePreference(rawSettings: unknown): string | undefined {
	if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) return undefined;
	const settings = rawSettings as Record<string, unknown>;
	if (!Object.hasOwn(settings, 'cssSwapper') || Object.hasOwn(settings, 'theme')) return undefined;
	return parseThemePreference(settings.cssSwapper) ?? THEME_NONE;
}
export const THEME_TEMPLATE_STARTER_ID = 'wok';
export function buildUserThemeTemplate(layerCss: string, starterPaletteCss: string): string {
	const header = [
		'/*',
		' * WOK Client user theme template.',
		' *',
		' * Copy this file, rename the copy to anything ending in .css, and it shows up in',
		' * Settings > Visuals > Theme. This file itself is skipped by the picker so that it stays a',
		' * clean starting point; delete it and the client writes a fresh copy on the next launch.',
		' *',
		" * Change the values in the :root block below to restyle the whole client: WOK's own panels",
		" * and Krunker's menu, HUD, scoreboard, chat, shop and popups. Everything after the palette",
		' * is the same pair of layers the bundled themes use, so you can also edit or add rules',
		' * directly.',
		' *',
		' * The variables the layers read:',
		' *',
		...THEME_VARIABLES.map((variable) => ` *   ${variable.name}\n *     ${variable.description}`),
		' */',
		''
	];
	return `${header.join('\n')}\n${starterPaletteCss.trimStart()}\n${layerCss.trimStart()}`;
}
