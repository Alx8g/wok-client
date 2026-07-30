import type { AppliedGraphicsBackend } from './graphics-profile.ts';

const CALIBRATION_STATE_VERSION = 1;
export const CALIBRATION_VERSION = 2;
export const CALIBRATION_BENCHMARK_MS = 2_800;
export const CALIBRATION_WARMUP_MS = 650;
export const CALIBRATION_MIN_SAMPLES = 45;
export const CALIBRATION_SCORE_TIE_MINIMUM = 5;
export const CALIBRATION_SCORE_MEANINGFUL_WIN_RATIO = 0.03;

export const FRAME_POLICIES = ['uncapped', 'capped'] as const;
export type FramePolicy = (typeof FRAME_POLICIES)[number];
export type CalibrationStatus = 'running' | 'awaiting-confirmation' | 'complete';

export const CALIBRATION_LOW_CONFIDENCE_REASONS = [
	'window-blurred',
	'document-visibility-changed',
	'window-resized',
	'webgl-context-lost',
	'severe-event-loop-disturbance'
] as const;
export type CalibrationLowConfidenceReason = (typeof CALIBRATION_LOW_CONFIDENCE_REASONS)[number];

export type ExplicitGraphicsBackend = Exclude<AppliedGraphicsBackend, 'default'>;
export type EffectiveBackendVerificationStatus = 'verified' | 'mismatch' | 'indeterminate';

export interface EffectiveBackendVerification {
	candidateBackend: AppliedGraphicsBackend;
	detectedBackend?: ExplicitGraphicsBackend;
	status: EffectiveBackendVerificationStatus;
}

export interface CalibrationSignature {
	/** Informational only. App-only releases do not invalidate calibration. */
	appVersion: string;
	benchmarkVersion: number;
	driverFingerprint: string;
	electronVersion: string;
	hardwareFingerprint: string;
}

export interface CalibrationCandidate {
	backend: AppliedGraphicsBackend;
	framePolicy: FramePolicy;
	id: string;
}

export interface CalibrationMetrics {
	averageFps: number;
	eventLoopP95Ms: number;
	/** Optional until the main-process metrics normalizer is updated. */
	eventLoopWorstMs?: number;
	longFrameRatio: number;
	/** Optional for persisted version-1 records and older main-process normalizers. */
	lowConfidenceReasons?: CalibrationLowConfidenceReason[];
	onePercentLowFps: number;
	p95FrameTimeMs: number;
	sampleCount: number;
	success: boolean;
	webglRenderer: string;
	worstFrameTimeMs: number;
}

export interface CalibrationResult {
	backendVerification: EffectiveBackendVerification;
	candidate: CalibrationCandidate;
	failureReason?: string;
	metrics: CalibrationMetrics;
	score: number;
}

export interface CalibrationState {
	activeSelection?: CalibrationResult;
	candidates: CalibrationCandidate[];
	competitiveModeWasEnabled: boolean;
	completedAt?: number;
	recommendedSelection?: CalibrationResult;
	rerunRequested: boolean;
	results: CalibrationResult[];
	signature: CalibrationSignature;
	status: CalibrationStatus;
	updatedAt: number;
	version: 1;
}

interface CalibrationCandidateOptions {
	blockedBackends?: readonly AppliedGraphicsBackend[];
	currentBackend: AppliedGraphicsBackend;
	currentFramePolicy: FramePolicy;
	platform?: NodeJS.Platform;
	recommendedBackend: AppliedGraphicsBackend;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function collectStableGraphicsDriverFields(value: unknown): string[] {
	const driverValues: string[] = [];
	const visit = (entry: unknown, path: string) => {
		if (Array.isArray(entry)) {
			entry.forEach((item, index) => visit(item, `${path}[${index}]`));
			return;
		}
		if (!isRecord(entry)) return;

		for (const [key, child] of Object.entries(entry)) {
			const childPath = path ? `${path}.${key}` : key;
			const normalizedKey = key.replaceAll(/[-_]/gu, '').toLowerCase();
			const stableDriverField = normalizedKey === 'drivervendor' || normalizedKey === 'driverversion' || normalizedKey === 'driverdate';
			if (stableDriverField && (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean')) {
				driverValues.push(`${childPath}=${String(child)}`);
			} else {
				visit(child, childPath);
			}
		}
	};
	visit(value, 'gpu');
	return driverValues.sort();
}

function isAppliedBackend(value: unknown): value is AppliedGraphicsBackend {
	return value === 'default' || value === 'd3d11' || value === 'd3d11on12' || value === 'vulkan';
}

function isFramePolicy(value: unknown): value is FramePolicy {
	return typeof value === 'string' && FRAME_POLICIES.includes(value as FramePolicy);
}

function isLowConfidenceReason(value: unknown): value is CalibrationLowConfidenceReason {
	return typeof value === 'string' && CALIBRATION_LOW_CONFIDENCE_REASONS.includes(value as CalibrationLowConfidenceReason);
}

function finiteNumber(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function metricsLowConfidenceReasons(metrics: CalibrationMetrics): CalibrationLowConfidenceReason[] {
	return [...new Set((metrics.lowConfidenceReasons ?? []).filter(isLowConfidenceReason))];
}

export function calibrationCandidateId(backend: AppliedGraphicsBackend, framePolicy: FramePolicy): string {
	return `${backend}:${framePolicy}`;
}

function makeCandidate(backend: AppliedGraphicsBackend, framePolicy: FramePolicy): CalibrationCandidate {
	return {
		backend,
		framePolicy,
		id: calibrationCandidateId(backend, framePolicy)
	};
}

export function createCalibrationCandidates({
	blockedBackends = [],
	currentBackend,
	currentFramePolicy,
	platform = process.platform,
	recommendedBackend
}: CalibrationCandidateOptions): CalibrationCandidate[] {
	const candidates: CalibrationCandidate[] = [];
	const blocked = new Set(blockedBackends);

	const addCandidate = (backend: AppliedGraphicsBackend, framePolicy: FramePolicy) => {
		if (blocked.has(backend) || (platform !== 'win32' && (backend === 'd3d11' || backend === 'd3d11on12'))) return;
		const candidate = makeCandidate(backend, framePolicy);
		if (!candidates.some(existing => existing.id === candidate.id)) candidates.push(candidate);
	};

	// Keep the first pass short. A capped candidate is staged later only when a clean uncapped trial shows severe instability.
	addCandidate(currentBackend, currentFramePolicy);
	addCandidate(recommendedBackend, 'uncapped');

	const fallbackBackend: AppliedGraphicsBackend = platform === 'win32' && recommendedBackend === 'default'
		? 'd3d11'
		: 'default';
	addCandidate(fallbackBackend, 'uncapped');

	if (candidates.length === 0) addCandidate('default', 'uncapped');
	return candidates.slice(0, 2);
}

function detectEffectiveRendererBackend(webglRenderer: string): ExplicitGraphicsBackend | undefined {
	const normalized = webglRenderer.toLowerCase();
	const compact = normalized.replaceAll(/[\s_-]+/gu, '');
	if (compact.includes('d3d11on12') || compact.includes('direct3d11on12')) return 'd3d11on12';
	if (normalized.includes('vulkan')) return 'vulkan';
	if (compact.includes('d3d11') || compact.includes('direct3d11')) return 'd3d11';
	return undefined;
}

/**
 * Verifies only explicit backend requests against the effective WebGL renderer.
 * Chromium's default backend is intentionally indeterminate because it is allowed to choose any supported implementation.
 */
export function verifyEffectiveRendererBackend(
	candidateBackend: AppliedGraphicsBackend,
	webglRenderer: string
): EffectiveBackendVerification {
	const detectedBackend = detectEffectiveRendererBackend(webglRenderer);
	if (candidateBackend === 'default' || !detectedBackend) {
		return {
			candidateBackend,
			...(detectedBackend ? { detectedBackend } : {}),
			status: 'indeterminate'
		};
	}

	return {
		candidateBackend,
		detectedBackend,
		status: detectedBackend === candidateBackend ? 'verified' : 'mismatch'
	};
}

export function createCalibrationSignature(
	appVersion: string,
	electronVersion: string,
	hardwareFingerprint: string,
	driverFingerprint: string
): CalibrationSignature {
	return {
		appVersion,
		benchmarkVersion: CALIBRATION_VERSION,
		driverFingerprint,
		electronVersion,
		hardwareFingerprint
	};
}

export function calibrationSignaturesEqual(left: CalibrationSignature, right: CalibrationSignature): boolean {
	return left.benchmarkVersion === right.benchmarkVersion
		&& left.driverFingerprint === right.driverFingerprint
		&& left.electronVersion === right.electronVersion
		&& left.hardwareFingerprint === right.hardwareFingerprint;
}

export function createCalibrationState(
	signature: CalibrationSignature,
	candidates: CalibrationCandidate[],
	competitiveModeWasEnabled: boolean,
	previousState?: CalibrationState
): CalibrationState {
	const preserveSelection = previousState && calibrationSignaturesEqual(previousState.signature, signature)
		? previousState.activeSelection ?? previousState.recommendedSelection
		: undefined;

	return {
		...(preserveSelection ? { activeSelection: preserveSelection } : {}),
		candidates,
		competitiveModeWasEnabled,
		rerunRequested: false,
		results: [],
		signature,
		status: 'running',
		updatedAt: Date.now(),
		version: CALIBRATION_STATE_VERSION
	};
}

export function prepareCalibrationState(
	existing: CalibrationState | undefined,
	signature: CalibrationSignature,
	candidates: CalibrationCandidate[],
	competitiveModeEnabled: boolean
): CalibrationState {
	if (existing && calibrationSignaturesEqual(existing.signature, signature) && !existing.rerunRequested) {
		if (existing.signature.appVersion === signature.appVersion) return existing;
		return {
			...existing,
			signature,
			updatedAt: Date.now()
		};
	}
	return createCalibrationState(signature, candidates, competitiveModeEnabled, existing);
}

export function getPendingCalibrationCandidate(state: CalibrationState): CalibrationCandidate | undefined {
	if (state.status !== 'running') return undefined;
	const completed = new Set(state.results.map(result => result.candidate.id));
	return state.candidates.find(candidate => !completed.has(candidate.id));
}

export function calculateCalibrationScore(metrics: CalibrationMetrics, _framePolicy: FramePolicy = 'uncapped'): number {
	if (!metrics.success || metrics.sampleCount < CALIBRATION_MIN_SAMPLES) return -1_000_000;

	const averageFps = Math.max(0, metrics.averageFps);
	const onePercentLowFps = Math.max(0, metrics.onePercentLowFps);
	const p95FrameRate = metrics.p95FrameTimeMs > 0 ? 1_000 / metrics.p95FrameTimeMs : 0;
	const consistency = averageFps > 0 ? Math.min(1, onePercentLowFps / averageFps) : 0;
	const longFramePenalty = Math.max(0, metrics.longFrameRatio) * 300;
	const worstFramePenalty = Math.max(0, metrics.worstFrameTimeMs - metrics.p95FrameTimeMs) * 0.08;

	return Math.round((
		averageFps * 0.28
		+ onePercentLowFps * 0.42
		+ p95FrameRate * 0.24
		+ consistency * 20
		- longFramePenalty
		- worstFramePenalty
	) * 100) / 100;
}

export function calibrationScoreWinThreshold(incumbentScore: number): number {
	return Math.max(CALIBRATION_SCORE_TIE_MINIMUM, Math.abs(incumbentScore) * CALIBRATION_SCORE_MEANINGFUL_WIN_RATIO);
}

export function isMeaningfulCalibrationScoreWin(challengerScore: number, incumbentScore: number): boolean {
	if (!Number.isFinite(challengerScore) || !Number.isFinite(incumbentScore)) return false;
	return challengerScore > incumbentScore + calibrationScoreWinThreshold(incumbentScore);
}

function resultHasLowConfidenceEvidence(result: CalibrationResult): boolean {
	return metricsLowConfidenceReasons(result.metrics).length > 0;
}

function resultVerificationConfidence(result: CalibrationResult): number {
	if (result.backendVerification.status === 'verified' || result.candidate.backend === 'default') return 1;
	return 0;
}

function choosePreferredResult(current: CalibrationResult | undefined, challenger: CalibrationResult): CalibrationResult {
	if (!current) return challenger;
	if (isMeaningfulCalibrationScoreWin(challenger.score, current.score)) return challenger;
	if (isMeaningfulCalibrationScoreWin(current.score, challenger.score)) return current;

	const currentIsLowConfidence = resultHasLowConfidenceEvidence(current);
	const challengerIsLowConfidence = resultHasLowConfidenceEvidence(challenger);
	if (currentIsLowConfidence !== challengerIsLowConfidence) return currentIsLowConfidence ? challenger : current;

	const currentVerificationConfidence = resultVerificationConfidence(current);
	const challengerVerificationConfidence = resultVerificationConfidence(challenger);
	if (currentVerificationConfidence !== challengerVerificationConfidence) {
		return challengerVerificationConfidence > currentVerificationConfidence ? challenger : current;
	}
	return current;
}

function selectPreferredResult(results: CalibrationResult[]): CalibrationResult | undefined {
	return results.reduce<CalibrationResult | undefined>((preferred, result) => choosePreferredResult(preferred, result), undefined);
}

function uncappedMetricsShowSevereInstability(metrics: CalibrationMetrics): boolean {
	const lowRatio = metrics.averageFps > 0 ? metrics.onePercentLowFps / metrics.averageFps : 0;
	return metrics.longFrameRatio > 0.03 || lowRatio < 0.4 || metrics.p95FrameTimeMs > 25;
}

function stageCappedRecoveryCandidate(
	state: CalibrationState,
	candidate: CalibrationCandidate,
	metrics: CalibrationMetrics,
	backendVerification: EffectiveBackendVerification,
	failureReason?: string
): CalibrationCandidate[] {
	if (
		candidate.framePolicy !== 'uncapped'
		|| failureReason
		|| !metrics.success
		|| metrics.sampleCount < CALIBRATION_MIN_SAMPLES
		|| metricsLowConfidenceReasons(metrics).length > 0
		|| backendVerification.status === 'mismatch'
		|| !uncappedMetricsShowSevereInstability(metrics)
		|| state.candidates.some(existing => existing.framePolicy === 'capped')
	) return state.candidates;

	const recoveryCandidate = makeCandidate(candidate.backend, 'capped');
	const candidateIndex = state.candidates.findIndex(existing => existing.id === candidate.id);
	const insertionIndex = candidateIndex < 0 ? state.candidates.length : candidateIndex + 1;
	return [
		...state.candidates.slice(0, insertionIndex),
		recoveryCandidate,
		...state.candidates.slice(insertionIndex)
	];
}

export function recordCalibrationResult(
	state: CalibrationState,
	candidate: CalibrationCandidate,
	metrics: CalibrationMetrics,
	failureReason?: string
): CalibrationState {
	const normalizedMetrics: CalibrationMetrics = {
		...metrics,
		lowConfidenceReasons: metricsLowConfidenceReasons(metrics)
	};
	const backendVerification = verifyEffectiveRendererBackend(candidate.backend, normalizedMetrics.webglRenderer);
	const verificationFailureReason = backendVerification.status === 'mismatch'
		? `Requested ${candidate.backend}, but WebGL reported ${backendVerification.detectedBackend}.`
		: undefined;
	const result: CalibrationResult = {
		backendVerification,
		candidate,
		...(failureReason || verificationFailureReason ? { failureReason: failureReason ?? verificationFailureReason } : {}),
		metrics: normalizedMetrics,
		score: calculateCalibrationScore(normalizedMetrics, candidate.framePolicy)
	};
	const results = [...state.results.filter(existing => existing.candidate.id !== candidate.id), result];
	const candidates = stageCappedRecoveryCandidate(state, candidate, normalizedMetrics, backendVerification, result.failureReason);

	return {
		...state,
		candidates,
		results,
		updatedAt: Date.now()
	};
}

function isValidCalibrationResult(result: CalibrationResult): boolean {
	return result.metrics.success
		&& result.metrics.sampleCount >= CALIBRATION_MIN_SAMPLES
		&& result.backendVerification.status !== 'mismatch';
}

function isKnownGoodCalibrationResult(result: CalibrationResult | undefined): result is CalibrationResult {
	return Boolean(
		result
		&& isValidCalibrationResult(result)
		&& !result.failureReason
		&& !resultHasLowConfidenceEvidence(result)
	);
}

export function finalizeCalibration(state: CalibrationState): CalibrationState {
	const validResults = state.results.filter(isValidCalibrationResult);
	const bestUncapped = selectPreferredResult(validResults.filter(result => result.candidate.framePolicy === 'uncapped'));
	const bestCapped = selectPreferredResult(validResults.filter(result => result.candidate.framePolicy === 'capped'));

	let recommendedSelection = bestUncapped ?? bestCapped;
	if (bestUncapped && bestCapped) {
		const uncappedIsUnstable = uncappedMetricsShowSevereInstability(bestUncapped.metrics);
		const cappedFixesInstability = bestCapped.metrics.longFrameRatio <= bestUncapped.metrics.longFrameRatio * 0.5
			&& bestCapped.metrics.onePercentLowFps >= bestUncapped.metrics.onePercentLowFps * 1.25;
		const cappedPreservesThroughput = bestCapped.metrics.averageFps >= bestUncapped.metrics.averageFps * 0.9;

		if (
			uncappedIsUnstable
			&& cappedFixesInstability
			&& cappedPreservesThroughput
			&& isMeaningfulCalibrationScoreWin(bestCapped.score, bestUncapped.score)
		) recommendedSelection = bestCapped;
	}

	const activeSelection = state.activeSelection;
	if (
		recommendedSelection
		&& activeSelection
		&& recommendedSelection.candidate.id !== activeSelection.candidate.id
		&& isKnownGoodCalibrationResult(activeSelection)
		&& !isMeaningfulCalibrationScoreWin(recommendedSelection.score, activeSelection.score)
	) recommendedSelection = activeSelection;

	if (!recommendedSelection && isKnownGoodCalibrationResult(activeSelection)) recommendedSelection = activeSelection;

	return {
		...state,
		...(recommendedSelection ? { recommendedSelection } : {}),
		status: 'awaiting-confirmation',
		updatedAt: Date.now()
	};
}

export function completeCalibration(state: CalibrationState, applyRecommendation: boolean): CalibrationState {
	return {
		...state,
		...(applyRecommendation && state.recommendedSelection ? { activeSelection: state.recommendedSelection } : {}),
		completedAt: Date.now(),
		rerunRequested: false,
		status: 'complete',
		updatedAt: Date.now()
	};
}

export function requestCalibrationRerun(state: CalibrationState): CalibrationState {
	return {
		...state,
		rerunRequested: true,
		updatedAt: Date.now()
	};
}

function parseCandidate(value: unknown): CalibrationCandidate | undefined {
	if (!isRecord(value) || !isAppliedBackend(value.backend) || !isFramePolicy(value.framePolicy)) return undefined;
	const id = calibrationCandidateId(value.backend, value.framePolicy);
	if (value.id !== id) return undefined;
	return { backend: value.backend, framePolicy: value.framePolicy, id };
}

function parseLowConfidenceReasons(value: unknown): CalibrationLowConfidenceReason[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter(isLowConfidenceReason))];
}

function parseMetrics(value: unknown): CalibrationMetrics | undefined {
	if (!isRecord(value)) return undefined;
	return {
		averageFps: finiteNumber(value.averageFps),
		eventLoopP95Ms: finiteNumber(value.eventLoopP95Ms),
		eventLoopWorstMs: finiteNumber(value.eventLoopWorstMs),
		longFrameRatio: finiteNumber(value.longFrameRatio),
		lowConfidenceReasons: parseLowConfidenceReasons(value.lowConfidenceReasons),
		onePercentLowFps: finiteNumber(value.onePercentLowFps),
		p95FrameTimeMs: finiteNumber(value.p95FrameTimeMs),
		sampleCount: Math.max(0, Math.trunc(finiteNumber(value.sampleCount))),
		success: value.success === true,
		webglRenderer: typeof value.webglRenderer === 'string' ? value.webglRenderer : '',
		worstFrameTimeMs: finiteNumber(value.worstFrameTimeMs)
	};
}

function parseResult(value: unknown): CalibrationResult | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = parseCandidate(value.candidate);
	const metrics = parseMetrics(value.metrics);
	if (!candidate || !metrics) return undefined;
	return {
		backendVerification: verifyEffectiveRendererBackend(candidate.backend, metrics.webglRenderer),
		candidate,
		...(typeof value.failureReason === 'string' ? { failureReason: value.failureReason } : {}),
		metrics,
		score: finiteNumber(value.score, calculateCalibrationScore(metrics, candidate.framePolicy))
	};
}

function parseSignature(value: unknown): CalibrationSignature | undefined {
	if (!isRecord(value)
		|| !Number.isInteger(value.benchmarkVersion)
		|| Number(value.benchmarkVersion) < 1
		|| typeof value.driverFingerprint !== 'string'
		|| typeof value.electronVersion !== 'string'
		|| typeof value.hardwareFingerprint !== 'string') return undefined;

	return {
		appVersion: typeof value.appVersion === 'string' ? value.appVersion : '',
		benchmarkVersion: Number(value.benchmarkVersion),
		driverFingerprint: value.driverFingerprint,
		electronVersion: value.electronVersion,
		hardwareFingerprint: value.hardwareFingerprint
	};
}

export function parseCalibrationState(value: unknown): CalibrationState | undefined {
	if (!isRecord(value) || value.version !== CALIBRATION_STATE_VERSION) return undefined;
	if (value.status !== 'running' && value.status !== 'awaiting-confirmation' && value.status !== 'complete') return undefined;
	const signature = parseSignature(value.signature);
	if (!signature || !Array.isArray(value.candidates) || !Array.isArray(value.results)) return undefined;

	const candidates = value.candidates.map(parseCandidate);
	const results = value.results.map(parseResult);
	if (candidates.some(candidate => candidate === undefined) || results.some(result => result === undefined)) return undefined;
	const recommendedSelection = parseResult(value.recommendedSelection);
	const activeSelection = parseResult(value.activeSelection);

	return {
		...(activeSelection ? { activeSelection } : {}),
		candidates: candidates as CalibrationCandidate[],
		competitiveModeWasEnabled: value.competitiveModeWasEnabled === true,
		...(typeof value.completedAt === 'number' ? { completedAt: value.completedAt } : {}),
		...(recommendedSelection ? { recommendedSelection } : {}),
		rerunRequested: value.rerunRequested === true,
		results: results as CalibrationResult[],
		signature,
		status: value.status,
		updatedAt: finiteNumber(value.updatedAt, Date.now()),
		version: CALIBRATION_STATE_VERSION
	};
}
