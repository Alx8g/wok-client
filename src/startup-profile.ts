/**
 * Adaptive launch-animation selection.
 *
 * Time-to-usable varies far too much for a fixed-length intro to fit it. Measured on one machine
 * in one session: 7.97 s on a clean run, 8.2-8.8 s typically, 11.15 s when the connection was
 * throttled, and one contended launch where the animation could not even start. Across other
 * people's hardware and connections the spread will be wider still.
 *
 * A fixed intro therefore either overshoots - forcing the user to watch an animation after the
 * game is already playable - or undershoots and leaves them on a static screen. Neither is fixable
 * by picking a better constant.
 *
 * So the client measures how long its own launches actually take and picks the longest variant that
 * fits, allowing a small overshoot. Every variant is the same render trimmed from a different start
 * point, so all of them end on the same WOK lockup before the branded loading card takes over.
 *
 * First launch has no history and deliberately gets the longest variant: a cold profile pays for
 * an empty HTTP cache, an empty shader cache and an empty V8 cache, and is the slowest launch a
 * user ever has.
 */

/** How many recent launches to keep. Enough to absorb one bad launch without chasing noise. */
const SAMPLE_LIMIT = 7;

/** Invalidates samples recorded by older, materially different readiness predicates. */
const READINESS_SIGNAL_VERSION = 2;

/**
 * How far an animation may run PAST the game becoming ready and still be chosen.
 *
 * Overshoot and undershoot are not symmetric costs, so the selector must not treat them as if they
 * are. A slightly long animation costs only a fraction of a second of waiting. Undershooting exposes
 * the static loading card for longer, which with only two variants can create a gap of seconds.
 *
 * Readiness is observed in the renderer and persisted by the main process, so IPC scheduling and
 * the final visual settle can still move the handoff by a few hundred milliseconds. The allowance
 * avoids dropping to a much shorter animation because of that small boundary cost.
 */
const OVERSHOOT_ALLOWANCE_MS = 600;

/** Playback cannot begin until the window exists and the first frame decodes. */
const INTRO_START_OFFSET_MS = 450;

export type IntroVariant = 'none' | 'short' | 'long';

export interface IntroVariantTiming {
	/** Asset basename, without the resolution suffix. */
	readonly asset: string;
	/** Video track end: the last frame of animation. */
	readonly visualMs: number;
	/** Audio track end, including the fade tail. */
	readonly audioMs: number;
	/**
	 * When the frame is opaque everywhere, so the game window can be revealed behind it with no
	 * visible seam. Measured per render; it is not a fixed fraction of the length.
	 */
	readonly opaqueMs: number;
}

/*
 * Every variant is the same render, trimmed from the START - never a separate export. Each one
 * therefore ends on the identical WOK lockup before handing over to the branded loading card, and
 * there is only ever one animation source to keep current.
 *
 * The cut points are not arbitrary. The animation pulses rather than ramping monotonically, and is
 * measured fully transparent (mean alpha exactly 0) across frames 47-58 and 101-108. Cutting inside
 * those windows means a trimmed variant still fades up from the user's desktop instead of popping
 * in at partial opacity.
 *
 *   long    cut at frame 0     picture 7167 ms   opaque 4933 ms   audio 9267 ms
 *   short   cut at frame 101   picture 3800 ms   opaque 1566 ms   audio 5900 ms
 *
 * Trimming shifts every timing by the cut, so none of these may be assumed from the length.
 */
export const INTRO_VARIANTS: Readonly<Record<Exclude<IntroVariant, 'none'>, IntroVariantTiming>> = {
	short: { asset: 'intro-short', visualMs: 3_800, audioMs: 5_900, opaqueMs: 1_566 },
	long: { asset: 'intro-long', visualMs: 7_167, audioMs: 9_267, opaqueMs: 4_933 }
};

/** Longest first: selection takes the first variant that fits. */
const VARIANTS_BY_LENGTH: readonly Exclude<IntroVariant, 'none'>[] = ['long', 'short'];

export interface StartupProfile {
	/**
	 * Version of the DOM predicate that produced readyMs. Optional so selector callers can provide
	 * synthetic profiles without persistence metadata.
	 */
	readonly readinessSignalVersion?: number;
	/** Time from process start to the game being usable, most recent last. */
	readonly readyMs: readonly number[];
}

export function createStartupProfile(): StartupProfile {
	return {
		readinessSignalVersion: READINESS_SIGNAL_VERSION,
		readyMs: []
	};
}

/**
 * Convert Node's monotonic process uptime into the wall-clock origin used by renderer IPC marks.
 * This is required for every launch, not only diagnostic-mark launches: the adaptive intro profile
 * measures from process start even when WOK_PERF_MARKS is disabled.
 */
export function estimateProcessStartWallClockMs(nowMs: number, processUptimeSeconds: number): number {
	if (!Number.isFinite(nowMs) || !Number.isFinite(processUptimeSeconds) || processUptimeSeconds < 0) return nowMs;
	return nowMs - processUptimeSeconds * 1_000;
}

/** Convert monotonic process uptime to a valid adaptive-startup sample. */
export function startupReadyMs(processUptimeSeconds: number): number | undefined {
	const readyMs = processUptimeSeconds * 1_000;
	return Number.isFinite(readyMs) && readyMs > 0 && readyMs < 120_000 ? readyMs : undefined;
}

/** Tolerates a hand-edited or partially written file rather than throwing during startup. */
export function parseStartupProfile(value: unknown): StartupProfile {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return createStartupProfile();
	const record = value as Record<string, unknown>;

	// Version 1 treated Krunker's early loading spinner as usable. Those samples were commonly around
	// 1.8 s even when the actual load took 8-10 s, so mixing them with corrected samples would suppress
	// the intro for several more launches. Start fresh whenever the predicate version changes.
	if (record.readinessSignalVersion !== READINESS_SIGNAL_VERSION) return createStartupProfile();

	const candidate = record.readyMs;
	if (!Array.isArray(candidate)) return createStartupProfile();
	const readyMs = candidate
		.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry) && entry > 0 && entry < 120_000)
		.slice(-SAMPLE_LIMIT);
	return {
		readinessSignalVersion: READINESS_SIGNAL_VERSION,
		readyMs
	};
}

export function recordStartupSample(profile: StartupProfile, readyMs: number): StartupProfile {
	if (!Number.isFinite(readyMs) || readyMs <= 0 || readyMs >= 120_000) return profile;
	return {
		readinessSignalVersion: READINESS_SIGNAL_VERSION,
		readyMs: [...profile.readyMs, Math.round(readyMs)].slice(-SAMPLE_LIMIT)
	};
}

/**
 * Median rather than mean: a single throttled or contended launch should not drag the estimate
 * and downgrade the animation for every launch after it.
 */
export function expectedReadyMs(profile: StartupProfile): number | undefined {
	if (profile.readyMs.length === 0) return undefined;
	const sorted = [...profile.readyMs].sort((first, second) => first - second);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

/**
 * Pick the longest animation that fits, tolerating a small overshoot.
 *
 * With no history, use the longest: first launches are the slowest a user ever sees, so being
 * generous there is both the best first impression and the least likely to leave a static gap.
 */
export function selectIntroVariant(profile: StartupProfile): IntroVariant {
	const expected = expectedReadyMs(profile);
	if (expected === undefined) return 'long';

	for (const variant of VARIANTS_BY_LENGTH) {
		const finishesAt = INTRO_START_OFFSET_MS + INTRO_VARIANTS[variant].visualMs;
		if (finishesAt <= expected + OVERSHOOT_ALLOWANCE_MS) return variant;
	}

	// Even the shortest animation would outlast the load. A launch this fast does not need masking,
	// and playing an animation over it would only add waiting.
	return 'none';
}
