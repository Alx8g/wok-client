import assert from 'node:assert/strict';
import test from 'node:test';
import { createStartupProfile, estimateProcessStartWallClockMs, expectedReadyMs, INTRO_VARIANTS, parseStartupProfile, recordStartupSample, selectIntroVariant, startupReadyMs } from '../src/startup-profile.ts';
test('process timing is available independently of diagnostic marks', () => {
	assert.equal(estimateProcessStartWallClockMs(10000, 2.5), 7500);
	assert.equal(estimateProcessStartWallClockMs(10000, -1), 10000);
	assert.equal(startupReadyMs(8.25), 8250);
	assert.equal(startupReadyMs(0), undefined);
	assert.equal(startupReadyMs(120), undefined);
});
test('a fresh profile selects the longest animation', () => {
	assert.equal(selectIntroVariant(createStartupProfile()), 'long');
});
test('a slow machine keeps the long animation', () => {
	const profile = { readyMs: [8400, 8200, 8600] };
	assert.equal(selectIntroVariant(profile), 'long');
});
test('a mid-speed machine takes the short animation', () => {
	assert.equal(selectIntroVariant({ readyMs: [6500, 6400, 6600] }), 'short');
});
test('this machine, measured at 7.1-7.8s, keeps the long animation', () => {
	assert.equal(selectIntroVariant({ readyMs: [7066, 7277, 7298, 7812] }), 'long');
});
test('overshoot is tolerated only up to the allowance', () => {
	assert.equal(selectIntroVariant({ readyMs: [7017] }), 'long');
	assert.equal(selectIntroVariant({ readyMs: [7016] }), 'short');
});
test('a machine faster than the shortest animation gets no animation', () => {
	const profile = { readyMs: [3000, 3100, 2900] };
	assert.equal(selectIntroVariant(profile), 'none');
});
test('one contended launch does not downgrade the animation', () => {
	const profile = { readyMs: [8400, 8300, 20000, 8500, 8350] };
	assert.equal(expectedReadyMs(profile), 8400);
	assert.equal(selectIntroVariant(profile), 'long');
});
test('samples are bounded and most recent are kept', () => {
	let profile = createStartupProfile();
	for (let sample = 1; sample <= 20; sample += 1) profile = recordStartupSample(profile, sample * 100);
	assert.equal(profile.readyMs.length, 7);
	assert.equal(profile.readyMs.at(-1), 2000);
	assert.equal(profile.readyMs.at(0), 1400);
});
test('implausible samples are rejected rather than stored', () => {
	const profile = createStartupProfile();
	assert.deepEqual(recordStartupSample(profile, 0).readyMs, []);
	assert.deepEqual(recordStartupSample(profile, -5).readyMs, []);
	assert.deepEqual(recordStartupSample(profile, Number.NaN).readyMs, []);
	assert.deepEqual(recordStartupSample(profile, 500000).readyMs, []);
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
			readyMs: [1000, 'x', -2, 8000]
		}),
		{
			readinessSignalVersion: 2,
			readyMs: [1000, 8000]
		}
	);
});
test('samples from the premature loading-spinner predicate are invalidated', () => {
	const migrated = parseStartupProfile({
		readyMs: [1873, 1737, 1742, 1823, 2076, 1912, 1825]
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
	assert.equal(selectIntroVariant({ readyMs: [8198] }), 'long');
});
