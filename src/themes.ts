/*
 * Theme registry, validation and resolution.
 *
 * A theme selection is a single string persisted as the `theme` preference. It is one of:
 *   'None'          no theme; the client keeps Krunker's stock look
 *   a bundled id    e.g. 'wok'; resolves to the shared layers + assets/theme-wok.css
 *   a .css filename e.g. 'mine.css'; a file in the user's config css/ folder, injected verbatim
 *
 * Bundled ids never collide with user selections because a user selection always ends in '.css'
 * and a bundled id never contains a dot.
 *
 * Why bundled themes are variable-based (and user files are not)
 * -------------------------------------------------------------
 * The shared layers (THEME_LAYER_ASSETS) map every surface the player looks at onto the custom
 * properties listed in THEME_VARIABLES, each with the current stock value as its var() fallback.
 * A bundled theme is therefore only a `:root` palette block, which is why six of them fit in a few
 * hundred lines and stay coherent with each other: nobody re-derives what a settings row looks
 * like, they pick colours. Overriding a layer's selectors is still possible from a theme file, and
 * a partial palette still renders because every consumption site carries a fallback.
 *
 * Two layers, because they have different rules:
 *   theme-base.css   WOK's own surfaces. Selectors are ours, so they are stable by construction.
 *   theme-game.css   Krunker's UI. Selectors belong to a game this project does not control, so
 *                    each one is checked against tests/fixtures/krunker-css-inventory.json, which
 *                    is generated from the live stylesheets by
 *                    scripts/fetch-krunker-css-inventory.mjs. A rename upstream then fails a test
 *                    instead of quietly turning a rule into a no-op.
 *
 * User .css files are deliberately NOT wrapped in the shared layers. They predate this system and
 * were written against the stock look, so injecting extra layers under them could change what they
 * render today. Authors who want the variable contract get it from the generated
 * css/theme-template.css (see buildUserThemeTemplate), which carries the layers inside the file
 * itself and so is self-contained.
 */

/** Selection value meaning "no theme". */
export const THEME_NONE = 'None';

/** Asset file mapping WOK's own surfaces onto the variable contract. */
export const THEME_BASE_ASSET = 'theme-base.css';

/** Asset file mapping Krunker's own UI onto the same contract. */
export const THEME_GAME_ASSET = 'theme-game.css';

/**
 * The variable-consuming layers every bundled theme loads, in cascade order, ahead of its palette.
 * Packaging allowlists read this rather than repeating the filenames.
 */
export const THEME_LAYER_ASSETS: readonly string[] = [THEME_BASE_ASSET, THEME_GAME_ASSET];

/** Filename seeded into the user's css/ folder as a starting point for a custom theme. */
export const THEME_TEMPLATE_FILE = 'theme-template.css';

/** Longest accepted persisted selection, matching the other free-form string preferences. */
const MAX_SELECTION_LENGTH = 128;

/** A user selection is a bare filename ending in .css: no separators, so no traversal. */
const USER_THEME_FILE = /^[^/\\]+\.css$/u;

/** Bundled ids are lowercase slugs, which keeps them disjoint from any '*.css' filename. */
const BUNDLED_THEME_ID = /^[a-z][a-z0-9-]{1,31}$/u;

export interface BundledTheme {
	/** Stable id persisted in settings.json; also names the asset file. Never rename in place. */
	id: string;

	/** Label shown in the settings dropdown. Safe to change: it is not persisted. */
	label: string;

	/** One-line description of the look, used by the generated user theme template. */
	summary: string;
}

/**
 * Themes shipped with the client, in dropdown order. Each entry needs a matching
 * assets/theme-<id>.css that sets every THEME_VARIABLES entry (tests/themes.test.ts proves it),
 * plus an entry in the packaging allowlists, which read this list rather than repeating it.
 */
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
	/** Custom property name, including the leading dashes. */
	name: string;

	/** What the property controls, surfaced in the generated template. */
	description: string;
}

/**
 * The documented contract between the shared layers and a palette. This is the whole surface a
 * theme author has to learn; anything outside it is ordinary CSS they can still write.
 *
 * The menu group (--wok-surface and friends) and the HUD group (--wok-hud-*) are split on purpose.
 * Menu surfaces cover the screen and can afford to be light, spacious or translucent; HUD panels
 * sit over live gameplay a few pixels from an enemy, so a theme has to be able to keep them dark
 * and cheap without giving up the look of its menus.
 *
 * Deliberately absent: anything that encodes state rather than style. The settings panel's safety
 * icons (levels 2-4 are yellow, orange, red), Krunker's team and health colours, the killfeed's
 * own text colours and the leaderboard's friend/enemy/self name colours are all information, and
 * a theme repainting them would be repainting information.
 */
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
	{ name: '--wok-font', description: 'UI font stack. Applied game-wide, so it replaces Krunker\'s GameFont.' },
	{ name: '--wok-font-mono', description: 'Monospace stack for keys, codes and metrics.' },
	{ name: '--wok-heading-transform', description: 'text-transform for group and section headings: uppercase or none.' },
	{ name: '--wok-heading-spacing', description: 'letter-spacing for group and section headings.' },
	{ name: '--wok-hud-bg', description: 'In-game panel background: killfeed, weapon list, scoreboard, chat, ammo.' },
	{ name: '--wok-hud-bg-inner', description: 'The inner fill Krunker layers inside a HUD panel. Keep it readable over gameplay.' },
	{ name: '--wok-hud-border', description: 'HUD panel border. transparent is a valid answer.' },
	{ name: '--wok-hud-text', description: 'Neutral HUD text. Never used for anything colour-coded.' },
	{ name: '--wok-scrollbar-track', description: 'Scrollbar trough.' },
	{ name: '--wok-scrollbar-thumb', description: 'Scrollbar thumb.' },
	{ name: '--wok-overlay-bg', description: 'FPS overlay background. It sits over live gameplay, not over a WOK panel.' },
	{ name: '--wok-overlay-border', description: 'FPS overlay border colour.' },
	{ name: '--wok-overlay-text', description: 'FPS overlay text colour.' }
];

/** Asset filename holding the palette for a bundled theme id. */
export function themeAssetName(id: string): string {
	return `theme-${id}.css`;
}

/** Whether an id names a theme this build actually ships. */
export function isBundledThemeId(value: unknown): value is string {
	return typeof value === 'string'
		&& BUNDLED_THEME_ID.test(value)
		&& BUNDLED_THEMES.some(theme => theme.id === value);
}

/** Whether a name is a bare .css filename, and so safe to join onto the css folder. */
export function isUserThemeFile(value: unknown): value is string {
	return typeof value === 'string'
		&& value.length <= MAX_SELECTION_LENGTH
		&& USER_THEME_FILE.test(value);
}

export type ThemeSource =
	| { kind: 'none' }
	/** `assets` is in cascade order: the shared layers first, the palette last. */
	| { kind: 'bundled'; id: string; assets: string[] }
	| { kind: 'user'; file: string };

/**
 * Turn a persisted selection into the files to load. Anything unrecognised resolves to 'none'
 * rather than throwing, so a hand-edited or stale settings.json can never leave the client
 * without a usable UI.
 */
export function resolveTheme(selection: unknown): ThemeSource {
	if (isBundledThemeId(selection)) {
		return { assets: [...THEME_LAYER_ASSETS, themeAssetName(selection)], id: selection, kind: 'bundled' };
	}
	if (isUserThemeFile(selection) && selection !== THEME_TEMPLATE_FILE) return { file: selection, kind: 'user' };
	return { kind: 'none' };
}

/**
 * Collapse a selection to one the given css folder can actually serve. Used by the settings UI,
 * which knows the folder contents; the injector uses resolveTheme, which does not need them.
 */
export function normalizeThemeSelection(selection: unknown, userThemeFiles: readonly string[]): string {
	const source = resolveTheme(selection);
	if (source.kind === 'bundled') return source.id;
	if (source.kind === 'user' && userThemeFiles.includes(source.file)) return source.file;
	return THEME_NONE;
}

export interface ThemeOptions {
	/** Values persisted in settings.json, in dropdown order. */
	values: string[];

	/** Labels shown for each value. Same length and order as values. */
	labels: string[];
}

/**
 * Dropdown contents: no theme, then the bundled themes, then whatever .css the user dropped in
 * the css folder. Filenames are shown as-is so the folder button is self-explanatory.
 */
export function buildThemeOptions(userThemeFiles: readonly string[]): ThemeOptions {
	const seen = new Set<string>([THEME_NONE, ...BUNDLED_THEMES.map(theme => theme.id)]);
	const values = [THEME_NONE, ...BUNDLED_THEMES.map(theme => theme.id)];
	const labels = ['None', ...BUNDLED_THEMES.map(theme => theme.label)];

	for (const file of userThemeFiles) {
		// The template is a starting point to copy, not a theme; selecting it would just re-apply
		// the stock palette under a confusing name.
		if (!isUserThemeFile(file) || file === THEME_TEMPLATE_FILE || seen.has(file)) continue;
		seen.add(file);
		values.push(file);
		labels.push(file);
	}

	return { labels, values };
}

/** Validate a persisted `theme` value. Returns undefined when the value cannot be trusted. */
export function parseThemePreference(value: unknown): string | undefined {
	if (value === THEME_NONE) return THEME_NONE;
	if (isBundledThemeId(value)) return value;
	if (isUserThemeFile(value)) return value;
	return undefined;
}

/**
 * One-time migration of the pre-theme `cssSwapper` preference. Returns the value the `theme`
 * preference should take, or undefined when there is nothing to migrate (already migrated, or a
 * profile that never had the old key). An unreadable old value becomes 'None' rather than being
 * left to fail at injection time.
 */
export function migrateThemePreference(rawSettings: unknown): string | undefined {
	if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) return undefined;
	const settings = rawSettings as Record<string, unknown>;
	if (!Object.hasOwn(settings, 'cssSwapper') || Object.hasOwn(settings, 'theme')) return undefined;
	return parseThemePreference(settings.cssSwapper) ?? THEME_NONE;
}

/** Bundled theme whose palette seeds the user template: the house identity. */
export const THEME_TEMPLATE_STARTER_ID = 'wok';

/**
 * The self-contained starter theme written into the user's css folder: a working palette followed
 * by the real shared layers, so editing the values at the top restyles everything the bundled
 * themes restyle. Assembled from the shipped files rather than from a copy of them, so a
 * regenerated template can never document a layer or a variable the client no longer has.
 */
export function buildUserThemeTemplate(layerCss: string, starterPaletteCss: string): string {
	const header = [
		'/*',
		' * WOK Client user theme template.',
		' *',
		' * Copy this file, rename the copy to anything ending in .css, and it shows up in',
		' * Settings > Visuals > Theme. This file itself is skipped by the picker so that it stays a',
		' * clean starting point; delete it and the client writes a fresh copy on the next launch.',
		' *',
		' * Change the values in the :root block below to restyle the whole client: WOK\'s own panels',
		' * and Krunker\'s menu, HUD, scoreboard, chat, shop and popups. Everything after the palette',
		' * is the same pair of layers the bundled themes use, so you can also edit or add rules',
		' * directly.',
		' *',
		' * The variables the layers read:',
		' *',
		...THEME_VARIABLES.map(variable => ` *   ${variable.name}\n *     ${variable.description}`),
		' */',
		''
	];

	return `${header.join('\n')}\n${starterPaletteCss.trimStart()}\n${layerCss.trimStart()}`;
}
