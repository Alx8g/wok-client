import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createStartupProfile,
	estimateProcessStartWallClockMs,
	expectedReadyMs,
	INTRO_VARIANTS,
	parseStartupProfile,
	recordStartupSample,
	selectIntroVariant,
	startupReadyMs
} from '../src/startup-profile.ts';

test('process timing is available independently of diagnostic marks', () => {
	assert.equal(estimateProcessStartWallClockMs(10_000, 2.5), 7_500);
	assert.equal(estimateProcessStartWallClockMs(10_000, -1), 10_000);
	assert.equal(startupReadyMs(8.25), 8_250);
	assert.equal(startupReadyMs(0), undefined);
	assert.equal(startupReadyMs(120), undefined);
});

test('a fresh profile selects the longest animation', () => {
	// First launch is the slowest a user ever has: cold HTTP, shader and V8 caches.
	assert.equal(selectIntroVariant(createStartupProfile()), 'long');
});

test('a slow machine keeps the long animation', () => {
	const profile = { readyMs: [8_400, 8_200, 8_600] };
	assert.equal(selectIntroVariant(profile), 'long');
});

test('a mid-speed machine takes the short animation', () => {
	// long finishes at 450 + 7167 = 7617 and needs ready >= 7017; 6500 does not reach that.
	assert.equal(selectIntroVariant({ readyMs: [6_500, 6_400, 6_600] }), 'short');
});

test('this machine, measured at 7.1-7.8s, keeps the long animation', () => {
	// Real launches from the cost A/B: 7066, 7277, 7298, 7812 (median 7288). The long variant
	// overshoots readiness by ~330ms. Rejecting it would expose the weapon morph loader for ~3.1s.
	assert.equal(selectIntroVariant({ readyMs: [7_066, 7_277, 7_298, 7_812] }), 'long');
});

test('overshoot is tolerated only up to the allowance', () => {
	assert.equal(selectIntroVariant({ readyMs: [7_017] }), 'long');
	assert.equal(selectIntroVariant({ readyMs: [7_016] }), 'short');
});

test('a machine faster than the shortest animation gets no animation', () => {
	// short finishes at 450 + 3800 = 4250 and needs ready >= 3650.
	const profile = { readyMs: [3_000, 3_100, 2_900] };
	assert.equal(selectIntroVariant(profile), 'none');
});

test('one contended launch does not downgrade the animation', () => {
	// A single 20s outlier among fast-but-long-enough launches must not win.
	const profile = { readyMs: [8_400, 8_300, 20_000, 8_500, 8_350] };
	assert.equal(expectedReadyMs(profile), 8_400);
	assert.equal(selectIntroVariant(profile), 'long');
});

test('samples are bounded and most recent are kept', () => {
	let profile = createStartupProfile();
	for (let sample = 1; sample <= 20; sample += 1) profile = recordStartupSample(profile, sample * 100);
	assert.equal(profile.readyMs.length, 7);
	assert.equal(profile.readyMs.at(-1), 2_000);
	assert.equal(profile.readyMs.at(0), 1_400);
});

test('implausible samples are rejected rather than stored', () => {
	const profile = createStartupProfile();
	assert.deepEqual(recordStartupSample(profile, 0).readyMs, []);
	assert.deepEqual(recordStartupSample(profile, -5).readyMs, []);
	assert.deepEqual(recordStartupSample(profile, Number.NaN).readyMs, []);
	assert.deepEqual(recordStartupSample(profile, 500_000).readyMs, []);
});

test('a corrupt or hand-edited profile falls back instead of throwing', () => {
	const freshProfile = createStartupProfile();
	assert.deepEqual(parseStartupProfile(undefined), freshProfile);
	assert.deepEqual(parseStartupProfile('nonsense'), freshProfile);
	assert.deepEqual(
		parseStartupProfile({
			readinessSignalVersion: 2,
			readyMs: 'nope'
		}),
		freshProfile
	);
	assert.deepEqual(
		parseStartupProfile({
			readinessSignalVersion: 2,
			readyMs: [1_000, 'x', -2, 8_000]
		}),
		{
			readinessSignalVersion: 2,
			readyMs: [1_000, 8_000]
		}
	);
});

test('samples from the premature loading-spinner predicate are invalidated', () => {
	const migrated = parseStartupProfile({
		readyMs: [1_873, 1_737, 1_742, 1_823, 2_076, 1_912, 1_825]
	});

	assert.deepEqual(migrated, createStartupProfile());
	assert.equal(selectIntroVariant(migrated), 'long');
});

test('every variant ends its audio after its picture, and is opaque before it ends', () => {
	for (const [name, timing] of Object.entries(INTRO_VARIANTS)) {
		assert.ok(timing.audioMs > timing.visualMs, `${name}: audio tail must outlast the picture`);
		assert.ok(timing.opaqueMs < timing.visualMs, `${name}: must be opaque before the picture ends`);
	}
});

test('a machine that just fits keeps the long animation rather than falling off a cliff', () => {
	// Regression: a measured 8198 ms launch previously computed 8217 ms and downgraded by 19 ms,
	// dropping the user from 7.2s of animation to 3.7s over a negligible handoff boundary.
	assert.equal(selectIntroVariant({ readyMs: [8_198] }), 'long');
});
