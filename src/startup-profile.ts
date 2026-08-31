const SAMPLE_LIMIT = 7;
const READINESS_SIGNAL_VERSION = 2;
const OVERSHOOT_ALLOWANCE_MS = 600;
const INTRO_START_OFFSET_MS = 450;
export type IntroVariant = 'none' | 'short' | 'long';
export interface IntroVariantTiming {
	readonly asset: string;
	readonly visualMs: number;
	readonly audioMs: number;
	readonly opaqueMs: number;
}
export const INTRO_VARIANTS: Readonly<Record<Exclude<IntroVariant, 'none'>, IntroVariantTiming>> = {
	short: { asset: 'intro-short', visualMs: 3800, audioMs: 5900, opaqueMs: 1566 },
	long: { asset: 'intro-long', visualMs: 7167, audioMs: 9267, opaqueMs: 4933 }
};
const VARIANTS_BY_LENGTH: readonly Exclude<IntroVariant, 'none'>[] = ['long', 'short'];
export interface StartupProfile {
	readonly readinessSignalVersion?: number;
	readonly readyMs: readonly number[];
}
export function createStartupProfile(): StartupProfile {
	return {
		readinessSignalVersion: READINESS_SIGNAL_VERSION,
		readyMs: []
	};
}
export function estimateProcessStartWallClockMs(nowMs: number, processUptimeSeconds: number): number {
	if (!Number.isFinite(nowMs) || !Number.isFinite(processUptimeSeconds) || processUptimeSeconds < 0) return nowMs;
	return nowMs - processUptimeSeconds * 1000;
}
export function startupReadyMs(processUptimeSeconds: number): number | undefined {
	const readyMs = processUptimeSeconds * 1000;
	return Number.isFinite(readyMs) && readyMs > 0 && readyMs < 120000 ? readyMs : undefined;
}
export function parseStartupProfile(value: unknown): StartupProfile {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return createStartupProfile();
	const record = value as Record<string, unknown>;
	if (record.readinessSignalVersion !== READINESS_SIGNAL_VERSION) return createStartupProfile();
	const candidate = record.readyMs;
	if (!Array.isArray(candidate)) return createStartupProfile();
	const readyMs = candidate.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry) && entry > 0 && entry < 120000).slice(-SAMPLE_LIMIT);
	return {
		readinessSignalVersion: READINESS_SIGNAL_VERSION,
		readyMs
	};
}
export function recordStartupSample(profile: StartupProfile, readyMs: number): StartupProfile {
	if (!Number.isFinite(readyMs) || readyMs <= 0 || readyMs >= 120000) return profile;
	return {
		readinessSignalVersion: READINESS_SIGNAL_VERSION,
		readyMs: [...profile.readyMs, Math.round(readyMs)].slice(-SAMPLE_LIMIT)
	};
}
export function expectedReadyMs(profile: StartupProfile): number | undefined {
	if (profile.readyMs.length === 0) return undefined;
	const sorted = [...profile.readyMs].sort((first, second) => first - second);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}
export function selectIntroVariant(profile: StartupProfile): IntroVariant {
	const expected = expectedReadyMs(profile);
	if (expected === undefined) return 'long';
	for (const variant of VARIANTS_BY_LENGTH) {
		const finishesAt = INTRO_START_OFFSET_MS + INTRO_VARIANTS[variant].visualMs;
		if (finishesAt <= expected + OVERSHOOT_ALLOWANCE_MS) return variant;
	}
	return 'none';
}
