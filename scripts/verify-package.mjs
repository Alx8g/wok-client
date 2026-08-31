import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractFile, listPackage } from '@electron/asar';
import { BUNDLED_THEMES, THEME_LAYER_ASSETS, themeAssetName } from '../src/themes.ts';
const THEME_ASSETS = [...THEME_LAYER_ASSETS.map((asset) => `assets/${asset}`), ...BUNDLED_THEMES.map((theme) => `assets/${themeAssetName(theme.id)}`)];
const REQUIRED_ASSETS = new Set([
	...THEME_ASSETS,
	'assets/blockFilters.txt',
	'assets/hideAds.css',
	'assets/intro-long-1080.webm',
	'assets/intro-long-1440.webm',
	'assets/intro-short-1080.webm',
	'assets/intro-short-1440.webm',
	'assets/intro.html',
	'assets/intro.js',
	'assets/matchmaker.css',
	'assets/menuTimer.css',
	'assets/quickClassPicker.css',
	'assets/settings.css',
	'assets/splash-frame.webp',
	'assets/splash.css',
	'assets/wok-mark.svg'
]);
const REQUIRED_EXTERNAL_NOTICES = new Map([
	['PATCHED_ELECTRON.txt', 'PATCHED_ELECTRON.txt'],
	['THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.txt'],
	['WOK-CLIENT-GPL-3.0.txt', 'LICENSE']
]);
const FORBIDDEN_PREFIXES = ['.git/', '.working/', 'dist/', 'scripts/', 'src/', 'tests/'];
function normalizedArchiveEntries(asarPath) {
	return listPackage(asarPath, { isPack: false })
		.map((entry) => entry.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, ''))
		.filter((entry) => entry.length > 0);
}
function resourcesPathFor(buildPath, platform) {
	if (platform !== 'darwin') {
		return join(buildPath, 'resources');
	}
	const appBundle = readdirSync(buildPath, {
		withFileTypes: true
	}).find((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
	assert.ok(appBundle, `Could not find the packaged macOS app in ${buildPath}.`);
	return join(buildPath, appBundle.name, 'Contents', 'Resources');
}
function expectedBundleEntries(repositoryRoot) {
	const metafile = JSON.parse(readFileSync(join(repositoryRoot, 'bundle', 'metafile.json'), 'utf8'));
	return new Set(
		Object.keys(metafile.outputs)
			.map((path) => path.replaceAll('\\', '/'))
			.filter((path) => path.startsWith('bundle/') && path.endsWith('.mjs'))
	);
}
function assertExactEntries(actual, expected, label) {
	const missing = [...expected].filter((entry) => !actual.has(entry));
	const unexpected = [...actual].filter((entry) => !expected.has(entry));
	assert.deepEqual(missing, [], `${label} are missing: ${missing.join(', ')}`);
	assert.deepEqual(unexpected, [], `${label} contain unexpected files: ${unexpected.join(', ')}`);
}
export function verifyPackagedApplication({ buildPath, platform, repositoryRoot }) {
	const resourcesPath = resourcesPathFor(buildPath, platform);
	const asarPath = join(resourcesPath, 'app.asar');
	assert.ok(existsSync(asarPath), `Packaged application is missing ${asarPath}.`);
	const entries = normalizedArchiveEntries(asarPath);
	const entrySet = new Set(entries);
	for (const prefix of FORBIDDEN_PREFIXES) {
		assert.ok(!entries.some((entry) => entry.startsWith(prefix)), `Packaged ASAR contains forbidden ${prefix} content.`);
	}
	assert.ok(!entries.some((entry) => entry.endsWith('.map') || entry.endsWith('.ts') || entry.endsWith('.tsx')), 'Packaged ASAR contains source or source-map files.');
	assert.ok(!entrySet.has('bundle/metafile.json'), 'Packaged ASAR must not contain the esbuild metafile.');
	const packagedAssets = new Set(entries.filter((entry) => entry.startsWith('assets/') && !entry.endsWith('/')));
	assertExactEntries(packagedAssets, REQUIRED_ASSETS, 'Packaged assets');
	const packagedBundle = new Set(entries.filter((entry) => entry.startsWith('bundle/') && !entry.endsWith('/')));
	assertExactEntries(packagedBundle, expectedBundleEntries(repositoryRoot), 'Packaged bundle outputs');
	const packageJson = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
	assert.equal(packageJson.main, './bundle/main.mjs', 'Packaged package.json must start the bundled main entry.');
	assert.equal(packageJson.private, true, 'Packaged package.json must retain private=true.');
	for (const [notice, source] of REQUIRED_EXTERNAL_NOTICES) {
		const packagedNoticePath = join(resourcesPath, notice);
		assert.ok(existsSync(packagedNoticePath), `Packaged resources are missing ${notice}.`);
		assert.deepEqual(readFileSync(packagedNoticePath), readFileSync(join(repositoryRoot, source)), `Packaged ${notice} does not match repository ${source}.`);
	}
	return {
		asarPath,
		assetCount: packagedAssets.size,
		bundleOutputCount: packagedBundle.size,
		entryCount: entrySet.size
	};
}
if (process.argv[1] === import.meta.filename) {
	const [buildPath, platform = process.platform] = process.argv.slice(2);
	assert.ok(buildPath, 'Usage: node scripts/verify-package.mjs <build-path> [platform]');
	const result = verifyPackagedApplication({
		buildPath,
		platform,
		repositoryRoot: join(import.meta.dirname, '..')
	});
	console.log(`verify-package: ok (${result.entryCount} ASAR entries; ` + `${result.bundleOutputCount} bundle outputs; ` + `${result.assetCount} assets)`);
}
