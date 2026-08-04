/**
 * Diagnostic-only gameplay frame log.
 *
 * The overlay shows live numbers, but reading them means alt-tabbing or screenshotting, and that
 * act itself produces a multi-hundred-millisecond hitch inside the ten-second window — which lands
 * squarely on the tail statistics (1% low, worst frame) that a backend comparison most needs. A
 * measurement you have to interrupt the game to read cannot answer questions about smoothness.
 *
 * This samples the same rolling statistics and emits them periodically, so a backend A/B can be
 * played uninterrupted and read afterwards. Pointer-lock gated: menu frames are not gameplay.
 * Inert unless WOK_FPS_LOG is set.
 */

export interface GameplayFpsSample {
	averageFps: number;
	onePercentLowFps: number;
	p95FrameTimeMs: number;
	sampleCount: number;
	worstFrameTimeMs: number;
	windowSeconds: number;
}

export interface GameplayFpsLogHooks {
	emit(sample: GameplayFpsSample): void;
	isActive(): boolean;
	now(): number;
	recordFrame(timestamp: number, frameTimeMs: number): void;
	requestFrame(callback: (timestamp: number) => void): void;
	snapshot(now: number): GameplayFpsSample;
	/** Gameplay frames required before the first emit, so load-in hitches stay out of the tail. */
	warmupFrames?: number;
	emitIntervalMs?: number;
}

export const GAMEPLAY_FPS_LOG_WARMUP_FRAMES = 120;
export const GAMEPLAY_FPS_LOG_INTERVAL_MS = 10_000;
/** Frame intervals outside this range are scheduler artifacts, not rendered frames. */
export const GAMEPLAY_FPS_LOG_MAX_FRAME_MS = 1_000;

/** Starts sampling; returns a stop function. */
export function startGameplayFpsLog(hooks: GameplayFpsLogHooks): () => void {
	const warmupFrames = hooks.warmupFrames ?? GAMEPLAY_FPS_LOG_WARMUP_FRAMES;
	const emitIntervalMs = hooks.emitIntervalMs ?? GAMEPLAY_FPS_LOG_INTERVAL_MS;
	let stopped = false;
	let previousTimestamp: number | undefined;
	let activeFrames = 0;
	let nextEmitAt: number | undefined;

	const tick = (timestamp: number) => {
		if (stopped) return;
		const active = hooks.isActive();
		if (!active) {
			// Leaving gameplay invalidates the interval across the gap and pauses emission.
			previousTimestamp = undefined;
			nextEmitAt = undefined;
		} else {
			if (previousTimestamp !== undefined) {
				const frameTime = timestamp - previousTimestamp;
				if (frameTime > 0 && frameTime < GAMEPLAY_FPS_LOG_MAX_FRAME_MS) {
					hooks.recordFrame(timestamp, frameTime);
					activeFrames++;
				}
			}
			previousTimestamp = timestamp;

			if (activeFrames > warmupFrames) {
				const now = hooks.now();
				if (nextEmitAt === undefined) nextEmitAt = now + emitIntervalMs;
				else if (now >= nextEmitAt) {
					hooks.emit(hooks.snapshot(now));
					nextEmitAt = now + emitIntervalMs;
				}
			}
		}
		hooks.requestFrame(tick);
	};
	hooks.requestFrame(tick);

	return () => { stopped = true; };
}
