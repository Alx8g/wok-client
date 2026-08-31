export interface DeadlineScheduler {
	cancel(handle: unknown): void;
	schedule(callback: () => void, delayMs: number): unknown;
}
const defaultScheduler: DeadlineScheduler = {
	cancel(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
	schedule(callback, delayMs) {
		return setTimeout(callback, delayMs);
	}
};
export class DeadlineExceededError extends Error {
	public constructor(label: string) {
		super(`${label} timed out.`);
		this.name = 'DeadlineExceededError';
	}
}
export function runBeforeDeadline<T>(
	operation: () => PromiseLike<T>,
	deadlineAt: number,
	label: string,
	options: {
		now?: () => number;
		scheduler?: DeadlineScheduler;
	} = {}
): Promise<T> {
	const now = options.now ?? Date.now;
	const scheduler = options.scheduler ?? defaultScheduler;
	const remainingMs = deadlineAt - now();
	if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
		return Promise.reject(new DeadlineExceededError(label));
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timeoutHandle: unknown;
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle !== undefined) scheduler.cancel(timeoutHandle);
			callback();
		};
		timeoutHandle = scheduler.schedule(() => {
			settle(() => reject(new DeadlineExceededError(label)));
		}, remainingMs);
		if (settled) return;
		try {
			Promise.resolve(operation()).then(
				(value) => {
					settle(() => resolve(value));
				},
				(error) => {
					settle(() => reject(error));
				}
			);
		} catch (error) {
			settle(() => reject(error));
		}
	});
}
