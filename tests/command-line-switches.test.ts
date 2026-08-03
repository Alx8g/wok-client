import assert from 'node:assert/strict';
import test from 'node:test';
import type { FramePolicy } from '../src/calibration.ts';
import { computeCommandLineSwitches, type CommandLineSwitch } from '../src/command-line-switches.ts';
import type { AppliedGraphicsBackend } from '../src/graphics-profile.ts';

const BACKENDS: readonly AppliedGraphicsBackend[] = ['default', 'd3d11', 'd3d11on12', 'vulkan'];
const FRAME_POLICIES: readonly (FramePolicy | undefined)[] = [undefined, 'uncapped', 'capped'];
const PLATFORMS: readonly NodeJS.Platform[] = ['win32', 'linux', 'darwin'];
const PERFORMANCE_PREF_KEYS = [
	'fpsUncap',
	'safeFlags_disableBackgrounding',
	'safeFlags_gpuRasterizing',
	'safeFlags_highPerformanceGpu',
	'experimentalFlags_experimental'
] as const;

/** Every switch the mapping is allowed to emit; anything else is a regression. */
const KNOWN_SWITCH_NAMES = new Set([
	'autoplay-policy',
	'disable-background-timer-throttling',
	'disable-renderer-backgrounding',
	'disable-backgrounding-occluded-windows',
	'use-angle',
	'enable-features',
	'force-high-performance-gpu',
	'enable-native-gpu-memory-buffers',
	'enable-gpu-rasterization',
	'disable-frame-rate-limit',
	'disable-gpu-vsync'
]);

interface MatrixCase {
	backend: AppliedGraphicsBackend;
	framePolicy: FramePolicy | undefined;
	platform: NodeJS.Platform;
	prefs: UserPrefs;
}

function* allMixtures(): Generator<MatrixCase> {
	const booleanMixtureCount = 2 ** PERFORMANCE_PREF_KEYS.length;
	for (let mixture = 0; mixture < booleanMixtureCount; mixture++) {
		const prefs: UserPrefs = {};
		PERFORMANCE_PREF_KEYS.forEach((key, index) => {
			prefs[key] = Boolean(mixture & (1 << index));
		});
		for (const backend of BACKENDS) {
			for (const framePolicy of FRAME_POLICIES) {
				for (const platform of PLATFORMS) yield { backend, framePolicy, platform, prefs };
			}
		}
	}
}

/** Independent statement of the intended pref-to-switch rules, kept apart from the implementation. */
function expectedSwitchSet({ backend, framePolicy, platform, prefs }: MatrixCase): Map<string, string | undefined> {
	const expected = new Map<string, string | undefined>([['autoplay-policy', 'no-user-gesture-required']]);
	if (prefs.safeFlags_disableBackgrounding) {
		expected.set('disable-background-timer-throttling', undefined);
		expected.set('disable-renderer-backgrounding', undefined);
		expected.set('disable-backgrounding-occluded-windows', undefined);
	}
	if (backend !== 'default') expected.set('use-angle', backend);
	if (backend === 'vulkan') expected.set('enable-features', 'Vulkan');
	if (prefs.safeFlags_highPerformanceGpu) expected.set('force-high-performance-gpu', undefined);
	if (prefs.experimentalFlags_experimental && platform === 'linux') expected.set('enable-native-gpu-memory-buffers', undefined);
	if (prefs.safeFlags_gpuRasterizing) expected.set('enable-gpu-rasterization', undefined);
	const uncapped = framePolicy === undefined ? prefs.fpsUncap === true : framePolicy === 'uncapped';
	if (uncapped) {
		expected.set('disable-frame-rate-limit', undefined);
		expected.set('disable-gpu-vsync', undefined);
	}
	return expected;
}

function describeCase(matrixCase: MatrixCase): string {
	const enabled = PERFORMANCE_PREF_KEYS.filter(key => matrixCase.prefs[key] === true).join('+') || 'none';
	return `backend=${matrixCase.backend} framePolicy=${String(matrixCase.framePolicy)} platform=${matrixCase.platform} prefs=${enabled}`;
}

test('every mixture of performance preferences produces exactly the intended switch set', () => {
	let checkedCases = 0;
	for (const matrixCase of allMixtures()) {
		const label = describeCase(matrixCase);
		const switches = computeCommandLineSwitches(matrixCase.prefs, matrixCase.backend, matrixCase.framePolicy, matrixCase.platform);

		const names = switches.map(entry => entry.name);
		assert.equal(new Set(names).size, names.length, `duplicate switches for ${label}`);
		for (const entry of switches) assert.ok(KNOWN_SWITCH_NAMES.has(entry.name), `unknown switch ${entry.name} for ${label}`);

		const actual = new Map<string, string | undefined>(switches.map((entry: CommandLineSwitch) => [entry.name, entry.value]));
		assert.deepEqual(actual, expectedSwitchSet(matrixCase), `switch set mismatch for ${label}`);
		checkedCases++;
	}
	assert.equal(checkedCases, (2 ** PERFORMANCE_PREF_KEYS.length) * BACKENDS.length * FRAME_POLICIES.length * PLATFORMS.length);
});

test('a calibrated frame policy overrides the manual fpsUncap preference in both directions', () => {
	const names = (prefs: UserPrefs, framePolicy?: FramePolicy) =>
		computeCommandLineSwitches(prefs, 'default', framePolicy, 'win32').map(entry => entry.name);

	assert.ok(!names({ fpsUncap: true }, 'capped').includes('disable-frame-rate-limit'));
	assert.ok(names({ fpsUncap: false }, 'uncapped').includes('disable-frame-rate-limit'));
	assert.ok(names({ fpsUncap: true }).includes('disable-frame-rate-limit'));
	assert.ok(!names({ fpsUncap: false }).includes('disable-frame-rate-limit'));
});

test('shipped defaults on Windows produce the expected switch list in a stable order', () => {
	const shippedDefaults: UserPrefs = {
		fpsUncap: true,
		safeFlags_disableBackgrounding: true,
		safeFlags_gpuRasterizing: false,
		safeFlags_highPerformanceGpu: true,
		experimentalFlags_experimental: false
	};

	assert.deepEqual(computeCommandLineSwitches(shippedDefaults, 'd3d11on12', undefined, 'win32'), [
		{ name: 'autoplay-policy', value: 'no-user-gesture-required' },
		{ name: 'disable-background-timer-throttling' },
		{ name: 'disable-renderer-backgrounding' },
		{ name: 'disable-backgrounding-occluded-windows' },
		{ name: 'use-angle', value: 'd3d11on12' },
		{ name: 'force-high-performance-gpu' },
		{ name: 'disable-frame-rate-limit' },
		{ name: 'disable-gpu-vsync' }
	]);
});
