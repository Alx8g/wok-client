import type { AppliedGraphicsBackend } from './graphics-profile.ts';
import { WORKLOAD_VERSION } from './calibration-workload.ts';
import { BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG, BENCHMARK_REJECTION_REASONS, BENCHMARK_RUN_RETRY_BUDGET, type BenchmarkRejectionReason } from './calibration-benchmark.ts';
const CALIBRATION_STATE_VERSION = 2;
export const CALIBRATION_VERSION = 5;
export const CALIBRATION_BENCHMARK_MS = 2800;
export const CALIBRATION_MIN_SAMPLES = 45;
export const CALIBRATION_SCORE_TIE_MINIMUM = 5;
export const CALIBRATION_SCORE_MEANINGFUL_WIN_RATIO = 0.03;
export const CALIBRATION_CLEAR_WIN_TIE_MULTIPLIER = 3;
export const CALIBRATION_CLEAR_WIN_RATIO = 0.1;
export const CALIBRATION_OVERLAP_WIN_MARGIN_MULTIPLIER = 2;
export const CALIBRATION_OVERLAP_MAX_UNION_FRACTION = 0.25;
export const CALIBRATION_RUN_BUDGET_MS = 90000;
export const CALIBRATION_MAX_LAUNCHES = 6;
export const CALIBRATION_PROVISIONAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const CALIBRATION_INTRA_LAUNCH_COOLDOWN_MS = 500;
export const FRAME_POLICIES = ['uncapped', 'capped'] as const;
export type FramePolicy = (typeof FRAME_POLICIES)[number];
export type CalibrationStatus = 'uncalibrated' | 'running' | 'awaiting-confirmation' | 'complete';
export type CalibrationConfirmationStatus = 'pending' | 'confirmed' | 'rolled-back' | 'unwatched';
export type CalibrationTrialStage = 'screen' | 'repeat' | 'recovery';
export const CALIBRATION_LOW_CONFIDENCE_REASONS = [
	'window-blurred',
	'document-visibility-changed',
	'window-resized',
	'webgl-context-lost',
	'severe-event-loop-disturbance',
	'gpu-disjoint-excessive',
	'power-state-changed',
	'insufficient-samples',
	'gpu-queue-exceeds-frame-budget'
] as const;
export type CalibrationLowConfidenceReason = (typeof CALIBRATION_LOW_CONFIDENCE_REASONS)[number];
export const CALIBRATION_TRIAL_REJECTION_REASONS = BENCHMARK_REJECTION_REASONS;
export type CalibrationTrialRejectionReason = BenchmarkRejectionReason;
export type CalibrationGpuTimingStatus = 'measured' | 'unsupported' | 'unreliable';
export type ExplicitGraphicsBackend = Exclude<AppliedGraphicsBackend, 'default'>;
export type EffectiveBackendVerificationStatus = 'verified' | 'mismatch' | 'indeterminate';
export interface EffectiveBackendVerification {
	candidateBackend: AppliedGraphicsBackend;
	detectedBackend?: ExplicitGraphicsBackend;
	status: EffectiveBackendVerificationStatus;
}
export interface CalibrationSignature {
	appVersion: string;
	benchmarkVersion: number;
	driverFingerprint: string;
	electronVersion: string;
	hardwareFingerprint: string;
	workloadVersion: number;
}
export interface CalibrationCandidate {
	backend: AppliedGraphicsBackend;
	framePolicy: FramePolicy;
	id: string;
}
export interface CalibrationTrialEnvironment {
	devicePixelRatio: number;
	drawingBufferHeight: number;
	drawingBufferWidth: number;
	onBattery?: boolean;
	refreshRateHz?: number;
}
export interface CalibrationMetrics {
	averageFps: number;
	contaminationFlags?: string[];
	cpuSubmitP50Ms?: number;
	cpuSubmitP95Ms?: number;
	environment?: CalibrationTrialEnvironment;
	eventLoopP95Ms: number;
	eventLoopWorstMs?: number;
	gpuDisjointDiscardCount?: number;
	gpuTimeP50Ms?: number;
	gpuTimeP95Ms?: number;
	gpuTimingStatus?: CalibrationGpuTimingStatus;
	longFrameRatio: number;
	lowConfidenceReasons?: CalibrationLowConfidenceReason[];
	onePercentLowFps: number;
	p95FrameTimeMs: number;
	rejectionReasons?: CalibrationTrialRejectionReason[];
	sampleCount: number;
	stallRatio?: number;
	success: boolean;
	webglRenderer: string;
	workloadVersion?: number;
	worstFrameTimeMs: number;
}
export interface CalibrationResult {
	backendVerification: EffectiveBackendVerification;
	candidate: CalibrationCandidate;
	failureReason?: string;
	fieldRejected?: true;
	metrics: CalibrationMetrics;
	score: number;
	slotIndex?: number;
}
export interface CalibrationTrialSlot {
	candidateId: string;
	launchGroup: number;
	stage: CalibrationTrialStage;
}
export interface CalibrationState {
	activeSelection?: CalibrationResult;
	autoRollbackUsed?: true;
	calibrationOfferDeclinedAt?: number;
	candidates: CalibrationCandidate[];
	competitiveModeWasEnabled: boolean;
	completedAt?: number;
	completionReason?: string;
	confirmation?: CalibrationConfirmationStatus;
	fieldRejectedCandidateIds: string[];
	launchCount: number;
	plan: CalibrationTrialSlot[];
	runRetriesUsed: number;
	planCreatedAt?: number;
	previousSelection?: CalibrationResult;
	provisionalSince?: number;
	recommendedSelection?: CalibrationResult;
	rejectedAttempts: CalibrationResult[];
	rerunRequested: boolean;
	results: CalibrationResult[];
	signature: CalibrationSignature;
	signatureStale?: true;
	staleRerunPromptShownAt?: number;
	startedAt?: number;
	status: CalibrationStatus;
	updatedAt: number;
	version: 2;
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
function isTrialRejectionReason(value: unknown): value is CalibrationTrialRejectionReason {
	return typeof value === 'string' && CALIBRATION_TRIAL_REJECTION_REASONS.includes(value as CalibrationTrialRejectionReason);
}
function finiteNumber(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function optionalFiniteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function metricsLowConfidenceReasons(metrics: CalibrationMetrics): CalibrationLowConfidenceReason[] {
	return [...new Set((metrics.lowConfidenceReasons ?? []).filter(isLowConfidenceReason))];
}
function fnv1aHash(value: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
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
export function createCalibrationCandidates({ blockedBackends = [], currentBackend, currentFramePolicy, platform = process.platform, recommendedBackend }: CalibrationCandidateOptions): CalibrationCandidate[] {
	const candidates: CalibrationCandidate[] = [];
	const blocked = new Set(blockedBackends);
	const addCandidate = (backend: AppliedGraphicsBackend, framePolicy: FramePolicy) => {
		if (blocked.has(backend) || (platform !== 'win32' && (backend === 'd3d11' || backend === 'd3d11on12'))) return;
		const candidate = makeCandidate(backend, framePolicy);
		if (!candidates.some((existing) => existing.id === candidate.id)) candidates.push(candidate);
	};
	addCandidate(currentBackend, currentFramePolicy);
	addCandidate(recommendedBackend, 'uncapped');
	if (platform === 'win32' && recommendedBackend === 'd3d11on12') addCandidate('default', 'uncapped');
	if (candidates.length === 0) addCandidate('default', 'uncapped');
	return candidates.slice(0, 2);
}
export function calibrationOffersBackendComparison(candidates: CalibrationCandidate[], platform: NodeJS.Platform = process.platform): boolean {
	const backends = new Set(candidates.map((candidate) => (platform === 'win32' && candidate.backend === 'd3d11' ? 'default' : candidate.backend)));
	return backends.size > 1;
}
export const CALIBRATION_NO_COMPARISON_REASON =
	'Only the Chromium default backend is available to benchmark on this platform, so calibration completed immediately with the default profile instead of measuring one candidate against itself.';
export function completeCalibrationWithoutComparison(state: CalibrationState, reason: string = CALIBRATION_NO_COMPARISON_REASON, now: number = Date.now()): CalibrationState {
	return {
		...state,
		completedAt: now,
		completionReason: reason,
		rerunRequested: false,
		status: 'complete',
		updatedAt: now
	};
}
function detectEffectiveRendererBackend(webglRenderer: string): ExplicitGraphicsBackend | undefined {
	const normalized = webglRenderer.toLowerCase();
	const compact = normalized.replaceAll(/[\s_-]+/gu, '');
	if (compact.includes('d3d11on12') || compact.includes('direct3d11on12')) return 'd3d11on12';
	if (normalized.includes('vulkan')) return 'vulkan';
	if (compact.includes('d3d11') || compact.includes('direct3d11')) return 'd3d11';
	return undefined;
}
export function verifyEffectiveRendererBackend(candidateBackend: AppliedGraphicsBackend, webglRenderer: string): EffectiveBackendVerification {
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
export function createCalibrationSignature(appVersion: string, electronVersion: string, hardwareFingerprint: string, driverFingerprint: string, workloadVersion: number = WORKLOAD_VERSION): CalibrationSignature {
	return {
		appVersion,
		benchmarkVersion: CALIBRATION_VERSION,
		driverFingerprint,
		electronVersion,
		hardwareFingerprint,
		workloadVersion
	};
}
export function calibrationSignaturesEqual(left: CalibrationSignature, right: CalibrationSignature): boolean {
	return (
		left.benchmarkVersion === right.benchmarkVersion &&
		left.driverFingerprint === right.driverFingerprint &&
		left.electronVersion === right.electronVersion &&
		left.hardwareFingerprint === right.hardwareFingerprint &&
		left.workloadVersion === right.workloadVersion
	);
}
export function calibrationSignatureOnlyVersionsDiffer(left: CalibrationSignature, right: CalibrationSignature): boolean {
	return !calibrationSignaturesEqual(left, right) && left.driverFingerprint === right.driverFingerprint && left.electronVersion === right.electronVersion && left.hardwareFingerprint === right.hardwareFingerprint;
}
export function createCalibrationState(signature: CalibrationSignature, candidates: CalibrationCandidate[], competitiveModeWasEnabled: boolean, previousState?: CalibrationState): CalibrationState {
	const sameSignature = previousState && calibrationSignaturesEqual(previousState.signature, signature);
	const preserveSelection = sameSignature ? (previousState.activeSelection ?? previousState.recommendedSelection) : undefined;
	return {
		...(preserveSelection ? { activeSelection: preserveSelection } : {}),
		...(sameSignature && previousState.autoRollbackUsed ? { autoRollbackUsed: true as const } : {}),
		...(previousState?.calibrationOfferDeclinedAt !== undefined ? { calibrationOfferDeclinedAt: previousState.calibrationOfferDeclinedAt } : {}),
		candidates,
		competitiveModeWasEnabled,
		fieldRejectedCandidateIds: sameSignature ? previousState.fieldRejectedCandidateIds : [],
		launchCount: 0,
		plan: [],
		rejectedAttempts: [],
		rerunRequested: false,
		runRetriesUsed: 0,
		results: [],
		signature,
		status: 'uncalibrated',
		updatedAt: Date.now(),
		version: CALIBRATION_STATE_VERSION
	};
}
export function startCalibrationRun(state: CalibrationState, now: number = Date.now()): CalibrationState {
	if (state.status === 'running') return state;
	const screenCandidates = [...state.candidates];
	if (screenCandidates.length === 2 && (fnv1aHash(`${state.signature.hardwareFingerprint}:${now}`) & 1) === 1) {
		screenCandidates.reverse();
	}
	const {
		completedAt: _completedAt,
		completionReason: _completionReason,
		confirmation: _confirmation,
		previousSelection: _previousSelection,
		provisionalSince: _provisionalSince,
		recommendedSelection: _recommendedSelection,
		signatureStale: _signatureStale,
		staleRerunPromptShownAt: _stalePrompt,
		...rest
	} = state;
	return {
		...rest,
		launchCount: 0,
		plan: screenCandidates.map((candidate, index) => ({ candidateId: candidate.id, launchGroup: index + 1, stage: 'screen' as const })),
		planCreatedAt: now,
		rejectedAttempts: [],
		rerunRequested: false,
		results: [],
		runRetriesUsed: 0,
		startedAt: now,
		status: 'running',
		updatedAt: now
	};
}
function coveredSlotIndices(state: CalibrationState): Set<number> {
	return new Set(state.results.map((result) => result.slotIndex).filter((index): index is number => typeof index === 'number'));
}
export function getPendingCalibrationSlotIndex(state: CalibrationState): number | undefined {
	if (state.status !== 'running') return undefined;
	const covered = coveredSlotIndices(state);
	for (let index = 0; index < state.plan.length; index++) {
		if (!covered.has(index)) return index;
	}
	return undefined;
}
export function getPendingCalibrationCandidate(state: CalibrationState): CalibrationCandidate | undefined {
	const slotIndex = getPendingCalibrationSlotIndex(state);
	if (slotIndex === undefined) return undefined;
	const candidateId = state.plan[slotIndex].candidateId;
	return state.candidates.find((candidate) => candidate.id === candidateId);
}
export function getPendingLaunchSlotIndices(state: CalibrationState): number[] {
	const first = getPendingCalibrationSlotIndex(state);
	if (first === undefined) return [];
	const covered = coveredSlotIndices(state);
	const group = state.plan[first].launchGroup;
	const candidateId = state.plan[first].candidateId;
	const indices: number[] = [];
	for (let index = first; index < state.plan.length; index++) {
		const slot = state.plan[index];
		if (slot.launchGroup !== group || slot.candidateId !== candidateId) break;
		if (!covered.has(index)) indices.push(index);
	}
	return indices;
}
export function calibrationResumeRequired(state: CalibrationState | undefined): boolean {
	if (!state) return false;
	if (state.rerunRequested) return true;
	if (state.status === 'awaiting-confirmation') return true;
	return getPendingCalibrationCandidate(state) !== undefined;
}
export function recordCalibrationLaunch(state: CalibrationState, now: number = Date.now()): CalibrationState {
	if (state.status !== 'running') return state;
	return {
		...state,
		launchCount: state.launchCount + 1,
		startedAt: state.startedAt ?? now,
		updatedAt: now
	};
}
export function isCalibrationRunTimeBudgetExhausted(state: CalibrationState, now: number = Date.now()): boolean {
	return state.status === 'running' && state.startedAt !== undefined && now - state.startedAt > CALIBRATION_RUN_BUDGET_MS;
}
export function clampCalibrationTrialDeadline(state: CalibrationState | undefined, requestedDeadlineAt: number): number {
	if (state?.status !== 'running' || state.startedAt === undefined) return requestedDeadlineAt;
	return Math.min(requestedDeadlineAt, state.startedAt + CALIBRATION_RUN_BUDGET_MS);
}
export function isCalibrationBudgetExhausted(state: CalibrationState, now: number = Date.now()): boolean {
	return state.status === 'running' && (state.launchCount >= CALIBRATION_MAX_LAUNCHES || isCalibrationRunTimeBudgetExhausted(state, now));
}
export function canStartCalibrationLaunch(state: CalibrationState, now: number = Date.now()): boolean {
	return state.status === 'running' && !isCalibrationBudgetExhausted(state, now);
}
export function tryRecordCalibrationLaunch(state: CalibrationState, now: number = Date.now()): CalibrationState | undefined {
	return canStartCalibrationLaunch(state, now) ? recordCalibrationLaunch(state, now) : undefined;
}
export function prepareCalibrationState(
	existing: CalibrationState | undefined,
	signature: CalibrationSignature,
	candidates: CalibrationCandidate[],
	competitiveModeEnabled: boolean,
	platform: NodeJS.Platform = process.platform
): CalibrationState {
	if (existing && calibrationSignaturesEqual(existing.signature, signature) && !existing.rerunRequested) {
		if (existing.signature.appVersion === signature.appVersion) return existing;
		return {
			...existing,
			signature,
			updatedAt: Date.now()
		};
	}
	if (existing && !existing.rerunRequested && existing.status === 'complete' && calibrationSignatureOnlyVersionsDiffer(existing.signature, signature)) {
		if (existing.signatureStale) return existing;
		return {
			...existing,
			signatureStale: true,
			updatedAt: Date.now()
		};
	}
	const reset = createCalibrationState(signature, candidates, competitiveModeEnabled, existing);
	if (!calibrationOffersBackendComparison(candidates, platform)) {
		return completeCalibrationWithoutComparison(reset);
	}
	return existing?.rerunRequested ? startCalibrationRun(reset) : reset;
}
export function calculateCalibrationScore(metrics: CalibrationMetrics, _framePolicy: FramePolicy = 'uncapped'): number {
	if (!metrics.success || metrics.sampleCount < CALIBRATION_MIN_SAMPLES) return -1000000;
	const averageFps = Math.max(0, metrics.averageFps);
	const onePercentLowFps = Math.max(0, metrics.onePercentLowFps);
	const p95FrameRate = metrics.p95FrameTimeMs > 0 ? 1000 / metrics.p95FrameTimeMs : 0;
	const consistency = averageFps > 0 ? Math.min(1, onePercentLowFps / averageFps) : 0;
	const longFramePenalty = Math.max(0, metrics.longFrameRatio) * 300;
	const worstFramePenalty = Math.max(0, metrics.worstFrameTimeMs - metrics.p95FrameTimeMs) * 0.08;
	return Math.round((averageFps * 0.28 + onePercentLowFps * 0.42 + p95FrameRate * 0.24 + consistency * 20 - longFramePenalty - worstFramePenalty) * 100) / 100;
}
export function calibrationScoreWinThreshold(incumbentScore: number): number {
	return Math.max(CALIBRATION_SCORE_TIE_MINIMUM, Math.abs(incumbentScore) * CALIBRATION_SCORE_MEANINGFUL_WIN_RATIO);
}
export function isMeaningfulCalibrationScoreWin(challengerScore: number, incumbentScore: number): boolean {
	if (!Number.isFinite(challengerScore) || !Number.isFinite(incumbentScore)) return false;
	return challengerScore > incumbentScore + calibrationScoreWinThreshold(incumbentScore);
}
export function calibrationClearWinMargin(loserScore: number): number {
	return Math.max(CALIBRATION_SCORE_TIE_MINIMUM * CALIBRATION_CLEAR_WIN_TIE_MULTIPLIER, Math.abs(loserScore) * CALIBRATION_CLEAR_WIN_RATIO);
}
function resultHasLowConfidenceEvidence(result: CalibrationResult): boolean {
	return metricsLowConfidenceReasons(result.metrics).length > 0;
}
export function metricsShowFencePacingArtifact(metrics: CalibrationMetrics): boolean {
	return (metrics.contaminationFlags ?? []).includes(BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG);
}
function resultShowsFencePacingArtifact(result: CalibrationResult): boolean {
	return metricsShowFencePacingArtifact(result.metrics);
}
function resultVerificationConfidence(result: CalibrationResult): number {
	if (result.backendVerification.status === 'verified' || result.candidate.backend === 'default') return 1;
	return 0;
}
function resultsNumericallyComparable(left: CalibrationResult, right: CalibrationResult): boolean {
	return (left.metrics.workloadVersion ?? 0) === (right.metrics.workloadVersion ?? 0);
}
function choosePreferredResult(current: CalibrationResult | undefined, challenger: CalibrationResult): CalibrationResult {
	if (!current) return challenger;
	if (resultsNumericallyComparable(current, challenger)) {
		if (isMeaningfulCalibrationScoreWin(challenger.score, current.score)) return challenger;
		if (isMeaningfulCalibrationScoreWin(current.score, challenger.score)) return current;
	}
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
function maxLaunchGroup(plan: CalibrationTrialSlot[]): number {
	return plan.reduce((maximum, slot) => Math.max(maximum, slot.launchGroup), 0);
}
function isValidCalibrationResult(result: CalibrationResult): boolean {
	return result.metrics.success && result.metrics.sampleCount >= CALIBRATION_MIN_SAMPLES && result.backendVerification.status !== 'mismatch';
}
function isCleanCalibrationResult(result: CalibrationResult): boolean {
	return isValidCalibrationResult(result) && !result.failureReason && !resultHasLowConfidenceEvidence(result) && !resultShowsFencePacingArtifact(result);
}
function isKnownGoodCalibrationResult(result: CalibrationResult | undefined): result is CalibrationResult {
	return Boolean(result && isCleanCalibrationResult(result));
}
function appendRepeatStageIfNeeded(plan: CalibrationTrialSlot[], results: CalibrationResult[]): CalibrationTrialSlot[] {
	if (plan.some((slot) => slot.stage === 'repeat')) return plan;
	const screenSlotIndices = plan.map((slot, index) => ({ index, slot })).filter((entry) => entry.slot.stage === 'screen');
	if (screenSlotIndices.length !== 2) return plan;
	const [first, second] = screenSlotIndices;
	if (first.slot.candidateId === second.slot.candidateId) return plan;
	const firstResult = results.find((result) => result.slotIndex === first.index);
	const secondResult = results.find((result) => result.slotIndex === second.index);
	if (!firstResult || !secondResult) return plan;
	if (!isValidCalibrationResult(firstResult) || !isValidCalibrationResult(secondResult)) return plan;
	if (resultShowsFencePacingArtifact(firstResult) || resultShowsFencePacingArtifact(secondResult)) return plan;
	const bothClean = isCleanCalibrationResult(firstResult) && isCleanCalibrationResult(secondResult);
	const loserScore = Math.min(firstResult.score, secondResult.score);
	if (bothClean && Math.abs(firstResult.score - secondResult.score) >= calibrationClearWinMargin(loserScore)) return plan;
	const nextGroup = maxLaunchGroup(plan) + 1;
	return [
		...plan,
		{ candidateId: first.slot.candidateId, launchGroup: nextGroup, stage: 'repeat' },
		{ candidateId: first.slot.candidateId, launchGroup: nextGroup, stage: 'repeat' },
		{ candidateId: second.slot.candidateId, launchGroup: nextGroup + 1, stage: 'repeat' },
		{ candidateId: second.slot.candidateId, launchGroup: nextGroup + 1, stage: 'repeat' }
	];
}
export function recordCalibrationResult(state: CalibrationState, candidate: CalibrationCandidate, metrics: CalibrationMetrics, failureReason?: string): CalibrationState {
	const normalizedMetrics: CalibrationMetrics = {
		...metrics,
		lowConfidenceReasons: metricsLowConfidenceReasons(metrics),
		workloadVersion: metrics.workloadVersion ?? state.signature.workloadVersion
	};
	const backendVerification = verifyEffectiveRendererBackend(candidate.backend, normalizedMetrics.webglRenderer);
	const verificationFailureReason = backendVerification.status === 'mismatch' ? `Requested ${candidate.backend}, but WebGL reported ${backendVerification.detectedBackend}.` : undefined;
	const covered = coveredSlotIndices(state);
	let plan = state.plan;
	let slotIndex = plan.findIndex((slot, index) => !covered.has(index) && slot.candidateId === candidate.id);
	if (slotIndex < 0) {
		plan = [
			...plan,
			{
				candidateId: candidate.id,
				launchGroup: maxLaunchGroup(plan) + 1,
				stage: candidate.framePolicy === 'capped' ? 'recovery' : 'screen'
			}
		];
		slotIndex = plan.length - 1;
	}
	const result: CalibrationResult = {
		backendVerification,
		candidate,
		...(failureReason || verificationFailureReason ? { failureReason: failureReason ?? verificationFailureReason } : {}),
		metrics: normalizedMetrics,
		score: calculateCalibrationScore(normalizedMetrics, candidate.framePolicy),
		slotIndex
	};
	const results = [...state.results, result];
	plan = appendRepeatStageIfNeeded(plan, results);
	return {
		...state,
		plan,
		results,
		updatedAt: Date.now()
	};
}
export function recordRejectedCalibrationAttempt(state: CalibrationState, candidate: CalibrationCandidate, metrics: CalibrationMetrics): CalibrationState {
	const normalizedMetrics: CalibrationMetrics = {
		...metrics,
		lowConfidenceReasons: metricsLowConfidenceReasons(metrics),
		workloadVersion: metrics.workloadVersion ?? state.signature.workloadVersion
	};
	const attempt: CalibrationResult = {
		backendVerification: verifyEffectiveRendererBackend(candidate.backend, normalizedMetrics.webglRenderer),
		candidate,
		metrics: normalizedMetrics,
		score: calculateCalibrationScore(normalizedMetrics, candidate.framePolicy)
	};
	return {
		...state,
		rejectedAttempts: [...state.rejectedAttempts, attempt],
		updatedAt: Date.now()
	};
}
export function recordCalibrationRetryLaunch(state: CalibrationState, now: number = Date.now()): CalibrationState {
	if (state.status !== 'running') {
		throw new Error('Calibration retries can only launch while a run is active.');
	}
	if (state.runRetriesUsed >= BENCHMARK_RUN_RETRY_BUDGET) {
		throw new Error('Calibration retry budget is already exhausted.');
	}
	return {
		...state,
		runRetriesUsed: state.runRetriesUsed + 1,
		updatedAt: now
	};
}
export interface CalibrationTrialAttemptOutcome {
	aborted: boolean;
	failureReason?: string;
	metrics: CalibrationMetrics;
}
export interface CalibrationTrialRetryOrchestrationOptions {
	candidate: CalibrationCandidate;
	getState(): CalibrationState | undefined;
	isRunTimeBudgetExhausted(state: CalibrationState): boolean;
	persistState(state: CalibrationState): void;
	runAttempt(attempt: number): Promise<CalibrationTrialAttemptOutcome>;
}
function pickBetterRejectedAttempt(first: CalibrationMetrics, second: CalibrationMetrics): CalibrationMetrics {
	if (first.success !== second.success) return first.success ? first : second;
	if (first.sampleCount !== second.sampleCount) {
		return first.sampleCount > second.sampleCount ? first : second;
	}
	return second.onePercentLowFps > first.onePercentLowFps ? second : first;
}
export async function orchestrateCalibrationTrialRetry(options: CalibrationTrialRetryOrchestrationOptions): Promise<CalibrationTrialAttemptOutcome> {
	let firstRejectedAttempt: CalibrationMetrics | undefined;
	for (let attempt = 1; ; attempt += 1) {
		const outcome = await options.runAttempt(attempt);
		if (outcome.aborted || outcome.failureReason !== undefined) return outcome;
		const rejected = (outcome.metrics.rejectionReasons?.length ?? 0) > 0;
		if (!rejected) return outcome;
		const state = options.getState();
		if (attempt === 1 && state !== undefined && state.runRetriesUsed < BENCHMARK_RUN_RETRY_BUDGET) {
			options.persistState(recordRejectedCalibrationAttempt(state, options.candidate, outcome.metrics));
			firstRejectedAttempt = outcome.metrics;
			const diagnosticState = options.getState();
			if (diagnosticState === undefined || options.isRunTimeBudgetExhausted(diagnosticState)) {
				return outcome;
			}
			options.persistState(recordCalibrationRetryLaunch(diagnosticState));
			continue;
		}
		if (firstRejectedAttempt !== undefined) {
			const better = pickBetterRejectedAttempt(firstRejectedAttempt, outcome.metrics);
			const currentState = options.getState();
			if (better !== outcome.metrics && currentState !== undefined) {
				options.persistState(recordRejectedCalibrationAttempt(currentState, options.candidate, outcome.metrics));
			}
			return {
				aborted: false,
				metrics: better
			};
		}
		return outcome;
	}
}
interface CandidateTrialSummary {
	candidate: CalibrationCandidate;
	cleanTrials: CalibrationResult[];
	lowConfidenceTrialCount: number;
	max: number;
	median: number;
	min: number;
	representative: CalibrationResult | undefined;
	validTrials: CalibrationResult[];
}
function scoreStatistics(scores: number[]): {
	max: number;
	median: number;
	min: number;
} {
	if (scores.length === 0) return { max: Number.NEGATIVE_INFINITY, median: Number.NEGATIVE_INFINITY, min: Number.NEGATIVE_INFINITY };
	const sorted = [...scores].sort((left, right) => left - right);
	const middle = (sorted.length - 1) / 2;
	const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2;
	return { max: sorted[sorted.length - 1], median, min: sorted[0] };
}
function summarizeCandidateTrials(state: CalibrationState, candidate: CalibrationCandidate): CandidateTrialSummary {
	const trials = state.results.filter((result) => result.candidate.id === candidate.id);
	const validTrials = trials.filter(isValidCalibrationResult);
	const cleanTrials = validTrials.filter(isCleanCalibrationResult);
	const statisticsSource = cleanTrials.length > 0 ? cleanTrials : validTrials;
	const statistics = scoreStatistics(statisticsSource.map((trial) => trial.score));
	let representative: CalibrationResult | undefined;
	if (cleanTrials.length > 0) {
		representative = cleanTrials.reduce((closest, trial) => (Math.abs(trial.score - statistics.median) < Math.abs(closest.score - statistics.median) ? trial : closest), cleanTrials[0]);
	} else {
		representative = selectPreferredResult(validTrials);
	}
	return {
		candidate,
		cleanTrials,
		lowConfidenceTrialCount: validTrials.length - cleanTrials.length,
		max: statistics.max,
		median: statistics.median,
		min: statistics.min,
		representative,
		validTrials
	};
}
function summaryGpuTieBreakValue(summary: CandidateTrialSummary): number | undefined {
	const measured = summary.cleanTrials.filter((trial) => trial.metrics.gpuTimingStatus === 'measured' && typeof trial.metrics.gpuTimeP95Ms === 'number').map((trial) => trial.metrics.gpuTimeP95Ms as number);
	if (measured.length === 0) return undefined;
	return scoreStatistics(measured).median;
}
function resolveTiedCandidates(state: CalibrationState, left: CandidateTrialSummary, right: CandidateTrialSummary): CandidateTrialSummary {
	const active = state.activeSelection;
	if (isKnownGoodCalibrationResult(active)) {
		if (active.candidate.id === left.candidate.id) return left;
		if (active.candidate.id === right.candidate.id) return right;
	}
	const leftFieldRejected = state.fieldRejectedCandidateIds.includes(left.candidate.id);
	const rightFieldRejected = state.fieldRejectedCandidateIds.includes(right.candidate.id);
	if (leftFieldRejected !== rightFieldRejected) return leftFieldRejected ? right : left;
	const leftDefault = left.candidate.backend === 'default';
	const rightDefault = right.candidate.backend === 'default';
	if (leftDefault !== rightDefault) return leftDefault ? left : right;
	const verificationConfidence = (summary: CandidateTrialSummary) => (summary.validTrials.some((trial) => resultVerificationConfidence(trial) === 1) ? 1 : 0);
	const leftVerification = verificationConfidence(left);
	const rightVerification = verificationConfidence(right);
	if (leftVerification !== rightVerification) return leftVerification > rightVerification ? left : right;
	if (left.lowConfidenceTrialCount !== right.lowConfidenceTrialCount) {
		return left.lowConfidenceTrialCount < right.lowConfidenceTrialCount ? left : right;
	}
	const leftGpu = summaryGpuTieBreakValue(left);
	const rightGpu = summaryGpuTieBreakValue(right);
	if (leftGpu !== undefined && rightGpu !== undefined && leftGpu !== rightGpu) return leftGpu < rightGpu ? left : right;
	const leftIndex = state.candidates.findIndex((candidate) => candidate.id === left.candidate.id);
	const rightIndex = state.candidates.findIndex((candidate) => candidate.id === right.candidate.id);
	return leftIndex <= rightIndex ? left : right;
}
function summaryShowsFencePacingArtifact(summary: CandidateTrialSummary): boolean {
	return summary.validTrials.some(resultShowsFencePacingArtifact);
}
function resolveArtifactAffectedCandidates(state: CalibrationState, left: CandidateTrialSummary, right: CandidateTrialSummary): CandidateTrialSummary {
	const active = state.activeSelection;
	if (isKnownGoodCalibrationResult(active)) {
		if (active.candidate.id === left.candidate.id) return left;
		if (active.candidate.id === right.candidate.id) return right;
	}
	const leftIndex = state.candidates.findIndex((candidate) => candidate.id === left.candidate.id);
	const rightIndex = state.candidates.findIndex((candidate) => candidate.id === right.candidate.id);
	return leftIndex <= rightIndex ? left : right;
}
function decideBetweenCandidates(state: CalibrationState, left: CandidateTrialSummary, right: CandidateTrialSummary): CandidateTrialSummary {
	if (left.validTrials.length === 0 && right.validTrials.length === 0) return resolveTiedCandidates(state, left, right);
	if (left.validTrials.length === 0) return right;
	if (right.validTrials.length === 0) return left;
	if (summaryShowsFencePacingArtifact(left) || summaryShowsFencePacingArtifact(right)) {
		return resolveArtifactAffectedCandidates(state, left, right);
	}
	const planHasRepeatSlots = state.plan.some((slot) => slot.stage === 'repeat');
	const requiredCleanTrialsToWin = planHasRepeatSlots ? 2 : 1;
	const [high, low] = left.median >= right.median ? [left, right] : [right, left];
	const medianDiff = high.median - low.median;
	const highCanWin = high.cleanTrials.length >= requiredCleanTrialsToWin;
	if (!planHasRepeatSlots) {
		if (highCanWin && low.cleanTrials.length > 0 && Number.isFinite(medianDiff) && medianDiff >= calibrationClearWinMargin(low.median)) return high;
		if (highCanWin && low.cleanTrials.length === 0 && medianDiff >= calibrationScoreWinThreshold(low.median)) return high;
		return resolveTiedCandidates(state, left, right);
	}
	const winMargin = calibrationScoreWinThreshold(low.median);
	const rangesDisjoint = high.min > low.max || low.min > high.max;
	let wins = false;
	let dominantWin = false;
	if (rangesDisjoint) {
		wins = medianDiff >= winMargin;
		dominantWin = wins;
	} else {
		const overlap = Math.min(high.max, low.max) - Math.max(high.min, low.min);
		const union = Math.max(high.max, low.max) - Math.min(high.min, low.min);
		wins = medianDiff >= CALIBRATION_OVERLAP_WIN_MARGIN_MULTIPLIER * winMargin && union > 0 && overlap / union < CALIBRATION_OVERLAP_MAX_UNION_FRACTION;
	}
	if (wins && highCanWin) {
		if (state.fieldRejectedCandidateIds.includes(high.candidate.id) && !dominantWin) return resolveTiedCandidates(state, left, right);
		return high;
	}
	return resolveTiedCandidates(state, left, right);
}
function selectBestSummary(state: CalibrationState, candidates: CalibrationCandidate[]): CandidateTrialSummary | undefined {
	const summaries = candidates.map((candidate) => summarizeCandidateTrials(state, candidate)).filter((summary) => summary.validTrials.length > 0);
	if (summaries.length === 0) return undefined;
	return summaries.reduce((best, summary) => decideBetweenCandidates(state, best, summary));
}
export function finalizeCalibration(state: CalibrationState): CalibrationState {
	const bestUncapped = selectBestSummary(
		state,
		state.candidates.filter((candidate) => candidate.framePolicy === 'uncapped')
	)?.representative;
	const bestCapped = selectBestSummary(
		state,
		state.candidates.filter((candidate) => candidate.framePolicy === 'capped')
	)?.representative;
	let recommendedSelection = bestUncapped ?? bestCapped;
	const activeSelection = state.activeSelection;
	if (
		recommendedSelection &&
		activeSelection &&
		recommendedSelection.candidate.id !== activeSelection.candidate.id &&
		isKnownGoodCalibrationResult(activeSelection) &&
		!(resultsNumericallyComparable(recommendedSelection, activeSelection) && isMeaningfulCalibrationScoreWin(recommendedSelection.score, activeSelection.score))
	)
		recommendedSelection = activeSelection;
	if (!recommendedSelection && isKnownGoodCalibrationResult(activeSelection)) recommendedSelection = activeSelection;
	return {
		...state,
		...(recommendedSelection ? { recommendedSelection } : {}),
		status: 'awaiting-confirmation',
		updatedAt: Date.now()
	};
}
export function completeCalibration(state: CalibrationState, applyRecommendation: boolean, now: number = Date.now()): CalibrationState {
	if (applyRecommendation && state.recommendedSelection) {
		return {
			...state,
			activeSelection: state.recommendedSelection,
			completedAt: now,
			confirmation: 'pending',
			...(state.activeSelection ? { previousSelection: state.activeSelection } : {}),
			provisionalSince: now,
			rerunRequested: false,
			status: 'complete',
			updatedAt: now
		};
	}
	return {
		...state,
		completedAt: now,
		rerunRequested: false,
		status: 'complete',
		updatedAt: now
	};
}
export function confirmCalibration(state: CalibrationState, now: number = Date.now()): CalibrationState {
	if (state.confirmation !== 'pending') return state;
	return {
		...state,
		confirmation: 'confirmed',
		updatedAt: now
	};
}
export function canAutoRollbackCalibration(state: CalibrationState): boolean {
	return state.confirmation === 'pending' && state.autoRollbackUsed !== true;
}
export function rollbackCalibration(state: CalibrationState, now: number = Date.now()): CalibrationState {
	if (!canAutoRollbackCalibration(state)) return state;
	const rejectedCandidateId = state.activeSelection?.candidate.id;
	const { activeSelection: _dropped, ...rest } = state;
	const flagRejected = (result: CalibrationResult): CalibrationResult => (rejectedCandidateId !== undefined && result.candidate.id === rejectedCandidateId ? { ...result, fieldRejected: true } : result);
	return {
		...rest,
		...(state.previousSelection ? { activeSelection: state.previousSelection } : {}),
		autoRollbackUsed: true,
		confirmation: 'rolled-back',
		fieldRejectedCandidateIds:
			rejectedCandidateId !== undefined && !state.fieldRejectedCandidateIds.includes(rejectedCandidateId) ? [...state.fieldRejectedCandidateIds, rejectedCandidateId] : state.fieldRejectedCandidateIds,
		...(state.recommendedSelection ? { recommendedSelection: flagRejected(state.recommendedSelection) } : {}),
		results: state.results.map(flagRejected),
		updatedAt: now
	};
}
export function markCalibrationUnwatched(state: CalibrationState, now: number = Date.now()): CalibrationState {
	if (state.confirmation !== 'pending') return state;
	return {
		...state,
		confirmation: 'unwatched',
		updatedAt: now
	};
}
export function calibrationProvisionalExpired(state: CalibrationState, now: number = Date.now()): boolean {
	return state.confirmation === 'pending' && state.provisionalSince !== undefined && now - state.provisionalSince > CALIBRATION_PROVISIONAL_WINDOW_MS;
}
export function declineCalibrationOffer(state: CalibrationState, now: number = Date.now()): CalibrationState {
	if (state.calibrationOfferDeclinedAt !== undefined) return state;
	return {
		...state,
		calibrationOfferDeclinedAt: now,
		updatedAt: now
	};
}
export function markStaleRerunPromptShown(state: CalibrationState, now: number = Date.now()): CalibrationState {
	if (state.staleRerunPromptShownAt !== undefined) return state;
	return {
		...state,
		staleRerunPromptShownAt: now,
		updatedAt: now
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
function parseTrialRejectionReasons(value: unknown): CalibrationTrialRejectionReason[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const reasons = [...new Set(value.filter(isTrialRejectionReason))];
	return reasons.length > 0 ? reasons : undefined;
}
function parseContaminationFlags(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const flags = [...new Set(value.filter((flag): flag is string => typeof flag === 'string' && flag.length <= 64))];
	return flags.length > 0 ? flags : undefined;
}
function parseGpuTimingStatus(value: unknown): CalibrationGpuTimingStatus | undefined {
	return value === 'measured' || value === 'unsupported' || value === 'unreliable' ? value : undefined;
}
function parseTrialEnvironment(value: unknown): CalibrationTrialEnvironment | undefined {
	if (!isRecord(value)) return undefined;
	const refreshRateHz = optionalFiniteNumber(value.refreshRateHz);
	return {
		devicePixelRatio: finiteNumber(value.devicePixelRatio, 1),
		drawingBufferHeight: Math.max(0, Math.trunc(finiteNumber(value.drawingBufferHeight))),
		drawingBufferWidth: Math.max(0, Math.trunc(finiteNumber(value.drawingBufferWidth))),
		...(typeof value.onBattery === 'boolean' ? { onBattery: value.onBattery } : {}),
		...(refreshRateHz !== undefined ? { refreshRateHz } : {})
	};
}
function parseMetrics(value: unknown): CalibrationMetrics | undefined {
	if (!isRecord(value)) return undefined;
	const contaminationFlags = parseContaminationFlags(value.contaminationFlags);
	const cpuSubmitP50Ms = optionalFiniteNumber(value.cpuSubmitP50Ms);
	const cpuSubmitP95Ms = optionalFiniteNumber(value.cpuSubmitP95Ms);
	const environment = parseTrialEnvironment(value.environment);
	const gpuDisjointDiscardCount = optionalFiniteNumber(value.gpuDisjointDiscardCount);
	const gpuTimeP50Ms = optionalFiniteNumber(value.gpuTimeP50Ms);
	const gpuTimeP95Ms = optionalFiniteNumber(value.gpuTimeP95Ms);
	const gpuTimingStatus = parseGpuTimingStatus(value.gpuTimingStatus);
	const rejectionReasons = parseTrialRejectionReasons(value.rejectionReasons);
	const stallRatio = optionalFiniteNumber(value.stallRatio);
	const workloadVersion = optionalFiniteNumber(value.workloadVersion);
	return {
		averageFps: finiteNumber(value.averageFps),
		...(contaminationFlags ? { contaminationFlags } : {}),
		...(cpuSubmitP50Ms !== undefined ? { cpuSubmitP50Ms } : {}),
		...(cpuSubmitP95Ms !== undefined ? { cpuSubmitP95Ms } : {}),
		...(environment ? { environment } : {}),
		eventLoopP95Ms: finiteNumber(value.eventLoopP95Ms),
		eventLoopWorstMs: finiteNumber(value.eventLoopWorstMs),
		...(gpuDisjointDiscardCount !== undefined ? { gpuDisjointDiscardCount } : {}),
		...(gpuTimeP50Ms !== undefined ? { gpuTimeP50Ms } : {}),
		...(gpuTimeP95Ms !== undefined ? { gpuTimeP95Ms } : {}),
		...(gpuTimingStatus ? { gpuTimingStatus } : {}),
		longFrameRatio: finiteNumber(value.longFrameRatio),
		lowConfidenceReasons: parseLowConfidenceReasons(value.lowConfidenceReasons),
		onePercentLowFps: finiteNumber(value.onePercentLowFps),
		p95FrameTimeMs: finiteNumber(value.p95FrameTimeMs),
		...(rejectionReasons ? { rejectionReasons } : {}),
		sampleCount: Math.max(0, Math.trunc(finiteNumber(value.sampleCount))),
		...(stallRatio !== undefined ? { stallRatio } : {}),
		success: value.success === true,
		webglRenderer: typeof value.webglRenderer === 'string' ? value.webglRenderer : '',
		...(Number.isInteger(workloadVersion) ? { workloadVersion } : {}),
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
		...(value.fieldRejected === true ? { fieldRejected: true } : {}),
		metrics,
		score: finiteNumber(value.score, calculateCalibrationScore(metrics, candidate.framePolicy)),
		...(Number.isInteger(value.slotIndex) && Number(value.slotIndex) >= 0 ? { slotIndex: Number(value.slotIndex) } : {})
	};
}
function parseSignature(value: unknown, requireWorkloadVersion: boolean): CalibrationSignature | undefined {
	if (
		!isRecord(value) ||
		!Number.isInteger(value.benchmarkVersion) ||
		Number(value.benchmarkVersion) < 1 ||
		typeof value.driverFingerprint !== 'string' ||
		typeof value.electronVersion !== 'string' ||
		typeof value.hardwareFingerprint !== 'string'
	)
		return undefined;
	if (requireWorkloadVersion && (!Number.isInteger(value.workloadVersion) || Number(value.workloadVersion) < 0)) return undefined;
	const benchmarkVersion = Number(value.benchmarkVersion);
	const workloadVersion = Number.isInteger(value.workloadVersion) && Number(value.workloadVersion) >= 0 ? Number(value.workloadVersion) : benchmarkVersion >= CALIBRATION_VERSION ? WORKLOAD_VERSION : 0;
	return {
		appVersion: typeof value.appVersion === 'string' ? value.appVersion : '',
		benchmarkVersion,
		driverFingerprint: value.driverFingerprint,
		electronVersion: value.electronVersion,
		hardwareFingerprint: value.hardwareFingerprint,
		workloadVersion
	};
}
function parseTrialSlot(value: unknown): CalibrationTrialSlot | undefined {
	if (
		!isRecord(value) ||
		typeof value.candidateId !== 'string' ||
		!Number.isInteger(value.launchGroup) ||
		Number(value.launchGroup) < 1 ||
		(value.stage !== 'screen' && value.stage !== 'repeat' && value.stage !== 'recovery')
	)
		return undefined;
	return {
		candidateId: value.candidateId,
		launchGroup: Number(value.launchGroup),
		stage: value.stage
	};
}
function parseConfirmation(value: unknown): CalibrationConfirmationStatus | undefined {
	return value === 'pending' || value === 'confirmed' || value === 'rolled-back' || value === 'unwatched' ? value : undefined;
}
function parseStatus(value: unknown): CalibrationStatus | undefined {
	return value === 'uncalibrated' || value === 'running' || value === 'awaiting-confirmation' || value === 'complete' ? value : undefined;
}
interface ParsedStateCore {
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
}
function parseStateCore(value: Record<string, unknown>, requireWorkloadVersion: boolean): ParsedStateCore | undefined {
	const status = parseStatus(value.status);
	if (!status) return undefined;
	const signature = parseSignature(value.signature, requireWorkloadVersion);
	if (!signature || !Array.isArray(value.candidates) || !Array.isArray(value.results)) return undefined;
	const candidates = value.candidates.map(parseCandidate);
	const results = value.results.map(parseResult);
	if (candidates.some((candidate) => candidate === undefined) || results.some((result) => result === undefined)) return undefined;
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
		status,
		updatedAt: finiteNumber(value.updatedAt, Date.now())
	};
}
function upgradeVersionOneState(core: ParsedStateCore): CalibrationState {
	const stampWorkloadVersion = (result: CalibrationResult, slotIndex?: number): CalibrationResult => ({
		...result,
		metrics: { ...result.metrics, workloadVersion: core.signature.workloadVersion },
		...(slotIndex !== undefined ? { slotIndex } : {})
	});
	return {
		...(core.activeSelection ? { activeSelection: stampWorkloadVersion(core.activeSelection) } : {}),
		candidates: core.candidates,
		competitiveModeWasEnabled: core.competitiveModeWasEnabled,
		...(core.completedAt !== undefined ? { completedAt: core.completedAt } : {}),
		...(core.status === 'complete' ? { confirmation: 'unwatched' as const } : {}),
		fieldRejectedCandidateIds: [],
		launchCount: core.results.length,
		plan: core.results.map((result, index) => ({ candidateId: result.candidate.id, launchGroup: index + 1, stage: 'screen' as const })),
		planCreatedAt: core.updatedAt,
		...(core.recommendedSelection ? { recommendedSelection: stampWorkloadVersion(core.recommendedSelection) } : {}),
		rejectedAttempts: [],
		rerunRequested: core.rerunRequested,
		results: core.results.map((result, index) => stampWorkloadVersion(result, index)),
		runRetriesUsed: 0,
		signature: core.signature,
		status: core.status,
		updatedAt: core.updatedAt,
		version: CALIBRATION_STATE_VERSION
	};
}
export function parseCalibrationState(value: unknown): CalibrationState | undefined {
	if (!isRecord(value)) return undefined;
	if (value.version === 1) {
		const core = parseStateCore(value, false);
		if (!core || core.status === 'uncalibrated') return undefined;
		return upgradeVersionOneState(core);
	}
	if (value.version !== CALIBRATION_STATE_VERSION) return undefined;
	const core = parseStateCore(value, true);
	if (!core || !Array.isArray(value.plan)) return undefined;
	const plan = value.plan.map(parseTrialSlot);
	if (plan.some((slot) => slot === undefined)) return undefined;
	const rejectedAttempts = Array.isArray(value.rejectedAttempts) ? value.rejectedAttempts.map(parseResult).filter((result): result is CalibrationResult => result !== undefined) : [];
	const fieldRejectedCandidateIds = Array.isArray(value.fieldRejectedCandidateIds) ? [...new Set(value.fieldRejectedCandidateIds.filter((id): id is string => typeof id === 'string' && id.length <= 64))] : [];
	const confirmation = parseConfirmation(value.confirmation);
	const previousSelection = parseResult(value.previousSelection);
	const calibrationOfferDeclinedAt = optionalFiniteNumber(value.calibrationOfferDeclinedAt);
	const planCreatedAt = optionalFiniteNumber(value.planCreatedAt);
	const provisionalSince = optionalFiniteNumber(value.provisionalSince);
	const staleRerunPromptShownAt = optionalFiniteNumber(value.staleRerunPromptShownAt);
	const startedAt = optionalFiniteNumber(value.startedAt);
	return {
		...core,
		...(value.autoRollbackUsed === true ? { autoRollbackUsed: true as const } : {}),
		...(calibrationOfferDeclinedAt !== undefined ? { calibrationOfferDeclinedAt } : {}),
		...(typeof value.completionReason === 'string' ? { completionReason: value.completionReason } : {}),
		...(confirmation ? { confirmation } : {}),
		fieldRejectedCandidateIds,
		launchCount: Math.max(0, Math.trunc(finiteNumber(value.launchCount))),
		plan: plan as CalibrationTrialSlot[],
		...(planCreatedAt !== undefined ? { planCreatedAt } : {}),
		...(previousSelection ? { previousSelection } : {}),
		...(provisionalSince !== undefined ? { provisionalSince } : {}),
		rejectedAttempts,
		runRetriesUsed: Math.max(0, Math.trunc(finiteNumber(value.runRetriesUsed))),
		...(value.signatureStale === true ? { signatureStale: true as const } : {}),
		...(staleRerunPromptShownAt !== undefined ? { staleRerunPromptShownAt } : {}),
		...(startedAt !== undefined ? { startedAt } : {}),
		version: CALIBRATION_STATE_VERSION
	};
}
