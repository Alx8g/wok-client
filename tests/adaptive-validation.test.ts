import assert from 'node:assert/strict';
import test from 'node:test';
import {
	ADAPTIVE_VALIDATION_MIN_SESSION_MS,
	ADAPTIVE_VALIDATION_PROFILE_SEMANTIC_VERSION,
	createAdaptiveValidationState,
	dismissAdaptiveValidationRecommendation,
	parseAdaptiveValidationProfileIdentity,
	parseAdaptiveValidationState,
	prepareAdaptiveValidationState,
	recordAdaptiveValidationSession,
	summarizeAdaptiveValidationEvidence,
	type AdaptiveValidationLowConfidenceReason,
	type AdaptiveValidationProfileIdentity,
	type AdaptiveValidationSession,
	type AdaptiveValidationState
} from '../src/adaptive-validation.ts';
const profile: AdaptiveValidationProfileIdentity = {
	activeBackend: 'd3d11on12',
	benchmarkSemanticVersion: 2,
	driverFingerprint: 'driver-a',
	electronVersion: '44.0.0',
	framePolicy: 'uncapped',
	hardwareFingerprint: '8086:46a6',
	profileSemanticVersion: ADAPTIVE_VALIDATION_PROFILE_SEMANTIC_VERSION
};
let sessionSequence = 0;
function stableSession(overrides: Partial<AdaptiveValidationSession> = {}): AdaptiveValidationSession {
	const sequence = ++sessionSequence;
	return {
		completedAt: 100000 + sequence,
		durationMs: ADAPTIVE_VALIDATION_MIN_SESSION_MS,
		id: `adaptive-session-${sequence.toString().padStart(8, '0')}`,
		lowConfidenceReasons: [],
		metrics: {
			averageFps: 240,
			onePercentLowFps: 180,
			p95FrameTimeMs: 6,
			sampleCount: 7000,
			worstFrameTimeMs: 18
		},
		...overrides
	};
}
function severeSession(lowConfidenceReasons: AdaptiveValidationLowConfidenceReason[] = []): AdaptiveValidationSession {
	return stableSession({
		lowConfidenceReasons,
		metrics: {
			averageFps: 150,
			onePercentLowFps: 35,
			p95FrameTimeMs: 31,
			sampleCount: 4500,
			worstFrameTimeMs: 95
		}
	});
}
function recordSessions(sessions: readonly AdaptiveValidationSession[]): AdaptiveValidationState {
	return sessions.reduce((state, session, index) => recordAdaptiveValidationSession(state, session, 200000 + index), createAdaptiveValidationState(profile, 1));
}
test('parses only internally consistent versioned adaptive validation state', () => {
	const state = recordSessions([stableSession(), stableSession(), stableSession()]);
	assert.deepEqual(parseAdaptiveValidationState(JSON.parse(JSON.stringify(state))), state);
	assert.equal(parseAdaptiveValidationState({ ...state, version: 2 }), undefined);
	assert.equal(parseAdaptiveValidationState({ ...state, classification: 'recalibration-recommended' }), undefined);
	assert.equal(parseAdaptiveValidationState({ ...state, profileChangeConfirmationRequired: false }), undefined);
	assert.equal(parseAdaptiveValidationState({ ...state, summary: { ...state.summary, cleanSessionCount: 0 } }), undefined);
	assert.equal(parseAdaptiveValidationState({ ...state, sessions: [...state.sessions, stableSession()] }), undefined);
});
test('rejects persisted states containing nonqualifying sessions', () => {
	const state = recordSessions([stableSession()]);
	const contaminated = stableSession({ lowConfidenceReasons: ['window-blurred'] });
	const insufficient = stableSession();
	insufficient.metrics = { ...insufficient.metrics, sampleCount: 99 };
	const contaminatedLegacyState = {
		...state,
		sessions: [...state.sessions, contaminated],
		summary: {
			...state.summary,
			acceptedSessionCount: 2
		}
	};
	const insufficientLegacyState = {
		...state,
		sessions: [...state.sessions, insufficient],
		summary: {
			...state.summary,
			acceptedSessionCount: 2,
			cleanSessionCount: 2,
			totalFrameSamples: state.summary.totalFrameSamples + insufficient.metrics.sampleCount
		}
	};
	assert.equal(parseAdaptiveValidationState(contaminatedLegacyState), undefined);
	assert.equal(parseAdaptiveValidationState(insufficientLegacyState), undefined);
});
test('rejects incomplete hardware identity before collecting gameplay evidence', () => {
	assert.equal(parseAdaptiveValidationProfileIdentity({ ...profile, driverFingerprint: '' }), undefined);
	assert.equal(parseAdaptiveValidationProfileIdentity({ ...profile, hardwareFingerprint: '' }), undefined);
});
test('resets evidence whenever the active profile identity changes', () => {
	const existing = recordSessions([stableSession()]);
	assert.equal(prepareAdaptiveValidationState(existing, profile, 500), existing);
	const changedProfiles: AdaptiveValidationProfileIdentity[] = [
		{ ...profile, activeBackend: 'default' },
		{ ...profile, benchmarkSemanticVersion: profile.benchmarkSemanticVersion + 1 },
		{ ...profile, driverFingerprint: 'driver-b' },
		{ ...profile, electronVersion: '45.0.0' },
		{ ...profile, framePolicy: 'capped' },
		{ ...profile, hardwareFingerprint: '10de:2684' }
	];
	for (const changedProfile of changedProfiles) {
		const reset = prepareAdaptiveValidationState(existing, changedProfile, 500);
		assert.equal(reset.sessions.length, 0);
		assert.deepEqual(reset.profile, changedProfile);
		assert.equal(reset.status, 'sampling');
	}
});
test('discards pointer-lock sessions shorter than thirty seconds', () => {
	const initial = createAdaptiveValidationState(profile, 1);
	const shortSession = stableSession({ durationMs: ADAPTIVE_VALIDATION_MIN_SESSION_MS - 0.01 });
	assert.equal(recordAdaptiveValidationSession(initial, shortSession, 2), initial);
	const accepted = recordAdaptiveValidationSession(initial, stableSession(), 3);
	assert.equal(accepted.sessions.length, 1);
	assert.equal(accepted.status, 'sampling');
});
test('rejects contaminated attempts without consuming qualifying session slots', () => {
	const first = stableSession();
	const contaminated = stableSession({ lowConfidenceReasons: ['window-blurred', 'window-resized'] });
	const second = stableSession();
	const third = stableSession();
	const initial = createAdaptiveValidationState(profile, 1);
	const afterFirst = recordAdaptiveValidationSession(initial, first, 2);
	const afterContaminated = recordAdaptiveValidationSession(afterFirst, contaminated, 3);
	assert.equal(afterContaminated, afterFirst);
	assert.equal(afterContaminated.sessions.length, 1);
	assert.equal(afterContaminated.status, 'sampling');
	const state = [second, third].reduce((current, session, index) => recordAdaptiveValidationSession(current, session, index + 4), afterContaminated);
	assert.equal(state.status, 'complete');
	assert.equal(state.classification, 'validated');
	assert.deepEqual(
		state.sessions.map((session) => session.id),
		[first.id, second.id, third.id]
	);
	assert.deepEqual(summarizeAdaptiveValidationEvidence(state), {
		acceptedSessionCount: 3,
		cleanSessionCount: 3,
		maximumP95FrameTimeMs: 6,
		maximumWorstFrameTimeMs: 18,
		minimumAverageFps: 240,
		minimumOnePercentLowFps: 180,
		severeInstabilitySessionCount: 0,
		totalFrameSamples: 21000
	});
});
test('rejects evidence-insufficient attempts without consuming qualifying session slots', () => {
	const initial = createAdaptiveValidationState(profile, 1);
	const insufficientSessions = [{ sampleCount: 99 }, { averageFps: 0 }, { onePercentLowFps: 0 }, { p95FrameTimeMs: 0 }].map((metricOverrides) => {
		const session = stableSession();
		return { ...session, metrics: { ...session.metrics, ...metricOverrides } };
	});
	for (const session of insufficientSessions) {
		assert.equal(recordAdaptiveValidationSession(initial, session, 2), initial);
	}
	const accepted = recordAdaptiveValidationSession(initial, stableSession(), 3);
	assert.equal(accepted.sessions.length, 1);
	assert.equal(accepted.status, 'sampling');
});
test('accepts exactly three qualifying sessions and ignores every later result', () => {
	let state = recordSessions([stableSession(), stableSession(), stableSession()]);
	assert.equal(state.sessions.length, 3);
	assert.equal(state.status, 'complete');
	const completed = state;
	state = recordAdaptiveValidationSession(state, severeSession(), 999999);
	assert.equal(state, completed);
	assert.equal(state.sessions.length, 3);
});
test('rejects replayed and non-chronological gameplay submissions', () => {
	const firstSession = stableSession();
	const initial = createAdaptiveValidationState(profile, 1);
	const afterFirst = recordAdaptiveValidationSession(initial, firstSession, 2);
	assert.equal(recordAdaptiveValidationSession(afterFirst, firstSession, 3), afterFirst);
	const reusedTimestamp = stableSession({ completedAt: firstSession.completedAt });
	assert.equal(recordAdaptiveValidationSession(afterFirst, reusedTimestamp, 4), afterFirst);
});
test('recommends only confirmation-gated recalibration after three clean severe sessions', () => {
	const twoSevere = recordSessions([severeSession(), severeSession()]);
	assert.equal(twoSevere.classification, 'inconclusive');
	const mixed = recordSessions([severeSession(), severeSession(), stableSession()]);
	assert.equal(mixed.classification, 'inconclusive');
	const contaminated = recordSessions([severeSession(), severeSession(['document-visibility-changed']), severeSession()]);
	assert.equal(contaminated.sessions.length, 2);
	assert.equal(contaminated.status, 'sampling');
	assert.equal(contaminated.classification, 'inconclusive');
	const recommended = recordSessions([severeSession(), severeSession(), severeSession()]);
	assert.equal(recommended.classification, 'recalibration-recommended');
	assert.equal(recommended.profileChangeConfirmationRequired, true);
	assert.equal(recommended.profile.activeBackend, profile.activeBackend);
	assert.equal(Object.hasOwn(recommended, 'recommendedBackend'), false);
	const dismissed = dismissAdaptiveValidationRecommendation(recommended, 900000);
	assert.equal(dismissed.recommendationDismissedAt, 900000);
	assert.deepEqual(parseAdaptiveValidationState(JSON.parse(JSON.stringify(dismissed))), dismissed);
	assert.equal(dismissAdaptiveValidationRecommendation(dismissed, 900001), dismissed);
	const validated = recordSessions([stableSession(), stableSession(), stableSession()]);
	assert.equal(validated.classification, 'validated');
});
test('summarizes only qualifying evidence with conservative cross-session bounds', () => {
	const firstCleanSession = stableSession();
	const slowerCleanSession = stableSession({
		metrics: {
			averageFps: 180,
			onePercentLowFps: 110,
			p95FrameTimeMs: 11,
			sampleCount: 5000,
			worstFrameTimeMs: 42
		}
	});
	const contaminatedOutlier = stableSession({
		lowConfidenceReasons: ['severe-event-loop-disturbance'],
		metrics: {
			averageFps: 20,
			onePercentLowFps: 2,
			p95FrameTimeMs: 200,
			sampleCount: 600,
			worstFrameTimeMs: 900
		}
	});
	const insufficientOutlier = stableSession({
		metrics: {
			averageFps: 20,
			onePercentLowFps: 2,
			p95FrameTimeMs: 200,
			sampleCount: 99,
			worstFrameTimeMs: 900
		}
	});
	const thirdCleanSession = stableSession({
		metrics: {
			averageFps: 210,
			onePercentLowFps: 140,
			p95FrameTimeMs: 8,
			sampleCount: 6000,
			worstFrameTimeMs: 26
		}
	});
	const state = recordSessions([firstCleanSession, slowerCleanSession, contaminatedOutlier, insufficientOutlier, thirdCleanSession]);
	const expectedSummary = {
		acceptedSessionCount: 3,
		cleanSessionCount: 3,
		maximumP95FrameTimeMs: 11,
		maximumWorstFrameTimeMs: 42,
		minimumAverageFps: 180,
		minimumOnePercentLowFps: 110,
		severeInstabilitySessionCount: 0,
		totalFrameSamples: 18000
	};
	assert.equal(state.status, 'complete');
	assert.deepEqual(
		state.sessions.map((session) => session.id),
		[firstCleanSession.id, slowerCleanSession.id, thirdCleanSession.id]
	);
	assert.deepEqual(state.summary, expectedSummary);
	assert.deepEqual(summarizeAdaptiveValidationEvidence(state), expectedSummary);
});
function fastSession(averageFps: number): AdaptiveValidationSession {
	return stableSession({
		metrics: {
			averageFps,
			onePercentLowFps: averageFps * 0.5,
			p95FrameTimeMs: 6,
			sampleCount: 7000,
			worstFrameTimeMs: 20
		}
	});
}
function validatedFastState(): AdaptiveValidationState {
	return recordSessions([fastSession(400), fastSession(405), fastSession(395)]);
}
test('a profile change carries the validated history forward as a baseline', () => {
	const validated = validatedFastState();
	assert.equal(validated.classification, 'validated');
	const switched = prepareAdaptiveValidationState(validated, { ...profile, activeBackend: 'default' }, 300000);
	assert.equal(switched.sessions.length, 0);
	assert.equal(switched.baseline?.medianAverageFps, 400);
	assert.equal(switched.baseline?.profile.activeBackend, 'd3d11on12');
});
test('healthy-looking sessions that halve the machine`s own FPS recommend recalibration', () => {
	const switched = prepareAdaptiveValidationState(validatedFastState(), { ...profile, activeBackend: 'default' }, 300000);
	const observed = [
		stableSession({ metrics: { averageFps: 192.3, onePercentLowFps: 79.2, p95FrameTimeMs: 7, sampleCount: 15090, worstFrameTimeMs: 40 } }),
		stableSession({ metrics: { averageFps: 196.6, onePercentLowFps: 66.4, p95FrameTimeMs: 6.25, sampleCount: 6249, worstFrameTimeMs: 45 } }),
		stableSession({ metrics: { averageFps: 177.2, onePercentLowFps: 55.8, p95FrameTimeMs: 8.75, sampleCount: 5690, worstFrameTimeMs: 50 } })
	];
	const complete = observed.reduce((state, session, index) => recordAdaptiveValidationSession(state, session, 400000 + index), switched);
	assert.equal(complete.status, 'complete');
	assert.equal(complete.classification, 'recalibration-recommended');
});
test('a modest dip within the regression bound still validates', () => {
	const switched = prepareAdaptiveValidationState(validatedFastState(), { ...profile, activeBackend: 'default' }, 300000);
	const complete = [fastSession(350), fastSession(340), fastSession(360)].reduce((state, session, index) => recordAdaptiveValidationSession(state, session, 400000 + index), switched);
	assert.equal(complete.classification, 'validated');
});
test('baselines never cross frame policies or machines', () => {
	const validated = validatedFastState();
	const cappedSwitch = prepareAdaptiveValidationState(validated, { ...profile, activeBackend: 'default', framePolicy: 'capped' }, 300000);
	assert.equal(cappedSwitch.baseline, undefined);
	const otherMachine = prepareAdaptiveValidationState(validated, { ...profile, activeBackend: 'default', hardwareFingerprint: '10de:2684' }, 300000);
	assert.equal(otherMachine.baseline, undefined);
});
test('the baseline survives a regressed interlude and a state round-trip', () => {
	const switched = prepareAdaptiveValidationState(validatedFastState(), { ...profile, activeBackend: 'default' }, 300000);
	const regressed = [fastSession(120), fastSession(118), fastSession(122)].reduce((state, session, index) => recordAdaptiveValidationSession(state, session, 400000 + index), switched);
	assert.equal(regressed.classification, 'recalibration-recommended');
	const rolledBack = prepareAdaptiveValidationState(regressed, profile, 500000);
	assert.equal(rolledBack.baseline?.medianAverageFps, 400);
	const roundTripped = parseAdaptiveValidationState(JSON.parse(JSON.stringify(regressed)));
	assert.deepEqual(roundTripped, regressed);
});
test('fast machines with healthy absolute lows are never labeled severe', () => {
	const fieldSession = stableSession({
		metrics: { averageFps: 214.4, onePercentLowFps: 55.8, p95FrameTimeMs: 7.9, sampleCount: 12000, worstFrameTimeMs: 35 }
	});
	const complete = recordSessions([
		fieldSession,
		stableSession({ metrics: { averageFps: 220.1, onePercentLowFps: 60.2, p95FrameTimeMs: 7.4, sampleCount: 11000, worstFrameTimeMs: 30 } }),
		stableSession({ metrics: { averageFps: 208.7, onePercentLowFps: 52.4, p95FrameTimeMs: 8.2, sampleCount: 10500, worstFrameTimeMs: 33 } })
	]);
	assert.equal(complete.classification, 'validated');
	const spiky = recordSessions([
		stableSession({ metrics: { averageFps: 240, onePercentLowFps: 24, p95FrameTimeMs: 9, sampleCount: 9000, worstFrameTimeMs: 80 } }),
		stableSession({ metrics: { averageFps: 235, onePercentLowFps: 22, p95FrameTimeMs: 9.5, sampleCount: 9000, worstFrameTimeMs: 85 } }),
		stableSession({ metrics: { averageFps: 238, onePercentLowFps: 25, p95FrameTimeMs: 8.8, sampleCount: 9000, worstFrameTimeMs: 82 } })
	]);
	assert.equal(spiky.classification, 'recalibration-recommended');
});
