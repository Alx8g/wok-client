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
	THEME_GAME_ASSET,
	THEME_LAYER_ASSETS,
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

const PALETTE_ASSETS = BUNDLED_THEMES.map(theme => themeAssetName(theme.id));
const ALL_THEME_ASSETS = [...THEME_LAYER_ASSETS, ...PALETTE_ASSETS];

interface KrunkerCssInventory {
	classes: string[];
	customProperties: string[];
	fetchedAt: string;
	ids: string[];
	sources: { bytes: number; rules: number; sha256: string; url: string }[];
}

const KRUNKER_CSS: KrunkerCssInventory = JSON.parse(
	readFileSync(join(import.meta.dirname, 'fixtures', 'krunker-css-inventory.json'), { encoding: 'utf-8' })
);

function selectorsOf(css: string): string[] {
	const withoutComments = css.replaceAll(/\/\*[\s\S]*?\*\//gu, '');
	assert.ok(!/@(media|supports|container)/u.test(withoutComments),
		'this parser assumes no conditional at-rules; teach it about them before adding one');
	return [...withoutComments.matchAll(/(^|\})([^{}]+)\{/gu)]
		.map(match => match[2].trim())
		.filter(selector => selector.length > 0 && !selector.startsWith('@'))
		.flatMap(selector => selector.split(',').map(part => part.trim()));
}

function rulesOf(css: string): { body: string; selector: string }[] {
	const withoutComments = css.replaceAll(/\/\*[\s\S]*?\*\//gu, '');
	return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
		.flatMap(match => match[1].trim().split(',')
			.map(part => ({ body: match[2], selector: part.trim() })))
		.filter(rule => rule.selector.length > 0 && !rule.selector.startsWith('@'));
}

function hooksOf(selector: string): { classes: string[]; ids: string[] } {
	return {
		classes: [...selector.matchAll(/\.([A-Za-z][\w-]*)/gu)].map(match => match[1]),
		ids: [...selector.matchAll(/#([A-Za-z][\w-]*)/gu)].map(match => match[1])
	};
}

const WOK_SELECTOR_TOKENS = [
	'wok-',
	'matchmaker',
	'matchResultButton',
	'refresh-popup',
	'customKeybindSetting' // src/settingsui.ts, the keybind capture dialog
];

function isWokOwnedSelector(selector: string): boolean {
	if (selector === ':root') return true;
	return WOK_SELECTOR_TOKENS.some(token => selector.includes(token));
}

function isLiveKrunkerSelector(selector: string): boolean {
	const hooks = hooksOf(selector);
	return hooks.classes.every(name => KRUNKER_CSS.classes.includes(name))
		&& hooks.ids.every(name => KRUNKER_CSS.ids.includes(name));
}

const OFF_LIMITS_HOOKS = [

	'crosshair', 'aimDot', 'aimRecticle', 'recticleImg', 'hitmarker', 'vignette', 'bloodDisplay',

	'nHealthBar', 'nHealthBarE', 'nHealthBarSeg', 'nHpBSeg', 'bottomLeftHealth', 'maxHP',
	'bhHolder', 'bhArm', 'bhBody', 'bhHead', 'bhLeg', 'spectHPB', 'spectHPBI', 'spectHPV',

	'leaderName', 'leaderNameM', 'leaderNameF',
	'newLeaderName', 'newLeaderNameM', 'newLeaderNameF',
	'teamTotalN0', 'teamTotalN1', 'teamWin0', 'teamWin1', 'teamNm', 'specTeam0', 'specTeam1',

	'killfeedMsg', 'death-report-text', 'death-row-user-stat',

	'lockedCard', 'lockedClass', 'lockedSkin', 'lockedClassText', 'classLimitIcon', 'bpCardLock',

	'ammoVal', 'ammoMax', 'timerVal', 'roundsVal', 'strike-timer',

	'adIcon', 'adIconL', 'adIconSq', 'eventAd', 'freeKRAd', 'homeStoreAd', 'bpAdIcon',
	'krDiscountAd', 'updateAdIcon', 'topLeftAdHolder', 'topRightAdHolder'
];

const REMOVAL_DECLARATIONS = [
	/display\s*:\s*none/u,
	/visibility\s*:\s*hidden/u,
	/opacity\s*:\s*0(?![.\d])/u,
	/content\s*:\s*none/u
];

const BLUR_ALLOWED_SELECTORS = new Set([
	'#menuWindow',
	'#popupContent',
	'.defaultModal',
	'.socialModal',
	'#itemViewPop',
	'#itemPurcPop',
	'.io-popup-container',
	'#matchmakerPopupContainer'
]);

type Rgba = [number, number, number, number];

function parseColour(value: string): Rgba | undefined {
	const text = value.trim();
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(text);
	if (hex) {
		const digits = hex[1].length === 3 ? [...hex[1]].map(digit => digit + digit).join('') : hex[1];
		return [
			Number.parseInt(digits.slice(0, 2), 16),
			Number.parseInt(digits.slice(2, 4), 16),
			Number.parseInt(digits.slice(4, 6), 16),
			1
		];
	}
	const functional = /^rgba?\(([^)]+)\)$/iu.exec(text);
	if (!functional) return undefined;
	const parts = functional[1].split(',').map(part => Number.parseFloat(part.trim()));
	if (parts.length < 3 || parts.some(part => Number.isNaN(part))) return undefined;
	return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

function over(top: Rgba, bottom: Rgba): Rgba {
	return [
		top[0] * top[3] + bottom[0] * (1 - top[3]),
		top[1] * top[3] + bottom[1] * (1 - top[3]),
		top[2] * top[3] + bottom[2] * (1 - top[3]),
		1
	];
}

function relativeLuminance([red, green, blue]: Rgba): number {
	const channel = (value: number) => {
		const ratio = value / 255;
		return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrast(foreground: Rgba, background: Rgba): number {
	const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)]
		.sort((first, second) => second - first);
	return (lighter + 0.05) / (darker + 0.05);
}

function paletteValues(css: string): Map<string, string> {
	const root = /:root\s*\{([^}]*)\}/u.exec(css.replaceAll(/\/\*[\s\S]*?\*\//gu, ''));
	assert.ok(root, 'a palette must declare its values in a :root block');
	const values = new Map<string, string>();
	for (const match of root[1].matchAll(/(--wok-[a-z-]+)\s*:\s*([^;]+);/gu)) values.set(match[1], match[2].trim());
	return values;
}

const GAMEPLAY_STAND_IN: Rgba = [110, 110, 110, 1];

const ART_OUTLINE: Rgba = [32, 32, 32, 1];

test('every bundled theme ships the palette and shared layers it resolves to', () => {
	assert.ok(BUNDLED_THEMES.length > 0);
	assert.deepEqual([...THEME_LAYER_ASSETS], [THEME_BASE_ASSET, THEME_GAME_ASSET]);
	for (const asset of THEME_LAYER_ASSETS) assert.doesNotThrow(() => readAsset(asset));
	for (const theme of BUNDLED_THEMES) {
		const source = resolveTheme(theme.id);
		assert.equal(source.kind, 'bundled');
		assert.deepEqual(source.kind === 'bundled' ? source.assets : [],
			[...THEME_LAYER_ASSETS, themeAssetName(theme.id)]);
		for (const asset of source.kind === 'bundled' ? source.assets : []) assert.doesNotThrow(() => readAsset(asset));
	}
});

test('the palette is the last asset, so it can override the shared layers', () => {
	const source = resolveTheme(BUNDLED_THEMES[0].id);
	assert.equal(source.kind, 'bundled');
	const assets = source.kind === 'bundled' ? source.assets : [];
	assert.equal(assets.at(-1), themeAssetName(BUNDLED_THEMES[0].id));
	assert.deepEqual(assets.slice(0, -1), [...THEME_LAYER_ASSETS]);
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

test('the shared layers only read variables the contract documents', () => {
	const documented = new Set(THEME_VARIABLES.map(variable => variable.name));
	for (const asset of THEME_LAYER_ASSETS) {
		const referenced = [...readAsset(asset).matchAll(/var\(\s*(--wok-[a-z-]+)/gu)].map(match => match[1]);
		assert.ok(referenced.length > 0);
		for (const name of new Set(referenced)) {
			assert.ok(documented.has(name), `assets/${asset} reads ${name}, which THEME_VARIABLES does not document`);
		}
	}
});

test('every documented variable is actually consumed by a shared layer', () => {
	const layers = THEME_LAYER_ASSETS.map(asset => readAsset(asset)).join('\n');
	for (const variable of THEME_VARIABLES) {
		assert.ok(layers.includes(`var(${variable.name}`),
			`${variable.name} is documented but nothing reads it`);
	}
});

test('every shared-layer read falls back to a stock value when a palette omits it', () => {
	for (const asset of THEME_LAYER_ASSETS) {
		const reads = [...readAsset(asset)
			.replaceAll(/\/\*[\s\S]*?\*\//gu, '')
			.matchAll(/var\(\s*--wok-[a-z-]+\s*([,)])/gu)];
		assert.ok(reads.length > 0);
		for (const read of reads) {
			assert.equal(read[1], ',',
				`assets/${asset} reads a variable with no fallback, so a partial palette would break it: ${read[0]}`);
		}
	}
});

test('the base layer stays inside surfaces WOK adds to the page', () => {
	for (const selector of selectorsOf(readAsset(THEME_BASE_ASSET))) {
		assert.ok(isWokOwnedSelector(selector),
			`assets/${THEME_BASE_ASSET} styles '${selector}', which is not a WOK surface`);
	}
});

test('every hook the game layer targets exists in the committed Krunker stylesheet inventory', () => {
	const selectors = selectorsOf(readAsset(THEME_GAME_ASSET));
	assert.ok(selectors.length > 0);
	let hookedSelectors = 0;
	for (const selector of selectors) {
		const hooks = hooksOf(selector);
		if (hooks.classes.length + hooks.ids.length > 0) hookedSelectors++;
		for (const name of hooks.classes) {
			assert.ok(KRUNKER_CSS.classes.includes(name),
				`assets/${THEME_GAME_ASSET} styles '.${name}' in '${selector}', which Krunker's stylesheets no longer declare. `
				+ 'Re-run scripts/fetch-krunker-css-inventory.mjs and fix the rule; a renamed hook is a rule that does nothing.');
		}
		for (const name of hooks.ids) {
			assert.ok(KRUNKER_CSS.ids.includes(name),
				`assets/${THEME_GAME_ASSET} styles '#${name}' in '${selector}', which Krunker's stylesheets no longer declare. `
				+ 'Re-run scripts/fetch-krunker-css-inventory.mjs and fix the rule; a renamed hook is a rule that does nothing.');
		}
	}

	assert.ok(hookedSelectors > 100, `only ${hookedSelectors} game-layer selectors carry a class or id hook`);
});

test('the game layer remaps only Krunker custom properties that Krunker still defines', () => {
	const remapped = [...readAsset(THEME_GAME_ASSET).matchAll(/^\t(--[a-z][a-z0-9-]*)\s*:/gmu)]
		.map(match => match[1])
		.filter(name => !name.startsWith('--wok-'));
	assert.ok(remapped.length > 0);
	for (const name of new Set(remapped)) {
		assert.ok(KRUNKER_CSS.customProperties.includes(name),
			`assets/${THEME_GAME_ASSET} remaps ${name}, which Krunker's stylesheets no longer define`);
	}
});

test('the game layer leaves WOK\'s own surfaces to the base layer', () => {
	for (const selector of selectorsOf(readAsset(THEME_GAME_ASSET))) {
		assert.ok(!/[Cc]rankshaft|wok-mark/u.test(selector),
			`assets/${THEME_GAME_ASSET} styles '${selector}'; WOK's own surfaces belong in ${THEME_BASE_ASSET}`);
	}
});

test('palettes stay inside WOK surfaces and hooks Krunker really declares', () => {
	for (const asset of PALETTE_ASSETS) {
		for (const selector of selectorsOf(readAsset(asset))) {
			assert.ok(isWokOwnedSelector(selector) || isLiveKrunkerSelector(selector),
				`assets/${asset} styles '${selector}', which is neither a WOK surface nor a live Krunker hook`);
		}
	}
});

test('no theme stylesheet repaints or hides anything that carries information', () => {
	for (const asset of ALL_THEME_ASSETS) {
		const css = readAsset(asset);
		for (const rule of rulesOf(css)) {
			const hooks = hooksOf(rule.selector);
			for (const name of [...hooks.classes, ...hooks.ids]) {
				assert.ok(!OFF_LIMITS_HOOKS.includes(name),
					`assets/${asset} styles '${name}' in '${rule.selector}'; that hook carries information, not decoration`);
			}
			for (const pattern of REMOVAL_DECLARATIONS) {
				assert.ok(!pattern.test(rule.body),
					`assets/${asset} removes something in '${rule.selector}'; a theme restyles, it never hides`);
			}
		}
		assert.ok(!/\banimation\s*:/u.test(css.replaceAll(/\/\*[\s\S]*?\*\//gu, '')),
			`assets/${asset} declares an animation; themes are static so they cannot cost frames`);
	}
});

test('backdrop-filter is confined to surfaces that only exist in menus', () => {
	let blurred = 0;
	for (const asset of ALL_THEME_ASSETS) {
		for (const rule of rulesOf(readAsset(asset))) {
			if (!/backdrop-filter/u.test(rule.body)) continue;
			blurred++;
			assert.ok(BLUR_ALLOWED_SELECTORS.has(rule.selector),
				`assets/${asset} blurs '${rule.selector}', which is not on the menu-only allowlist. `
				+ 'A backdrop-filter that can be on screen during gameplay costs the player frames.');
		}
	}
	assert.ok(blurred > 0, 'nothing reads --wok-blur any more; drop the variable or restore the rules');
});

test('every palette keeps its text readable on the surface it is drawn on', () => {
	for (const theme of BUNDLED_THEMES) {
		const values = paletteValues(readAsset(themeAssetName(theme.id)));
		const colour = (name: string): Rgba => {
			const parsed = parseColour(values.get(name) ?? '');
			assert.ok(parsed, `assets/${themeAssetName(theme.id)} has no parseable ${name}`);
			return parsed;
		};

		const bg = colour('--wok-bg');
		const surface = over(colour('--wok-surface'), bg);
		const raised = over(colour('--wok-surface-raised'), surface);
		const hud = over(colour('--wok-hud-bg'), GAMEPLAY_STAND_IN);
		const hudInner = over(colour('--wok-hud-bg-inner'), hud);

		const pairs: [string, Rgba, Rgba, number][] = [
			['--wok-text on --wok-surface', over(colour('--wok-text'), surface), surface, 4.5],
			['--wok-text on --wok-surface-raised', over(colour('--wok-text'), raised), raised, 4.5],
			['--wok-text-muted on --wok-surface', over(colour('--wok-text-muted'), surface), surface, 3],
			['--wok-text-muted on --wok-surface-raised', over(colour('--wok-text-muted'), raised), raised, 3],
			['--wok-text-faint on --wok-surface', over(colour('--wok-text-faint'), surface), surface, 2],
			['--wok-accent-contrast on --wok-accent', over(colour('--wok-accent-contrast'), colour('--wok-accent')), colour('--wok-accent'), 4],
			['--wok-accent on --wok-surface', over(colour('--wok-accent'), surface), surface, 2.5],
			['--wok-hud-text on --wok-hud-bg', over(colour('--wok-hud-text'), hud), hud, 4.5],
			['--wok-hud-text on --wok-hud-bg-inner', over(colour('--wok-hud-text'), hudInner), hudInner, 4],
			['--wok-text-on-art on its outline', over(colour('--wok-text-on-art'), ART_OUTLINE), ART_OUTLINE, 4.5]
		];

		for (const [label, foreground, background, minimum] of pairs) {
			const ratio = contrast(foreground, background);
			assert.ok(ratio >= minimum,
				`${theme.id}: ${label} is ${ratio.toFixed(2)}:1, below the ${minimum}:1 this pair needs`);
		}
	}
});

test('the committed Krunker inventory records what it was generated from', () => {
	assert.match(KRUNKER_CSS.fetchedAt, /^\d{4}-\d{2}-\d{2}$/u);
	assert.ok(KRUNKER_CSS.sources.some(source => source.url.endsWith('/main.css')));
	for (const source of KRUNKER_CSS.sources) {
		assert.match(source.url, /^https:\/\/krunker\.io\//u);
		assert.match(source.sha256, /^[0-9a-f]{64}$/u);
		assert.ok(source.bytes > 0);
	}

	assert.ok(KRUNKER_CSS.ids.length > 400, `only ${KRUNKER_CSS.ids.length} ids in the inventory`);
	assert.ok(KRUNKER_CSS.classes.length > 900, `only ${KRUNKER_CSS.classes.length} classes in the inventory`);
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
	for (const value of ['../outside.css', 'unknown-theme', '', 7, null, undefined, { id: 'wok' }]) {
		assert.equal(parseThemePreference(value), undefined, `${String(value)} must not be persisted`);
	}
});

test('id and filename predicates stay disjoint', () => {
	assert.ok(isBundledThemeId(BUNDLED_THEMES[0].id));
	assert.ok(!isBundledThemeId(`${BUNDLED_THEMES[0].id}.css`));
	assert.ok(isUserThemeFile(`${BUNDLED_THEMES[0].id}.css`));
	assert.ok(!isUserThemeFile(BUNDLED_THEMES[0].id));
	assert.ok(!isBundledThemeId('wok-but-not-shipped'));
});

test('a css swapper selection carries over to the theme preference exactly once', () => {
	assert.equal(migrateThemePreference({ cssSwapper: 'mine.css' }), 'mine.css');
	assert.equal(migrateThemePreference({ cssSwapper: 'None' }), THEME_NONE);

	assert.equal(migrateThemePreference({ cssSwapper: 'mine.css', theme: 'wok' }), undefined);

	assert.equal(migrateThemePreference({ theme: 'wok' }), undefined);
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
	const layers = THEME_LAYER_ASSETS.map(asset => readAsset(asset)).join('\n');
	const starter = readAsset(themeAssetName(THEME_TEMPLATE_STARTER_ID));
	const template = buildUserThemeTemplate(layers, starter);

	assert.ok(BUNDLED_THEMES.some(theme => theme.id === THEME_TEMPLATE_STARTER_ID));
	for (const variable of THEME_VARIABLES) {
		assert.ok(template.includes(variable.name), `the template never mentions ${variable.name}`);
		assert.ok(template.includes(variable.description), `the template does not explain ${variable.name}`);

		assert.match(template, new RegExp(`${variable.name}\\s*:\\s*\\S`, 'u'));
	}
	assert.ok(template.includes('.wok-settings'), 'the template must carry the base layer, not just describe it');
	assert.ok(template.includes('#menuWindow'), 'the template must carry the game layer, not just describe it');
	assert.ok(template.trimStart().startsWith('/*'));
});
