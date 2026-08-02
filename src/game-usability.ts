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
 * Watches the whole document until Krunker's instructions UI has content or gameplay acquires
 * pointer lock. Observing the document, rather than an element captured at load, covers late
 * creation and replacement of #instructions.
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
	const instructionsAreReady = (): boolean =>
		options.document
			.getElementById('instructions')
			?.hasChildNodes() === true;
	const evaluateInstructions = (): void => {
		if (instructionsAreReady()) finish();
	};
	const onPointerLockChange = (): void => {
		if (options.document.pointerLockElement) finish();
	};
	const observer = createMutationObserver(
		evaluateInstructions
	);

	options.document.addEventListener(
		'pointerlockchange',
		onPointerLockChange
	);
	observer.observe(options.document, {
		childList: true,
		subtree: true
	});
	evaluateInstructions();

	return () => {
		if (finished) return;
		finished = true;
		cleanup();
	};
}
