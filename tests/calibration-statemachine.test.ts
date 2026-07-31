import assert from 'node:assert/strict';
import test from 'node:test';
import {
	CALIBRATION_PROVISIONAL_WINDOW_MS,
	calibrationProvisionalExpired,
	calibrationResumeRequired,
	canAutoRollbackCalibration,
	completeCalibration,
	confirmCalibration,
	createCalibrationCandidates,
	createCalibrationSignature,
	createCalibrationState,
	declineCalibrationOffer,
	finalizeCalibration,
	getPendingCalibrationCandidate,
	markCalibrationUnwatched,
	markStaleRerunPromptShown,
	prepareCalibrationState,
	recordCalibrationResult,
	requestCalibrationRerun,
	rollbackCalibration,
	startCalibrationRun,
	type CalibrationCandidate,
	type CalibrationMetrics,
	type CalibrationState
} from '../src/calibration.ts';

const signature = createCalibrationSignature('2.0.0', '44.0.0', '8086:46a6', 'driver-a');
const d3d11on12Renderer = 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, D3D11on12 vs_5_0 ps_5_0, D3D11)';

function createWindowsCandidates(): CalibrationCandidate[] {
	return createCalibrationCandidates({
		currentBackend: 'd3d11on12',
		currentFramePolicy: 'uncapped',
		platform: 'win32',
		recommendedBackend: 'd3d11on12'
	});
}

function cleanMetrics(averageFps: number, webglRenderer = d3d11on12Renderer): CalibrationMetrics {
	return {
		averageFps,
		eventLoopP95Ms: 0.8,
		eventLoopWorstMs: 3,
		longFrameRatio: 0,
		lowConfidenceReasons: [],
		onePercentLowFps: averageFps * 0.9,
		p95FrameTimeMs: 4,
		sampleCount: 800,
		success: true,
		webglRenderer,
		worstFrameTimeMs: 8
	};
}

function startRunWithOrder(state: CalibrationState, firstCandidateId: string): CalibrationState {
	for (let now = 1_000; now < 1_200; now++) {
		const started = startCalibrationRun(state, now);
		if (started.plan[0]?.candidateId === firstCandidateId) return started;
	}
	throw new Error(`Could not stage ${firstCandidateId} first`);
}

/** UNCALIBRATED -> RUNNING -> AWAITING-CONFIRMATION with a clear d3d11on12 win over default. */
function runToDecision(candidates: CalibrationCandidate[] = createWindowsCandidates()): CalibrationState {
	let state = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, true), candidates[0].id);
	state = recordCalibrationResult(state, candidates[0], cleanMetrics(300));
	state = recordCalibrationResult(state, candidates[1], cleanMetrics(200, 'Unknown renderer'));
	return finalizeCalibration(state);
}

test('deferral: a fresh or reset state never requires a startup detour', () => {
	const candidates = createWindowsCandidates();
	const fresh = prepareCalibrationState(undefined, signature, candidates, false);

	assert.equal(fresh.status, 'uncalibrated');
	assert.equal(getPendingCalibrationCandidate(fresh), undefined);
	assert.equal(calibrationResumeRequired(fresh), false);
	assert.equal(calibrationResumeRequired(undefined), false);
});

test('deferral: consent, mid-plan resume, results page, and explicit reruns do detour', () => {
	const candidates = createWindowsCandidates();
	const fresh = prepareCalibrationState(undefined, signature, candidates, false);
	const running = startCalibrationRun(fresh, 7);
	assert.equal(running.status, 'running');
	assert.equal(calibrationResumeRequired(running), true, 'a consented plan resumes across launches');

	const awaiting = runToDecision(candidates);
	assert.equal(awaiting.status, 'awaiting-confirmation');
	assert.equal(calibrationResumeRequired(awaiting), true, 'an interrupted results page resumes');

	const completed = completeCalibration(awaiting, false);
	assert.equal(calibrationResumeRequired(completed), false);
	assert.equal(calibrationResumeRequired(requestCalibrationRerun(completed)), true);
});

test('apply enters the provisional state with the previous selection retained for rollback', () => {
	const candidates = createWindowsCandidates();
	const previousSelection = runToDecision(candidates).recommendedSelection;
	assert.ok(previousSelection);

	let state = runToDecision(candidates);
	state = { ...state, activeSelection: { ...previousSelection, candidate: candidates[1], score: 150 } };
	const applied = completeCalibration(state, true, 50_000);

	assert.equal(applied.status, 'complete');
	assert.equal(applied.confirmation, 'pending');
	assert.equal(applied.provisionalSince, 50_000);
	assert.equal(applied.activeSelection?.candidate.id, state.recommendedSelection?.candidate.id);
	assert.equal(applied.previousSelection?.candidate.id, candidates[1].id);
});

test('keep leaves the state complete without a provisional confirmation loop', () => {
	const kept = completeCalibration(runToDecision(), false);
	assert.equal(kept.status, 'complete');
	assert.equal(kept.confirmation, undefined);
	assert.equal(kept.previousSelection, undefined);
});

test('a validated field verdict confirms the provisional profile', () => {
	const applied = completeCalibration(runToDecision(), true, 1_000);
	const confirmed = confirmCalibration(applied, 2_000);

	assert.equal(confirmed.confirmation, 'confirmed');
	assert.equal(confirmed.activeSelection?.candidate.id, applied.activeSelection?.candidate.id);
	assert.equal(confirmCalibration(confirmed, 3_000), confirmed, 'confirming twice is a no-op');
});

test('three severe sessions roll back to the previous selection and field-reject the loser', () => {
	const candidates = createWindowsCandidates();
	let state = runToDecision(candidates);
	const previous = { ...state.recommendedSelection, candidate: candidates[1] };
	state = { ...state, activeSelection: previous };
	const applied = completeCalibration(state, true, 1_000);
	const rejectedId = applied.activeSelection?.candidate.id;
	assert.ok(rejectedId);

	assert.equal(canAutoRollbackCalibration(applied), true);
	const rolledBack = rollbackCalibration(applied, 2_000);

	assert.equal(rolledBack.confirmation, 'rolled-back');
	assert.equal(rolledBack.autoRollbackUsed, true);
	assert.equal(rolledBack.activeSelection?.candidate.id, candidates[1].id, 'the previous selection is restored');
	assert.ok(rolledBack.fieldRejectedCandidateIds.includes(rejectedId));
	assert.ok(rolledBack.results.filter(result => result.candidate.id === rejectedId).every(result => result.fieldRejected === true));
});

test('rollback without a previous selection clears the active selection back to the auto path', () => {
	const applied = completeCalibration(runToDecision(), true, 1_000);
	assert.equal(applied.previousSelection, undefined);

	const rolledBack = rollbackCalibration(applied, 2_000);
	assert.equal(rolledBack.confirmation, 'rolled-back');
	assert.equal(rolledBack.activeSelection, undefined);
});

test('only one automatic rollback is allowed per signature, even across resets', () => {
	const candidates = createWindowsCandidates();
	const rolledBack = rollbackCalibration(completeCalibration(runToDecision(candidates), true, 1_000), 2_000);
	assert.equal(canAutoRollbackCalibration(rolledBack), false);
	assert.equal(rollbackCalibration(rolledBack, 3_000), rolledBack, 'a second rollback is a no-op');

	// A rerun under the same signature keeps the marker: later disagreements go back to dialogs.
	const rerun = prepareCalibrationState(requestCalibrationRerun(rolledBack), signature, candidates, true);
	assert.equal(rerun.autoRollbackUsed, true);
	let next = recordCalibrationResult(rerun, candidates[0], cleanMetrics(300));
	next = recordCalibrationResult(next, candidates[1], cleanMetrics(200, 'Unknown renderer'));
	const reApplied = completeCalibration(finalizeCalibration(next), true, 10_000);
	assert.equal(reApplied.confirmation, 'pending');
	assert.equal(canAutoRollbackCalibration(reApplied), false);
});

test('keep-anyway parks the provisional profile unwatched instead of reverting', () => {
	const applied = completeCalibration(runToDecision(), true, 1_000);
	const keptAnyway = markCalibrationUnwatched(applied, 2_000);

	assert.equal(keptAnyway.confirmation, 'unwatched');
	assert.equal(keptAnyway.activeSelection?.candidate.id, applied.activeSelection?.candidate.id);
	assert.equal(keptAnyway.fieldRejectedCandidateIds.length, 0);
	assert.equal(markCalibrationUnwatched(keptAnyway, 3_000), keptAnyway);
});

test('a provisional profile with stalled sampling expires to unwatched after fourteen days', () => {
	const applied = completeCalibration(runToDecision(), true, 1_000);

	assert.equal(calibrationProvisionalExpired(applied, 1_000 + CALIBRATION_PROVISIONAL_WINDOW_MS), false);
	assert.equal(calibrationProvisionalExpired(applied, 1_001 + CALIBRATION_PROVISIONAL_WINDOW_MS), true);
	assert.equal(calibrationProvisionalExpired(confirmCalibration(applied), 1_001 + CALIBRATION_PROVISIONAL_WINDOW_MS), false);
});

test('declining the post-session offer persists once and survives signature resets', () => {
	const candidates = createWindowsCandidates();
	const fresh = prepareCalibrationState(undefined, signature, candidates, true);
	const declined = declineCalibrationOffer(fresh, 5_000);

	assert.equal(declined.calibrationOfferDeclinedAt, 5_000);
	assert.equal(declineCalibrationOffer(declined, 9_000), declined, 'a second decline never overwrites the first');

	const hardwareChanged = createCalibrationSignature('2.0.0', '44.0.0', '10de:2684', 'driver-a');
	const reset = prepareCalibrationState(declined, hardwareChanged, candidates, true);
	assert.equal(reset.calibrationOfferDeclinedAt, 5_000, 'the decline is user intent, not measurement state');
});

test('the stale-rerun prompt marker is recorded at most once', () => {
	const fresh = prepareCalibrationState(undefined, signature, createWindowsCandidates(), true);
	const shown = markStaleRerunPromptShown(fresh, 4_000);
	assert.equal(shown.staleRerunPromptShownAt, 4_000);
	assert.equal(markStaleRerunPromptShown(shown, 8_000), shown);
});

test('starting a new consented run clears the previous confirmation bookkeeping', () => {
	const candidates = createWindowsCandidates();
	const applied = completeCalibration(runToDecision(candidates), true, 1_000);
	const restarted = startCalibrationRun(createCalibrationState(signature, candidates, true, applied), 9_999);

	assert.equal(restarted.status, 'running');
	assert.equal(restarted.confirmation, undefined);
	assert.equal(restarted.provisionalSince, undefined);
	assert.equal(restarted.previousSelection, undefined);
	assert.equal(restarted.activeSelection?.candidate.id, applied.activeSelection?.candidate.id, 'the applied selection itself is preserved');
});
