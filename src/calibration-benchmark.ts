export const BENCHMARK_GPU_QUERY_POOL_SIZE = 8;
export const BENCHMARK_GPU_SAMPLE_FRAME_INTERVAL = 8;
export const BENCHMARK_FENCE_QUEUE_DEPTH = 6;
export const BENCHMARK_FENCE_RING_SIZE = BENCHMARK_FENCE_QUEUE_DEPTH + 1;
export const BENCHMARK_GPU_DISJOINT_DEMOTION_RATIO = 0.05;
export const BENCHMARK_GPU_IMPLAUSIBLE_DEMOTION_RATIO = 0.2;
export const BENCHMARK_GPU_SAMPLE_MIN_MS = 0.05;
export const BENCHMARK_GPU_SAMPLE_MAX_FRAME_RATIO = 4;
export const BENCHMARK_GPU_QUEUE_FLAG_RATIO = 1.3;
export const BENCHMARK_FENCE_STALL_ARTIFACT_RATIO = 0.5;
export const BENCHMARK_FENCE_STALL_GPU_HEADROOM_RATIO = 0.5;
export const BENCHMARK_EVENT_LOOP_SAMPLE_MS = 16;
export const BENCHMARK_SEVERE_EVENT_LOOP_DELAY_MS = 100;
export const BENCHMARK_LONG_FRAME_MS = 33.34;
export const BENCHMARK_TRIAL_RETRY_LIMIT = 1;
export const BENCHMARK_RUN_RETRY_BUDGET = 2;
export type BenchmarkGpuTimingStatus = 'measured' | 'unsupported' | 'unreliable';
export const BENCHMARK_REJECTION_REASONS = [
	'window-blurred',
	'document-visibility-changed',
	'window-resized',
	'webgl-context-lost',
	'gpu-disjoint-excessive',
	'severe-event-loop-disturbance',
	'power-state-changed',
	'insufficient-samples'
] as const;
export type BenchmarkRejectionReason = (typeof BENCHMARK_REJECTION_REASONS)[number];
export const BENCHMARK_PROGRESS_WARMUP_SHARE = 0.15;
export const BENCHMARK_GPU_QUEUE_CONTAMINATION_FLAG = 'gpu-queue-exceeds-frame-budget';
export const BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG = 'fence-pacing-dominates-frame-interval';
export interface BenchmarkEnvironmentInfo {
	devicePixelRatio: number;
	drawingBufferHeight: number;
	drawingBufferWidth: number;
	onBattery?: boolean;
	refreshRateHz?: number;
}
export interface BenchmarkTrialConfig {
	benchmarkMs: number;
	minSamples: number;
	warmupMaxMs: number;
	warmupMinMs: number;
	warmupSettleFrames: number;
	warmupSettleRatio: number;
}
type GlObject = unknown;
export interface BenchmarkGl {
	QUERY_RESULT: number;
	QUERY_RESULT_AVAILABLE: number;
	SIGNALED: number;
	SYNC_GPU_COMMANDS_COMPLETE: number;
	SYNC_STATUS: number;
	beginQuery(target: number, query: GlObject): void;
	createQuery(): GlObject;
	deleteSync(sync: GlObject): void;
	endQuery(target: number): void;
	fenceSync(condition: number, flags: number): GlObject;
	flush(): void;
	getParameter(parameter: number): unknown;
	getQueryParameter(query: GlObject, parameter: number): unknown;
	getSyncParameter(sync: GlObject, parameter: number): unknown;
}
export interface BenchmarkTimerQueryExt {
	GPU_DISJOINT_EXT: number;
	TIME_ELAPSED_EXT: number;
}
export interface BenchmarkTrialHooks {
	environment: BenchmarkEnvironmentInfo;
	getTimerQueryExt(): BenchmarkTimerQueryExt | null;
	gl: BenchmarkGl | null;
	now(): number;
	onProgress?(progress: { phase: 'warmup' | 'measure'; ratio: number }): void;
	renderFrame(frameIndex: number): void;
	requestFrame(callback: (timestamp: number) => void): void;
	spin(): number;
	startSampler(callback: () => void, intervalMs: number): () => void;
	subscribeContamination(notify: (reason: BenchmarkRejectionReason) => void): () => void;
	webglRenderer: string;
}
export interface BenchmarkTrialResult {
	averageFps: number;
	contaminationFlags: string[];
	cpuSubmitP50Ms: number;
	cpuSubmitP95Ms: number;
	environment: BenchmarkEnvironmentInfo;
	eventLoopP95Ms: number;
	eventLoopWorstMs: number;
	gpuDisjointDiscardCount: number;
	gpuImplausibleCount: number;
	gpuSampleCount: number;
	gpuTimeP50Ms?: number;
	gpuTimeP95Ms?: number;
	gpuTimingStatus: BenchmarkGpuTimingStatus;
	longFrameRatio: number;
	onePercentLowFps: number;
	p95FrameTimeMs: number;
	rejected: boolean;
	rejectionReasons: BenchmarkRejectionReason[];
	sampleCount: number;
	stallRatio: number;
	stalledTicks: number;
	success: boolean;
	totalTicks: number;
	webglRenderer: string;
	worstFrameTimeMs: number;
}
export function runBenchmarkTrial(hooks: BenchmarkTrialHooks, config: BenchmarkTrialConfig): Promise<BenchmarkTrialResult> {
	const percentile = (sorted: number[], ratio: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] : 0);
	const average = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
	const round = (value: number) => Math.round(value * 100) / 100;
	const gl = hooks.gl;
	const extension = gl ? hooks.getTimerQueryExt() : null;
	const rejectionReasons = new Set<BenchmarkRejectionReason>();
	const frameTimes: number[] = [];
	const cpuSubmitTimes: number[] = [];
	const eventLoopDelays: number[] = [];
	const gpuSamplesMs: number[] = [];
	const frameIntervalByIndex = new Map<number, number>();
	let frameTimeSum = 0;
	let longFrameCount = 0;
	let eventLoopWorstMs = 0;
	let lastFrameCallbackTs: number | undefined;
	let worstFrameCallbackIntervalMs = 0;
	let stalledTicks = 0;
	let totalTicks = 0;
	let gpuDisjointDiscardCount = 0;
	let gpuImplausibleCount = 0;
	let contextLost = false;
	const finalize = (): BenchmarkTrialResult => {
		const ext = extension;
		if (gl && frameTimes.length < config.minSamples) rejectionReasons.add('insufficient-samples');
		const sortedFrames = [...frameTimes].sort((left, right) => left - right);
		const worstFrameTimeMs = sortedFrames.at(-1) || 0;
		if (eventLoopWorstMs >= BENCHMARK_SEVERE_EVENT_LOOP_DELAY_MS && worstFrameCallbackIntervalMs >= BENCHMARK_SEVERE_EVENT_LOOP_DELAY_MS) rejectionReasons.add('severe-event-loop-disturbance');
		let gpuTimingStatus: BenchmarkGpuTimingStatus = ext ? 'measured' : 'unsupported';
		if (ext) {
			const disjointAttemptCount = gpuSamplesMs.length + gpuImplausibleCount + gpuDisjointDiscardCount;
			const disjointExcessive = gpuDisjointDiscardCount > disjointAttemptCount * BENCHMARK_GPU_DISJOINT_DEMOTION_RATIO;
			const gpuAttemptCount = gpuSamplesMs.length + gpuImplausibleCount;
			const implausibleExcessive = gpuAttemptCount > 0 && gpuImplausibleCount > gpuAttemptCount * BENCHMARK_GPU_IMPLAUSIBLE_DEMOTION_RATIO;
			if (disjointExcessive || implausibleExcessive || gpuSamplesMs.length === 0) gpuTimingStatus = 'unreliable';
			if (disjointExcessive && rejectionReasons.size > 0) rejectionReasons.add('gpu-disjoint-excessive');
		}
		const sortedDelays = [...eventLoopDelays].sort((left, right) => left - right);
		const sortedSubmits = [...cpuSubmitTimes].sort((left, right) => left - right);
		const sortedGpu = [...gpuSamplesMs].sort((left, right) => left - right);
		const slowFrameCount = Math.max(1, Math.ceil(sortedFrames.length * 0.01));
		const slowFrames = sortedFrames.slice(-slowFrameCount);
		const meanFrameTime = frameTimes.length ? frameTimeSum / frameTimes.length : 0;
		const meanSlowFrameTime = average(slowFrames);
		const p95FrameTimeMs = round(percentile(sortedFrames, 0.95));
		const gpuTimeP95Ms = gpuTimingStatus === 'measured' ? round(percentile(sortedGpu, 0.95)) : undefined;
		const contaminationFlags: string[] = [];
		if (gpuTimingStatus === 'measured' && gpuTimeP95Ms !== undefined && p95FrameTimeMs > 0 && gpuTimeP95Ms > p95FrameTimeMs * BENCHMARK_GPU_QUEUE_FLAG_RATIO) {
			contaminationFlags.push(BENCHMARK_GPU_QUEUE_CONTAMINATION_FLAG);
		}
		const stallRatioValue = totalTicks > 0 ? stalledTicks / totalTicks : 0;
		if (
			gpuTimingStatus === 'measured' &&
			gpuTimeP95Ms !== undefined &&
			p95FrameTimeMs > 0 &&
			stallRatioValue > BENCHMARK_FENCE_STALL_ARTIFACT_RATIO &&
			gpuTimeP95Ms < p95FrameTimeMs * BENCHMARK_FENCE_STALL_GPU_HEADROOM_RATIO
		) {
			contaminationFlags.push(BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG);
		}
		return {
			averageFps: round(meanFrameTime > 0 ? 1000 / meanFrameTime : 0),
			contaminationFlags,
			cpuSubmitP50Ms: round(percentile(sortedSubmits, 0.5)),
			cpuSubmitP95Ms: round(percentile(sortedSubmits, 0.95)),
			environment: hooks.environment,
			eventLoopP95Ms: round(percentile(sortedDelays, 0.95)),
			eventLoopWorstMs: round(eventLoopWorstMs),
			gpuDisjointDiscardCount,
			gpuImplausibleCount,
			gpuSampleCount: gpuSamplesMs.length,
			...(gpuTimingStatus === 'measured' ? { gpuTimeP50Ms: round(percentile(sortedGpu, 0.5)), gpuTimeP95Ms } : {}),
			gpuTimingStatus,
			longFrameRatio: round(frameTimes.length ? longFrameCount / frameTimes.length : 1),
			onePercentLowFps: round(meanSlowFrameTime > 0 ? 1000 / meanSlowFrameTime : 0),
			p95FrameTimeMs,
			rejected: rejectionReasons.size > 0,
			rejectionReasons: [...rejectionReasons],
			sampleCount: frameTimes.length,
			stallRatio: round(totalTicks > 0 ? stalledTicks / totalTicks : 0),
			stalledTicks,
			success: frameTimes.length > 0,
			totalTicks,
			webglRenderer: hooks.webglRenderer,
			worstFrameTimeMs: round(worstFrameTimeMs)
		};
	};
	if (!gl) {
		return Promise.resolve(finalize());
	}
	interface FenceSlot {
		frameIndex: number;
		sync: GlObject;
	}
	const fences: (FenceSlot | undefined)[] = new Array(BENCHMARK_FENCE_RING_SIZE).fill(undefined);
	interface QuerySlot {
		frameIndex: number;
		query: GlObject;
	}
	const freeQueries: GlObject[] = [];
	const inFlightQueries: QuerySlot[] = [];
	let createdQueries = 0;
	const acquireQuery = (): GlObject | undefined => {
		if (freeQueries.length > 0) return freeQueries.pop();
		if (createdQueries >= BENCHMARK_GPU_QUERY_POOL_SIZE) return undefined;
		createdQueries++;
		return gl.createQuery();
	};
	const pollQueries = () => {
		if (!extension || contextLost || inFlightQueries.length === 0) return;
		if (gl.getParameter(extension.GPU_DISJOINT_EXT)) {
			gpuDisjointDiscardCount += inFlightQueries.length;
			while (inFlightQueries.length > 0) freeQueries.push(inFlightQueries.shift().query);
			return;
		}
		while (inFlightQueries.length > 0) {
			const head = inFlightQueries[0];
			if (!gl.getQueryParameter(head.query, gl.QUERY_RESULT_AVAILABLE)) break;
			const elapsedNs = Number(gl.getQueryParameter(head.query, gl.QUERY_RESULT));
			const elapsedMs = elapsedNs / 1e6;
			const frameInterval = frameIntervalByIndex.get(head.frameIndex);
			if (frameInterval !== undefined) {
				if (elapsedMs > BENCHMARK_GPU_SAMPLE_MIN_MS && elapsedMs < frameInterval * BENCHMARK_GPU_SAMPLE_MAX_FRAME_RATIO) gpuSamplesMs.push(elapsedMs);
				else gpuImplausibleCount++;
			}
			inFlightQueries.shift();
			freeQueries.push(head.query);
		}
	};
	let reportedProgress = 0;
	let start: number | undefined;
	let warmupMinEnd = 0;
	let warmupHardEnd = 0;
	let measureEnd = 0;
	let measuring = false;
	let lastSubmittedTs: number | undefined;
	let submittedFrames = 0;
	const warmupIntervals: number[] = [];
	const warmupSettled = () => {
		if (warmupIntervals.length < config.warmupSettleFrames) return false;
		const sorted = [...warmupIntervals].sort((left, right) => left - right);
		const median = sorted[Math.floor((sorted.length - 1) / 2)];
		if (median <= 0) return false;
		const recent = warmupIntervals.slice(-config.warmupSettleFrames);
		return !recent.some((interval) => interval > median * config.warmupSettleRatio);
	};
	const detachContamination = hooks.subscribeContamination((reason) => {
		rejectionReasons.add(reason);
		if (reason === 'webgl-context-lost') contextLost = true;
	});
	let samplerExpected: number | undefined;
	const stopSampler = hooks.startSampler(() => {
		const now = hooks.now();
		if (measuring && samplerExpected !== undefined) {
			const delay = Math.max(0, now - samplerExpected);
			eventLoopDelays.push(delay);
			eventLoopWorstMs = Math.max(eventLoopWorstMs, delay);
		}
		samplerExpected = now + BENCHMARK_EVENT_LOOP_SAMPLE_MS;
	}, BENCHMARK_EVENT_LOOP_SAMPLE_MS);
	return new Promise<BenchmarkTrialResult>((resolve) => {
		const finish = () => {
			stopSampler();
			detachContamination();
			if (!contextLost) {
				for (let index = 0; index < fences.length; index++) {
					const slot = fences[index];
					if (slot) gl.deleteSync(slot.sync);
					fences[index] = undefined;
				}
			}
			resolve(finalize());
		};
		const tick = (timestamp: number) => {
			if (start === undefined) {
				start = timestamp;
				warmupMinEnd = start + config.warmupMinMs;
				warmupHardEnd = start + config.warmupMaxMs;
			}
			if (contextLost) {
				if (measuring ? timestamp >= measureEnd : timestamp >= warmupHardEnd + config.benchmarkMs) finish();
				else hooks.requestFrame(tick);
				return;
			}
			pollQueries();
			if (!measuring && timestamp >= warmupMinEnd && (warmupSettled() || timestamp >= warmupHardEnd)) {
				measuring = true;
				measureEnd = timestamp + config.benchmarkMs;
				samplerExpected = undefined;
				lastFrameCallbackTs = undefined;
			}
			if (measuring) {
				if (lastFrameCallbackTs !== undefined) {
					const callbackInterval = timestamp - lastFrameCallbackTs;
					if (callbackInterval > 0) {
						worstFrameCallbackIntervalMs = Math.max(worstFrameCallbackIntervalMs, callbackInterval);
					}
				}
				lastFrameCallbackTs = timestamp;
			}
			if (hooks.onProgress) {
				const warmupRatio = Math.min(1, (timestamp - start) / config.warmupMinMs);
				const rawRatio = measuring
					? BENCHMARK_PROGRESS_WARMUP_SHARE + (1 - BENCHMARK_PROGRESS_WARMUP_SHARE) * Math.min(1, 1 - (measureEnd - timestamp) / config.benchmarkMs)
					: BENCHMARK_PROGRESS_WARMUP_SHARE * warmupRatio;
				reportedProgress = Math.max(reportedProgress, Math.min(1, rawRatio));
				hooks.onProgress({ phase: measuring ? 'measure' : 'warmup', ratio: reportedProgress });
			}
			if (measuring) totalTicks++;
			const gateSlot = fences[(submittedFrames - BENCHMARK_FENCE_QUEUE_DEPTH + BENCHMARK_FENCE_RING_SIZE * 2) % BENCHMARK_FENCE_RING_SIZE];
			if (submittedFrames >= BENCHMARK_FENCE_QUEUE_DEPTH && gateSlot && gateSlot.frameIndex === submittedFrames - BENCHMARK_FENCE_QUEUE_DEPTH) {
				if (gl.getSyncParameter(gateSlot.sync, gl.SYNC_STATUS) !== gl.SIGNALED) {
					if (measuring) stalledTicks++;
					hooks.requestFrame(tick);
					return;
				}
				gl.deleteSync(gateSlot.sync);
				fences[gateSlot.frameIndex % BENCHMARK_FENCE_RING_SIZE] = undefined;
			}
			if (lastSubmittedTs !== undefined) {
				const frameTime = timestamp - lastSubmittedTs;
				if (measuring) {
					if (frameTime > 0 && frameTime < 1000) {
						frameTimes.push(frameTime);
						frameTimeSum += frameTime;
						if (frameTime > BENCHMARK_LONG_FRAME_MS) longFrameCount++;
						frameIntervalByIndex.set(submittedFrames, frameTime);
					}
				} else if (frameTime > 0 && frameTime < 1000) warmupIntervals.push(frameTime);
			}
			lastSubmittedTs = timestamp;
			hooks.spin();
			const submitStart = hooks.now();
			const sampleThisFrame = submittedFrames % BENCHMARK_GPU_SAMPLE_FRAME_INTERVAL === 0;
			const query = measuring && extension && sampleThisFrame ? acquireQuery() : undefined;
			if (query !== undefined) gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
			hooks.renderFrame(submittedFrames);
			if (query !== undefined) {
				gl.endQuery(extension.TIME_ELAPSED_EXT);
				inFlightQueries.push({ frameIndex: submittedFrames, query });
			}
			fences[submittedFrames % BENCHMARK_FENCE_RING_SIZE] = { frameIndex: submittedFrames, sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) };
			gl.flush();
			if (measuring) cpuSubmitTimes.push(Math.max(0, hooks.now() - submitStart));
			submittedFrames++;
			if (measuring && timestamp >= measureEnd) finish();
			else hooks.requestFrame(tick);
		};
		hooks.requestFrame(tick);
	});
}
export function markBenchmarkTrialRejected(result: BenchmarkTrialResult, reason: BenchmarkRejectionReason): BenchmarkTrialResult {
	if (result.rejectionReasons.includes(reason)) return result;
	return {
		...result,
		rejected: true,
		rejectionReasons: [...result.rejectionReasons, reason]
	};
}
export function shouldRetryBenchmarkTrial(result: BenchmarkTrialResult, attemptsForTrial: number, runRetriesUsed: number): boolean {
	return result.rejected && attemptsForTrial <= BENCHMARK_TRIAL_RETRY_LIMIT && runRetriesUsed < BENCHMARK_RUN_RETRY_BUDGET;
}
export interface ResolvedBenchmarkAttempts {
	downgradedToLowConfidence: boolean;
	result: BenchmarkTrialResult;
}
export function resolveBenchmarkAttempts(attempts: BenchmarkTrialResult[]): ResolvedBenchmarkAttempts {
	const clean = attempts.find((attempt) => !attempt.rejected);
	if (clean) return { downgradedToLowConfidence: false, result: clean };
	const better = attempts.reduce(
		(best, attempt) => {
			if (!best) return attempt;
			if (attempt.success !== best.success) return attempt.success ? attempt : best;
			if (attempt.sampleCount !== best.sampleCount) return attempt.sampleCount > best.sampleCount ? attempt : best;
			return attempt.onePercentLowFps > best.onePercentLowFps ? attempt : best;
		},
		undefined as BenchmarkTrialResult | undefined
	);
	return { downgradedToLowConfidence: true, result: better };
}
