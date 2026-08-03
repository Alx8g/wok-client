import type { FramePolicy } from './calibration.ts';
import type { AppliedGraphicsBackend } from './graphics-profile.ts';

export const ADAPTIVE_VALIDATION_STATE_VERSION = 1;
export const ADAPTIVE_VALIDATION_PROFILE_SEMANTIC_VERSION = 1;
export const ADAPTIVE_VALIDATION_REQUIRED_SESSIONS = 3;
export const ADAPTIVE_VALIDATION_MIN_SESSION_MS = 30_000;
export const ADAPTIVE_VALIDATION_MIN_FRAME_SAMPLES = 100;
export const ADAPTIVE_VALIDATION_SEVERE_P95_FRAME_TIME_MS = 25;
/**
 * Severe means objectively bad frame delivery, expressed in one currency: frames slower than
 * 25 ms. p95 above 25 ms catches sustained slowness; 1% lows under 40 FPS catch a spiking tail.
 * The old ratio rule (1% low < 40% of average) punished fast machines — 214 FPS average with
 * healthy 55 FPS lows was labeled severe, which blocked validation and baseline formation on
 * exactly the machines that were fine. Relative degradation is the baseline comparison's job.
 */
export const ADAPTIVE_VALIDATION_SEVERE_ONE_PERCENT_LOW_FPS = 40;
/**
 * Relative regression bound: a new profile whose median gameplay FPS falls below this fraction of
 * the previous validated profile's median is recommended for recalibration even when every
 * session looks healthy in absolute terms. Absolute thresholds cannot see a 400-to-200 collapse
 * on a fast machine; only the machine's own history can.
 */
export const ADAPTIVE_VALIDATION_BASELINE_REGRESSION_RATIO = 0.75;

export const ADAPTIVE_VALIDATION_LOW_CONFIDENCE_REASONS = [
	'window-blurred',
	'document-visibility-changed',
	'window-resized',
	'severe-event-loop-disturbance'
] as const;

export type AdaptiveValidationLowConfidenceReason = (typeof ADAPTIVE_VALIDATION_LOW_CONFIDENCE_REASONS)[number];
export type AdaptiveValidationFramePolicy = FramePolicy | 'unknown';
export type AdaptiveValidationStatus = 'sampling' | 'complete';
export type AdaptiveValidationClassification = 'validated' | 'inconclusive' | 'recalibration-recommended';

export interface AdaptiveValidationProfileIdentity {
	activeBackend: AppliedGraphicsBackend;
	benchmarkSemanticVersion: number;
	driverFingerprint: string;
	electronVersion: string;
	framePolicy: AdaptiveValidationFramePolicy;
	hardwareFingerprint: string;
	profileSemanticVersion: number;
}

export interface AdaptiveValidationSessionMetrics {
	averageFps: number;
	onePercentLowFps: number;
	p95FrameTimeMs: number;
	sampleCount: number;
	worstFrameTimeMs: number;
}

export interface AdaptiveValidationSession {
	completedAt: number;
	durationMs: number;
	id: string;
	lowConfidenceReasons: AdaptiveValidationLowConfidenceReason[];
	metrics: AdaptiveValidationSessionMetrics;
}

/** Gameplay evidence carried over from the previous validated profile on the same machine. */
export interface AdaptiveValidationBaseline {
	medianAverageFps: number;
	profile: AdaptiveValidationProfileIdentity;
}

export interface AdaptiveValidationState {
	baseline?: AdaptiveValidationBaseline;
	classification: AdaptiveValidationClassification;
	completedAt?: number;
	profile: AdaptiveValidationProfileIdentity;
	profileChangeConfirmationRequired: true;
	recommendationDismissedAt?: number;
	sessions: AdaptiveValidationSession[];
	status: AdaptiveValidationStatus;
	summary: AdaptiveValidationEvidenceSummary;
	updatedAt: number;
	version: 1;
}

export interface AdaptiveValidationSubmission {
	profile: AdaptiveValidationProfileIdentity;
	session: AdaptiveValidationSession;
}

export interface AdaptiveValidationEvidenceSummary {
	acceptedSessionCount: number;
	cleanSessionCount: number;
	maximumP95FrameTimeMs: number;
	maximumWorstFrameTimeMs: number;
	minimumAverageFps: number;
	minimumOnePercentLowFps: number;
	severeInstabilitySessionCount: number;
	totalFrameSamples: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAppliedBackend(value: unknown): value is AppliedGraphicsBackend {
	return value === 'default' || value === 'd3d11' || value === 'd3d11on12' || value === 'vulkan';
}

function isFramePolicy(value: unknown): value is AdaptiveValidationFramePolicy {
	return value === 'uncapped' || value === 'capped' || value === 'unknown';
}

function isLowConfidenceReason(value: unknown): value is AdaptiveValidationLowConfidenceReason {
	return typeof value === 'string' && ADAPTIVE_VALIDATION_LOW_CONFIDENCE_REASONS.includes(value as AdaptiveValidationLowConfidenceReason);
}

function finiteNumberInRange(value: unknown, maximum: number): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum
		? value
		: undefined;
}

function parseRequiredIdentityString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= 1_024 ? value : undefined;
}

function parseSessionId(value: unknown): string | undefined {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(value) ? value : undefined;
}

export function parseAdaptiveValidationProfileIdentity(value: unknown): AdaptiveValidationProfileIdentity | undefined {
	if (!isRecord(value) || !isAppliedBackend(value.activeBackend) || !isFramePolicy(value.framePolicy)) return undefined;
	if (!Number.isInteger(value.benchmarkSemanticVersion) || Number(value.benchmarkSemanticVersion) < 1) return undefined;
	if (value.profileSemanticVersion !== ADAPTIVE_VALIDATION_PROFILE_SEMANTIC_VERSION) return undefined;

	const driverFingerprint = parseRequiredIdentityString(value.driverFingerprint);
	const electronVersion = parseRequiredIdentityString(value.electronVersion);
	const hardwareFingerprint = parseRequiredIdentityString(value.hardwareFingerprint);
	if (driverFingerprint === undefined || electronVersion === undefined || hardwareFingerprint === undefined) return undefined;

	return {
		activeBackend: value.activeBackend,
		benchmarkSemanticVersion: Number(value.benchmarkSemanticVersion),
		driverFingerprint,
		electronVersion,
		framePolicy: value.framePolicy,
		hardwareFingerprint,
		profileSemanticVersion: ADAPTIVE_VALIDATION_PROFILE_SEMANTIC_VERSION
	};
}

/**
 * True when this validation state is watching the given applied profile. The main-process
 * provisional-confirmation coordinator uses it to tell "confirmation evidence for the provisional
 * selection" apart from evidence about some other profile (design §4.4); no schema change.
 */
export function adaptiveValidationWatchesProfile(
	state: AdaptiveValidationState,
	activeBackend: AppliedGraphicsBackend,
	framePolicy: AdaptiveValidationFramePolicy
): boolean {
	return state.profile.activeBackend === activeBackend && state.profile.framePolicy === framePolicy;
}

export function adaptiveValidationProfileIdentitiesEqual(
	left: AdaptiveValidationProfileIdentity,
	right: AdaptiveValidationProfileIdentity
): boolean {
	return left.activeBackend === right.activeBackend
		&& left.benchmarkSemanticVersion === right.benchmarkSemanticVersion
		&& left.driverFingerprint === right.driverFingerprint
		&& left.electronVersion === right.electronVersion
		&& left.framePolicy === right.framePolicy
		&& left.hardwareFingerprint === right.hardwareFingerprint
		&& left.profileSemanticVersion === right.profileSemanticVersion;
}

function parseSessionMetrics(value: unknown): AdaptiveValidationSessionMetrics | undefined {
	if (!isRecord(value)) return undefined;
	const averageFps = finiteNumberInRange(value.averageFps, 100_000);
	const onePercentLowFps = finiteNumberInRange(value.onePercentLowFps, 100_000);
	const p95FrameTimeMs = finiteNumberInRange(value.p95FrameTimeMs, 60_000);
	const worstFrameTimeMs = finiteNumberInRange(value.worstFrameTimeMs, 60_000);
	if (averageFps === undefined || onePercentLowFps === undefined || p95FrameTimeMs === undefined || worstFrameTimeMs === undefined) return undefined;
	if (!Number.isSafeInteger(value.sampleCount) || Number(value.sampleCount) < 0 || Number(value.sampleCount) > 100_000_000) return undefined;

	return {
		averageFps,
		onePercentLowFps,
		p95FrameTimeMs,
		sampleCount: Number(value.sampleCount),
		worstFrameTimeMs
	};
}

export function parseAdaptiveValidationSession(value: unknown): AdaptiveValidationSession | undefined {
	if (!isRecord(value) || !Array.isArray(value.lowConfidenceReasons)) return undefined;
	if (value.lowConfidenceReasons.length > ADAPTIVE_VALIDATION_LOW_CONFIDENCE_REASONS.length) return undefined;
	if (value.lowConfidenceReasons.some(reason => !isLowConfidenceReason(reason))) return undefined;
	const completedAt = finiteNumberInRange(value.completedAt, Number.MAX_SAFE_INTEGER);
	const durationMs = finiteNumberInRange(value.durationMs, 7 * 24 * 60 * 60 * 1_000);
	const id = parseSessionId(value.id);
	const metrics = parseSessionMetrics(value.metrics);
	if (completedAt === undefined || durationMs === undefined || id === undefined || !metrics) return undefined;

	return {
		completedAt,
		durationMs,
		id,
		lowConfidenceReasons: [...new Set(value.lowConfidenceReasons as AdaptiveValidationLowConfidenceReason[])],
		metrics
	};
}

export function parseAdaptiveValidationSubmission(value: unknown): AdaptiveValidationSubmission | undefined {
	if (!isRecord(value)) return undefined;
	const profile = parseAdaptiveValidationProfileIdentity(value.profile);
	const session = parseAdaptiveValidationSession(value.session);
	return profile && session ? { profile, session } : undefined;
}

function sessionHasEnoughEvidence(session: AdaptiveValidationSession): boolean {
	return session.metrics.sampleCount >= ADAPTIVE_VALIDATION_MIN_FRAME_SAMPLES
		&& session.metrics.averageFps > 0
		&& session.metrics.onePercentLowFps > 0
		&& session.metrics.p95FrameTimeMs > 0;
}

// The version-1 sessions array is the bounded set of qualifying evidence; rejected attempts are not persisted.
function sessionQualifies(session: AdaptiveValidationSession): boolean {
	return session.durationMs >= ADAPTIVE_VALIDATION_MIN_SESSION_MS
		&& session.lowConfidenceReasons.length === 0
		&& sessionHasEnoughEvidence(session);
}

export function adaptiveValidationSessionHasSevereInstability(session: AdaptiveValidationSession): boolean {
	if (!sessionHasEnoughEvidence(session)) return false;
	return session.metrics.p95FrameTimeMs > ADAPTIVE_VALIDATION_SEVERE_P95_FRAME_TIME_MS
		|| session.metrics.onePercentLowFps < ADAPTIVE_VALIDATION_SEVERE_ONE_PERCENT_LOW_FPS;
}

function medianSessionAverageFps(sessions: readonly AdaptiveValidationSession[]): number {
	const sorted = sessions.map(session => session.metrics.averageFps).sort((left, right) => left - right);
	if (sorted.length === 0) return 0;
	const middle = (sorted.length - 1) / 2;
	return sorted.length % 2 === 1
		? sorted[middle]
		: (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2;
}

function sessionsRegressFromBaseline(
	sessions: readonly AdaptiveValidationSession[],
	baseline: AdaptiveValidationBaseline | undefined
): boolean {
	if (!baseline || baseline.medianAverageFps <= 0) return false;
	return medianSessionAverageFps(sessions) < baseline.medianAverageFps * ADAPTIVE_VALIDATION_BASELINE_REGRESSION_RATIO;
}

function classificationForSessions(
	sessions: readonly AdaptiveValidationSession[],
	baseline?: AdaptiveValidationBaseline
): AdaptiveValidationClassification {
	if (sessions.length < ADAPTIVE_VALIDATION_REQUIRED_SESSIONS) return 'inconclusive';
	if (sessions.some(session => !sessionQualifies(session))) return 'inconclusive';

	// A relative collapse against this machine's own validated history is decisive on its own;
	// mixed severity must not soften it to 'inconclusive'.
	if (sessionsRegressFromBaseline(sessions, baseline)) return 'recalibration-recommended';

	const severeSessions = sessions.filter(adaptiveValidationSessionHasSevereInstability).length;
	if (severeSessions === ADAPTIVE_VALIDATION_REQUIRED_SESSIONS) return 'recalibration-recommended';
	if (severeSessions === 0) return 'validated';
	return 'inconclusive';
}

function summarizeSessions(sessions: readonly AdaptiveValidationSession[]): AdaptiveValidationEvidenceSummary {
	const qualifyingSessions = sessions.filter(sessionQualifies);
	return {
		acceptedSessionCount: qualifyingSessions.length,
		cleanSessionCount: qualifyingSessions.length,
		maximumP95FrameTimeMs: qualifyingSessions.reduce((maximum, session) => Math.max(maximum, session.metrics.p95FrameTimeMs), 0),
		maximumWorstFrameTimeMs: qualifyingSessions.reduce((maximum, session) => Math.max(maximum, session.metrics.worstFrameTimeMs), 0),
		minimumAverageFps: qualifyingSessions.length > 0 ? Math.min(...qualifyingSessions.map(session => session.metrics.averageFps)) : 0,
		minimumOnePercentLowFps: qualifyingSessions.length > 0 ? Math.min(...qualifyingSessions.map(session => session.metrics.onePercentLowFps)) : 0,
		severeInstabilitySessionCount: qualifyingSessions.filter(adaptiveValidationSessionHasSevereInstability).length,
		totalFrameSamples: qualifyingSessions.reduce((total, session) => total + session.metrics.sampleCount, 0)
	};
}

function evidenceSummaryMatches(value: unknown, expected: AdaptiveValidationEvidenceSummary): boolean {
	return isRecord(value)
		&& value.acceptedSessionCount === expected.acceptedSessionCount
		&& value.cleanSessionCount === expected.cleanSessionCount
		&& value.maximumP95FrameTimeMs === expected.maximumP95FrameTimeMs
		&& value.maximumWorstFrameTimeMs === expected.maximumWorstFrameTimeMs
		&& value.minimumAverageFps === expected.minimumAverageFps
		&& value.minimumOnePercentLowFps === expected.minimumOnePercentLowFps
		&& value.severeInstabilitySessionCount === expected.severeInstabilitySessionCount
		&& value.totalFrameSamples === expected.totalFrameSamples;
}

export function summarizeAdaptiveValidationEvidence(state: AdaptiveValidationState): AdaptiveValidationEvidenceSummary {
	return summarizeSessions(state.sessions);
}

export function createAdaptiveValidationState(
	profile: AdaptiveValidationProfileIdentity,
	now: number = Date.now(),
	baseline?: AdaptiveValidationBaseline
): AdaptiveValidationState {
	return {
		...(baseline ? { baseline } : {}),
		classification: 'inconclusive',
		profile,
		profileChangeConfirmationRequired: true,
		sessions: [],
		status: 'sampling',
		summary: summarizeSessions([]),
		updatedAt: now,
		version: ADAPTIVE_VALIDATION_STATE_VERSION
	};
}

/**
 * Baselines only compare like with like: the same machine, driver, Electron build, and frame
 * policy. The backend is allowed to differ — measuring backend changes against the machine's own
 * gameplay history is the point.
 */
function baselineComparableToProfile(
	baselineProfile: AdaptiveValidationProfileIdentity,
	profile: AdaptiveValidationProfileIdentity
): boolean {
	return baselineProfile.hardwareFingerprint === profile.hardwareFingerprint
		&& baselineProfile.driverFingerprint === profile.driverFingerprint
		&& baselineProfile.electronVersion === profile.electronVersion
		&& baselineProfile.framePolicy === profile.framePolicy
		&& baselineProfile.framePolicy !== 'unknown';
}

function baselineForProfileChange(
	existing: AdaptiveValidationState,
	profile: AdaptiveValidationProfileIdentity
): AdaptiveValidationBaseline | undefined {
	if (
		existing.status === 'complete'
		&& existing.classification === 'validated'
		&& baselineComparableToProfile(existing.profile, profile)
	) {
		return {
			medianAverageFps: medianSessionAverageFps(existing.sessions),
			profile: existing.profile
		};
	}
	// A profile that never validated keeps the last trustworthy baseline alive (for example a
	// regressed profile that is being rolled back, or an inconclusive interlude).
	if (existing.baseline && baselineComparableToProfile(existing.baseline.profile, profile)) return existing.baseline;
	return undefined;
}

export function prepareAdaptiveValidationState(
	existing: AdaptiveValidationState | undefined,
	profile: AdaptiveValidationProfileIdentity,
	now: number = Date.now()
): AdaptiveValidationState {
	if (existing && adaptiveValidationProfileIdentitiesEqual(existing.profile, profile)) return existing;
	return createAdaptiveValidationState(profile, now, existing ? baselineForProfileChange(existing, profile) : undefined);
}

export function recordAdaptiveValidationSession(
	state: AdaptiveValidationState,
	value: unknown,
	now: number = Date.now()
): AdaptiveValidationState {
	if (state.status === 'complete' || state.sessions.length >= ADAPTIVE_VALIDATION_REQUIRED_SESSIONS) return state;
	const session = parseAdaptiveValidationSession(value);
	const previousSession = state.sessions.at(-1);
	if (
		!session
		|| !sessionQualifies(session)
		|| state.sessions.some(existing => existing.id === session.id)
		|| (previousSession !== undefined && session.completedAt <= previousSession.completedAt)
	) return state;

	const sessions = [...state.sessions, session];
	const complete = sessions.length === ADAPTIVE_VALIDATION_REQUIRED_SESSIONS;
	return {
		...(state.baseline ? { baseline: state.baseline } : {}),
		classification: classificationForSessions(sessions, state.baseline),
		...(complete ? { completedAt: now } : {}),
		profile: state.profile,
		profileChangeConfirmationRequired: true,
		sessions,
		status: complete ? 'complete' : 'sampling',
		summary: summarizeSessions(sessions),
		updatedAt: now,
		version: ADAPTIVE_VALIDATION_STATE_VERSION
	};
}

export function dismissAdaptiveValidationRecommendation(
	state: AdaptiveValidationState,
	now: number = Date.now()
): AdaptiveValidationState {
	if (
		state.status !== 'complete'
		|| state.classification !== 'recalibration-recommended'
		|| state.recommendationDismissedAt !== undefined
	) return state;

	return {
		...state,
		recommendationDismissedAt: now,
		updatedAt: now
	};
}

function parseAdaptiveValidationBaseline(value: unknown): AdaptiveValidationBaseline | undefined {
	if (!isRecord(value)) return undefined;
	const medianAverageFps = finiteNumberInRange(value.medianAverageFps, 100_000);
	const profile = parseAdaptiveValidationProfileIdentity(value.profile);
	if (medianAverageFps === undefined || medianAverageFps <= 0 || !profile) return undefined;
	return { medianAverageFps, profile };
}

export function parseAdaptiveValidationState(value: unknown): AdaptiveValidationState | undefined {
	if (!isRecord(value) || value.version !== ADAPTIVE_VALIDATION_STATE_VERSION || !Array.isArray(value.sessions)) return undefined;
	if (value.sessions.length > ADAPTIVE_VALIDATION_REQUIRED_SESSIONS || value.profileChangeConfirmationRequired !== true) return undefined;
	const profile = parseAdaptiveValidationProfileIdentity(value.profile);
	const sessions = value.sessions.map(parseAdaptiveValidationSession);
	if (!profile || sessions.some(session => !session || !sessionQualifies(session))) return undefined;
	const baseline = parseAdaptiveValidationBaseline(value.baseline);
	if (value.baseline !== undefined && baseline === undefined) return undefined;

	const parsedSessions = sessions as AdaptiveValidationSession[];
	if (
		new Set(parsedSessions.map(session => session.id)).size !== parsedSessions.length
		|| parsedSessions.some((session, index) => index > 0 && session.completedAt <= parsedSessions[index - 1].completedAt)
	) return undefined;
	const status: AdaptiveValidationStatus = parsedSessions.length === ADAPTIVE_VALIDATION_REQUIRED_SESSIONS ? 'complete' : 'sampling';
	const classification = classificationForSessions(parsedSessions, baseline);
	const summary = summarizeSessions(parsedSessions);
	if (value.status !== status || value.classification !== classification || !evidenceSummaryMatches(value.summary, summary)) return undefined;
	const updatedAt = finiteNumberInRange(value.updatedAt, Number.MAX_SAFE_INTEGER);
	const completedAt = finiteNumberInRange(value.completedAt, Number.MAX_SAFE_INTEGER);
	const recommendationDismissedAt = finiteNumberInRange(value.recommendationDismissedAt, Number.MAX_SAFE_INTEGER);
	if (
		updatedAt === undefined
		|| (status === 'complete' && completedAt === undefined)
		|| (status === 'sampling' && value.completedAt !== undefined)
		|| (value.recommendationDismissedAt !== undefined && recommendationDismissedAt === undefined)
		|| (recommendationDismissedAt !== undefined && classification !== 'recalibration-recommended')
	) return undefined;

	return {
		...(baseline ? { baseline } : {}),
		classification,
		...(completedAt !== undefined ? { completedAt } : {}),
		profile,
		profileChangeConfirmationRequired: true,
		...(recommendationDismissedAt !== undefined ? { recommendationDismissedAt } : {}),
		sessions: parsedSessions,
		status,
		summary,
		updatedAt,
		version: ADAPTIVE_VALIDATION_STATE_VERSION
	};
}
