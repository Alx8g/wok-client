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
	warmupFrames?: number;
	emitIntervalMs?: number;
}
export const GAMEPLAY_FPS_LOG_WARMUP_FRAMES = 120;
export const GAMEPLAY_FPS_LOG_INTERVAL_MS = 10000;
export const GAMEPLAY_FPS_LOG_MAX_FRAME_MS = 1000;
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
	return () => {
		stopped = true;
	};
}
