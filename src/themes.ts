/*
 * Theme registry, validation and resolution.
 *
 * A theme selection is a single string persisted as the `theme` preference. It is one of:
 *   'None'          no theme; WOK's surfaces keep the stock look
 *   a bundled id    e.g. 'noir'; resolves to assets/theme-base.css + assets/theme-noir.css
 *   a .css filename e.g. 'mine.css'; a file in the user's config css/ folder, injected verbatim
 *
 * Bundled ids never collide with user selections because a user selection always ends in '.css'
 * and a bundled id never contains a dot.
 *
 * Why bundled themes are variable-based (and user files are not)
 * -------------------------------------------------------------
 * assets/theme-base.css maps every WOK-owned surface onto the custom properties listed in
 * THEME_VARIABLES, each with the current stock value as its var() fallback. A bundled theme is
 * therefore only a `:root` palette block, which is why five of them fit in a few hundred lines
 * and stay coherent with each other: nobody re-derives what a settings row looks like, they pick
 * colours. Overriding the base layer's selectors is still possible from a theme file, and a
 * partial palette still renders because every consumption site carries a fallback.
 *
 * User .css files are deliberately NOT wrapped in the base layer. They predate this system and
 * were written against the stock look, so injecting an extra layer under them could change what
 * they render today. Authors who want the variable contract get it from the generated
 * css/theme-template.css (see buildUserThemeTemplate), which carries the base layer inside the
 * file itself and so is self-contained.
 */

/** Selection value meaning "no theme". */
export const THEME_NONE = 'None';

/** Asset file holding the variable-consuming layer shared by every bundled theme. */
export const THEME_BASE_ASSET = 'theme-base.css';

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
		id: 'noir',
		label: 'Noir',
		summary: 'Near-black surfaces, hairline borders and the WOK yellow accent.'
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
		id: 'terminal',
		label: 'Terminal',
		summary: 'Black, square-cornered and monospaced, with phosphor green text.'
	},
	{
		id: 'paper',
		label: 'Paper',
		summary: 'Light warm paper surfaces with dark ink text and a deep gold accent.'
	}
];

export interface ThemeVariable {
	/** Custom property name, including the leading dashes. */
	name: string;

	/** What the property controls, surfaced in the generated template. */
	description: string;
}

/**
 * The documented contract between assets/theme-base.css and a palette. This is the whole surface
 * a theme author has to learn; anything outside it is ordinary CSS they can still write.
 *
 * Deliberately absent: the safety icon colours for levels 2-4. Those encode how risky a setting
 * is (yellow, orange, red) and a theme repainting them would be repainting a warning.
 */
export const THEME_VARIABLES: readonly ThemeVariable[] = [
	{ name: '--wok-bg', description: 'Deepest background: the settings panel backdrop and the splash.' },
	{ name: '--wok-surface', description: 'Panel and card background sitting on top of --wok-bg.' },
	{ name: '--wok-surface-raised', description: 'Inputs, buttons and sub-cards that need to sit above --wok-surface.' },
	{ name: '--wok-border', description: 'Hairline separators and default control borders.' },
	{ name: '--wok-border-strong', description: 'Emphasised borders: hover states, focused controls, dialog edges.' },
	{ name: '--wok-accent', description: 'Primary accent: active nav rail, group headings, progress and focus.' },
	{ name: '--wok-accent-contrast', description: 'Text and icon colour drawn on top of a solid --wok-accent fill.' },
	{ name: '--wok-accent-soft', description: 'Translucent accent wash behind selected rows. Should keep some alpha.' },
	{ name: '--wok-text', description: 'Primary text colour.' },
	{ name: '--wok-text-muted', description: 'Secondary text: setting titles, nav items, toasts.' },
	{ name: '--wok-text-faint', description: 'Tertiary text: setting descriptions and captions.' },
	{ name: '--wok-danger', description: 'Destructive and cancel affordances.' },
	{ name: '--wok-success', description: 'Confirm and accept affordances.' },
	{ name: '--wok-radius', description: 'Corner radius for panels, controls and popups. 0 for a squared-off look.' },
	{ name: '--wok-shadow', description: 'box-shadow applied to floating surfaces (dialogs, toasts, popups).' },
	{ name: '--wok-font', description: 'UI font stack for WOK panels.' },
	{ name: '--wok-font-mono', description: 'Monospace stack for keys, codes and metrics.' },
	{ name: '--wok-heading-transform', description: 'text-transform for group headings: uppercase or none.' },
	{ name: '--wok-heading-spacing', description: 'letter-spacing for group headings.' },
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
	| { kind: 'bundled'; id: string; assets: string[] }
	| { kind: 'user'; file: string };

/**
 * Turn a persisted selection into the files to load. Anything unrecognised resolves to 'none'
 * rather than throwing, so a hand-edited or stale settings.json can never leave the client
 * without a usable UI.
 */
export function resolveTheme(selection: unknown): ThemeSource {
	if (isBundledThemeId(selection)) {
		return { assets: [THEME_BASE_ASSET, themeAssetName(selection)], id: selection, kind: 'bundled' };
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

/** Bundled theme whose palette seeds the user template: the closest thing to the stock look. */
export const THEME_TEMPLATE_STARTER_ID = 'noir';

/**
 * The self-contained starter theme written into the user's css folder: a working palette followed
 * by the real base layer, so editing the values at the top restyles everything the bundled themes
 * restyle. Assembled from the shipped files rather than from a copy of them, so a regenerated
 * template can never document a layer or a variable the client no longer has.
 */
export function buildUserThemeTemplate(baseLayerCss: string, starterPaletteCss: string): string {
	const header = [
		'/*',
		' * WOK Client user theme template.',
		' *',
		' * Copy this file, rename the copy to anything ending in .css, and it shows up in',
		' * Settings > Visuals > Theme. This file itself is skipped by the picker so that it stays a',
		' * clean starting point; delete it and the client writes a fresh copy on the next launch.',
		' *',
		' * Change the values in the :root block below to restyle the client. Everything after it is',
		' * the same layer the bundled themes use, so you can also edit or add rules directly. Every',
		' * selector in it belongs to a surface WOK itself adds to the page.',
		' *',
		' * The variables the layer reads:',
		' *',
		...THEME_VARIABLES.map(variable => ` *   ${variable.name}\n *     ${variable.description}`),
		' */',
		''
	];

	return `${header.join('\n')}\n${starterPaletteCss.trimStart()}\n${baseLayerCss.trimStart()}`;
}
