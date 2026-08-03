import assert from 'node:assert/strict';
import test from 'node:test';
import { BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG } from '../src/calibration-benchmark.ts';
import { buildCalibrationResultPage, buildCalibrationTrialPage } from '../src/calibration-window.ts';
import {
	CALIBRATION_VERSION,
	calculateCalibrationScore,
	calibrationSignaturesEqual,
	collectStableGraphicsDriverFields,
	completeCalibration,
	createCalibrationCandidates,
	createCalibrationSignature,
	finalizeCalibration,
	getPendingCalibrationCandidate,
	isMeaningfulCalibrationScoreWin,
	orchestrateCalibrationTrialRetry,
	parseCalibrationState,
	prepareCalibrationState,
	recordCalibrationResult,
	requestCalibrationRerun,
	startCalibrationRun,
	verifyEffectiveRendererBackend,
	type CalibrationMetrics,
	type CalibrationSignature,
	type CalibrationState
} from '../src/calibration.ts';
import { WORKLOAD_VERSION } from '../src/calibration-workload.ts';

const d3d11on12Renderer = 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, D3D11on12 vs_5_0 ps_5_0, D3D11)';
const stableMetrics: CalibrationMetrics = {
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
};

const signature = createCalibrationSignature('2.0.0', '44.0.0', '8086:46a6', 'driver-a');

function createWindowsCandidates() {
	return createCalibrationCandidates({
		currentBackend: 'd3d11on12',
		currentFramePolicy: 'uncapped',
		platform: 'win32',
		recommendedBackend: 'd3d11on12'
	});
}

function unstableMetrics(overrides: Partial<CalibrationMetrics> = {}): CalibrationMetrics {
	return {
		...stableMetrics,
		averageFps: 140,
		longFrameRatio: 0.1,
		onePercentLowFps: 30,
		p95FrameTimeMs: 30,
		worstFrameTimeMs: 90,
		...overrides
	};
}

function signatureWith(overrides: Partial<CalibrationSignature>): CalibrationSignature {
	return { ...signature, ...overrides };
}

/** Starts the run with a plan-creation time whose counterbalancing coin flip stages the wanted candidate first. */
function startRunWithOrder(state: CalibrationState, firstCandidateId: string): CalibrationState {
	for (let now = 1_000; now < 1_200; now++) {
		const started = startCalibrationRun(state, now);
		if (started.plan[0]?.candidateId === firstCandidateId) return started;
	}
	throw new Error(`Could not stage ${firstCandidateId} first`);
}

test('driver invalidation ignores backend-dependent GL renderer strings', () => {
	const d3d11 = collectStableGraphicsDriverFields({
		driverVendor: 'Intel',
		driverVersion: '32.0.101.9999',
		glRenderer: 'ANGLE D3D11'
	});
	const d3d11on12 = collectStableGraphicsDriverFields({
		driverVendor: 'Intel',
		driverVersion: '32.0.101.9999',
		glRenderer: 'ANGLE D3D11on12'
	});

	assert.deepEqual(d3d11, d3d11on12);
});

test('stages a short uncapped-first Windows candidate plan', () => {
	const candidates = createWindowsCandidates();

	assert.deepEqual(candidates.map(candidate => candidate.id), [
		'd3d11on12:uncapped',
		'default:uncapped'
	]);
	assert.equal(candidates.some(candidate => candidate.framePolicy === 'capped'), false);
});

test('never stages a capped (vsync) recovery candidate, even after severe uncapped instability', () => {
	const candidates = createWindowsCandidates();
	let healthyState = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, false), candidates[0].id);
	healthyState = recordCalibrationResult(healthyState, candidates[0], stableMetrics);
	assert.equal(healthyState.candidates.some(candidate => candidate.framePolicy === 'capped'), false);

	// A competitive preset never auto-applies vsync on synthetic evidence: instability that is
	// real gets caught by the real-gameplay validation loop, not traded for hidden latency.
	let unstableState = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, false), candidates[0].id);
	unstableState = recordCalibrationResult(unstableState, candidates[0], unstableMetrics());
	assert.equal(unstableState.candidates.some(candidate => candidate.framePolicy === 'capped'), false);
	assert.equal(unstableState.plan.some(slot => slot.stage === 'recovery'), false);
	assert.equal(getPendingCalibrationCandidate(unstableState)?.id, 'default:uncapped');
});

test('never schedules blocked or Windows-only profiles where unsupported', () => {
	const windowsCandidates = createCalibrationCandidates({
		blockedBackends: ['d3d11on12'],
		currentBackend: 'default',
		currentFramePolicy: 'uncapped',
		platform: 'win32',
		recommendedBackend: 'd3d11on12'
	});
	assert.equal(windowsCandidates.some(candidate => candidate.backend === 'd3d11on12'), false);

	const linuxCandidates = createCalibrationCandidates({
		currentBackend: 'default',
		currentFramePolicy: 'uncapped',
		platform: 'linux',
		recommendedBackend: 'd3d11'
	});
	assert.deepEqual(linuxCandidates.map(candidate => candidate.id), ['default:uncapped']);

	const macCandidates = createCalibrationCandidates({
		currentBackend: 'default',
		currentFramePolicy: 'uncapped',
		platform: 'darwin',
		recommendedBackend: 'd3d11on12'
	});
	assert.deepEqual(macCandidates.map(candidate => candidate.id), ['default:uncapped']);
});

test('verifies explicit effective renderer backends and treats default conservatively', () => {
	assert.deepEqual(
		verifyEffectiveRendererBackend('d3d11', 'ANGLE (NVIDIA, GeForce RTX, D3D11 vs_5_0 ps_5_0, D3D11)'),
		{ candidateBackend: 'd3d11', detectedBackend: 'd3d11', status: 'verified' }
	);
	assert.deepEqual(
		verifyEffectiveRendererBackend('d3d11on12', d3d11on12Renderer),
		{ candidateBackend: 'd3d11on12', detectedBackend: 'd3d11on12', status: 'verified' }
	);
	assert.deepEqual(
		verifyEffectiveRendererBackend('vulkan', 'ANGLE (AMD, Radeon RX, Vulkan 1.3.0)'),
		{ candidateBackend: 'vulkan', detectedBackend: 'vulkan', status: 'verified' }
	);
	assert.deepEqual(
		verifyEffectiveRendererBackend('d3d11on12', 'ANGLE (Intel, Iris Xe, D3D11 vs_5_0 ps_5_0, D3D11)'),
		{ candidateBackend: 'd3d11on12', detectedBackend: 'd3d11', status: 'mismatch' }
	);
	assert.deepEqual(
		verifyEffectiveRendererBackend('default', d3d11on12Renderer),
		{ candidateBackend: 'default', detectedBackend: 'd3d11on12', status: 'indeterminate' }
	);
	assert.deepEqual(
		verifyEffectiveRendererBackend('vulkan', 'Unknown renderer'),
		{ candidateBackend: 'vulkan', status: 'indeterminate' }
	);
});

test('scores factual throughput and consistency without a frame-policy penalty', () => {
	const unstable = unstableMetrics({
		averageFps: 330,
		eventLoopP95Ms: 5,
		longFrameRatio: 0.12,
		onePercentLowFps: 90,
		p95FrameTimeMs: 14,
		worstFrameTimeMs: 80
	});

	assert.ok(calculateCalibrationScore(stableMetrics) > calculateCalibrationScore(unstable));
	assert.equal(calculateCalibrationScore(stableMetrics, 'uncapped'), calculateCalibrationScore(stableMetrics, 'capped'));
});

test('records every first-pass trial and recommends the strongest measured backend', () => {
	const candidates = createWindowsCandidates();
	let state = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, false), candidates[0].id);
	assert.equal(getPendingCalibrationCandidate(state)?.id, candidates[0].id);

	state = recordCalibrationResult(state, candidates[0], stableMetrics);
	state = recordCalibrationResult(state, candidates[1], {
		...stableMetrics,
		averageFps: 220,
		onePercentLowFps: 180,
		p95FrameTimeMs: 5.5
	});
	state = finalizeCalibration(state);

	assert.equal(state.status, 'awaiting-confirmation');
	assert.equal(state.recommendedSelection?.candidate.id, candidates[0].id);
	state = completeCalibration(state, true);
	assert.equal(state.status, 'complete');
	assert.equal(state.activeSelection?.candidate.id, candidates[0].id);
});

test('does not accept an explicit candidate whose renderer reports another backend', () => {
	const candidates = createWindowsCandidates();
	let state = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, false), candidates[0].id);
	state = recordCalibrationResult(state, candidates[0], {
		...stableMetrics,
		averageFps: 400,
		onePercentLowFps: 350,
		webglRenderer: 'ANGLE (Intel, Iris Xe, D3D11 vs_5_0 ps_5_0, D3D11)'
	});
	state = recordCalibrationResult(state, candidates[1], {
		...stableMetrics,
		averageFps: 220,
		onePercentLowFps: 180
	});
	state = finalizeCalibration(state);

	assert.equal(state.results[0].backendVerification.status, 'mismatch');
	assert.match(state.results[0].failureReason ?? '', /requested d3d11on12/i);
	assert.equal(state.recommendedSelection?.candidate.backend, 'default');
});

test('recommends only uncapped profiles from the automatic path, even under instability', () => {
	const candidates = createWindowsCandidates();
	let state = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, false), candidates[0].id);
	state = recordCalibrationResult(state, candidates[0], unstableMetrics());
	state = recordCalibrationResult(state, candidates[1], unstableMetrics({
		averageFps: 130,
		webglRenderer: 'ANGLE (Intel, Iris Xe, Direct3D11 vs_5_0 ps_5_0, D3D11)'
	}));
	state = finalizeCalibration(state);

	assert.equal(state.recommendedSelection?.candidate.framePolicy, 'uncapped');
	assert.equal(state.candidates.some(candidate => candidate.framePolicy === 'capped'), false);
});

test('legacy persisted capped evidence is only used when no uncapped evidence exists', () => {
	// A resumed pre-removal plan can still hold capped results; they may win only by default.
	const candidates = createWindowsCandidates();
	let state = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, false), candidates[0].id);
	const legacyCapped = { backend: 'd3d11on12' as const, framePolicy: 'capped' as const, id: 'd3d11on12:capped' };
	state = { ...state, candidates: [...state.candidates, legacyCapped] };
	state = recordCalibrationResult(state, legacyCapped, {
		...stableMetrics,
		averageFps: 132,
		onePercentLowFps: 110,
		p95FrameTimeMs: 8
	});
	assert.equal(finalizeCalibration(state).recommendedSelection?.candidate.framePolicy, 'capped');

	state = recordCalibrationResult(state, candidates[0], stableMetrics);
	assert.equal(finalizeCalibration(state).recommendedSelection?.candidate.framePolicy, 'uncapped');
});

test('v3 signatures stamp the current benchmark and workload versions', () => {
	assert.equal(CALIBRATION_VERSION, 3);
	assert.equal(signature.benchmarkVersion, CALIBRATION_VERSION);
	assert.equal(signature.workloadVersion, WORKLOAD_VERSION);
	assert.equal(WORKLOAD_VERSION, 1);
});

test('treats app version as informational while relevant signature fields invalidate', () => {
	const appOnlyChange = signatureWith({ appVersion: '2.1.0' });
	assert.equal(calibrationSignaturesEqual(signature, appOnlyChange), true);
	assert.equal(calibrationSignaturesEqual(signature, signatureWith({ benchmarkVersion: CALIBRATION_VERSION + 1 })), false);
	assert.equal(calibrationSignaturesEqual(signature, signatureWith({ workloadVersion: signature.workloadVersion + 1 })), false);
	assert.equal(calibrationSignaturesEqual(signature, signatureWith({ electronVersion: '45.0.0' })), false);
	assert.equal(calibrationSignaturesEqual(signature, signatureWith({ hardwareFingerprint: '10de:2684' })), false);
	assert.equal(calibrationSignaturesEqual(signature, signatureWith({ driverFingerprint: 'driver-b' })), false);

	const candidates = createWindowsCandidates();
	const state = prepareCalibrationState(undefined, signature, candidates, false);
	const appUpdated = prepareCalibrationState(state, appOnlyChange, candidates, false);
	assert.notEqual(appUpdated, state);
	assert.equal(appUpdated.status, state.status);
	assert.equal(appUpdated.results, state.results);
	assert.equal(appUpdated.signature.appVersion, '2.1.0');
	assert.notEqual(prepareCalibrationState(state, signatureWith({ benchmarkVersion: CALIBRATION_VERSION + 1 }), candidates, false), state);
	assert.notEqual(prepareCalibrationState(state, signatureWith({ electronVersion: '45.0.0' }), candidates, false), state);
	assert.notEqual(prepareCalibrationState(state, signatureWith({ hardwareFingerprint: '10de:2684' }), candidates, false), state);
	assert.notEqual(prepareCalibrationState(state, signatureWith({ driverFingerprint: 'driver-b' }), candidates, false), state);
});

test('preserves a known-good selection for an explicit rerun but not a relevant signature change', () => {
	const candidates = createWindowsCandidates();
	let completed = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, true), candidates[0].id);
	completed = recordCalibrationResult(completed, candidates[0], stableMetrics);
	completed = completeCalibration(finalizeCalibration(completed), true);
	assert.ok(completed.activeSelection);

	const explicitRerun = prepareCalibrationState(requestCalibrationRerun(completed), signature, candidates, true);
	assert.equal(explicitRerun.activeSelection?.candidate.id, completed.activeSelection.candidate.id);

	const driverInvalidated = prepareCalibrationState(
		completed,
		signatureWith({ driverFingerprint: 'driver-b' }),
		candidates,
		true
	);
	assert.equal(driverInvalidated.activeSelection, undefined);
});

test('preserves backward-compatible parsing while an old benchmark version reruns', () => {
	const candidates = createWindowsCandidates();
	let state = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, false), candidates[0].id);
	state = recordCalibrationResult(state, candidates[0], stableMetrics);
	const legacyState = {
		...state,
		results: state.results.map(result => ({
			candidate: result.candidate,
			metrics: {
				averageFps: result.metrics.averageFps,
				eventLoopP95Ms: result.metrics.eventLoopP95Ms,
				longFrameRatio: result.metrics.longFrameRatio,
				onePercentLowFps: result.metrics.onePercentLowFps,
				p95FrameTimeMs: result.metrics.p95FrameTimeMs,
				sampleCount: result.metrics.sampleCount,
				success: result.metrics.success,
				webglRenderer: result.metrics.webglRenderer,
				worstFrameTimeMs: result.metrics.worstFrameTimeMs
			},
			score: result.score
		})),
		signature: { ...state.signature, benchmarkVersion: 1 }
	};
	const parsed = parseCalibrationState(legacyState);

	assert.ok(parsed);
	assert.equal(parsed.signature.benchmarkVersion, 1);
	assert.deepEqual(parsed.results[0].metrics.lowConfidenceReasons, []);
	assert.equal(parsed.results[0].metrics.eventLoopWorstMs, 0);
	assert.equal(parsed.results[0].backendVerification.status, 'verified');
	assert.notEqual(prepareCalibrationState(parsed, signature, candidates, false), parsed);
});

test('uses a meaningful-win threshold and keeps known-good active selection on marginal low-confidence evidence', () => {
	assert.equal(isMeaningfulCalibrationScoreWin(104.99, 100), false);
	assert.equal(isMeaningfulCalibrationScoreWin(106, 100), true);

	const candidates = createWindowsCandidates();
	let completed = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, true), candidates[0].id);
	completed = recordCalibrationResult(completed, candidates[0], stableMetrics);
	completed = completeCalibration(finalizeCalibration(completed), true);
	assert.equal(completed.activeSelection?.candidate.id, candidates[0].id);

	let rerun = prepareCalibrationState(requestCalibrationRerun(completed), signature, candidates, true);
	const marginalLowConfidenceMetrics: CalibrationMetrics = {
		...stableMetrics,
		averageFps: 306,
		lowConfidenceReasons: ['window-blurred'],
		onePercentLowFps: 252,
		p95FrameTimeMs: 3.95
	};
	rerun = recordCalibrationResult(rerun, candidates[1], marginalLowConfidenceMetrics);
	assert.equal(
		isMeaningfulCalibrationScoreWin(rerun.results[0].score, completed.activeSelection?.score ?? 0),
		false
	);
	rerun = finalizeCalibration(rerun);

	assert.deepEqual(rerun.results[0].metrics.lowConfidenceReasons, ['window-blurred']);
	assert.equal(rerun.recommendedSelection?.candidate.id, completed.activeSelection?.candidate.id);
});

test('allows warn-and-continue evidence to win only when the measured gain is meaningful', () => {
	const candidates = createWindowsCandidates();
	let completed = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, true), candidates[0].id);
	completed = recordCalibrationResult(completed, candidates[0], stableMetrics);
	completed = completeCalibration(finalizeCalibration(completed), true);

	let rerun = prepareCalibrationState(requestCalibrationRerun(completed), signature, candidates, true);
	rerun = recordCalibrationResult(rerun, candidates[1], {
		...stableMetrics,
		averageFps: 340,
		lowConfidenceReasons: ['window-resized', 'severe-event-loop-disturbance'],
		onePercentLowFps: 290,
		p95FrameTimeMs: 3.5,
		worstFrameTimeMs: 7
	});
	assert.equal(
		isMeaningfulCalibrationScoreWin(rerun.results[0].score, completed.activeSelection?.score ?? 0),
		true
	);
	rerun = finalizeCalibration(rerun);

	assert.equal(rerun.recommendedSelection?.candidate.id, candidates[1].id);
});

test('benchmark page reports contamination and keeps measured-loop UI work bounded', () => {
	const page = buildCalibrationTrialPage(createWindowsCandidates()[0], 1, 2, '<svg></svg>');

	assert.match(page, /UI_UPDATE_INTERVAL_MS = 200/);
	assert.match(page, /frameTimeSum \+= frameTime/);
	assert.match(page, /window\.addEventListener\('blur'/);
	assert.match(page, /document\.addEventListener\('visibilitychange'/);
	assert.match(page, /window\.addEventListener\('resize'/);
	assert.match(page, /webglcontextlost/);
	assert.match(page, /severe-event-loop-disturbance/);
	assert.match(page, /sortedFrames = \[\.\.\.frameTimes\]\.sort/);
	assert.doesNotMatch(page, /average\(frameTimes\)/);
	assert.doesNotMatch(page, /\.toFixed\(/);
	assert.doesNotMatch(page, /gl\.finish\(/);
});

test('trial page embeds the workload and completion-honest measurement modules', () => {
	const page = buildCalibrationTrialPage(createWindowsCandidates()[0], 1, 2, '<svg></svg>');

	// The unit-tested modules are serialized into the page, so page and tests cannot drift.
	assert.match(page, /const createWorkload = /);
	assert.match(page, /const createWorkloadSpin = /);
	assert.match(page, /const runBenchmarkTrial = /);
	assert.match(page, /"jsSpinIterations":2560000/);
	assert.match(page, /EXT_disjoint_timer_query_webgl2/);
	assert.match(page, /fenceSync/);
	assert.match(page, /"desynchronized":false/);
	assert.match(page, /"depth":true/);
	// Full-window canvas at real dimensions x devicePixelRatio, plus the CSS-only DOM overlay.
	assert.match(page, /window\.innerWidth \* devicePixelRatioValue/);
	assert.match(page, /overlay-gradient/);
	assert.match(page, /data-feed-row/);
	assert.doesNotMatch(page, /desynchronized: true/);
});

test('retry orchestration counts launched retries independently from rejected diagnostics', async () => {
	const candidates = createWindowsCandidates();
	let state = startRunWithOrder(
		prepareCalibrationState(undefined, signature, candidates, false),
		candidates[0].id
	);
	const firstRejected: CalibrationMetrics = {
		...stableMetrics,
		lowConfidenceReasons: ['window-blurred'],
		rejectionReasons: ['window-blurred'],
		sampleCount: 800
	};
	const secondRejected: CalibrationMetrics = {
		...stableMetrics,
		lowConfidenceReasons: ['power-state-changed'],
		onePercentLowFps: firstRejected.onePercentLowFps + 10,
		rejectionReasons: ['power-state-changed'],
		sampleCount: 700
	};
	const firstTrialAttempts: number[] = [];
	const firstTrial = await orchestrateCalibrationTrialRetry({
		candidate: candidates[0],
		getState: () => state,
		isRunTimeBudgetExhausted: () => false,
		persistState: nextState => {
			state = nextState;
		},
		runAttempt: async attempt => {
			firstTrialAttempts.push(attempt);
			return {
				aborted: false,
				metrics: attempt === 1 ? firstRejected : secondRejected
			};
		}
	});
	assert.deepEqual(firstTrialAttempts, [1, 2]);
	assert.equal(firstTrial.metrics, firstRejected);
	assert.equal(state.runRetriesUsed, 1);
	assert.equal(
		state.rejectedAttempts.length,
		2,
		'both rejected attempts remain available as diagnostics'
	);

	const laterRejected: CalibrationMetrics = {
		...stableMetrics,
		lowConfidenceReasons: ['window-blurred'],
		rejectionReasons: ['window-blurred']
	};
	const laterTrialAttempts: number[] = [];
	const laterTrial = await orchestrateCalibrationTrialRetry({
		candidate: candidates[1],
		getState: () => state,
		isRunTimeBudgetExhausted: () => false,
		persistState: nextState => {
			state = nextState;
		},
		runAttempt: async attempt => {
			laterTrialAttempts.push(attempt);
			return {
				aborted: false,
				metrics: attempt === 1 ? laterRejected : stableMetrics
			};
		}
	});
	assert.deepEqual(laterTrialAttempts, [1, 2]);
	assert.equal(laterTrial.metrics, stableMetrics);
	assert.equal(state.runRetriesUsed, 2);
	assert.equal(state.rejectedAttempts.length, 3);
});

test('retry orchestration fails closed when the retry-count transition cannot persist', async () => {
	const candidates = createWindowsCandidates();
	let state = startRunWithOrder(
		prepareCalibrationState(undefined, signature, candidates, false),
		candidates[0].id
	);
	const rejected: CalibrationMetrics = {
		...stableMetrics,
		lowConfidenceReasons: ['window-blurred'],
		rejectionReasons: ['window-blurred']
	};
	const attempts: number[] = [];

	await assert.rejects(
		orchestrateCalibrationTrialRetry({
			candidate: candidates[0],
			getState: () => state,
			isRunTimeBudgetExhausted: () => false,
			persistState: nextState => {
				if (nextState.runRetriesUsed > state.runRetriesUsed) {
					throw new Error('retry-count-write-failed');
				}
				state = nextState;
			},
			runAttempt: async attempt => {
				attempts.push(attempt);
				return {
					aborted: false,
					metrics: rejected
				};
			}
		}),
		/retry-count-write-failed/u
	);
	assert.deepEqual(attempts, [1]);
	assert.equal(state.runRetriesUsed, 0);
	assert.equal(state.rejectedAttempts.length, 1);
});

test('trial page renders retry messaging only for a second attempt', () => {
	const candidate = createWindowsCandidates()[0];
	const firstAttempt = buildCalibrationTrialPage(candidate, 1, 2, '<svg></svg>');
	const retryAttempt = buildCalibrationTrialPage(candidate, 1, 2, '<svg></svg>', { attempt: 2 });

	assert.doesNotMatch(firstAttempt, /class="pill retry"/);
	assert.match(retryAttempt, /class="pill retry"/);
	assert.match(retryAttempt, /running again/);
	assert.match(retryAttempt, /warning visible/);
});

test('result page displays low-confidence and backend-verification evidence without a latency claim', () => {
	const candidates = createWindowsCandidates();
	let state = prepareCalibrationState(undefined, signature, candidates, false);
	state = recordCalibrationResult(state, candidates[0], {
		...stableMetrics,
		lowConfidenceReasons: [
			'window-blurred',
			'document-visibility-changed',
			'window-resized',
			'webgl-context-lost',
			'severe-event-loop-disturbance'
		]
	});
	const result = state.results[0];
	const page = buildCalibrationResultPage([result], result, '<svg></svg>', false);

	assert.match(page, /Lower confidence/);
	assert.match(page, /window lost focus/);
	assert.match(page, /document visibility changed/);
	assert.match(page, /window was resized/);
	assert.match(page, /WebGL context loss/);
	assert.match(page, /severe event-loop disturbance/);
	assert.match(page, /Effective renderer verified as d3d11on12/);
	assert.match(page, /not an end-to-end input-latency measurement/);
	assert.doesNotMatch(page, /renderer-response estimate/);
});

test('result page reports GPU-timing status honestly and lists repeated trials', () => {
	const candidates = createWindowsCandidates();
	let state = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, false), candidates[0].id);
	state = recordCalibrationResult(state, candidates[0], {
		...stableMetrics,
		gpuTimeP50Ms: 3.1,
		gpuTimeP95Ms: 4.2,
		gpuTimingStatus: 'measured'
	});
	state = recordCalibrationResult(state, candidates[1], { ...stableMetrics, averageFps: 280, webglRenderer: 'Unknown renderer' });
	state = recordCalibrationResult(state, candidates[1], { ...stableMetrics, averageFps: 282, webglRenderer: 'Unknown renderer' });
	const finalized = finalizeCalibration(state);
	const page = buildCalibrationResultPage(finalized.results, finalized.recommendedSelection, '<svg></svg>', true);

	assert.match(page, /GPU completion measured directly \(p95 4\.20 ms\)/);
	assert.match(page, /GPU completion inferred from bounded-queue frame delivery/);
	assert.match(page, /2 trials, median shown/);
	assert.match(page, /Trial 1:/);
	assert.match(page, /Trial 2:/);
	assert.match(page, /provisionally/);
	assert.match(page, /automatically reverts to the previous profile/);
});

test('a fence-pacing artifact invalidates the comparison and keeps the current backend', () => {
	// Field reproduction (Iris Xe): the benchmark stalled 75% of ticks on d3d11on12 with ~2 ms of
	// measured GPU time, scored it 2x below default, and switched a machine whose real gameplay
	// runs 2x FASTER on d3d11on12. The artifact flag must keep the benchmark from deciding.
	const artifactMetrics: CalibrationMetrics = {
		...stableMetrics,
		averageFps: 106.29,
		contaminationFlags: [BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG],
		gpuTimeP50Ms: 1.6,
		gpuTimeP95Ms: 2,
		gpuTimingStatus: 'measured',
		longFrameRatio: 0.01,
		onePercentLowFps: 27.45,
		p95FrameTimeMs: 14.7,
		sampleCount: 555,
		stallRatio: 0.75,
		worstFrameTimeMs: 30
	};
	const defaultWinnerMetrics: CalibrationMetrics = {
		...stableMetrics,
		averageFps: 197.76,
		onePercentLowFps: 88.89,
		p95FrameTimeMs: 6.6,
		stallRatio: 0,
		webglRenderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, Direct3D11 vs_5_0 ps_5_0, D3D11)'
	};

	const candidates = createWindowsCandidates();
	let state = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, true), candidates[0].id);
	state = recordCalibrationResult(state, candidates[0], artifactMetrics);

	// Synthetic instability from the artifact must not stage a capped recovery launch.
	assert.equal(state.candidates.some(candidate => candidate.framePolicy === 'capped'), false);

	state = recordCalibrationResult(state, candidates[1], defaultWinnerMetrics);

	// Repeating trials reproduces a deterministic artifact; no ABAB stage may be scheduled.
	assert.equal(state.plan.some(slot => slot.stage === 'repeat'), false);

	const finalized = finalizeCalibration(state);
	assert.equal(finalized.recommendedSelection?.candidate.id, 'd3d11on12:uncapped');
});

test('the same slow trial without the artifact flag still lets the numeric winner switch backends', () => {
	const honestSlowMetrics: CalibrationMetrics = {
		...stableMetrics,
		averageFps: 106.29,
		longFrameRatio: 0.01,
		onePercentLowFps: 27.45,
		p95FrameTimeMs: 14.7,
		sampleCount: 555,
		worstFrameTimeMs: 30
	};
	const defaultWinnerMetrics: CalibrationMetrics = {
		...stableMetrics,
		averageFps: 197.76,
		onePercentLowFps: 88.89,
		p95FrameTimeMs: 6.6,
		webglRenderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, Direct3D11 vs_5_0 ps_5_0, D3D11)'
	};

	const candidates = createWindowsCandidates();
	let state = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, true), candidates[0].id);
	state = recordCalibrationResult(state, candidates[0], honestSlowMetrics);
	state = recordCalibrationResult(state, candidates[1], defaultWinnerMetrics);

	const finalized = finalizeCalibration(state);
	assert.equal(finalized.recommendedSelection?.candidate.id, 'default:uncapped');
});

test('non-Intel Windows machines get a real challenger, not ANGLE-D3D11 against itself', () => {
	// Chromium's `default` on Windows is already ANGLE-D3D11, so a d3d11 challenger would spend
	// the whole calibration budget comparing the incumbent against itself.
	const nvidiaCandidates = createCalibrationCandidates({
		currentBackend: 'default',
		currentFramePolicy: 'uncapped',
		platform: 'win32',
		recommendedBackend: 'default'
	});
	assert.deepEqual(nvidiaCandidates.map(candidate => candidate.id), [
		'default:uncapped',
		'd3d11on12:uncapped'
	]);

	// A quarantined d3d11on12 leaves a single-candidate plan instead of a tautological pair.
	const quarantinedCandidates = createCalibrationCandidates({
		blockedBackends: ['d3d11on12'],
		currentBackend: 'default',
		currentFramePolicy: 'uncapped',
		platform: 'win32',
		recommendedBackend: 'default'
	});
	assert.deepEqual(quarantinedCandidates.map(candidate => candidate.id), ['default:uncapped']);
});

test('the results page explains an artifact-affected verdict instead of claiming a measured win', () => {
	const artifactResult: CalibrationMetrics = {
		...stableMetrics,
		averageFps: 90.95,
		contaminationFlags: [BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG],
		onePercentLowFps: 20.7,
		p95FrameTimeMs: 16.3,
		stallRatio: 0.73
	};
	const candidates = createWindowsCandidates();
	let state = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, true), candidates[0].id);
	state = recordCalibrationResult(state, candidates[0], artifactResult);
	state = recordCalibrationResult(state, candidates[1], { ...stableMetrics, averageFps: 151.15, webglRenderer: 'ANGLE (Intel, Iris Xe, Direct3D11 vs_5_0 ps_5_0, D3D11)' });
	const finalized = finalizeCalibration(state);

	const page = buildCalibrationResultPage(finalized.results, finalized.recommendedSelection, '<svg></svg>', true);
	assert.ok(page.includes('could not fairly compare'), 'summary must explain the invalidated comparison');
	assert.ok(page.includes('Benchmark artifact'), 'the artifact card must be labeled');
	assert.ok(page.includes('not comparable'), 'the artifact score must not print as a number');
	assert.ok(!page.includes('The strongest measured profile'), 'must not claim a measured win');
});

test('an artifact-retained uncapped winner cannot be rescue-swapped to a capped profile', () => {
	// Exact field reproduction: default:uncapped trips the low-ratio instability heuristic and
	// stages default:capped recovery; d3d11on12 wins the uncapped bracket via the artifact
	// guard; the capped rescue must not then use the artifact numbers to swap in default:capped.
	const candidates = createWindowsCandidates(); // d3d11on12 current, default challenger
	let state = startRunWithOrder(prepareCalibrationState(undefined, signature, candidates, true), candidates[1].id);

	state = recordCalibrationResult(state, candidates[1], {
		...stableMetrics,
		averageFps: 127.96,
		longFrameRatio: 0.01,
		onePercentLowFps: 33.33,
		p95FrameTimeMs: 10.5,
		stallRatio: 0.01,
		webglRenderer: 'ANGLE (Intel, Iris Xe, Direct3D11 vs_5_0 ps_5_0, D3D11)'
	});
	// Even genuine instability no longer stages a capped (vsync) candidate.
	assert.deepEqual(state.candidates.map(candidate => candidate.id), [
		'd3d11on12:uncapped',
		'default:uncapped'
	]);

	state = recordCalibrationResult(state, candidates[0], {
		...stableMetrics,
		averageFps: 68.89,
		contaminationFlags: [BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG],
		gpuTimeP95Ms: 6.67,
		gpuTimingStatus: 'measured',
		longFrameRatio: 0.01,
		onePercentLowFps: 18.13,
		p95FrameTimeMs: 22.9,
		stallRatio: 0.75
	});
	const finalized = finalizeCalibration(state);
	assert.equal(finalized.recommendedSelection?.candidate.id, 'd3d11on12:uncapped');
});
