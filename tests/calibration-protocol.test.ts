import assert from 'node:assert/strict';
import test from 'node:test';
import {
	CALIBRATION_MAX_LAUNCHES,
	calibrationClearWinMargin,
	canStartCalibrationLaunch,
	clampCalibrationTrialDeadline,
	createCalibrationCandidates,
	createCalibrationSignature,
	finalizeCalibration,
	getPendingCalibrationCandidate,
	getPendingCalibrationSlotIndex,
	getPendingLaunchSlotIndices,
	isCalibrationBudgetExhausted,
	parseCalibrationState,
	prepareCalibrationState,
	recordCalibrationResult,
	startCalibrationRun,
	tryRecordCalibrationLaunch,
	type CalibrationCandidate,
	type CalibrationMetrics,
	type CalibrationState
} from '../src/calibration.ts';
const signature = createCalibrationSignature('2.0.0', '44.0.0', '8086:46a6', 'driver-a');
const d3d11on12Renderer = 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, D3D11on12 vs_5_0 ps_5_0, D3D11)';
const d3d11Renderer = 'ANGLE (Intel, Iris Xe, D3D11 vs_5_0 ps_5_0, D3D11)';
function createWindowsCandidates(): CalibrationCandidate[] {
	return createCalibrationCandidates({
		currentBackend: 'd3d11on12',
		currentFramePolicy: 'uncapped',
		platform: 'win32',
		recommendedBackend: 'd3d11on12'
	});
}
function metricsForScore(target: number, overrides: Partial<CalibrationMetrics> = {}): CalibrationMetrics {
	const averageFps = (target - 80) / 0.7;
	return {
		averageFps,
		eventLoopP95Ms: 0.8,
		eventLoopWorstMs: 3,
		longFrameRatio: 0,
		lowConfidenceReasons: [],
		onePercentLowFps: averageFps,
		p95FrameTimeMs: 4,
		sampleCount: 800,
		success: true,
		webglRenderer: d3d11on12Renderer,
		worstFrameTimeMs: 4,
		...overrides
	};
}
function startRunWithOrder(state: CalibrationState, firstCandidateId: string): CalibrationState {
	for (let now = 1000; now < 1200; now++) {
		const started = startCalibrationRun(state, now);
		if (started.plan[0]?.candidateId === firstCandidateId) return started;
	}
	throw new Error(`Could not stage ${firstCandidateId} first`);
}
function freshRun(candidates: CalibrationCandidate[] = createWindowsCandidates()): CalibrationState {
	return startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, false), candidates[0].id);
}
interface StageTwoScores {
	explicitScores: number[];
	fallbackRenderer?: string;
	fallbackScores: number[];
}
function runStageTwo(state: CalibrationState, { explicitScores, fallbackRenderer = 'Unknown renderer', fallbackScores }: StageTwoScores): CalibrationState {
	const [explicit, fallback] = state.candidates;
	let next = state;
	next = recordCalibrationResult(next, explicit, metricsForScore(explicitScores[0]));
	next = recordCalibrationResult(next, fallback, metricsForScore(fallbackScores[0], { webglRenderer: fallbackRenderer }));
	assert.ok(
		next.plan.some((slot) => slot.stage === 'repeat'),
		'expected close screen results to append the repeat stage'
	);
	for (const score of explicitScores.slice(1)) next = recordCalibrationResult(next, explicit, metricsForScore(score));
	for (const score of fallbackScores.slice(1)) next = recordCalibrationResult(next, fallback, metricsForScore(score, { webglRenderer: fallbackRenderer }));
	return next;
}
test('plan creation counterbalances first-candidate order across the population', () => {
	const candidates = createWindowsCandidates();
	const base = prepareCalibrationState(undefined, signature, candidates, false);
	const firstCandidates = new Set<string>();
	for (let now = 1; now <= 64; now++) firstCandidates.add(startCalibrationRun(base, now).plan[0].candidateId);
	assert.deepEqual([...firstCandidates].sort(), ['d3d11on12:uncapped', 'default:uncapped']);
});
test('the persisted plan is followed deterministically across simulated relaunches', () => {
	const candidates = createWindowsCandidates();
	let state = freshRun(candidates);
	assert.deepEqual(
		state.plan.map((slot) => `${slot.candidateId}#${slot.launchGroup}`),
		['d3d11on12:uncapped#1', 'default:uncapped#2']
	);
	const reloaded = parseCalibrationState(JSON.parse(JSON.stringify(state)));
	assert.ok(reloaded);
	assert.deepEqual(reloaded.plan, state.plan);
	assert.equal(getPendingCalibrationCandidate(reloaded)?.id, 'd3d11on12:uncapped');
	state = recordCalibrationResult(reloaded, candidates[0], metricsForScore(300));
	assert.equal(getPendingCalibrationCandidate(state)?.id, 'default:uncapped');
});
test('a clear stage-1 win decides on one trial per candidate without a repeat stage', () => {
	const candidates = createWindowsCandidates();
	let state = freshRun(candidates);
	state = recordCalibrationResult(state, candidates[0], metricsForScore(300));
	state = recordCalibrationResult(state, candidates[1], metricsForScore(200, { webglRenderer: 'Unknown renderer' }));
	assert.ok(Math.abs(300 - 200) >= calibrationClearWinMargin(200));
	assert.equal(
		state.plan.some((slot) => slot.stage === 'repeat'),
		false
	);
	assert.equal(getPendingCalibrationCandidate(state), undefined);
	const finalized = finalizeCalibration(state);
	assert.equal(finalized.recommendedSelection?.candidate.id, 'd3d11on12:uncapped');
});
test('close screen results append an ABAB repeat block with shared launch groups', () => {
	const candidates = createWindowsCandidates();
	let state = freshRun(candidates);
	state = recordCalibrationResult(state, candidates[0], metricsForScore(300));
	state = recordCalibrationResult(state, candidates[1], metricsForScore(295, { webglRenderer: 'Unknown renderer' }));
	assert.deepEqual(
		state.plan.map((slot) => `${slot.candidateId}:${slot.stage}:${slot.launchGroup}`),
		['d3d11on12:uncapped:screen:1', 'default:uncapped:screen:2', 'd3d11on12:uncapped:repeat:3', 'd3d11on12:uncapped:repeat:3', 'default:uncapped:repeat:4', 'default:uncapped:repeat:4']
	);
	assert.deepEqual(getPendingLaunchSlotIndices(state), [2, 3], 'same-candidate repeat trials share one launch');
	state = recordCalibrationResult(state, candidates[0], metricsForScore(301));
	assert.deepEqual(getPendingLaunchSlotIndices(state), [3]);
});
test('a low-confidence screen trial forces the repeat stage even with a wide score gap', () => {
	const candidates = createWindowsCandidates();
	let state = freshRun(candidates);
	state = recordCalibrationResult(state, candidates[0], metricsForScore(300, { lowConfidenceReasons: ['window-blurred'] }));
	state = recordCalibrationResult(state, candidates[1], metricsForScore(200, { webglRenderer: 'Unknown renderer' }));
	assert.equal(state.plan.filter((slot) => slot.stage === 'repeat').length, 4);
});
test('an invalid screen trial skips the repeat stage because the loser cannot win', () => {
	const candidates = createWindowsCandidates();
	let state = freshRun(candidates);
	state = recordCalibrationResult(state, candidates[0], metricsForScore(300, { success: false }), 'GPU process crashed.');
	state = recordCalibrationResult(state, candidates[1], metricsForScore(200, { webglRenderer: 'Unknown renderer' }));
	assert.equal(
		state.plan.some((slot) => slot.stage === 'repeat'),
		false
	);
	assert.equal(finalizeCalibration(state).recommendedSelection?.candidate.id, 'default:uncapped');
});
test('heavily overlapping score ranges tie and resolve to the safer default backend', () => {
	const state = runStageTwo(freshRun(), { explicitScores: [300, 304, 302], fallbackScores: [301, 303, 305] });
	const finalized = finalizeCalibration(state);
	assert.equal(finalized.recommendedSelection?.candidate.backend, 'default');
});
test('a tie keeps the current known-good active selection', () => {
	const candidates = createWindowsCandidates();
	let completed = freshRun(candidates);
	completed = recordCalibrationResult(completed, candidates[0], metricsForScore(302));
	completed = finalizeCalibration(completed);
	completed = { ...completed, status: 'complete' as const, activeSelection: completed.recommendedSelection };
	let rerun = startCalibrationRun(prepareCalibrationState(completed, signature, candidates, false), 5);
	rerun = { ...rerun, activeSelection: completed.activeSelection };
	rerun = runStageTwo(rerun, { explicitScores: [300, 304, 302], fallbackScores: [301, 303, 305] });
	const finalized = finalizeCalibration(rerun);
	assert.equal(finalized.recommendedSelection?.candidate.id, 'd3d11on12:uncapped');
});
test('disjoint score ranges past the win margin let the challenger beat the incumbent', () => {
	const candidates = createWindowsCandidates();
	let completed = freshRun(candidates);
	completed = recordCalibrationResult(completed, candidates[0], metricsForScore(200));
	completed = finalizeCalibration(completed);
	completed = { ...completed, status: 'complete' as const, activeSelection: completed.recommendedSelection };
	let rerun = startCalibrationRun(prepareCalibrationState(completed, signature, candidates, false), 5);
	rerun = { ...rerun, activeSelection: completed.activeSelection };
	rerun = runStageTwo(rerun, { explicitScores: [200, 202, 204], fallbackScores: [214, 230, 234] });
	const finalized = finalizeCalibration(rerun);
	assert.equal(finalized.recommendedSelection?.candidate.id, 'default:uncapped');
});
test('overlapping ranges need twice the margin and under a quarter overlap to win', () => {
	const state = runStageTwo(freshRun(), { explicitScores: [200, 201, 214], fallbackScores: [213, 216, 219] });
	const finalized = finalizeCalibration(state);
	assert.equal(finalized.recommendedSelection?.candidate.id, 'default:uncapped');
});
test('a field-rejected candidate loses a marginal overlap win but keeps a dominant disjoint win', () => {
	const overlapState = runStageTwo(freshRun(), { explicitScores: [200, 201, 214], fallbackScores: [213, 216, 219] });
	const overlapDemoted = finalizeCalibration({ ...overlapState, fieldRejectedCandidateIds: ['default:uncapped'] });
	assert.equal(overlapDemoted.recommendedSelection?.candidate.id, 'd3d11on12:uncapped');
	const disjointState = runStageTwo(freshRun(), { explicitScores: [200, 202, 204], fallbackScores: [214, 230, 234] });
	const dominantWin = finalizeCalibration({ ...disjointState, fieldRejectedCandidateIds: ['default:uncapped'] });
	assert.equal(dominantWin.recommendedSelection?.candidate.id, 'default:uncapped');
});
test('fewer than two clean trials cannot win once the repeat stage ran', () => {
	const candidates = createWindowsCandidates();
	let state = freshRun(candidates);
	state = recordCalibrationResult(state, candidates[0], metricsForScore(290, { lowConfidenceReasons: ['window-blurred'] }));
	state = recordCalibrationResult(state, candidates[1], metricsForScore(198, { webglRenderer: 'Unknown renderer' }));
	assert.ok(state.plan.some((slot) => slot.stage === 'repeat'));
	state = recordCalibrationResult(state, candidates[0], metricsForScore(292));
	state = recordCalibrationResult(state, candidates[0], metricsForScore(288, { lowConfidenceReasons: ['window-resized'] }));
	state = recordCalibrationResult(state, candidates[1], metricsForScore(200, { webglRenderer: 'Unknown renderer' }));
	state = recordCalibrationResult(state, candidates[1], metricsForScore(202, { webglRenderer: 'Unknown renderer' }));
	const finalized = finalizeCalibration(state);
	assert.equal(finalized.recommendedSelection?.candidate.id, 'default:uncapped');
});
test('verified backend evidence breaks ties between explicit candidates', () => {
	const candidates = createCalibrationCandidates({
		currentBackend: 'd3d11',
		currentFramePolicy: 'uncapped',
		platform: 'win32',
		recommendedBackend: 'd3d11on12'
	});
	assert.deepEqual(
		candidates.map((candidate) => candidate.id),
		['d3d11:uncapped', 'd3d11on12:uncapped']
	);
	let state = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, false), candidates[0].id);
	state = recordCalibrationResult(state, candidates[0], metricsForScore(300, { webglRenderer: d3d11Renderer }));
	state = recordCalibrationResult(state, candidates[1], metricsForScore(301, { webglRenderer: 'Unknown renderer' }));
	for (const score of [304, 302]) state = recordCalibrationResult(state, candidates[0], metricsForScore(score, { webglRenderer: d3d11Renderer }));
	for (const score of [303, 305]) state = recordCalibrationResult(state, candidates[1], metricsForScore(score, { webglRenderer: 'Unknown renderer' }));
	const finalized = finalizeCalibration(state);
	assert.equal(finalized.recommendedSelection?.candidate.id, 'd3d11:uncapped');
});
test('the GPU-time tie-breaker fires only when both candidates have measured GPU timing', () => {
	const candidates = createCalibrationCandidates({
		currentBackend: 'd3d11',
		currentFramePolicy: 'uncapped',
		platform: 'win32',
		recommendedBackend: 'd3d11on12'
	});
	const explicitMetrics = (score: number, gpuTimeP95Ms: number | undefined, renderer: string): CalibrationMetrics =>
		metricsForScore(score, {
			webglRenderer: renderer,
			...(gpuTimeP95Ms !== undefined ? { gpuTimeP95Ms, gpuTimingStatus: 'measured' as const } : { gpuTimingStatus: 'unsupported' as const })
		});
	const runWithGpu = (secondCandidateGpuP95: number | undefined) => {
		let state = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, false), candidates[0].id);
		state = recordCalibrationResult(state, candidates[0], explicitMetrics(300, 6, d3d11Renderer));
		state = recordCalibrationResult(state, candidates[1], explicitMetrics(301, secondCandidateGpuP95, d3d11on12Renderer));
		for (const score of [304, 302]) state = recordCalibrationResult(state, candidates[0], explicitMetrics(score, 6, d3d11Renderer));
		for (const score of [303, 305]) state = recordCalibrationResult(state, candidates[1], explicitMetrics(score, secondCandidateGpuP95, d3d11on12Renderer));
		return finalizeCalibration(state);
	};
	assert.equal(runWithGpu(4).recommendedSelection?.candidate.id, 'd3d11on12:uncapped', 'lower measured GPU p95 wins the tie');
	assert.equal(runWithGpu(undefined).recommendedSelection?.candidate.id, 'd3d11:uncapped', 'without both measured, the first-persisted candidate keeps the tie');
});
test('the calibration budget bounds wall time and launches, then finalizes with partial evidence', () => {
	const candidates = createWindowsCandidates();
	let state = startCalibrationRun(prepareCalibrationState(undefined, signature, candidates, false), 0);
	assert.equal(isCalibrationBudgetExhausted(state, 89000), false);
	assert.equal(isCalibrationBudgetExhausted(state, 90001), true);
	assert.equal(clampCalibrationTrialDeadline(state, 99000), 90000);
	assert.equal(clampCalibrationTrialDeadline(state, 80000), 80000);
	for (let launch = 0; launch < CALIBRATION_MAX_LAUNCHES; launch++) {
		assert.equal(canStartCalibrationLaunch(state, 10), true, `launch ${launch + 1} should be allowed`);
		const admittedLaunch = tryRecordCalibrationLaunch(state, 10);
		assert.ok(admittedLaunch);
		state = admittedLaunch;
	}
	assert.equal(state.launchCount, CALIBRATION_MAX_LAUNCHES);
	assert.equal(canStartCalibrationLaunch(state, 10), false);
	assert.equal(tryRecordCalibrationLaunch(state, 10), undefined, 'a seventh launch must be stopped before incrementing');
	assert.equal(state.launchCount, CALIBRATION_MAX_LAUNCHES);
	assert.equal(isCalibrationBudgetExhausted(state, 10), true);
	state = recordCalibrationResult(state, candidates[0], metricsForScore(300));
	const finalized = finalizeCalibration(state);
	assert.equal(finalized.status, 'awaiting-confirmation');
	assert.equal(finalized.recommendedSelection?.candidate.id, 'd3d11on12:uncapped');
	assert.equal(getPendingCalibrationSlotIndex(finalized), undefined);
});
test('finalizing without any valid evidence recommends nothing rather than guessing', () => {
	const candidates = createWindowsCandidates();
	const state = startCalibrationRun(prepareCalibrationState(undefined, signature, candidates, false), 0);
	const finalized = finalizeCalibration(state);
	assert.equal(finalized.recommendedSelection, undefined);
	assert.equal(finalized.status, 'awaiting-confirmation');
});
