export interface GameUsabilitySignalOptions {
	onFirstReport(): void;
	onListenerError(error: unknown): void;
	schedule?(callback: () => void): void;
}

/**
 * One-shot readiness signal shared by startup profiling and optional presentation code.
 * A faulty subscriber cannot consume the signal or prevent the remaining subscribers.
 */
export class GameUsabilitySignal {
	private readonly listeners = new Set<() => void>();
	private readonly options: GameUsabilitySignalOptions;
	private readonly schedule: (callback: () => void) => void;
	private reported = false;

	public constructor(options: GameUsabilitySignalOptions) {
		this.options = options;
		this.schedule = options.schedule ?? queueMicrotask;
	}

	/** Lets presentation code skip mounting something it would only have to remove again. */
	public get hasReported(): boolean {
		return this.reported;
	}

	private notify(listener: () => void): void {
		try {
			listener();
		} catch (error) {
			try {
				this.options.onListenerError(error);
			} catch {
				// Error reporting must not break readiness propagation.
			}
		}
	}

	public report(): boolean {
		if (this.reported) return false;
		this.reported = true;

		this.notify(this.options.onFirstReport);
		const listeners = [...this.listeners];
		this.listeners.clear();
		for (const listener of listeners) this.notify(listener);
		return true;
	}

	public subscribe(listener: () => void): () => void {
		if (!this.reported) {
			this.listeners.add(listener);
			return () => {
				this.listeners.delete(listener);
			};
		}

		let active = true;
		this.schedule(() => {
			if (active) this.notify(listener);
		});
		return () => {
			active = false;
		};
	}
}

interface MutationObserverHandle {
	disconnect(): void;
	observe(
		target: Node,
		options?: MutationObserverInit
	): void;
}

export interface GameUsabilityObservationOptions {
	createMutationObserver?(
		callback: MutationCallback
	): MutationObserverHandle;
	document: Document;
	/**
	 * Reports a failure in the readiness path instead of throwing out of it. An exception here
	 * used to mean readiness could never arrive, which left the client's opaque splash mounted
	 * forever, so nothing in this module is allowed to escape.
	 */
	onError?(error: unknown): void;
	onUsable(): void;
}

export interface GameUsabilitySnapshot {
	instructionsPresent: boolean;
	instructionsSpinner: boolean;
	instructionsTextLength: number;
	loadingBackgroundHidden: boolean;
	loadingBackgroundPresent: boolean;
	pointerLocked: boolean;
	readyState: string;
}

/**
 * Best-effort description of everything the readiness predicate looks at.
 *
 * This is what makes a stuck load diagnosable after the fact: the same fields answer whether
 * Krunker was still loading, whether its markup changed under us, or whether something else
 * entirely (an error page, a login or ban screen) was on screen. Never throws - a snapshot taken
 * because something already went wrong must not be the thing that goes wrong next.
 */
export function describeGameUsability(
	document: Document,
	onError?: (error: unknown) => void
): GameUsabilitySnapshot {
	const snapshot: GameUsabilitySnapshot = {
		instructionsPresent: false,
		instructionsSpinner: false,
		instructionsTextLength: 0,
		loadingBackgroundHidden: false,
		loadingBackgroundPresent: false,
		pointerLocked: false,
		readyState: 'unknown'
	};
	const attempt = (action: () => void): void => {
		try {
			action();
		} catch (error) {
			// Leave the field at its default rather than losing the rest of the snapshot, but say
			// so: a field that cannot be read is the likeliest explanation for a stuck load.
			try {
				onError?.(error);
			} catch {
				// Reporting a failed field must not fail the snapshot.
			}
		}
	};

	attempt(() => {
		snapshot.readyState = String(document.readyState ?? 'unknown');
	});
	attempt(() => {
		snapshot.pointerLocked = Boolean(document.pointerLockElement);
	});
	attempt(() => {
		const instructions = document.getElementById('instructions');
		if (!instructions) return;
		snapshot.instructionsPresent = true;
		attempt(() => {
			snapshot.instructionsTextLength = (instructions.textContent ?? '').trim().length;
		});
		attempt(() => {
			snapshot.instructionsSpinner = instructions.querySelector('.lds-ring') !== null;
		});
	});
	attempt(() => {
		const loadingBackground = document.getElementById('loadingBg');
		if (!loadingBackground) return;
		snapshot.loadingBackgroundPresent = true;
		snapshot.loadingBackgroundHidden = Boolean(
			loadingBackground.hidden
			|| loadingBackground.style?.display === 'none'
			|| document.defaultView
				?.getComputedStyle(loadingBackground)
				?.display === 'none'
		);
	});

	return snapshot;
}

/** Krunker's readiness stated as one predicate over the snapshot, so the two cannot drift apart. */
export function isGameUsable(snapshot: GameUsabilitySnapshot): boolean {
	if (snapshot.pointerLocked) return true;
	return snapshot.instructionsPresent
		&& snapshot.loadingBackgroundPresent
		&& snapshot.loadingBackgroundHidden
		&& snapshot.instructionsTextLength > 0
		&& !snapshot.instructionsSpinner;
}

export function formatGameUsabilitySnapshot(snapshot: GameUsabilitySnapshot): string {
	return [
		`readyState=${snapshot.readyState}`,
		`pointerLocked=${snapshot.pointerLocked}`,
		`instructions=${snapshot.instructionsPresent ? 'present' : 'missing'}`,
		`instructionsText=${snapshot.instructionsTextLength}`,
		`spinner=${snapshot.instructionsSpinner}`,
		`loadingBg=${snapshot.loadingBackgroundPresent ? (snapshot.loadingBackgroundHidden ? 'hidden' : 'visible') : 'missing'}`
	].join(' ');
}

/**
 * Watches the whole document until Krunker's initial loading overlay is gone and its instructions
 * UI has changed from the loading spinner to an actionable prompt. Pointer lock remains an
 * independent definitive signal.
 *
 * Krunker creates a populated #instructions element very early: during a live 2026-08-03 trace it
 * contained .lds-ring at 1.2 s, while #loadingBg did not clear and "CLICK TO PLAY" did not appear
 * until 10.3 s. Treating any child node as readiness therefore removed WOK's splash roughly nine
 * seconds too early. Observing the document, rather than elements captured at load, also covers
 * late creation and replacement.
 */
export function observeGameUsability(
	options: GameUsabilityObservationOptions
): () => void {
	const createMutationObserver =
		options.createMutationObserver
		?? (callback => new MutationObserver(callback));
	let finished = false;

	const reportError = (error: unknown): void => {
		try {
			options.onError?.(error);
		} catch {
			// Error reporting must not break readiness observation.
		}
	};
	const guard = (action: () => void): void => {
		try {
			action();
		} catch (error) {
			reportError(error);
		}
	};
	const cleanup = (): void => {
		guard(() => {
			observer?.disconnect();
		});
		guard(() => {
			options.document.removeEventListener(
				'pointerlockchange',
				onPointerLockChange
			);
		});
	};
	const finish = (): void => {
		if (finished) return;
		finished = true;
		cleanup();
		guard(options.onUsable);
	};
	const evaluateReadiness = (): void => {
		if (finished) return;
		let usable = false;
		try {
			usable = isGameUsable(
				describeGameUsability(options.document, reportError)
			);
		} catch (error) {
			// A predicate that throws must read as "not ready yet", never as a dead observer:
			// the caller's deadline is what rescues the launch from here.
			reportError(error);
			return;
		}
		if (usable) finish();
	};
	const onPointerLockChange = (): void => {
		try {
			if (!options.document.pointerLockElement) return;
		} catch (error) {
			reportError(error);
			return;
		}
		finish();
	};
	let observer: MutationObserverHandle | undefined;
	guard(() => {
		observer = createMutationObserver(evaluateReadiness);
	});

	guard(() => {
		options.document.addEventListener(
			'pointerlockchange',
			onPointerLockChange
		);
	});
	guard(() => {
		observer?.observe(options.document, {
			attributeFilter: ['class', 'hidden', 'style'],
			attributes: true,
			characterData: true,
			childList: true,
			subtree: true
		});
	});
	evaluateReadiness();

	return () => {
		if (finished) return;
		finished = true;
		cleanup();
	};
}
