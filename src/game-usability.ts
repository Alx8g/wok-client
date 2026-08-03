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
	onUsable(): void;
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

	const cleanup = (): void => {
		observer.disconnect();
		options.document.removeEventListener(
			'pointerlockchange',
			onPointerLockChange
		);
	};
	const finish = (): void => {
		if (finished) return;
		finished = true;
		cleanup();
		options.onUsable();
	};
	const initialLoadingIsComplete = (): boolean => {
		const instructions =
			options.document.getElementById('instructions');
		const loadingBackground =
			options.document.getElementById('loadingBg');

		if (!instructions || !loadingBackground) return false;

		const loadingBackgroundIsHidden =
			loadingBackground.hidden
			|| loadingBackground.style.display === 'none'
			|| options.document.defaultView
				?.getComputedStyle(loadingBackground)
				.display === 'none';
		const instructionsHavePrompt =
			(instructions.textContent ?? '').trim().length > 0;
		const instructionsHaveSpinner =
			instructions.querySelector('.lds-ring') !== null;

		return loadingBackgroundIsHidden
			&& instructionsHavePrompt
			&& !instructionsHaveSpinner;
	};
	const evaluateReadiness = (): void => {
		if (initialLoadingIsComplete()) finish();
	};
	const onPointerLockChange = (): void => {
		if (options.document.pointerLockElement) finish();
	};
	const observer = createMutationObserver(
		evaluateReadiness
	);

	options.document.addEventListener(
		'pointerlockchange',
		onPointerLockChange
	);
	observer.observe(options.document, {
		attributeFilter: ['class', 'hidden', 'style'],
		attributes: true,
		characterData: true,
		childList: true,
		subtree: true
	});
	evaluateReadiness();

	return () => {
		if (finished) return;
		finished = true;
		cleanup();
	};
}
