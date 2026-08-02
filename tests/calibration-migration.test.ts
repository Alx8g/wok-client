import assert from 'node:assert/strict';
import test from 'node:test';
import {
	calibrationResumeRequired,
	createCalibrationCandidates,
	createCalibrationSignature,
	finalizeCalibration,
	getPendingCalibrationCandidate,
	parseCalibrationState,
	prepareCalibrationState,
	recordCalibrationResult,
	requestCalibrationRerun,
	startCalibrationRun,
	type CalibrationCandidate,
	type CalibrationMetrics,
	type CalibrationResult,
	type CalibrationState
} from '../src/calibration.ts';
import { WORKLOAD_VERSION } from '../src/calibration-workload.ts';

const d3d11on12Renderer = 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, D3D11on12 vs_5_0 ps_5_0, D3D11)';
const currentSignature = createCalibrationSignature('2.1.0', '44.0.0', '8086:46a6', 'driver-a');

function createWindowsCandidates(): CalibrationCandidate[] {
	return createCalibrationCandidates({
		currentBackend: 'd3d11on12',
		currentFramePolicy: 'uncapped',
		platform: 'win32',
		recommendedBackend: 'd3d11on12'
	});
}

function versionOneMetrics(averageFps: number, webglRenderer: string): Record<string, unknown> {
	return {
		averageFps,
		eventLoopP95Ms: 0.8,
		longFrameRatio: 0,
		onePercentLowFps: averageFps * 0.85,
		p95FrameTimeMs: 4,
		sampleCount: 700,
		success: true,
		webglRenderer,
		worstFrameTimeMs: 8
	};
}

function versionOneDocument(): Record<string, unknown> {
	const winner = {
		candidate: { backend: 'd3d11on12', framePolicy: 'uncapped', id: 'd3d11on12:uncapped' },
		metrics: versionOneMetrics(300, d3d11on12Renderer),
		score: 268
	};
	const runnerUp = {
		candidate: { backend: 'default', framePolicy: 'uncapped', id: 'default:uncapped' },
		metrics: versionOneMetrics(220, 'Unknown renderer'),
		score: 197
	};
	return {
		activeSelection: winner,
		candidates: [winner.candidate, runnerUp.candidate],
		competitiveModeWasEnabled: true,
		completedAt: 900,
		recommendedSelection: winner,
		rerunRequested: false,
		results: [winner, runnerUp],
		signature: {
			appVersion: '2.0.0',
			benchmarkVersion: 2,
			driverFingerprint: 'driver-a',
			electronVersion: '44.0.0',
			hardwareFingerprint: '8086:46a6'
		},
		status: 'complete',
		updatedAt: 1_000,
		version: 1
	};
}

test('a version-1 document upgrades to a single-trial plan with the workload sentinel', () => {
	const parsed = parseCalibrationState(versionOneDocument());

	assert.ok(parsed);
	assert.equal(parsed.version, 2);
	assert.equal(parsed.status, 'complete');
	// benchmarkVersion 2 predates the workload concept: stamped with sentinel 0, never 1.
	assert.equal(parsed.signature.workloadVersion, 0);
	assert.equal(parsed.confirmation, 'unwatched');
	assert.deepEqual(parsed.plan, [
		{ candidateId: 'd3d11on12:uncapped', launchGroup: 1, stage: 'screen' },
		{ candidateId: 'default:uncapped', launchGroup: 2, stage: 'screen' }
	]);
	assert.deepEqual(parsed.results.map(result => result.slotIndex), [0, 1]);
	assert.equal(parsed.launchCount, 2);
	assert.equal(parsed.runRetriesUsed, 0);
	assert.equal(parsed.activeSelection?.candidate.id, 'd3d11on12:uncapped');
	assert.equal(parsed.activeSelection?.metrics.workloadVersion, 0);
	assert.deepEqual(parsed.fieldRejectedCandidateIds, []);
	assert.deepEqual(parsed.rejectedAttempts, []);
	assert.equal(calibrationResumeRequired(parsed), false, 'a completed upgrade must never block startup');
});

test('a benchmark-1 era document also parses with the sentinel workload version', () => {
	const document = versionOneDocument();
	(document.signature as Record<string, unknown>).benchmarkVersion = 1;
	const parsed = parseCalibrationState(document);
	assert.ok(parsed);
	assert.equal(parsed.signature.workloadVersion, 0);
});

test('a benchmark-only version bump retains the completed state as stale without a rerun', () => {
	const parsed = parseCalibrationState(versionOneDocument());
	assert.ok(parsed);
	const candidates = createWindowsCandidates();

	const prepared = prepareCalibrationState(parsed, currentSignature, candidates, true);
	assert.equal(prepared.signatureStale, true);
	assert.equal(prepared.status, 'complete');
	assert.equal(prepared.activeSelection?.candidate.id, 'd3d11on12:uncapped', 'the confirmed selection keeps applying');
	assert.equal(prepared.signature.benchmarkVersion, 2, 'the stale signature stays honest about what produced the results');
	assert.equal(calibrationResumeRequired(prepared), false);
	assert.equal(prepareCalibrationState(prepared, currentSignature, candidates, true), prepared, 'stale marking is idempotent');
});

test('an explicit rerun of a stale calibration resets and starts a fresh consented plan', () => {
	const parsed = parseCalibrationState(versionOneDocument());
	assert.ok(parsed);
	const candidates = createWindowsCandidates();
	const stale = prepareCalibrationState(parsed, currentSignature, candidates, true);

	const rerun = prepareCalibrationState(requestCalibrationRerun(stale), currentSignature, candidates, true);
	assert.equal(rerun.status, 'running');
	assert.equal(rerun.signature.benchmarkVersion, currentSignature.benchmarkVersion);
	assert.equal(rerun.signature.workloadVersion, WORKLOAD_VERSION);
	assert.equal(rerun.activeSelection, undefined, 'cross-version selections never carry their stale score into a fresh run');
	assert.equal(rerun.plan.length, 2);
	assert.equal(calibrationResumeRequired(rerun), true);
});

test('a hardware change resets to uncalibrated without blocking startup', () => {
	const parsed = parseCalibrationState(versionOneDocument());
	assert.ok(parsed);
	const candidates = createWindowsCandidates();
	const hardwareChanged = createCalibrationSignature('2.1.0', '44.0.0', '10de:2684', 'driver-a');

	const resetState = prepareCalibrationState(parsed, hardwareChanged, candidates, true);
	assert.equal(resetState.status, 'uncalibrated');
	assert.equal(resetState.activeSelection, undefined);
	assert.equal(getPendingCalibrationCandidate(resetState), undefined);
	assert.equal(calibrationResumeRequired(resetState), false);
});

test('cross-workload-version scores are never compared numerically', () => {
	const candidates = createWindowsCandidates();
	const cleanMetrics = (workloadVersion: number): CalibrationMetrics => ({
		averageFps: 250,
		eventLoopP95Ms: 0.8,
		eventLoopWorstMs: 3,
		longFrameRatio: 0,
		lowConfidenceReasons: [],
		onePercentLowFps: 250,
		p95FrameTimeMs: 4,
		sampleCount: 800,
		success: true,
		webglRenderer: d3d11on12Renderer,
		workloadVersion,
		worstFrameTimeMs: 4
	});
	const staleActive: CalibrationResult = {
		backendVerification: { candidateBackend: 'd3d11on12', detectedBackend: 'd3d11on12', status: 'verified' },
		candidate: candidates[0],
		metrics: cleanMetrics(0),
		score: 100
	};

	let state = startCalibrationRun(prepareCalibrationState(undefined, currentSignature, candidates, true), 0);
	state = { ...state, activeSelection: staleActive };
	state = recordCalibrationResult(state, candidates[1], {
		...cleanMetrics(WORKLOAD_VERSION),
		averageFps: 320,
		onePercentLowFps: 320,
		webglRenderer: 'Unknown renderer'
	});

	// The challenger hugely outscores the stale selection, but a stale score is not numeric
	// evidence: the known-good incumbent competes only through the tie preferences and is kept.
	const finalized = finalizeCalibration(state);
	assert.equal(finalized.recommendedSelection?.candidate.id, candidates[0].id);

	// With comparable workload versions the identical challenger wins meaningfully.
	let comparableState = startCalibrationRun(prepareCalibrationState(undefined, currentSignature, candidates, true), 0);
	comparableState = { ...comparableState, activeSelection: { ...staleActive, metrics: cleanMetrics(WORKLOAD_VERSION) } };
	comparableState = recordCalibrationResult(comparableState, candidates[1], {
		...cleanMetrics(WORKLOAD_VERSION),
		averageFps: 320,
		onePercentLowFps: 320,
		webglRenderer: 'Unknown renderer'
	});
	const comparableFinalized = finalizeCalibration(comparableState);
	assert.equal(comparableFinalized.recommendedSelection?.candidate.id, candidates[1].id);
});

test('a mid-run version-1 document parses but resumes nothing after the signature reset', () => {
	const document = versionOneDocument();
	document.status = 'running';
	document.completedAt = undefined;
	document.activeSelection = undefined;
	document.recommendedSelection = undefined;
	document.results = (document.results as unknown[]).slice(0, 1);

	const parsed = parseCalibrationState(document);
	assert.ok(parsed);
	assert.equal(parsed.status, 'running');

	const resetState = prepareCalibrationState(parsed, currentSignature, createWindowsCandidates(), true);
	assert.equal(resetState.status, 'uncalibrated');
	assert.equal(calibrationResumeRequired(resetState), false);
});

test('version-2 states survive a JSON persistence round trip byte-for-byte', () => {
	const candidates = createWindowsCandidates();
	let state: CalibrationState = startCalibrationRun(prepareCalibrationState(undefined, currentSignature, candidates, true), 42);
	state = recordCalibrationResult(state, getPendingCalibrationCandidate(state) as CalibrationCandidate, {
		averageFps: 300,
		eventLoopP95Ms: 0.8,
		eventLoopWorstMs: 3,
		longFrameRatio: 0,
		lowConfidenceReasons: [],
		onePercentLowFps: 250,
		p95FrameTimeMs: 4,
		sampleCount: 800,
		success: true,
		webglRenderer: d3d11on12Renderer,
		worstFrameTimeMs: 8
	});

	const reloaded = parseCalibrationState(JSON.parse(JSON.stringify(state)));
	assert.deepEqual(reloaded, state);
});