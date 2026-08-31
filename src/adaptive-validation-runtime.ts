import {
	ADAPTIVE_VALIDATION_MIN_SESSION_MS,
	adaptiveValidationProfileIdentitiesEqual,
	parseAdaptiveValidationState,
	type AdaptiveValidationLowConfidenceReason,
	type AdaptiveValidationSession,
	type AdaptiveValidationState,
	type AdaptiveValidationSubmission
} from './adaptive-validation.ts';
import { MAX_VALID_FRAME_MS, PERFORMANCE_WINDOW_MS, RollingPerformanceStats } from './performance-stats.ts';
export { parseAdaptiveValidationState } from './adaptive-validation.ts';
export const ADAPTIVE_VALIDATION_EVENT_LOOP_INTERVAL_MS = 1000;
export const ADAPTIVE_VALIDATION_SEVERE_EVENT_LOOP_DELAY_MS = 250;
interface AdaptiveValidationRuntimeDocument {
	pointerLockElement: unknown;
	visibilityState: DocumentVisibilityState;
	addEventListener: (type: string, listener: EventListener, options?: AddEventListenerOptions | boolean) => void;
	hasFocus?: () => boolean;
	removeEventListener: (type: string, listener: EventListener, options?: EventListenerOptions | boolean) => void;
}
interface AdaptiveValidationRuntimeWindow {
	addEventListener: (type: string, listener: EventListener, options?: AddEventListenerOptions | boolean) => void;
	removeEventListener: (type: string, listener: EventListener, options?: EventListenerOptions | boolean) => void;
}
export interface AdaptiveValidationRuntimeEnvironment {
	cancelAnimationFrame: (handle: number) => void;
	clearTimeout: (handle: number) => void;
	createSessionId: () => string;
	document: AdaptiveValidationRuntimeDocument;
	now: () => number;
	requestAnimationFrame: (callback: FrameRequestCallback) => number;
	setTimeout: (callback: () => void, delayMs: number) => number;
	wallClockNow: () => number;
	window: AdaptiveValidationRuntimeWindow;
}
export interface AdaptiveValidationRuntimeOptions {
	onError?: (error: unknown) => void;
	state: AdaptiveValidationState;
	submitSession: (submission: AdaptiveValidationSubmission) => Promise<unknown>;
}
interface SessionAccumulator {
	maximumP95FrameTimeMs: number;
	maximumWorstFrameTimeMs: number;
	minimumOnePercentLowFps: number;
	sampleCount: number;
	totalFrameTimeMs: number;
}
interface ActiveSession {
	accumulator: SessionAccumulator;
	id: string;
	lastFrameTime: number;
	lowConfidenceReasons: Set<AdaptiveValidationLowConfidenceReason>;
	segmentStartedAt: number;
	startedAt: number;
	stats: RollingPerformanceStats;
}
function rounded(value: number, decimalPlaces = 2): number {
	const scale = 10 ** decimalPlaces;
	return Math.round(value * scale) / scale;
}
function defaultEnvironment(): AdaptiveValidationRuntimeEnvironment {
	return {
		cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
		clearTimeout: (handle) => window.clearTimeout(handle),
		createSessionId: () => globalThis.crypto.randomUUID(),
		document,
		now: () => performance.now(),
		requestAnimationFrame: (callback) => requestAnimationFrame(callback),
		setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
		wallClockNow: () => Date.now(),
		window
	};
}
function addSnapshotToAccumulator(accumulator: SessionAccumulator, snapshot: PerformanceSnapshot): void {
	if (snapshot.sampleCount <= 0 || snapshot.averageFps <= 0) return;
	accumulator.sampleCount += snapshot.sampleCount;
	accumulator.totalFrameTimeMs += snapshot.sampleCount * (1000 / snapshot.averageFps);
	accumulator.maximumP95FrameTimeMs = Math.max(accumulator.maximumP95FrameTimeMs, snapshot.p95FrameTimeMs);
	accumulator.maximumWorstFrameTimeMs = Math.max(accumulator.maximumWorstFrameTimeMs, snapshot.worstFrameTimeMs);
	if (snapshot.onePercentLowFps > 0) {
		accumulator.minimumOnePercentLowFps = accumulator.minimumOnePercentLowFps > 0 ? Math.min(accumulator.minimumOnePercentLowFps, snapshot.onePercentLowFps) : snapshot.onePercentLowFps;
	}
}
function createSession(id: string, startedAt: number, stats: RollingPerformanceStats): ActiveSession {
	stats.reset();
	return {
		accumulator: {
			maximumP95FrameTimeMs: 0,
			maximumWorstFrameTimeMs: 0,
			minimumOnePercentLowFps: 0,
			sampleCount: 0,
			totalFrameTimeMs: 0
		},
		id,
		lastFrameTime: 0,
		lowConfidenceReasons: new Set(),
		segmentStartedAt: startedAt,
		startedAt,
		stats
	};
}
function buildSessionEvidence(session: ActiveSession, durationMs: number, completedAt: number): AdaptiveValidationSession {
	const { accumulator } = session;
	return {
		completedAt,
		durationMs: rounded(durationMs),
		id: session.id,
		lowConfidenceReasons: [...session.lowConfidenceReasons],
		metrics: {
			averageFps: accumulator.sampleCount > 0 && accumulator.totalFrameTimeMs > 0 ? rounded(1000 / (accumulator.totalFrameTimeMs / accumulator.sampleCount), 1) : 0,
			onePercentLowFps: rounded(accumulator.minimumOnePercentLowFps, 1),
			p95FrameTimeMs: rounded(accumulator.maximumP95FrameTimeMs),
			sampleCount: accumulator.sampleCount,
			worstFrameTimeMs: rounded(accumulator.maximumWorstFrameTimeMs)
		}
	};
}
export function startAdaptiveValidationRuntime(options: AdaptiveValidationRuntimeOptions, environment: AdaptiveValidationRuntimeEnvironment = defaultEnvironment()): () => void {
	let state = options.state;
	let activeSession: ActiveSession | undefined;
	let animationFrame: number | undefined;
	let eventLoopTimer: number | undefined;
	let performanceStats: RollingPerformanceStats | undefined;
	let submissionPending = false;
	let stopped = false;
	let listenersAttached = false;
	const finishSegment = (session: ActiveSession, now: number) => {
		addSnapshotToAccumulator(session.accumulator, session.stats.snapshot(now));
		session.stats.reset();
		session.segmentStartedAt = now;
	};
	const stopAnimationFrame = () => {
		if (animationFrame !== undefined) environment.cancelAnimationFrame(animationFrame);
		animationFrame = undefined;
	};
	const stopEventLoopWatch = () => {
		if (eventLoopTimer !== undefined) environment.clearTimeout(eventLoopTimer);
		eventLoopTimer = undefined;
	};
	const startEventLoopWatch = () => {
		let expectedTime = environment.now() + ADAPTIVE_VALIDATION_EVENT_LOOP_INTERVAL_MS;
		const checkEventLoop = () => {
			eventLoopTimer = undefined;
			const session = activeSession;
			if (stopped || !session) return;
			const now = environment.now();
			if (now - expectedTime >= ADAPTIVE_VALIDATION_SEVERE_EVENT_LOOP_DELAY_MS) {
				session.lowConfidenceReasons.add('severe-event-loop-disturbance');
			}
			expectedTime = now + ADAPTIVE_VALIDATION_EVENT_LOOP_INTERVAL_MS;
			eventLoopTimer = environment.setTimeout(checkEventLoop, ADAPTIVE_VALIDATION_EVENT_LOOP_INTERVAL_MS);
		};
		eventLoopTimer = environment.setTimeout(checkEventLoop, ADAPTIVE_VALIDATION_EVENT_LOOP_INTERVAL_MS);
	};
	const detachListeners = () => {
		if (!listenersAttached) return;
		environment.document.removeEventListener('pointerlockchange', handlePointerLockChange);
		environment.document.removeEventListener('visibilitychange', handleVisibilityChange);
		environment.window.removeEventListener('blur', handleBlur);
		environment.window.removeEventListener('resize', handleResize);
		environment.window.removeEventListener('beforeunload', handleBeforeUnload);
		listenersAttached = false;
	};
	const stop = () => {
		if (stopped) return;
		stopped = true;
		activeSession = undefined;
		performanceStats = undefined;
		stopAnimationFrame();
		stopEventLoopWatch();
		detachListeners();
	};
	const startSessionIfEligible = () => {
		if (stopped || submissionPending || activeSession || state.status === 'complete' || environment.document.pointerLockElement == null) return;
		performanceStats ??= new RollingPerformanceStats();
		activeSession = createSession(environment.createSessionId(), environment.now(), performanceStats);
		if (environment.document.visibilityState !== 'visible') activeSession.lowConfidenceReasons.add('document-visibility-changed');
		if (environment.document.hasFocus?.() === false) activeSession.lowConfidenceReasons.add('window-blurred');
		startEventLoopWatch();
		animationFrame = environment.requestAnimationFrame(recordFrame);
	};
	const handleSubmissionResult = (value: unknown) => {
		if (stopped) return;
		const nextState = parseAdaptiveValidationState(value);
		if (!nextState || !adaptiveValidationProfileIdentitiesEqual(state.profile, nextState.profile)) {
			stop();
			return;
		}
		state = nextState;
		submissionPending = false;
		if (state.status === 'complete') stop();
		else startSessionIfEligible();
	};
	const submitSession = (session: AdaptiveValidationSession) => {
		submissionPending = true;
		void options
			.submitSession({ profile: state.profile, session })
			.then(handleSubmissionResult)
			.catch((error) => {
				submissionPending = false;
				options.onError?.(error);
				startSessionIfEligible();
			});
	};
	const finishActiveSession = () => {
		const session = activeSession;
		if (!session) return;
		if (environment.document.visibilityState !== 'visible') session.lowConfidenceReasons.add('document-visibility-changed');
		if (environment.document.hasFocus?.() === false) session.lowConfidenceReasons.add('window-blurred');
		activeSession = undefined;
		stopAnimationFrame();
		stopEventLoopWatch();
		const now = environment.now();
		const durationMs = Math.max(0, now - session.startedAt);
		if (durationMs < ADAPTIVE_VALIDATION_MIN_SESSION_MS) return;
		finishSegment(session, now);
		submitSession(buildSessionEvidence(session, durationMs, environment.wallClockNow()));
	};
	function recordFrame(now: number) {
		animationFrame = undefined;
		const session = activeSession;
		if (stopped || !session || environment.document.pointerLockElement == null) return;
		if (session.lastFrameTime > 0) {
			const frameTime = now - session.lastFrameTime;
			if (frameTime > 0 && frameTime <= MAX_VALID_FRAME_MS) session.stats.recordFrame(now, frameTime);
		}
		session.lastFrameTime = now;
		if (now - session.segmentStartedAt >= PERFORMANCE_WINDOW_MS) finishSegment(session, now);
		animationFrame = environment.requestAnimationFrame(recordFrame);
	}
	function handlePointerLockChange() {
		if (environment.document.pointerLockElement == null) finishActiveSession();
		else startSessionIfEligible();
	}
	function handleVisibilityChange() {
		if (activeSession) activeSession.lowConfidenceReasons.add('document-visibility-changed');
	}
	function handleBlur() {
		if (activeSession) activeSession.lowConfidenceReasons.add('window-blurred');
	}
	function handleResize() {
		if (activeSession) activeSession.lowConfidenceReasons.add('window-resized');
	}
	function handleBeforeUnload() {
		stop();
	}
	if (state.status === 'complete') return stop;
	listenersAttached = true;
	environment.document.addEventListener('pointerlockchange', handlePointerLockChange, { passive: true });
	environment.document.addEventListener('visibilitychange', handleVisibilityChange, { passive: true });
	environment.window.addEventListener('blur', handleBlur, { passive: true });
	environment.window.addEventListener('resize', handleResize, { passive: true });
	environment.window.addEventListener('beforeunload', handleBeforeUnload, { once: true });
	startSessionIfEligible();
	return stop;
}
