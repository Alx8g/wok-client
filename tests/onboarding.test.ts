import assert from 'node:assert/strict';
import test from 'node:test';
import {
	advanceOnboardingFlow,
	createOnboardingFlow,
	createOnboardingMarker,
	currentOnboardingStep,
	describeOnboardingFollowUp,
	ONBOARDING_VERSION,
	parseOnboardingAction,
	parseOnboardingChoices,
	parseOnboardingMarker,
	planOnboardingOutcome,
	shouldRunOnboarding
} from '../src/onboarding.ts';

const NOW = 1_760_000_000_000;

test('a fresh install with no marker runs setup', () => {
	assert.equal(shouldRunOnboarding(undefined), true);
});

test('an install already at the current marker version never runs setup again', () => {
	const marker = createOnboardingMarker(NOW);
	assert.deepEqual(marker, { completedAt: NOW, version: ONBOARDING_VERSION });
	assert.equal(shouldRunOnboarding(marker), false);
});

test('an older marker version re-triggers setup so a future step can be introduced deliberately', () => {
	assert.equal(shouldRunOnboarding({ completedAt: NOW, version: ONBOARDING_VERSION - 1 }), true);
});

test('a marker from a newer build is left alone', () => {
	assert.equal(shouldRunOnboarding({ completedAt: NOW, version: ONBOARDING_VERSION + 1 }), false);
});

test('an unreadable marker never re-runs setup on ambiguous evidence', () => {
	assert.equal(shouldRunOnboarding(undefined, true), false);
});

test('marker parsing rejects junk and repairs a missing timestamp', () => {
	assert.equal(parseOnboardingMarker(null), undefined);
	assert.equal(parseOnboardingMarker('1'), undefined);
	assert.equal(parseOnboardingMarker({ version: 0 }), undefined);
	assert.equal(parseOnboardingMarker({ version: 1.5 }), undefined);
	assert.deepEqual(parseOnboardingMarker({ version: 2 }), { completedAt: 0, version: 2 });
	assert.deepEqual(parseOnboardingMarker({ completedAt: NOW, version: 1 }), { completedAt: NOW, version: 1 });
});

test('the import step is only in the flow when there is something to import from', () => {
	assert.deepEqual(createOnboardingFlow({ includeImport: false }).steps, ['welcome', 'performance', 'settings', 'done']);
	assert.deepEqual(createOnboardingFlow({ includeImport: true }).steps, ['welcome', 'performance', 'import', 'settings', 'done']);
});

test('advancing walks the steps and finishes after the last one', () => {
	let flow = createOnboardingFlow({ includeImport: false });
	const visited: string[] = [];
	while (!flow.finished) {
		const step = currentOnboardingStep(flow);
		assert.ok(step);
		visited.push(step);
		flow = advanceOnboardingFlow(flow, { choices: {}, kind: 'next' });
	}
	assert.deepEqual(visited, ['welcome', 'performance', 'settings', 'done']);
	assert.equal(currentOnboardingStep(flow), undefined);
});

test('quitting on any step ends the flow immediately', () => {
	const flow = advanceOnboardingFlow(createOnboardingFlow({ includeImport: true }), { kind: 'quit' });
	assert.equal(flow.finished, true);
	assert.equal(currentOnboardingStep(flow), undefined);
	assert.deepEqual(planOnboardingOutcome(flow.choices).preferences, {});
});

test('back returns to the previous step and never walks past the start', () => {
	let flow = advanceOnboardingFlow(createOnboardingFlow({ includeImport: false }), { choices: {}, kind: 'next' });
	assert.equal(currentOnboardingStep(flow), 'performance');
	flow = advanceOnboardingFlow(flow, { kind: 'back' });
	assert.equal(currentOnboardingStep(flow), 'welcome');
	flow = advanceOnboardingFlow(flow, { kind: 'back' });
	assert.equal(currentOnboardingStep(flow), 'welcome');
});

test('revisiting a step through back replaces what it recorded', () => {
	let flow = createOnboardingFlow({ includeImport: false });
	flow = advanceOnboardingFlow(flow, { choices: {}, kind: 'next' });
	flow = advanceOnboardingFlow(flow, { choices: { competitiveMode: true, measurePc: true }, kind: 'next' });
	flow = advanceOnboardingFlow(flow, { kind: 'back' });
	flow = advanceOnboardingFlow(flow, { choices: { competitiveMode: false, measurePc: false }, kind: 'next' });

	const outcome = planOnboardingOutcome(flow.choices, { competitiveMode: false });
	assert.equal(outcome.scheduleCalibration, false);
	assert.deepEqual(outcome.preferences, {});
});

test('a finished flow ignores further actions', () => {
	const finished = advanceOnboardingFlow(createOnboardingFlow({ includeImport: false }), { kind: 'quit' });
	assert.equal(advanceOnboardingFlow(finished, { choices: { discordRPC: true }, kind: 'next' }), finished);
});

test('choices from the renderer are validated, not trusted', () => {
	assert.deepEqual(parseOnboardingChoices(undefined), {});
	assert.deepEqual(parseOnboardingChoices({ competitiveMode: 'yes', fullscreen: 'borderless', importFrom: 'evil' }), {});
	assert.deepEqual(
		parseOnboardingChoices({ discordRPC: true, fullscreen: 'fullscreen', importFrom: 'kcc', unknownKey: 1 }),
		{ discordRPC: true, fullscreen: 'fullscreen', importFrom: 'kcc' }
	);
});

test('an unrecognised or missing renderer response is treated as quitting', () => {
	assert.deepEqual(parseOnboardingAction(undefined), { kind: 'quit' });
	assert.deepEqual(parseOnboardingAction({ kind: 'explode' }), { kind: 'quit' });
	assert.deepEqual(parseOnboardingAction({ kind: 'back' }), { kind: 'back' });
	assert.deepEqual(
		parseOnboardingAction({ choices: { performanceOverlay: true }, kind: 'next' }),
		{ choices: { performanceOverlay: true }, kind: 'next' }
	);
});

test('the performance choice enables Competitive mode and queues the measurement for next launch', () => {
	const outcome = planOnboardingOutcome({ competitiveMode: true, measurePc: true }, { competitiveMode: false });
	assert.deepEqual(outcome.preferences, { competitiveMode: true });
	assert.equal(outcome.scheduleCalibration, true);
});

test('declining the measurement still leaves a working configuration', () => {
	const outcome = planOnboardingOutcome({}, { competitiveMode: false });
	assert.deepEqual(outcome.preferences, {});
	assert.equal(outcome.scheduleCalibration, false);
});

test('only settings that actually differ are written', () => {
	const outcome = planOnboardingOutcome(
		{ discordRPC: false, fullscreen: 'fullscreen', performanceOverlay: true },
		{ discordRPC: false, fullscreen: 'windowed', performanceOverlay: false }
	);
	assert.deepEqual(outcome.preferences, { fullscreen: 'fullscreen', performanceOverlay: true });
});

test('an invalid window mode is dropped rather than written', () => {
	const outcome = planOnboardingOutcome({ fullscreen: 'ultrawide' }, { fullscreen: 'windowed' });
	assert.deepEqual(outcome.preferences, {});
});

test('the closing line tells the truth about when changes take effect', () => {
	assert.equal(describeOnboardingFollowUp({ preferences: {}, scheduleCalibration: false }), undefined);
	assert.equal(
		describeOnboardingFollowUp({ preferences: {}, scheduleCalibration: false }, true),
		'These apply the next time you launch WOK.'
	);
	assert.equal(
		describeOnboardingFollowUp({ preferences: { performanceOverlay: true }, scheduleCalibration: false }),
		'These apply the next time you launch WOK.'
	);
	assert.equal(
		describeOnboardingFollowUp({ preferences: { competitiveMode: true }, scheduleCalibration: true }),
		'Your PC gets measured the next time you launch WOK.'
	);
});
