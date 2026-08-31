import assert from 'node:assert/strict';
import test from 'node:test';
import {
	BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG,
	BENCHMARK_FENCE_QUEUE_DEPTH,
	BENCHMARK_FENCE_STALL_ARTIFACT_RATIO,
	BENCHMARK_GPU_QUEUE_CONTAMINATION_FLAG,
	BENCHMARK_GPU_QUERY_POOL_SIZE,
	BENCHMARK_GPU_SAMPLE_FRAME_INTERVAL,
	BENCHMARK_RUN_RETRY_BUDGET,
	markBenchmarkTrialRejected,
	resolveBenchmarkAttempts,
	runBenchmarkTrial,
	shouldRetryBenchmarkTrial,
	type BenchmarkGl,
	type BenchmarkRejectionReason,
	type BenchmarkTimerQueryExt,
	type BenchmarkTrialConfig,
	type BenchmarkTrialResult
} from '../src/calibration-benchmark.ts';
const TIMER_EXT: BenchmarkTimerQueryExt = { GPU_DISJOINT_EXT: 0x8fbb, TIME_ELAPSED_EXT: 0x88bf };
interface FakeGlOptions {
	disjoint?: () => boolean;
	queryResultNs?: (issueIndex: number) => number;
	signalDelayTicks?: number;
	statusPollsRequired?: (frameIndex: number) => number;
}
interface FakeGl {
	currentTick: number;
	deletedSyncs: unknown[];
	fenceCount: number;
	gl: BenchmarkGl;
	queryIssueCount: number;
}
function createFakeGl(options: FakeGlOptions = {}): FakeGl {
	const fake: FakeGl = {
		currentTick: 0,
		deletedSyncs: [],
		fenceCount: 0,
		gl: undefined as unknown as BenchmarkGl,
		queryIssueCount: 0
	};
	const statusPolls = new Map<object, number>();
	const queryIssue = new Map<
		object,
		{
			issueIndex: number;
			issueTick: number;
		}
	>();
	fake.gl = {
		QUERY_RESULT: 0x8866,
		QUERY_RESULT_AVAILABLE: 0x8867,
		SIGNALED: 0x9119,
		SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
		SYNC_STATUS: 0x9114,
		beginQuery: (_target: number, query: object) => {
			queryIssue.set(query, { issueIndex: fake.queryIssueCount++, issueTick: fake.currentTick });
		},
		createQuery: () => ({ query: true }),
		deleteSync: (sync: unknown) => {
			fake.deletedSyncs.push(sync);
		},
		endQuery: () => {},
		fenceSync: () => ({ createdTick: fake.currentTick, frameIndex: fake.fenceCount++ }),
		flush: () => {},
		getParameter: (parameter: number) => (parameter === TIMER_EXT.GPU_DISJOINT_EXT ? Boolean(options.disjoint?.()) : undefined),
		getQueryParameter: (query: object, parameter: number) => {
			const issue = queryIssue.get(query);
			if (!issue) return parameter === 0x8867 ? false : 0;
			if (parameter === 0x8867) return fake.currentTick > issue.issueTick;
			return options.queryResultNs ? options.queryResultNs(issue.issueIndex) : 3000000;
		},
		getSyncParameter: (
			sync: {
				createdTick: number;
				frameIndex: number;
			},
			_parameter: number
		) => {
			if (options.signalDelayTicks !== undefined) {
				return fake.currentTick - sync.createdTick >= options.signalDelayTicks ? 0x9119 : 0x9118;
			}
			const polls = (statusPolls.get(sync) ?? 0) + 1;
			statusPolls.set(sync, polls);
			const required = options.statusPollsRequired ? options.statusPollsRequired(sync.frameIndex) : 1;
			return polls >= required ? 0x9119 : 0x9118;
		}
	} as unknown as BenchmarkGl;
	return fake;
}
const FAST_CONFIG: BenchmarkTrialConfig = {
	benchmarkMs: 500,
	minSamples: 10,
	warmupMaxMs: 300,
	warmupMinMs: 100,
	warmupSettleFrames: 3,
	warmupSettleRatio: 3
};
interface TrialDriverApi {
	contaminate(reason: BenchmarkRejectionReason): void;
	fireSampler(): void;
	tickIndex: number;
	time: number;
}
interface TrialDriverOptions {
	config?: Partial<BenchmarkTrialConfig>;
	ext?: BenchmarkTimerQueryExt | null;
	fake?: FakeGl;
	frameIntervalMs?: number | ((tickIndex: number) => number);
	onTick?: (api: TrialDriverApi) => void;
}
async function driveTrial(options: TrialDriverOptions = {}): Promise<{
	fake: FakeGl;
	result: BenchmarkTrialResult;
}> {
	const fake = options.fake ?? createFakeGl();
	let currentTime = 0;
	const frameQueue: ((timestamp: number) => void)[] = [];
	const samplerCallbacks: (() => void)[] = [];
	let contaminate: ((reason: BenchmarkRejectionReason) => void) | undefined;
	const promise = runBenchmarkTrial(
		{
			environment: { devicePixelRatio: 1.25, drawingBufferHeight: 1080, drawingBufferWidth: 1920, onBattery: false, refreshRateHz: 60 },
			getTimerQueryExt: () => (options.ext === undefined ? TIMER_EXT : options.ext),
			gl: fake.gl,
			now: () => currentTime,
			renderFrame: () => {},
			requestFrame: (callback) => {
				frameQueue.push(callback);
			},
			spin: () => 0,
			startSampler: (callback) => {
				samplerCallbacks.push(callback);
				return () => {};
			},
			subscribeContamination: (notify) => {
				contaminate = notify;
				return () => {};
			},
			webglRenderer: 'ANGLE (Intel, Iris Xe, D3D11 vs_5_0 ps_5_0, D3D11)'
		},
		{ ...FAST_CONFIG, ...options.config }
	);
	const interval = options.frameIntervalMs ?? 16.7;
	let tickIndex = 0;
	while (frameQueue.length > 0 && tickIndex < 10000) {
		const callback = frameQueue.shift();
		currentTime += typeof interval === 'function' ? interval(tickIndex) : interval;
		fake.currentTick = tickIndex;
		options.onTick?.({
			contaminate: (reason) => contaminate?.(reason),
			fireSampler: () => {
				for (const sampler of samplerCallbacks) sampler();
			},
			tickIndex,
			time: currentTime
		});
		callback(currentTime);
		tickIndex++;
	}
	return { fake, result: await promise };
}
test('missing timer-query extension reports unsupported while the fence path stays active', async () => {
	const { fake, result } = await driveTrial({ ext: null });
	assert.equal(result.gpuTimingStatus, 'unsupported');
	assert.equal(result.gpuSampleCount, 0);
	assert.equal(result.gpuTimeP50Ms, undefined);
	assert.equal(result.gpuTimeP95Ms, undefined);
	assert.equal(result.rejected, false);
	assert.equal(result.success, true);
	assert.ok(result.sampleCount >= FAST_CONFIG.minSamples);
	assert.ok(fake.fenceCount > result.sampleCount, 'expected a fence per submitted frame');
	assert.ok(fake.deletedSyncs.length > 0, 'expected signaled fences to be deleted');
	assert.equal(fake.queryIssueCount, 0);
});
test('healthy timer queries produce measured GPU percentiles', async () => {
	const { result } = await driveTrial();
	assert.equal(result.gpuTimingStatus, 'measured');
	assert.ok(result.gpuSampleCount > 0);
	assert.ok(result.gpuTimeP50Ms > 2.9 && result.gpuTimeP50Ms < 3.1, `p50 ${result.gpuTimeP50Ms}`);
	assert.deepEqual(result.contaminationFlags, []);
	assert.equal(result.rejected, false);
});
test('persistent disjoint discards samples and demotes GPU timing without rejecting the trial', async () => {
	const { result } = await driveTrial({ fake: createFakeGl({ disjoint: () => true }) });
	assert.equal(result.gpuTimingStatus, 'unreliable');
	assert.equal(result.gpuSampleCount, 0);
	assert.ok(result.gpuDisjointDiscardCount > result.sampleCount * 0.05);
	assert.equal(result.gpuTimeP50Ms, undefined);
	assert.equal(result.rejected, false, 'disjoint alone must not reject the trial');
	assert.equal(result.success, true);
	assert.ok(result.sampleCount >= FAST_CONFIG.minSamples, 'frame-interval evidence must stand');
});
test('excessive disjoint plus disturbed frame evidence rejects with gpu-disjoint-excessive', async () => {
	const { result } = await driveTrial({
		fake: createFakeGl({ disjoint: () => true }),
		onTick: (api) => {
			if (api.tickIndex === 20) api.contaminate('window-blurred');
		}
	});
	assert.equal(result.rejected, true);
	assert.ok(result.rejectionReasons.includes('window-blurred'));
	assert.ok(result.rejectionReasons.includes('gpu-disjoint-excessive'));
});
test('implausible GPU samples beyond twenty percent demote timing to unreliable', async () => {
	const { result } = await driveTrial({ fake: createFakeGl({ queryResultNs: () => 200000000 }) });
	assert.equal(result.gpuTimingStatus, 'unreliable');
	assert.ok(result.gpuImplausibleCount > 0);
	assert.equal(result.gpuSampleCount, 0);
	assert.equal(result.rejected, false);
});
test('sub-threshold GPU samples also count as implausible', async () => {
	const { result } = await driveTrial({ fake: createFakeGl({ queryResultNs: () => 10000 }) });
	assert.equal(result.gpuTimingStatus, 'unreliable');
	assert.ok(result.gpuImplausibleCount > 0);
});
test('queued GPU work beyond the frame budget raises the submission-masking flag', async () => {
	const { result } = await driveTrial({ fake: createFakeGl({ queryResultNs: () => 30000000 }) });
	assert.equal(result.gpuTimingStatus, 'measured');
	assert.ok(result.gpuTimeP95Ms > result.p95FrameTimeMs * 1.3);
	assert.deepEqual(result.contaminationFlags, [BENCHMARK_GPU_QUEUE_CONTAMINATION_FLAG]);
	assert.equal(result.rejected, false);
});
test('an unsignaled fence stalls submission and elongates the recorded interval', async () => {
	const stalledFrame = 12;
	const extraPolls = 3;
	const { fake, result } = await driveTrial({
		fake: createFakeGl({ statusPollsRequired: (frameIndex) => (frameIndex === stalledFrame ? extraPolls : 1) })
	});
	assert.equal(result.stalledTicks, extraPolls - 1);
	assert.ok(result.stallRatio > 0);
	assert.ok(result.totalTicks > result.sampleCount);
	assert.ok(result.worstFrameTimeMs >= 16.7 * extraPolls - 0.1, `worst ${result.worstFrameTimeMs}`);
	assert.ok(fake.deletedSyncs.length > 0);
	assert.equal(result.rejected, false);
});
test('the query pool never grows beyond its fixed size', async () => {
	const fake = createFakeGl();
	const baseGetQueryParameter = fake.gl.getQueryParameter.bind(fake.gl);
	fake.gl.getQueryParameter = (query: unknown, parameter: number) => (parameter === 0x8867 ? false : baseGetQueryParameter(query, parameter));
	let created = 0;
	const baseCreateQuery = fake.gl.createQuery.bind(fake.gl);
	fake.gl.createQuery = () => {
		created++;
		return baseCreateQuery();
	};
	await driveTrial({ config: { benchmarkMs: 2000 }, fake });
	assert.equal(created, BENCHMARK_GPU_QUERY_POOL_SIZE);
});
test('GPU timing is sampled, not instrumented on every frame', async () => {
	const fake = createFakeGl();
	let queriesBegun = 0;
	const baseBeginQuery = fake.gl.beginQuery.bind(fake.gl);
	fake.gl.beginQuery = (target: number, query: object) => {
		queriesBegun++;
		baseBeginQuery(target, query);
	};
	const { result } = await driveTrial({ config: { benchmarkMs: 2000 }, fake });
	assert.ok(result.sampleCount > BENCHMARK_GPU_SAMPLE_FRAME_INTERVAL * 4, `expected a long enough trial, got ${result.sampleCount} frames`);
	const expected = result.sampleCount / BENCHMARK_GPU_SAMPLE_FRAME_INTERVAL;
	assert.ok(queriesBegun >= expected - 2 && queriesBegun <= expected + 2, `expected ~${expected.toFixed(1)} sampled frames out of ${result.sampleCount}, got ${queriesBegun}`);
	assert.equal(result.gpuTimingStatus, 'measured');
	assert.ok(result.gpuSampleCount > 0);
});
test('context loss rejects the trial and abandons fence objects without deleting them', async () => {
	let deletionsAtLoss = -1;
	const fake = createFakeGl();
	const { result } = await driveTrial({
		fake,
		onTick: (api) => {
			if (api.tickIndex === 15) {
				api.contaminate('webgl-context-lost');
				deletionsAtLoss = fake.deletedSyncs.length;
			}
		}
	});
	assert.equal(result.rejected, true);
	assert.ok(result.rejectionReasons.includes('webgl-context-lost'));
	assert.equal(fake.deletedSyncs.length, deletionsAtLoss, 'no fence deletion may happen after context loss');
});
test('each contamination signal rejects the trial with its reason', async () => {
	const reasons: BenchmarkRejectionReason[] = ['window-blurred', 'document-visibility-changed', 'window-resized'];
	for (const reason of reasons) {
		const { result } = await driveTrial({
			onTick: (api) => {
				if (api.tickIndex === 3) api.contaminate(reason);
			}
		});
		assert.equal(result.rejected, true, `${reason} during warmup must reject`);
		assert.deepEqual(result.rejectionReasons, [reason]);
		assert.equal(result.success, true, 'metrics remain recorded for diagnostics');
	}
});
test('warmup timer lateness cannot contaminate the first measured sampler callback', async () => {
	const { result } = await driveTrial({
		onTick: (api) => {
			if (api.tickIndex === 0) api.fireSampler();
			if (api.tickIndex === 7) api.fireSampler();
		}
	});
	assert.equal(result.rejected, false);
	assert.equal(result.eventLoopWorstMs, 0);
});
test('timer starvation without a severe frame gap remains diagnostic evidence', async () => {
	const { result } = await driveTrial({
		onTick: (api) => {
			if (api.tickIndex === 25) api.fireSampler();
			if (api.tickIndex === 33) api.fireSampler();
		}
	});
	assert.equal(result.rejected, false);
	assert.deepEqual(result.rejectionReasons, []);
	assert.ok(result.eventLoopWorstMs >= 100);
	assert.ok(result.worstFrameTimeMs < 100);
});
test('GPU fence stalls cannot corroborate timer starvation while animation callbacks stay regular', async () => {
	const stalledFrame = 12;
	const pollsRequired = 7;
	const { result } = await driveTrial({
		fake: createFakeGl({
			statusPollsRequired: (frameIndex) => (frameIndex === stalledFrame ? pollsRequired : 1)
		}),
		onTick: (api) => {
			if (api.tickIndex === 25) api.fireSampler();
			if (api.tickIndex === 33) api.fireSampler();
		}
	});
	assert.ok(result.eventLoopWorstMs >= 100);
	assert.ok(result.worstFrameTimeMs >= 100, 'the fence stall must stretch submitted-frame evidence');
	assert.equal(result.stalledTicks, pollsRequired - 1);
	assert.equal(result.rejected, false);
	assert.deepEqual(result.rejectionReasons, []);
});
test('severe event-loop lateness corroborated by a severe frame gap rejects the trial', async () => {
	const { result } = await driveTrial({
		config: {
			benchmarkMs: 600,
			minSamples: 2,
			warmupSettleFrames: 1
		},
		frameIntervalMs: 120,
		onTick: (api) => {
			if (api.tickIndex === 4 || api.tickIndex === 5) api.fireSampler();
		}
	});
	assert.equal(result.rejected, true);
	assert.deepEqual(result.rejectionReasons, ['severe-event-loop-disturbance']);
	assert.ok(result.eventLoopWorstMs >= 100);
	assert.ok(result.worstFrameTimeMs >= 100);
});
test('an exact-threshold callback gap corroborates severe timer starvation', async () => {
	const { result } = await driveTrial({
		frameIntervalMs: (tickIndex) => (tickIndex === 25 ? 100 : 20),
		onTick: (api) => {
			if (api.tickIndex === 18 || api.tickIndex === 25) api.fireSampler();
		}
	});
	assert.ok(result.eventLoopWorstMs >= 100);
	assert.ok(result.worstFrameTimeMs >= 100);
	assert.equal(result.rejected, true);
	assert.ok(result.rejectionReasons.includes('severe-event-loop-disturbance'));
});
test('sub-threshold timer lateness does not reject an exact-threshold callback gap', async () => {
	const { result } = await driveTrial({
		frameIntervalMs: (tickIndex) => (tickIndex === 25 ? 100 : 20),
		onTick: (api) => {
			if (api.tickIndex === 24 || api.tickIndex === 25) api.fireSampler();
		}
	});
	assert.ok(result.eventLoopWorstMs < 100);
	assert.ok(result.worstFrameTimeMs >= 100);
	assert.equal(result.rejected, false);
	assert.deepEqual(result.rejectionReasons, []);
});
test('callback intervals just below the severe threshold do not corroborate timer starvation', async () => {
	const { result } = await driveTrial({
		frameIntervalMs: (tickIndex) => (tickIndex === 25 ? 99.9 : 16.7),
		onTick: (api) => {
			if (api.tickIndex === 18 || api.tickIndex === 25) api.fireSampler();
		}
	});
	assert.ok(result.eventLoopWorstMs >= 100);
	assert.ok(result.worstFrameTimeMs < 100);
	assert.equal(result.rejected, false);
	assert.deepEqual(result.rejectionReasons, []);
});
test('callback gaps of one second or longer corroborate severe timer starvation', async () => {
	for (const callbackGapMs of [1000, 1200]) {
		const { result } = await driveTrial({
			frameIntervalMs: (tickIndex) => (tickIndex === 25 ? callbackGapMs : 16.7),
			onTick: (api) => {
				if (api.tickIndex === 24 || api.tickIndex === 25) api.fireSampler();
			}
		});
		assert.ok(result.eventLoopWorstMs >= 100, `${callbackGapMs} ms timer evidence`);
		assert.equal(result.rejected, true, `${callbackGapMs} ms callback gap must reject`);
		assert.ok(result.rejectionReasons.includes('severe-event-loop-disturbance'));
	}
});
test('too few submitted frames reject the trial as insufficient-samples', async () => {
	const { result } = await driveTrial({ frameIntervalMs: 100 });
	assert.ok(result.sampleCount < FAST_CONFIG.minSamples);
	assert.equal(result.rejected, true);
	assert.ok(result.rejectionReasons.includes('insufficient-samples'));
});
test('a missing GL context fails plainly instead of requesting a retry', async () => {
	const result = await runBenchmarkTrial(
		{
			environment: { devicePixelRatio: 1, drawingBufferHeight: 0, drawingBufferWidth: 0 },
			getTimerQueryExt: () => TIMER_EXT,
			gl: null,
			now: () => 0,
			renderFrame: () => {},
			requestFrame: () => {},
			spin: () => 0,
			startSampler: () => () => {},
			subscribeContamination: () => () => {},
			webglRenderer: ''
		},
		FAST_CONFIG
	);
	assert.equal(result.success, false);
	assert.equal(result.rejected, false);
	assert.equal(result.gpuTimingStatus, 'unsupported');
});
test('main-process power flips can be applied to a finished trial', async () => {
	const { result } = await driveTrial();
	const marked = markBenchmarkTrialRejected(result, 'power-state-changed');
	assert.equal(marked.rejected, true);
	assert.deepEqual(marked.rejectionReasons, ['power-state-changed']);
	assert.equal(markBenchmarkTrialRejected(marked, 'power-state-changed'), marked);
});
test('rejected trials retry once immediately, bounded by the global retry budget', async () => {
	const { result: clean } = await driveTrial();
	const rejected = markBenchmarkTrialRejected(clean, 'window-blurred');
	assert.equal(shouldRetryBenchmarkTrial(rejected, 1, 0), true);
	assert.equal(shouldRetryBenchmarkTrial(rejected, 2, 0), false, 'only one retry per trial');
	assert.equal(shouldRetryBenchmarkTrial(rejected, 1, BENCHMARK_RUN_RETRY_BUDGET), false, 'global retry budget exhausted');
	assert.equal(shouldRetryBenchmarkTrial(clean, 1, 0), false, 'clean trials never retry');
});
test('twice-rejected trials resolve to the better attempt as warn-and-continue evidence', async () => {
	const { result: clean } = await driveTrial();
	const weaker = markBenchmarkTrialRejected({ ...clean, sampleCount: 20 }, 'window-blurred');
	const stronger = markBenchmarkTrialRejected(clean, 'document-visibility-changed');
	const bothRejected = resolveBenchmarkAttempts([weaker, stronger]);
	assert.equal(bothRejected.downgradedToLowConfidence, true);
	assert.equal(bothRejected.result, stronger);
	const retrySucceeded = resolveBenchmarkAttempts([weaker, clean]);
	assert.equal(retrySucceeded.downgradedToLowConfidence, false);
	assert.equal(retrySucceeded.result, clean);
});
test('fence queue depth matches the v4 pacing freeze', () => {
	assert.equal(BENCHMARK_FENCE_QUEUE_DEPTH, 6);
});
test('the depth-6 horizon absorbs the measured D3D11on12 fence observability latency', async () => {
	const { result } = await driveTrial({ fake: createFakeGl({ signalDelayTicks: BENCHMARK_FENCE_QUEUE_DEPTH }) });
	assert.equal(result.stalledTicks, 0);
	assert.equal(result.stallRatio, 0);
	assert.equal(result.rejected, false);
	assert.ok(result.sampleCount >= FAST_CONFIG.minSamples);
});
test('fence latency beyond the depth-6 horizon still trips the gate', async () => {
	const { result } = await driveTrial({ fake: createFakeGl({ signalDelayTicks: BENCHMARK_FENCE_QUEUE_DEPTH + 1 }) });
	assert.ok(result.stalledTicks > 0, 'the gate must still bound in-flight work');
	assert.ok(result.stallRatio > 0);
});
test('flags fence-pacing artifacts when stalls dominate while the GPU has headroom', async () => {
	const { result } = await driveTrial({
		config: { benchmarkMs: 1500 },
		fake: createFakeGl({ queryResultNs: () => 2000000, statusPollsRequired: () => 3 })
	});
	assert.equal(result.rejected, false);
	assert.ok(result.stallRatio > BENCHMARK_FENCE_STALL_ARTIFACT_RATIO);
	assert.equal(result.gpuTimingStatus, 'measured');
	assert.ok(result.contaminationFlags.includes(BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG));
});
test('does not flag fence pacing when the GPU is genuinely the bottleneck', async () => {
	const { result } = await driveTrial({
		config: { benchmarkMs: 1500 },
		fake: createFakeGl({ queryResultNs: () => 40000000, statusPollsRequired: () => 3 })
	});
	assert.ok(result.stallRatio > BENCHMARK_FENCE_STALL_ARTIFACT_RATIO);
	assert.equal(result.contaminationFlags.includes(BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG), false);
});
test('does not flag fence pacing on a healthy trial without stalls', async () => {
	const { result } = await driveTrial({ config: { benchmarkMs: 1500 } });
	assert.equal(result.stallRatio, 0);
	assert.equal(result.contaminationFlags.includes(BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG), false);
});
