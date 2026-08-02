import { WORKLOAD_VERSION } from '../../../../src/calibration-workload.ts';

export const RUNTIME_LAB_PROTOCOL_VERSION = 1;
export const RUNTIME_LAB_PAGE_ID = 'tier1-calibration-parity-v1';
export const RUNTIME_LAB_MAX_RESULT_BYTES = 512 * 1024;
export const RUNTIME_LAB_DEFAULT_BENCHMARK_MS = 30_000;
export const RUNTIME_LAB_DEFAULT_MIN_SAMPLES = 120;
export const RUNTIME_LAB_DEFAULT_TIMEOUT_MS = 60_000;
export const RUNTIME_LAB_FOREGROUND_POLL_MS = 50;
export const RUNTIME_LAB_FOREGROUND_SETTLE_MS = 500;
export const RUNTIME_LAB_FOREGROUND_TIMEOUT_MS = 10_000;
export const RUNTIME_LAB_WORKLOAD_VERSION = WORKLOAD_VERSION;

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type RuntimeLabInputMode = 'off' | 'synthetic';

export interface RuntimeLabExpectedResult {
	candidateId: string;
	inputMode: RuntimeLabInputMode;
	pageSha256: string;
	runId: string;
	workloadVersion: number;
}

export interface RuntimeLabPageIdentity {
	deviceMemoryGiB?: number;
	hardwareConcurrency: number;
	language: string;
	platform: string;
	userAgent: string;
	userAgentBrands?: { brand: string; version: string }[];
	userAgentMobile?: boolean;
	userAgentPlatform?: string;
}

export type RuntimeLabForegroundEventType =
	| 'initial-state'
	| 'visibility-change'
	| 'window-blur'
	| 'window-focus';

export interface RuntimeLabForegroundEvent {
	hasFocus: boolean;
	performanceNowMs: number;
	type: RuntimeLabForegroundEventType;
	visibilityState: 'hidden' | 'visible';
}

export interface RuntimeLabPageTimings {
	benchmarkCompletedMs: number;
	benchmarkInvokedMs: number;
	controllerReleasedMs?: number;
	domReadyMs: number;
	foregroundStableMs?: number;
	pageScriptStartMs: number;
	timeOriginEpochMs: number;
}

export interface RuntimeLabSyntheticInputMetrics {
	dispatchChecksum: number;
	dispatchIntervalMs: number;
	dispatchedEvents: number;
	mode: RuntimeLabInputMode;
	p95DispatchLatenessMs: number;
	receivedChecksum: number;
	receivedEvents: number;
	worstDispatchLatenessMs: number;
}

export interface RuntimeLabBenchmarkResult {
	averageFps: number;
	contaminationFlags: string[];
	cpuSubmitP50Ms: number;
	cpuSubmitP95Ms: number;
	environment: {
		devicePixelRatio: number;
		drawingBufferHeight: number;
		drawingBufferWidth: number;
		onBattery?: boolean;
		refreshRateHz?: number;
	};
	eventLoopP95Ms: number;
	eventLoopWorstMs: number;
	gpuDisjointDiscardCount: number;
	gpuImplausibleCount: number;
	gpuSampleCount: number;
	gpuTimeP50Ms?: number;
	gpuTimeP95Ms?: number;
	gpuTimingStatus: 'measured' | 'unsupported' | 'unreliable';
	longFrameRatio: number;
	lowConfidenceReasons: string[];
	onePercentLowFps: number;
	p95FrameTimeMs: number;
	rejected: boolean;
	rejectionReasons: string[];
	sampleCount: number;
	stallRatio: number;
	stalledTicks: number;
	success: boolean;
	totalTicks: number;
	webglRenderer: string;
	worstFrameTimeMs: number;
}

export interface RuntimeLabResultEnvelope {
	benchmark: RuntimeLabBenchmarkResult;
	candidateId: string;
	foregroundEvents: RuntimeLabForegroundEvent[];
	identity: RuntimeLabPageIdentity;
	input: RuntimeLabSyntheticInputMetrics;
	pageId: typeof RUNTIME_LAB_PAGE_ID;
	pageSha256: string;
	protocolVersion: typeof RUNTIME_LAB_PROTOCOL_VERSION;
	runId: string;
	timings: RuntimeLabPageTimings;
	workloadVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
	return value;
}

function requireBoolean(value: unknown, label: string): boolean {
	if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean.`);
	return value;
}

function requireFiniteNumber(value: unknown, label: string, minimum = 0): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
		throw new TypeError(`${label} must be a finite number greater than or equal to ${minimum}.`);
	}
	return value;
}

function optionalFiniteNumber(value: unknown, label: string, minimum = 0): number | undefined {
	if (value === undefined) return undefined;
	return requireFiniteNumber(value, label, minimum);
}

function requireString(value: unknown, label: string, maximumLength = 4_096): string {
	if (typeof value !== 'string' || value.length > maximumLength) throw new TypeError(`${label} must be a bounded string.`);
	return value;
}

function requireIdentifier(value: unknown, label: string): string {
	const identifier = requireString(value, label, 128);
	if (!IDENTIFIER_PATTERN.test(identifier)) throw new TypeError(`${label} is not a valid identifier.`);
	return identifier;
}

function requireSha256(value: unknown, label: string): string {
	const digest = requireString(value, label, 64);
	if (!SHA256_PATTERN.test(digest)) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
	return digest;
}

function requireStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length > 64) throw new TypeError(`${label} must be a bounded string array.`);
	return value.map((item, index) => requireString(item, `${label}[${index}]`, 256));
}

function requireGpuTimingStatus(value: unknown): RuntimeLabBenchmarkResult['gpuTimingStatus'] {
	if (value !== 'measured' && value !== 'unsupported' && value !== 'unreliable') {
		throw new TypeError('benchmark.gpuTimingStatus is invalid.');
	}
	return value;
}

function parseIdentity(value: unknown): RuntimeLabPageIdentity {
	const identity = requireRecord(value, 'identity');
	const userAgentData = identity.userAgentBrands;
	let userAgentBrands: { brand: string; version: string }[] | undefined;
	if (userAgentData !== undefined) {
		if (!Array.isArray(userAgentData) || userAgentData.length > 16) throw new TypeError('identity.userAgentBrands must be a bounded array.');
		userAgentBrands = userAgentData.map((item, index) => {
			const brand = requireRecord(item, `identity.userAgentBrands[${index}]`);
			return {
				brand: requireString(brand.brand, `identity.userAgentBrands[${index}].brand`, 128),
				version: requireString(brand.version, `identity.userAgentBrands[${index}].version`, 64)
			};
		});
	}

	return {
		...(identity.deviceMemoryGiB === undefined ? {} : { deviceMemoryGiB: requireFiniteNumber(identity.deviceMemoryGiB, 'identity.deviceMemoryGiB') }),
		hardwareConcurrency: requireFiniteNumber(identity.hardwareConcurrency, 'identity.hardwareConcurrency'),
		language: requireString(identity.language, 'identity.language', 128),
		platform: requireString(identity.platform, 'identity.platform', 256),
		userAgent: requireString(identity.userAgent, 'identity.userAgent', 4_096),
		...(userAgentBrands === undefined ? {} : { userAgentBrands }),
		...(identity.userAgentMobile === undefined ? {} : { userAgentMobile: requireBoolean(identity.userAgentMobile, 'identity.userAgentMobile') }),
		...(identity.userAgentPlatform === undefined ? {} : { userAgentPlatform: requireString(identity.userAgentPlatform, 'identity.userAgentPlatform', 256) })
	};
}

function parseForegroundEvents(
	value: unknown,
	timings: RuntimeLabPageTimings
): RuntimeLabForegroundEvent[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
		throw new TypeError(
			'foregroundEvents must contain 1 through 64 events.'
		);
	}
	let previousPerformanceNowMs = -1;
	const events = value.map((item, index) => {
		const event = requireRecord(
			item,
			`foregroundEvents[${index}]`
		);
		if (
			event.type !== 'initial-state'
			&& event.type !== 'visibility-change'
			&& event.type !== 'window-blur'
			&& event.type !== 'window-focus'
		) {
			throw new TypeError(
				`foregroundEvents[${index}].type is invalid.`
			);
		}
		if (
			event.visibilityState !== 'hidden'
			&& event.visibilityState !== 'visible'
		) {
			throw new TypeError(
				`foregroundEvents[${index}].visibilityState is invalid.`
			);
		}
		const performanceNowMs = requireFiniteNumber(
			event.performanceNowMs,
			`foregroundEvents[${index}].performanceNowMs`
		);
		if (performanceNowMs < previousPerformanceNowMs) {
			throw new TypeError(
				'foregroundEvents are not ordered by performanceNowMs.'
			);
		}
		if (
			performanceNowMs < timings.pageScriptStartMs
			|| performanceNowMs > timings.benchmarkCompletedMs
		) {
			throw new TypeError(
				`foregroundEvents[${index}] lies outside the page result interval.`
			);
		}
		previousPerformanceNowMs = performanceNowMs;
		return {
			hasFocus: requireBoolean(
				event.hasFocus,
				`foregroundEvents[${index}].hasFocus`
			),
			performanceNowMs,
			type: event.type as RuntimeLabForegroundEventType,
			visibilityState:
				event.visibilityState as RuntimeLabForegroundEvent['visibilityState']
		};
	});
	if (events[0]?.type !== 'initial-state') {
		throw new TypeError(
			'foregroundEvents must begin with initial-state.'
		);
	}
	return events;
}

function parseTimings(value: unknown): RuntimeLabPageTimings {
	const timings = requireRecord(value, 'timings');
	const parsed: RuntimeLabPageTimings = {
		benchmarkCompletedMs: requireFiniteNumber(timings.benchmarkCompletedMs, 'timings.benchmarkCompletedMs'),
		benchmarkInvokedMs: requireFiniteNumber(timings.benchmarkInvokedMs, 'timings.benchmarkInvokedMs'),
		...(timings.controllerReleasedMs === undefined ? {} : { controllerReleasedMs: requireFiniteNumber(timings.controllerReleasedMs, 'timings.controllerReleasedMs') }),
		domReadyMs: requireFiniteNumber(timings.domReadyMs, 'timings.domReadyMs'),
		...(timings.foregroundStableMs === undefined ? {} : { foregroundStableMs: requireFiniteNumber(timings.foregroundStableMs, 'timings.foregroundStableMs') }),
		pageScriptStartMs: requireFiniteNumber(timings.pageScriptStartMs, 'timings.pageScriptStartMs'),
		timeOriginEpochMs: requireFiniteNumber(timings.timeOriginEpochMs, 'timings.timeOriginEpochMs')
	};
	if (parsed.domReadyMs < parsed.pageScriptStartMs) throw new TypeError('timings.domReadyMs precedes pageScriptStartMs.');
	if (parsed.controllerReleasedMs !== undefined && parsed.controllerReleasedMs < parsed.domReadyMs) throw new TypeError('timings.controllerReleasedMs precedes domReadyMs.');
	if (parsed.foregroundStableMs !== undefined && parsed.foregroundStableMs < (parsed.controllerReleasedMs ?? parsed.domReadyMs)) throw new TypeError('timings.foregroundStableMs precedes controller release.');
	if (parsed.benchmarkInvokedMs < (parsed.foregroundStableMs ?? parsed.controllerReleasedMs ?? parsed.domReadyMs)) throw new TypeError('timings.benchmarkInvokedMs precedes foreground readiness.');
	if (parsed.benchmarkCompletedMs < parsed.benchmarkInvokedMs) throw new TypeError('timings.benchmarkCompletedMs precedes benchmarkInvokedMs.');
	return parsed;
}

function parseInput(
	value: unknown,
	allowEmptySynthetic = false
): RuntimeLabSyntheticInputMetrics {
	const input = requireRecord(value, 'input');
	if (input.mode !== 'off' && input.mode !== 'synthetic') throw new TypeError('input.mode is invalid.');
	const parsed: RuntimeLabSyntheticInputMetrics = {
		dispatchChecksum: requireFiniteNumber(input.dispatchChecksum, 'input.dispatchChecksum'),
		dispatchIntervalMs: requireFiniteNumber(input.dispatchIntervalMs, 'input.dispatchIntervalMs'),
		dispatchedEvents: requireFiniteNumber(input.dispatchedEvents, 'input.dispatchedEvents'),
		mode: input.mode,
		p95DispatchLatenessMs: requireFiniteNumber(input.p95DispatchLatenessMs, 'input.p95DispatchLatenessMs'),
		receivedChecksum: requireFiniteNumber(input.receivedChecksum, 'input.receivedChecksum'),
		receivedEvents: requireFiniteNumber(input.receivedEvents, 'input.receivedEvents'),
		worstDispatchLatenessMs: requireFiniteNumber(input.worstDispatchLatenessMs, 'input.worstDispatchLatenessMs')
	};
	if (parsed.mode === 'off') {
		const inactiveValues = [parsed.dispatchChecksum, parsed.dispatchIntervalMs, parsed.dispatchedEvents, parsed.p95DispatchLatenessMs, parsed.receivedChecksum, parsed.receivedEvents, parsed.worstDispatchLatenessMs];
		if (inactiveValues.some(item => item !== 0)) throw new TypeError('Disabled input metrics must all be zero.');
		return parsed;
	}
	if (parsed.dispatchedEvents < 1) {
		const inactiveValues = [parsed.dispatchChecksum, parsed.dispatchIntervalMs, parsed.dispatchedEvents, parsed.p95DispatchLatenessMs, parsed.receivedChecksum, parsed.receivedEvents, parsed.worstDispatchLatenessMs];
		if (allowEmptySynthetic && inactiveValues.every(item => item === 0)) return parsed;
		throw new TypeError('Synthetic input did not dispatch any events.');
	}
	if (parsed.dispatchedEvents !== parsed.receivedEvents) throw new TypeError('Synthetic input event count mismatch.');
	if (parsed.dispatchChecksum !== parsed.receivedChecksum) throw new TypeError('Synthetic input checksum mismatch.');
	return parsed;
}

function parseBenchmark(value: unknown): RuntimeLabBenchmarkResult {
	const benchmark = requireRecord(value, 'benchmark');
	const environment = requireRecord(benchmark.environment, 'benchmark.environment');
	return {
		averageFps: requireFiniteNumber(benchmark.averageFps, 'benchmark.averageFps'),
		contaminationFlags: requireStringArray(benchmark.contaminationFlags, 'benchmark.contaminationFlags'),
		cpuSubmitP50Ms: requireFiniteNumber(benchmark.cpuSubmitP50Ms, 'benchmark.cpuSubmitP50Ms'),
		cpuSubmitP95Ms: requireFiniteNumber(benchmark.cpuSubmitP95Ms, 'benchmark.cpuSubmitP95Ms'),
		environment: {
			devicePixelRatio: requireFiniteNumber(environment.devicePixelRatio, 'benchmark.environment.devicePixelRatio'),
			drawingBufferHeight: requireFiniteNumber(environment.drawingBufferHeight, 'benchmark.environment.drawingBufferHeight'),
			drawingBufferWidth: requireFiniteNumber(environment.drawingBufferWidth, 'benchmark.environment.drawingBufferWidth'),
			...(environment.onBattery === undefined ? {} : { onBattery: requireBoolean(environment.onBattery, 'benchmark.environment.onBattery') }),
			...(environment.refreshRateHz === undefined ? {} : { refreshRateHz: requireFiniteNumber(environment.refreshRateHz, 'benchmark.environment.refreshRateHz') })
		},
		eventLoopP95Ms: requireFiniteNumber(benchmark.eventLoopP95Ms, 'benchmark.eventLoopP95Ms'),
		eventLoopWorstMs: requireFiniteNumber(benchmark.eventLoopWorstMs, 'benchmark.eventLoopWorstMs'),
		gpuDisjointDiscardCount: requireFiniteNumber(benchmark.gpuDisjointDiscardCount, 'benchmark.gpuDisjointDiscardCount'),
		gpuImplausibleCount: requireFiniteNumber(benchmark.gpuImplausibleCount, 'benchmark.gpuImplausibleCount'),
		gpuSampleCount: requireFiniteNumber(benchmark.gpuSampleCount, 'benchmark.gpuSampleCount'),
		...(benchmark.gpuTimeP50Ms === undefined ? {} : { gpuTimeP50Ms: optionalFiniteNumber(benchmark.gpuTimeP50Ms, 'benchmark.gpuTimeP50Ms') }),
		...(benchmark.gpuTimeP95Ms === undefined ? {} : { gpuTimeP95Ms: optionalFiniteNumber(benchmark.gpuTimeP95Ms, 'benchmark.gpuTimeP95Ms') }),
		gpuTimingStatus: requireGpuTimingStatus(benchmark.gpuTimingStatus),
		longFrameRatio: requireFiniteNumber(benchmark.longFrameRatio, 'benchmark.longFrameRatio'),
		lowConfidenceReasons: requireStringArray(benchmark.lowConfidenceReasons, 'benchmark.lowConfidenceReasons'),
		onePercentLowFps: requireFiniteNumber(benchmark.onePercentLowFps, 'benchmark.onePercentLowFps'),
		p95FrameTimeMs: requireFiniteNumber(benchmark.p95FrameTimeMs, 'benchmark.p95FrameTimeMs'),
		rejected: requireBoolean(benchmark.rejected, 'benchmark.rejected'),
		rejectionReasons: requireStringArray(benchmark.rejectionReasons, 'benchmark.rejectionReasons'),
		sampleCount: requireFiniteNumber(benchmark.sampleCount, 'benchmark.sampleCount'),
		stallRatio: requireFiniteNumber(benchmark.stallRatio, 'benchmark.stallRatio'),
		stalledTicks: requireFiniteNumber(benchmark.stalledTicks, 'benchmark.stalledTicks'),
		success: requireBoolean(benchmark.success, 'benchmark.success'),
		totalTicks: requireFiniteNumber(benchmark.totalTicks, 'benchmark.totalTicks'),
		webglRenderer: requireString(benchmark.webglRenderer, 'benchmark.webglRenderer', 4_096),
		worstFrameTimeMs: requireFiniteNumber(benchmark.worstFrameTimeMs, 'benchmark.worstFrameTimeMs')
	};
}

export function validateRuntimeLabResult(value: unknown, expected: RuntimeLabExpectedResult): RuntimeLabResultEnvelope {
	const envelope = requireRecord(value, 'result');
	if (envelope.protocolVersion !== RUNTIME_LAB_PROTOCOL_VERSION) throw new TypeError('result.protocolVersion is unsupported.');
	if (envelope.pageId !== RUNTIME_LAB_PAGE_ID) throw new TypeError('result.pageId is unsupported.');

	const runId = requireIdentifier(envelope.runId, 'result.runId');
	const candidateId = requireIdentifier(envelope.candidateId, 'result.candidateId');
	const pageSha256 = requireSha256(envelope.pageSha256, 'result.pageSha256');
	const workloadVersion = requireFiniteNumber(envelope.workloadVersion, 'result.workloadVersion');
	if (runId !== expected.runId) throw new TypeError('result.runId does not match this run.');
	if (candidateId !== expected.candidateId) throw new TypeError('result.candidateId does not match this run.');
	if (pageSha256 !== expected.pageSha256) throw new TypeError('result.pageSha256 does not match the served page.');
	if (workloadVersion !== expected.workloadVersion) throw new TypeError('result.workloadVersion does not match this scenario.');
	const benchmark = parseBenchmark(envelope.benchmark);
	const input = parseInput(envelope.input, !benchmark.success);
	if (input.mode !== expected.inputMode) throw new TypeError('result.input.mode does not match this scenario.');
	const timings = parseTimings(envelope.timings);
	const foregroundEvents = parseForegroundEvents(
		envelope.foregroundEvents,
		timings
	);

	return {
		benchmark,
		candidateId,
		foregroundEvents,
		identity: parseIdentity(envelope.identity),
		input,
		pageId: RUNTIME_LAB_PAGE_ID,
		pageSha256,
		protocolVersion: RUNTIME_LAB_PROTOCOL_VERSION,
		runId,
		timings,
		workloadVersion
	};
}

export function assertRuntimeLabIdentifier(value: string, label: string): void {
	if (!IDENTIFIER_PATTERN.test(value)) throw new TypeError(`${label} is not a valid runtime-lab identifier.`);
}
