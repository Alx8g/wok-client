import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
	BUNDLED_THEMES,
	buildThemeOptions,
	buildUserThemeTemplate,
	isBundledThemeId,
	isUserThemeFile,
	migrateThemePreference,
	normalizeThemeSelection,
	parseThemePreference,
	resolveTheme,
	THEME_BASE_ASSET,
	THEME_NONE,
	THEME_TEMPLATE_FILE,
	THEME_TEMPLATE_STARTER_ID,
	THEME_VARIABLES,
	themeAssetName
} from '../src/themes.ts';

const ASSETS = join(import.meta.dirname, '..', 'assets');

function readAsset(name: string): string {
	return readFileSync(join(ASSETS, name), { encoding: 'utf-8' });
}

/** Strip comments, then pull the selector of every top-level rule. */
function selectorsOf(css: string): string[] {
	const withoutComments = css.replaceAll(/\/\*[\s\S]*?\*\//gu, '');
	assert.ok(!/@(media|supports|container)/u.test(withoutComments),
		'this parser assumes no conditional at-rules; teach it about them before adding one');
	return [...withoutComments.matchAll(/(^|\})([^{}]+)\{/gu)]
		.map(match => match[2].trim())
		.filter(selector => selector.length > 0 && !selector.startsWith('@'))
		.flatMap(selector => selector.split(',').map(part => part.trim()));
}

/*
 * A selector is WOK's own if it names an element WOK adds to the page. The project deliberately
 * does not restyle Krunker's game UI, and a theme system is the easiest place to do it by
 * accident, so the boundary is checked rather than trusted.
 */
const WOK_SELECTOR_TOKENS = [
	'Crankshaft', // settings panel, toasts, splash background, performance overlay
	'crankshaft',
	'wok-', // splash stage and weapon loader
	'matchmaker', // src/matchmaker.ts builds the whole popup; Krunker has no matchmaker of its own
	'matchResultButton', // src/preload.ts
	'refresh-popup', // src/settingsui.ts, the settings refresh notice
	'customKeybindSetting' // src/settingsui.ts, the keybind capture dialog
];

function isWokOwnedSelector(selector: string): boolean {
	if (selector === ':root') return true;
	return WOK_SELECTOR_TOKENS.some(token => selector.includes(token));
}

test('every bundled theme ships the palette and base layer it resolves to', () => {
	assert.ok(BUNDLED_THEMES.length > 0);
	assert.doesNotThrow(() => readAsset(THEME_BASE_ASSET));
	for (const theme of BUNDLED_THEMES) {
		const source = resolveTheme(theme.id);
		assert.equal(source.kind, 'bundled');
		assert.deepEqual(source.kind === 'bundled' ? source.assets : [], [THEME_BASE_ASSET, themeAssetName(theme.id)]);
		for (const asset of source.kind === 'bundled' ? source.assets : []) assert.doesNotThrow(() => readAsset(asset));
	}
});

test('bundled theme ids and labels are unique, and ids are slugs a filename can hold', () => {
	assert.equal(new Set(BUNDLED_THEMES.map(theme => theme.id)).size, BUNDLED_THEMES.length);
	assert.equal(new Set(BUNDLED_THEMES.map(theme => theme.label)).size, BUNDLED_THEMES.length);
	for (const theme of BUNDLED_THEMES) {
		assert.match(theme.id, /^[a-z][a-z0-9-]*$/u, `${theme.id} must stay disjoint from '*.css' selections`);
		assert.ok(theme.summary.length > 0);
	}
});

test('every bundled palette defines the whole documented variable contract', () => {
	for (const theme of BUNDLED_THEMES) {
		const palette = readAsset(themeAssetName(theme.id));
		for (const variable of THEME_VARIABLES) {
			assert.match(palette, new RegExp(`${variable.name}\\s*:\\s*\\S`, 'u'),
				`assets/${themeAssetName(theme.id)} does not set ${variable.name}`);
		}
	}
});

test('the base layer only reads variables the contract documents', () => {
	const documented = new Set(THEME_VARIABLES.map(variable => variable.name));
	const referenced = [...readAsset(THEME_BASE_ASSET).matchAll(/var\(\s*(--wok-[a-z-]+)/gu)].map(match => match[1]);
	assert.ok(referenced.length > 0);
	for (const name of new Set(referenced)) {
		assert.ok(documented.has(name), `theme-base.css reads ${name}, which THEME_VARIABLES does not document`);
	}
});

test('every documented variable is actually consumed by the base layer', () => {
	const baseLayer = readAsset(THEME_BASE_ASSET);
	// The overlay variables are read from inline styles in src/performance-monitor.ts instead.
	const consumedElsewhere = new Set(['--wok-overlay-bg', '--wok-overlay-border', '--wok-overlay-text']);
	for (const variable of THEME_VARIABLES) {
		if (consumedElsewhere.has(variable.name)) continue;
		assert.ok(baseLayer.includes(`var(${variable.name}`),
			`${variable.name} is documented but nothing reads it`);
	}
});

test('every base-layer value falls back to a stock value when a palette omits it', () => {
	const declarations = readAsset(THEME_BASE_ASSET)
		.replaceAll(/\/\*[\s\S]*?\*\//gu, '')
		.split('\n')
		.filter(line => line.includes('var(--wok-'));
	assert.ok(declarations.length > 0);
	for (const declaration of declarations) {
		assert.match(declaration, /var\(--wok-[a-z-]+,/u,
			`a base layer declaration has no fallback, so a partial palette would break it: ${declaration.trim()}`);
	}
});

test('theme stylesheets never reach outside surfaces WOK adds to the page', () => {
	for (const asset of [THEME_BASE_ASSET, ...BUNDLED_THEMES.map(theme => themeAssetName(theme.id))]) {
		for (const selector of selectorsOf(readAsset(asset))) {
			assert.ok(isWokOwnedSelector(selector), `assets/${asset} styles '${selector}', which is not a WOK surface`);
		}
	}
});

test('resolveTheme maps each kind of selection to the files to load', () => {
	assert.deepEqual(resolveTheme(THEME_NONE), { kind: 'none' });
	assert.deepEqual(resolveTheme('mine.css'), { file: 'mine.css', kind: 'user' });
	assert.equal(resolveTheme(BUNDLED_THEMES[0].id).kind, 'bundled');
});

test('resolveTheme refuses anything that could escape the css folder', () => {
	for (const selection of [
		'../outside.css',
		'..\\outside.css',
		'/etc/passwd.css',
		'C:\\windows\\evil.css',
		'nested/dir/theme.css',
		`${'a'.repeat(200)}.css`
	]) {
		assert.deepEqual(resolveTheme(selection), { kind: 'none' }, `${selection} must not resolve to a file`);
	}
});

test('resolveTheme falls back to no theme for junk instead of throwing', () => {
	for (const selection of [undefined, null, 42, {}, [], '', 'not-a-real-theme', 'notes.txt']) {
		assert.deepEqual(resolveTheme(selection), { kind: 'none' });
	}
});

test('the template file is a starting point, not a selectable theme', () => {
	assert.deepEqual(resolveTheme(THEME_TEMPLATE_FILE), { kind: 'none' });
	assert.ok(!buildThemeOptions([THEME_TEMPLATE_FILE, 'mine.css']).values.includes(THEME_TEMPLATE_FILE));
});

test('the dropdown lists no theme, then the bundled ones, then the user files', () => {
	const options = buildThemeOptions(['zebra.css', 'mine.css']);
	assert.deepEqual(options.values, [THEME_NONE, ...BUNDLED_THEMES.map(theme => theme.id), 'zebra.css', 'mine.css']);
	assert.deepEqual(options.labels, ['None', ...BUNDLED_THEMES.map(theme => theme.label), 'zebra.css', 'mine.css']);
	assert.equal(options.values.length, options.labels.length);
});

test('the dropdown drops duplicates and anything that is not a plain css filename', () => {
	const options = buildThemeOptions(['mine.css', 'mine.css', '../escape.css', 'notes.txt', BUNDLED_THEMES[0].id]);
	assert.deepEqual(options.values.filter(value => value.endsWith('.css')), ['mine.css']);
	assert.equal(new Set(options.values).size, options.values.length);
});

test('a selection whose file has since been deleted collapses to no theme', () => {
	assert.equal(normalizeThemeSelection('mine.css', ['mine.css']), 'mine.css');
	assert.equal(normalizeThemeSelection('mine.css', ['other.css']), THEME_NONE);
	assert.equal(normalizeThemeSelection(BUNDLED_THEMES[0].id, []), BUNDLED_THEMES[0].id);
	assert.equal(normalizeThemeSelection('../escape.css', ['../escape.css']), THEME_NONE);
});

test('the persisted preference accepts only values the picker can offer', () => {
	assert.equal(parseThemePreference(THEME_NONE), THEME_NONE);
	assert.equal(parseThemePreference(BUNDLED_THEMES[0].id), BUNDLED_THEMES[0].id);
	assert.equal(parseThemePreference('mine.css'), 'mine.css');
	for (const value of ['../outside.css', 'unknown-theme', '', 7, null, undefined, { id: 'noir' }]) {
		assert.equal(parseThemePreference(value), undefined, `${String(value)} must not be persisted`);
	}
});

test('id and filename predicates stay disjoint', () => {
	assert.ok(isBundledThemeId(BUNDLED_THEMES[0].id));
	assert.ok(!isBundledThemeId(`${BUNDLED_THEMES[0].id}.css`));
	assert.ok(isUserThemeFile(`${BUNDLED_THEMES[0].id}.css`));
	assert.ok(!isUserThemeFile(BUNDLED_THEMES[0].id));
	assert.ok(!isBundledThemeId('noir-but-not-shipped'));
});

test('a css swapper selection carries over to the theme preference exactly once', () => {
	assert.equal(migrateThemePreference({ cssSwapper: 'mine.css' }), 'mine.css');
	assert.equal(migrateThemePreference({ cssSwapper: 'None' }), THEME_NONE);
	// Already migrated: the new key wins and the stale one is ignored.
	assert.equal(migrateThemePreference({ cssSwapper: 'mine.css', theme: 'noir' }), undefined);
	// Never had the old key, so there is nothing to migrate.
	assert.equal(migrateThemePreference({ theme: 'noir' }), undefined);
	assert.equal(migrateThemePreference({}), undefined);
});

test('an unusable css swapper selection migrates to no theme rather than to a broken one', () => {
	assert.equal(migrateThemePreference({ cssSwapper: '../outside.css' }), THEME_NONE);
	assert.equal(migrateThemePreference({ cssSwapper: 12 }), THEME_NONE);
});

test('migration ignores anything that is not a settings object', () => {
	for (const raw of [undefined, null, 'cssSwapper', ['cssSwapper'], 5]) {
		assert.equal(migrateThemePreference(raw), undefined);
	}
});

test('the generated user template is a working theme plus the documented contract', () => {
	const baseLayer = readAsset(THEME_BASE_ASSET);
	const starter = readAsset(themeAssetName(THEME_TEMPLATE_STARTER_ID));
	const template = buildUserThemeTemplate(baseLayer, starter);

	assert.ok(BUNDLED_THEMES.some(theme => theme.id === THEME_TEMPLATE_STARTER_ID));
	for (const variable of THEME_VARIABLES) {
		assert.ok(template.includes(variable.name), `the template never mentions ${variable.name}`);
		assert.ok(template.includes(variable.description), `the template does not explain ${variable.name}`);
		// Real values, not blanks: the template has to render as a theme the moment it is selected.
		assert.match(template, new RegExp(`${variable.name}\\s*:\\s*\\S`, 'u'));
	}
	assert.ok(template.includes('.Crankshaft-settings'), 'the template must carry the base layer, not just describe it');
	assert.ok(template.trimStart().startsWith('/*'));
});
