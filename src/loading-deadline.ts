/**
 * Bounded wait for a startup readiness signal.
 *
 * WOK covers Krunker's own loading with an opaque presentation (the launch animation, then the
 * splash) and takes it away when the game reports itself usable. That readiness signal is derived
 * from Krunker's markup, so it is not guaranteed to arrive: the game can change its markup, stall
 * on an asset, serve an error, rate-limit, or put a login, captcha or ban screen in front of the
 * menu. A presentation that only ends on readiness therefore has a path where it never ends, and
 * because it is opaque and takes pointer events the user cannot even see, let alone click, what is
 * actually in front of them. That turns a recoverable situation into a dead client - measured once
 * as a full minute on a black screen with no way out.
 *
 * This module removes that path. Every wait gets a deadline, every deadline resolves, and every
 * resolution - readiness, deadline, an exception anywhere in the path, or teardown - runs the same
 * single reveal callback. There is no ordering of events, and no thrown error, that leaves a caller
 * waiting forever.
 *
 * The clock, the scheduler and the readiness subscription are all injected so the whole state
 * machine is testable without a browser, a renderer or real time.
 */

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

/**
 * How long the client may keep its own loading presentation over Krunker before showing the page
 * regardless of readiness.
 *
 * Chosen from what launches actually measure (see startup-profile.ts, whose samples are recorded
 * from process start to the same readiness signal):
 *
 *   ~8.0 s    clean launch on the reference machine
 *   8.2-8.8 s typical launches on that machine
 *   10.3 s    live 2026-08-03 trace: Krunker's loading overlay cleared and the play prompt appeared
 *   11.15 s   same machine with the connection throttled
 *
 * The often-quoted "warm launch is ~1.8 s" figure is not evidence for a shorter deadline: those
 * samples came from readiness signal version 1, which mistook Krunker's loading spinner for a
 * playable game (startup-profile.ts invalidates them for exactly that reason).
 *
 * 20 s is therefore roughly 1.8x the slowest launch ever measured here and about 2.5x a typical
 * one, which leaves a weak machine or a slow connection substantial room before the notice appears.
 * The two costs are not symmetric: overrunning early only reveals Krunker's own loading screen,
 * which is honest and self-explanatory and disappears again the moment readiness arrives, while
 * overrunning late is the reported bug. When in doubt, reveal.
 */
export const SPLASH_REVEAL_DEADLINE_MS = 20_000;

/**
 * Main-process backstop on the game window ever becoming visible at all.
 *
 * The window is created hidden and is normally revealed by the launch intro or by ready-to-show.
 * A renderer that never paints (a hung DNS lookup, a wedged GPU process) fires neither, and the
 * splash deadline above cannot help because it lives in that renderer. Deliberately later than the
 * splash deadline so that whenever the renderer is alive the user sees its honest, specific notice
 * rather than a bare window appearing first.
 */
export const WINDOW_REVEAL_DEADLINE_MS = 25_000;

export type LoadingDeadlineOutcome = 'ready' | 'overrun' | 'failed' | 'disposed';

export interface LoadingDeadlineResolution {
	elapsedMs: number;
	/** Present only for the 'failed' outcome. */
	error?: unknown;
	outcome: LoadingDeadlineOutcome;
}

export interface LoadingDeadlineEvent {
	detail?: Record<string, unknown>;
	elapsedMs: number;
	kind: 'started' | 'resolved' | 'late-ready' | 'error';
}

export interface LoadingDeadlineOptions {
	/** Milliseconds from start to the forced reveal. Non-positive or non-finite reveals at once. */
	deadlineMs: number;
	now(): number;
	/** Diagnostics sink. Never allowed to affect the reveal, however badly it misbehaves. */
	onDiagnostic?(event: LoadingDeadlineEvent): void;
	/** Last-ditch reveal, used only when onResolve itself threw. */
	onFailsafe?(error: unknown): void;
	/** Readiness that arrived after the deadline already revealed the page. Runs at most once. */
	onLateReady?(elapsedMs: number): void;
	/**
	 * Reveal the game. Runs exactly once for every possible sequence of events, including
	 * teardown, so it must be safe to call from any of them.
	 */
	onResolve(resolution: LoadingDeadlineResolution): void;
	scheduler?: LoadingDeadlineScheduler;
	/** Register a readiness listener; returns an unsubscribe function. */
	subscribe(listener: () => void): () => void;
}

export interface LoadingDeadline {
	/** Cancels the timer and the subscription, revealing first if nothing else has. */
	dispose(): void;
	readonly resolution: LoadingDeadlineResolution | undefined;
}

/** Errors reach diagnostics as text: a log line must never depend on a serializable error. */
export function describeError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	if (typeof error === 'string') return error;
	try {
		return String(error);
	} catch {
		return 'unprintable error';
	}
}

/** Wording shown when a load overruns. Plain, specific, and honest about what WOK just did. */
export function formatLoadingOverrunMessage(elapsedMs: number): string {
	const seconds = Number.isFinite(elapsedMs) && elapsedMs > 0 ? Math.round(elapsedMs / 1_000) : 0;
	return `Krunker is still loading after ${seconds} seconds. WOK Client has removed its loading screen so you can see and use the page underneath.`;
}

/** One bounded line per event, in the shape the other WOK diagnostics use. */
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
		} catch {
			// Diagnostics are never allowed to influence whether the user gets their game back.
		}
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
		// Recorded before any callback runs, so a callback that re-enters cannot resolve twice.
		resolution = { elapsedMs: elapsed(), error, outcome };
		cancelTimer();
		// An overrun keeps listening: readiness may still arrive, and the notice should go away
		// by itself when it does.
		if (outcome !== 'overrun') detachSubscription();
		emit('resolved', { outcome, ...(error === undefined ? {} : { reason: describeError(error) }) });

		try {
			options.onResolve(resolution);
		} catch (resolveError) {
			emit('error', { stage: 'resolve', reason: describeError(resolveError) });
			try {
				options.onFailsafe?.(resolveError);
			} catch {
				// Nothing further can be done here; the failsafe is already the last resort.
			}
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
			// Teardown must not be a way to stay covered: an unresolved wait still reveals.
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
	// A subscription that reports readiness synchronously has already resolved; it could not be
	// detached at the time because its unsubscribe function did not exist yet.
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
