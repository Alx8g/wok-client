export interface GraphicsStabilityScheduler {
	cancel(handle: unknown): void;
	schedule(callback: () => void, delayMs: number): unknown;
}
export interface GraphicsStabilityConfirmation {
	cancel(): void;
	mainFrameLoadFinished(): void;
	mainFrameLoadStarted(): void;
}
const defaultScheduler: GraphicsStabilityScheduler = {
	cancel: (handle) => {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
	schedule: (callback, delayMs) => setTimeout(callback, delayMs)
};
export function createGraphicsStabilityConfirmation(options: { delayMs: number; onStable: () => void; scheduler?: GraphicsStabilityScheduler }): GraphicsStabilityConfirmation {
	const scheduler = options.scheduler ?? defaultScheduler;
	let generation = 0;
	let timerActive = false;
	let timerHandle: unknown;
	const cancel = () => {
		generation++;
		if (!timerActive) return;
		timerActive = false;
		scheduler.cancel(timerHandle);
		timerHandle = undefined;
	};
	return {
		cancel,
		mainFrameLoadFinished: () => {
			cancel();
			const expectedGeneration = generation;
			timerActive = true;
			timerHandle = scheduler.schedule(() => {
				if (!timerActive || generation !== expectedGeneration) return;
				timerActive = false;
				timerHandle = undefined;
				options.onStable();
			}, options.delayMs);
		},
		mainFrameLoadStarted: cancel
	};
}
