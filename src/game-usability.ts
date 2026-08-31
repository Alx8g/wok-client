export interface GameUsabilitySignalOptions {
	onFirstReport(): void;
	onListenerError(error: unknown): void;
	schedule?(callback: () => void): void;
}
export class GameUsabilitySignal {
	private readonly listeners = new Set<() => void>();
	private readonly options: GameUsabilitySignalOptions;
	private readonly schedule: (callback: () => void) => void;
	private reported = false;
	public constructor(options: GameUsabilitySignalOptions) {
		this.options = options;
		this.schedule = options.schedule ?? queueMicrotask;
	}
	public get hasReported(): boolean {
		return this.reported;
	}
	private notify(listener: () => void): void {
		try {
			listener();
		} catch (error) {
			try {
				this.options.onListenerError(error);
			} catch {}
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
	observe(target: Node, options?: MutationObserverInit): void;
}
export interface GameUsabilityObservationOptions {
	createMutationObserver?(callback: MutationCallback): MutationObserverHandle;
	document: Document;
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
export function describeGameUsability(document: Document, onError?: (error: unknown) => void): GameUsabilitySnapshot {
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
			try {
				onError?.(error);
			} catch {}
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
		snapshot.loadingBackgroundHidden = Boolean(loadingBackground.hidden || loadingBackground.style?.display === 'none' || document.defaultView?.getComputedStyle(loadingBackground)?.display === 'none');
	});
	return snapshot;
}
export function isGameUsable(snapshot: GameUsabilitySnapshot): boolean {
	if (snapshot.pointerLocked) return true;
	return snapshot.instructionsPresent && snapshot.loadingBackgroundPresent && snapshot.loadingBackgroundHidden && snapshot.instructionsTextLength > 0 && !snapshot.instructionsSpinner;
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
export function observeGameUsability(options: GameUsabilityObservationOptions): () => void {
	const createMutationObserver = options.createMutationObserver ?? ((callback) => new MutationObserver(callback));
	let finished = false;
	const reportError = (error: unknown): void => {
		try {
			options.onError?.(error);
		} catch {}
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
			options.document.removeEventListener('pointerlockchange', onPointerLockChange);
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
			usable = isGameUsable(describeGameUsability(options.document, reportError));
		} catch (error) {
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
		options.document.addEventListener('pointerlockchange', onPointerLockChange);
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
