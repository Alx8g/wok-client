import assert from 'node:assert/strict';
import test from 'node:test';
import {
	parseSettingsBaselineMarker,
	planSettingsBaseline,
	SETTINGS_BASELINE_VERSION
} from '../src/settings-baseline.ts';

const NOW = 1_750_000_000_000;

test('a pre-baseline profile gets current defaults and the gpuRasterizing flip together', () => {
	const plan = planSettingsBaseline(undefined, {
		competitionAutomation: true,
		customFilters: true,
		hideAds: 'off',
		matchmaker: true,
		resourceSwapper: true,
		safeFlags_gpuRasterizing: true
	}, NOW);

	assert.deepEqual(plan.patch, {
		competitionAutomation: false,
		customFilters: false,
		hideAds: 'block',
		matchmaker: false,
		resourceSwapper: false,
		safeFlags_gpuRasterizing: false
	});
	assert.deepEqual(plan.marker, { appliedAt: NOW, version: SETTINGS_BASELINE_VERSION });
});

test('a fresh install matching every baseline still records the marker with an empty patch', () => {
	const plan = planSettingsBaseline(undefined, {
		competitionAutomation: false,
		customFilters: false,
		hideAds: 'block',
		matchmaker: false,
		resourceSwapper: false,
		safeFlags_gpuRasterizing: false
	}, NOW);

	assert.deepEqual(plan.patch, {});
	assert.deepEqual(plan.marker, { appliedAt: NOW, version: SETTINGS_BASELINE_VERSION });
});

test('version 1 installs migrate only the stale gpuRasterizing default, never user choices', () => {

	const plan = planSettingsBaseline({ appliedAt: NOW - 5_000, version: 1 }, {
		matchmaker: true,
		safeFlags_gpuRasterizing: true
	}, NOW);

	assert.deepEqual(plan.patch, { safeFlags_gpuRasterizing: false });
	assert.deepEqual(plan.marker, { appliedAt: NOW - 5_000, version: SETTINGS_BASELINE_VERSION });
});

test('version 1 installs that already run with gpuRasterizing off only advance the marker', () => {
	const plan = planSettingsBaseline({ appliedAt: NOW - 5_000, version: 1 }, {
		safeFlags_gpuRasterizing: false
	}, NOW);

	assert.deepEqual(plan.patch, {});
	assert.equal(plan.marker?.version, SETTINGS_BASELINE_VERSION);
});

test('re-enabling gpuRasterizing after the migration is a user choice that stays', () => {
	const plan = planSettingsBaseline({ appliedAt: NOW - 5_000, version: SETTINGS_BASELINE_VERSION }, {
		safeFlags_gpuRasterizing: true
	}, NOW);

	assert.deepEqual(plan.patch, {});
	assert.equal(plan.marker, undefined);
});

test('markers from future versions are left alone', () => {
	const plan = planSettingsBaseline({ appliedAt: NOW, version: SETTINGS_BASELINE_VERSION + 1 }, {
		safeFlags_gpuRasterizing: true
	}, NOW);

	assert.deepEqual(plan.patch, {});
	assert.equal(plan.marker, undefined);
});

test('parses the shipped version-1 marker document and rejects malformed ones', () => {
	assert.deepEqual(
		parseSettingsBaselineMarker({ appliedAt: 1_700_000_000_000, version: 1 }),
		{ appliedAt: 1_700_000_000_000, version: 1 }
	);

	assert.deepEqual(parseSettingsBaselineMarker({ version: 2 }), { appliedAt: 0, version: 2 });
	assert.equal(parseSettingsBaselineMarker(undefined), undefined);
	assert.equal(parseSettingsBaselineMarker('baseline'), undefined);
	assert.equal(parseSettingsBaselineMarker({ appliedAt: 1, version: 0 }), undefined);
	assert.equal(parseSettingsBaselineMarker({ appliedAt: 1, version: 1.5 }), undefined);
	assert.equal(parseSettingsBaselineMarker([]), undefined);
});
