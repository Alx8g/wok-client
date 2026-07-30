import assert from 'node:assert/strict';
import test from 'node:test';
import {
	ADAPTIVE_VALIDATION_PROFILE_SEMANTIC_VERSION,
	createAdaptiveValidationState,
	recordAdaptiveValidationSession,
	type AdaptiveValidationProfileIdentity,
	type AdaptiveValidationSession,
	type AdaptiveValidationState,
	type AdaptiveValidationSubmission
} from '../src/adaptive-validation.ts';
import { startAdaptiveValidationRuntime, type AdaptiveValidationRuntimeEnvironment } from '../src/adaptive-validation-runtime.ts';

type TestListener = EventListener;

function createEventTarget() {
	const listeners = new Map<string, Set<TestListener>>();
	return {
		addEventListener(type: string, listener: TestListener) {
			let typeListeners = listeners.get(type);
			if (!typeListeners) {
				typeListeners = new Set();
				listeners.set(type, typeListeners);
			}
			typeListeners.add(listener);
		},
		removeEventListener(type: string, listener: TestListener) {
			listeners.get(type)?.delete(listener);
		},
		dispatch(type: string) {
			for (const listener of listeners.get(type) ?? []) listener({ type } as Event);
		},
		listenerCount() {
			let count = 0;
			for (const typeListeners of listeners.values()) count += typeListeners.size;
			return count;
		}
	};
}

const profile: AdaptiveValidationProfileIdentity = {
	activeBackend: 'default',
	benchmarkSemanticVersion: 2,
	driverFingerprint: 'driver-a',
	electronVersion: '44.0.0',
	framePolicy: 'uncapped',
	hardwareFingerprint: '8086:46a6',
	profileSemanticVersion: ADAPTIVE_VALIDATION_PROFILE_SEMANTIC_VERSION
};

function stableSession(completedAt: number): AdaptiveValidationSession {
	return {
		completedAt,
		durationMs: 30_000,
		id: `runtime-session-${completedAt.toString().padStart(8, '0')}`,
		lowConfidenceReasons: [],
		metrics: {
			averageFps: 240,
			onePercentLowFps: 180,
			p95FrameTimeMs: 6,
			sampleCount: 7_000,
			worstFrameTimeMs: 18
		}
	};
}

function stateWithSessions(count: number): AdaptiveValidationState {
	let state = createAdaptiveValidationState(profile, 1);
	for (let index = 0; index < count; index++) state = recordAdaptiveValidationSession(state, stableSession(index + 1), index + 2);
	return state;
}

function createRuntimeHarness(pointerLocked: boolean) {
	const documentEvents = createEventTarget();
	const windowEvents = createEventTarget();
	const animationFrames = new Map<number, FrameRequestCallback>();
	const timers = new Map<number, () => void>();
	let nextAnimationFrame = 1;
	let nextTimer = 1;
	let nextSessionId = 1;
	let now = 0;
	const runtimeDocument = {
		pointerLockElement: pointerLocked ? {} : null,
		visibilityState: 'visible' as DocumentVisibilityState,
		addEventListener: documentEvents.addEventListener,
		removeEventListener: documentEvents.removeEventListener
	};
	const environment: AdaptiveValidationRuntimeEnvironment = {
		cancelAnimationFrame(handle) { animationFrames.delete(handle); },
		clearTimeout(handle) { timers.delete(handle); },
		createSessionId: () => `runtime-generated-${(nextSessionId++).toString().padStart(8, '0')}`,
		document: runtimeDocument,
		now: () => now,
		requestAnimationFrame(callback) {
			const handle = nextAnimationFrame++;
			animationFrames.set(handle, callback);
			return handle;
		},
		setTimeout(callback) {
			const handle = nextTimer++;
			timers.set(handle, callback);
			return handle;
		},
		wallClockNow: () => 500_000,
		window: {
			addEventListener: windowEvents.addEventListener,
			removeEventListener: windowEvents.removeEventListener
		}
	};

	return {
		animationFrames,
		documentEvents,
		environment,
		runtimeDocument,
		runNextAnimationFrame(frameTime: number) {
			now = frameTime;
			const next = animationFrames.entries().next().value as [number, FrameRequestCallback] | undefined;
			assert.ok(next);
			animationFrames.delete(next[0]);
			next[1](frameTime);
		},
		runNextTimer(timerTime: number) {
			now = timerTime;
			const next = timers.entries().next().value as [number, () => void] | undefined;
			assert.ok(next);
			timers.delete(next[0]);
			next[1]();
		},
		setNow(value: number) { now = value; },
		timers,
		windowEvents
	};
}

test('starts no listeners or animation frames after validation is already complete', () => {
	const harness = createRuntimeHarness(true);
	const stop = startAdaptiveValidationRuntime({
		state: stateWithSessions(3),
		submitSession: async () => assert.fail('completed validation must not submit')
	}, harness.environment);

	assert.equal(harness.animationFrames.size, 0);
	assert.equal(harness.timers.size, 0);
	assert.equal(harness.documentEvents.listenerCount(), 0);
	assert.equal(harness.windowEvents.listenerCount(), 0);
	stop();
});

test('unload cancels active sampling without accepting or submitting a partial session', () => {
	const harness = createRuntimeHarness(true);
	let submissions = 0;
	startAdaptiveValidationRuntime({
		state: createAdaptiveValidationState(profile, 1),
		submitSession: async () => {
			submissions++;
			return createAdaptiveValidationState(profile, 2);
		}
	}, harness.environment);

	assert.equal(harness.animationFrames.size, 1);
	assert.equal(harness.timers.size, 1);
	harness.windowEvents.dispatch('beforeunload');
	assert.equal(harness.animationFrames.size, 0);
	assert.equal(harness.timers.size, 0);
	assert.equal(harness.documentEvents.listenerCount(), 0);
	assert.equal(harness.windowEvents.listenerCount(), 0);
	assert.equal(submissions, 0);
});

test('marks passive contamination and stops all background sampling after the third accepted session', async () => {
	const harness = createRuntimeHarness(true);
	let persistedState = stateWithSessions(2);
	const submissions: AdaptiveValidationSubmission[] = [];
	startAdaptiveValidationRuntime({
		state: persistedState,
		submitSession: async submission => {
			submissions.push(submission);
			persistedState = recordAdaptiveValidationSession(persistedState, submission.session, 600_000);
			return persistedState;
		}
	}, harness.environment);

	harness.runNextAnimationFrame(1);
	harness.windowEvents.dispatch('blur');
	harness.windowEvents.dispatch('resize');
	harness.documentEvents.dispatch('visibilitychange');
	harness.runNextTimer(1_300);
	harness.runNextAnimationFrame(1_301);
	harness.setNow(30_001);
	harness.runtimeDocument.pointerLockElement = null;
	harness.documentEvents.dispatch('pointerlockchange');
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(submissions.length, 1);
	assert.deepEqual(new Set(submissions[0].session.lowConfidenceReasons), new Set([
		'document-visibility-changed',
		'severe-event-loop-disturbance',
		'window-blurred',
		'window-resized'
	]));
	assert.equal(persistedState.status, 'complete');
	assert.equal(persistedState.classification, 'inconclusive');
	assert.equal(harness.animationFrames.size, 0);
	assert.equal(harness.timers.size, 0);
	assert.equal(harness.documentEvents.listenerCount(), 0);
	assert.equal(harness.windowEvents.listenerCount(), 0);

	harness.runtimeDocument.pointerLockElement = {};
	harness.documentEvents.dispatch('pointerlockchange');
	assert.equal(submissions.length, 1);
	assert.equal(harness.animationFrames.size, 0);
});
