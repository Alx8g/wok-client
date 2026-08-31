export interface LoadingDeadlineScheduler {
	cancel(handle: unknown): void;
	schedule(callback: () => void, delayMs: number): unknown;
}
const defaultScheduler: LoadingDeadlineScheduler = {
	cancel(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
	schedule(callback, delayMs) {
		return setTimeout(callback, delayMs);
	}
};
export const SPLASH_REVEAL_DEADLINE_MS = 20000;
export const WINDOW_REVEAL_DEADLINE_MS = 25000;
export type LoadingDeadlineOutcome = 'ready' | 'overrun' | 'failed' | 'disposed';
export interface LoadingDeadlineResolution {
	elapsedMs: number;
	error?: unknown;
	outcome: LoadingDeadlineOutcome;
}
export interface LoadingDeadlineEvent {
	detail?: Record<string, unknown>;
	elapsedMs: number;
	kind: 'started' | 'resolved' | 'late-ready' | 'error';
}
export interface LoadingDeadlineOptions {
	deadlineMs: number;
	now(): number;
	onDiagnostic?(event: LoadingDeadlineEvent): void;
	onFailsafe?(error: unknown): void;
	onLateReady?(elapsedMs: number): void;
	onResolve(resolution: LoadingDeadlineResolution): void;
	scheduler?: LoadingDeadlineScheduler;
	subscribe(listener: () => void): () => void;
}
export interface LoadingDeadline {
	dispose(): void;
	readonly resolution: LoadingDeadlineResolution | undefined;
}
export function describeError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	if (typeof error === 'string') return error;
	try {
		return String(error);
	} catch {
		return 'unprintable error';
	}
}
export function formatLoadingOverrunMessage(elapsedMs: number): string {
	const seconds = Number.isFinite(elapsedMs) && elapsedMs > 0 ? Math.round(elapsedMs / 1000) : 0;
	return `Krunker is still loading after ${seconds} seconds. WOK Client has removed its loading screen so you can see and use the page underneath.`;
}
export function formatLoadingDeadlineEvent(label: string, event: LoadingDeadlineEvent): string {
	const detail = Object.entries(event.detail ?? {})
		.map(([key, value]) => `${key}=${typeof value === 'string' ? value.replace(/\s+/gu, ' ') : String(value)}`)
		.join(' ');
	return `${label} ${event.kind} elapsed=${Math.round(event.elapsedMs)}ms${detail ? ` ${detail}` : ''}`;
}
export function startLoadingDeadline(options: LoadingDeadlineOptions): LoadingDeadline {
	const scheduler = options.scheduler ?? defaultScheduler;
	let resolution: LoadingDeadlineResolution | undefined;
	let unsubscribe: (() => void) | undefined;
	let timer: unknown;
	let lateReported = false;
	const readClock = (fallback: number): number => {
		try {
			const value = options.now();
			return Number.isFinite(value) ? value : fallback;
		} catch {
			return fallback;
		}
	};
	const startedAt = readClock(0);
	const elapsed = (): number => readClock(startedAt) - startedAt;
	const emit = (kind: LoadingDeadlineEvent['kind'], detail?: Record<string, unknown>): void => {
		if (!options.onDiagnostic) return;
		try {
			options.onDiagnostic({ detail, elapsedMs: elapsed(), kind });
		} catch {}
	};
	const cancelTimer = (): void => {
		if (timer === undefined) return;
		const handle = timer;
		timer = undefined;
		try {
			scheduler.cancel(handle);
		} catch (error) {
			emit('error', { stage: 'cancel-timer', reason: describeError(error) });
		}
	};
	const detachSubscription = (): void => {
		if (!unsubscribe) return;
		const stop = unsubscribe;
		unsubscribe = undefined;
		try {
			stop();
		} catch (error) {
			emit('error', { stage: 'unsubscribe', reason: describeError(error) });
		}
	};
	const resolve = (outcome: LoadingDeadlineOutcome, error?: unknown): void => {
		if (resolution) return;
		resolution = { elapsedMs: elapsed(), error, outcome };
		cancelTimer();
		if (outcome !== 'overrun') detachSubscription();
		emit('resolved', { outcome, ...(error === undefined ? {} : { reason: describeError(error) }) });
		try {
			options.onResolve(resolution);
		} catch (resolveError) {
			emit('error', { stage: 'resolve', reason: describeError(resolveError) });
			try {
				options.onFailsafe?.(resolveError);
			} catch {}
		}
	};
	const handleReady = (): void => {
		if (!resolution) {
			resolve('ready');
			return;
		}
		if (resolution.outcome !== 'overrun' || lateReported) return;
		lateReported = true;
		detachSubscription();
		emit('late-ready');
		try {
			options.onLateReady?.(elapsed());
		} catch (error) {
			emit('error', { stage: 'late-ready', reason: describeError(error) });
		}
	};
	const deadline: LoadingDeadline = {
		dispose: () => {
			cancelTimer();
			detachSubscription();
			resolve('disposed');
		},
		get resolution() {
			return resolution;
		}
	};
	emit('started', { deadlineMs: options.deadlineMs });
	try {
		const stop = options.subscribe(handleReady);
		if (typeof stop === 'function') unsubscribe = stop;
	} catch (error) {
		resolve('failed', error);
		return deadline;
	}
	if (resolution) {
		if (resolution.outcome !== 'overrun') detachSubscription();
		return deadline;
	}
	const delayMs = Number.isFinite(options.deadlineMs) && options.deadlineMs > 0 ? options.deadlineMs : 0;
	try {
		timer = scheduler.schedule(() => {
			timer = undefined;
			resolve('overrun');
		}, delayMs);
	} catch (error) {
		resolve('failed', error);
	}
	return deadline;
}
