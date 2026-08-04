import assert from 'node:assert/strict';
import test from 'node:test';
import {
	describeGameUsability,
	formatGameUsabilitySnapshot,
	GameUsabilitySignal,
	isGameUsable,
	observeGameUsability
} from '../src/game-usability.ts';

class FakeElement {
	public hasLoadingSpinner = false;
	public hidden = false;
	public readonly style = { display: '' };
	public textContent = '';

	public querySelector(selector: string): FakeElement | null {
		return selector === '.lds-ring' && this.hasLoadingSpinner
			? new FakeElement()
			: null;
	}
}

class FakeDocument {
	public instructions: FakeElement | null = null;
	public loadingBackground: FakeElement | null = null;
	public pointerLockElement: object | null = null;
	public readyState = 'loading';
	/** Set to make every style read throw, the way a detached or hostile document can. */
	public styleReadsThrow = false;
	private readonly listeners = new Map<
		string,
		Set<() => void>
	>();

	/** What getComputedStyle reports, so a test can hide the overlay without an inline style. */
	public computedDisplay = '';

	public get defaultView(): { getComputedStyle(element: unknown): { display: string } } {
		if (this.styleReadsThrow) throw new Error('no view');
		return {
			getComputedStyle: () => ({ display: this.computedDisplay })
		};
	}

	public addEventListener(
		type: string,
		listener: () => void
	): void {
		const listeners = this.listeners.get(type)
			?? new Set<() => void>();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	public removeEventListener(
		type: string,
		listener: () => void
	): void {
		this.listeners.get(type)?.delete(listener);
	}

	public dispatch(type: string): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener();
		}
	}

	public getElementById(id: string): FakeElement | null {
		if (id === 'instructions') return this.instructions;
		if (id === 'loadingBg') return this.loadingBackground;
		return null;
	}

	public listenerCount(type: string): number {
		return this.listeners.get(type)?.size ?? 0;
	}
}

function completeInitialLoading(document: FakeDocument): void {
	document.instructions = new FakeElement();
	document.instructions.textContent = 'CLICK TO PLAY';
	document.loadingBackground = new FakeElement();
	document.loadingBackground.style.display = 'none';
}

function createObservationHarness(
	options: {
		createMutationObserver?: (callback: MutationCallback) => never;
		onUsable?: () => void;
	} = {}
) {
	const document = new FakeDocument();
	const errors: unknown[] = [];
	let callback: MutationCallback = () => {};
	let disconnectCount = 0;
	let reportCount = 0;
	const observedTargets: Node[] = [];
	const observedOptions: (MutationObserverInit | undefined)[] = [];
	const stop = observeGameUsability({
		createMutationObserver: options.createMutationObserver ?? (nextCallback => {
			callback = nextCallback;
			return {
				disconnect: () => {
					disconnectCount += 1;
				},
				observe: (target, observeOptions) => {
					observedTargets.push(target);
					observedOptions.push(observeOptions);
				}
			};
		}),
		document: document as unknown as Document,
		onError: error => {
			errors.push(error);
		},
		onUsable: () => {
			reportCount += 1;
			options.onUsable?.();
		}
	});

	return {
		document,
		get disconnectCount() {
			return disconnectCount;
		},
		errors,
		get reportCount() {
			return reportCount;
		},
		observedOptions,
		observedTargets,
		stop,
		triggerMutation: () => {
			callback(
				[],
				{} as MutationObserver
			);
		}
	};
}

test('game usability signal reports once and isolates faulty listeners', () => {
	let firstReportCount = 0;
	let listenerCount = 0;
	const errors: unknown[] = [];
	const signal = new GameUsabilitySignal({
		onFirstReport: () => {
			firstReportCount += 1;
		},
		onListenerError: error => {
			errors.push(error);
		}
	});

	signal.subscribe(() => {
		throw new Error('listener failed');
	});
	signal.subscribe(() => {
		listenerCount += 1;
	});

	assert.equal(signal.hasReported, false);
	assert.equal(signal.report(), true);
	assert.equal(signal.hasReported, true, 'presentation code needs to know it is already too late to mount');
	assert.equal(signal.report(), false);
	assert.equal(firstReportCount, 1);
	assert.equal(listenerCount, 1);
	assert.equal(errors.length, 1);
});

test('late game usability subscriptions are asynchronous and cancellable', () => {
	const scheduled: (() => void)[] = [];
	let listenerCount = 0;
	const signal = new GameUsabilitySignal({
		onFirstReport: () => {},
		onListenerError: error => {
			throw error;
		},
		schedule: callback => {
			scheduled.push(callback);
		}
	});

	signal.report();
	const cancel = signal.subscribe(() => {
		listenerCount += 1;
	});
	cancel();
	signal.subscribe(() => {
		listenerCount += 1;
	});

	assert.equal(listenerCount, 0);
	for (const callback of scheduled) callback();
	assert.equal(listenerCount, 1);
});

test('readiness ignores Krunker loading instructions until the overlay clears', () => {
	const harness = createObservationHarness();
	assert.equal(harness.observedTargets.length, 1);
	assert.deepEqual(harness.observedOptions[0], {
		attributeFilter: ['class', 'hidden', 'style'],
		attributes: true,
		characterData: true,
		childList: true,
		subtree: true
	});
	assert.equal(harness.reportCount, 0);
	assert.equal(
		harness.document.listenerCount('pointerlockchange'),
		1
	);

	// Current Krunker creates this populated spinner around nine seconds before it is playable.
	harness.document.instructions = new FakeElement();
	harness.document.instructions.hasLoadingSpinner = true;
	harness.document.loadingBackground = new FakeElement();
	harness.triggerMutation();
	assert.equal(harness.reportCount, 0);

	// Neither a prompt behind the loading overlay nor a hidden overlay with a spinner is sufficient.
	harness.document.instructions.textContent = 'CLICK TO PLAY';
	harness.triggerMutation();
	assert.equal(harness.reportCount, 0);
	harness.document.loadingBackground.style.display = 'none';
	harness.triggerMutation();
	assert.equal(harness.reportCount, 0);

	harness.document.instructions.hasLoadingSpinner = false;
	harness.triggerMutation();
	assert.equal(harness.reportCount, 1);
	assert.equal(harness.disconnectCount, 1);
	assert.equal(
		harness.document.listenerCount('pointerlockchange'),
		0
	);

	harness.triggerMutation();
	harness.document.pointerLockElement = {};
	harness.document.dispatch('pointerlockchange');
	assert.equal(harness.reportCount, 1);
});

test('an exception in the readiness path never stops readiness arriving later', () => {
	const harness = createObservationHarness();
	harness.document.instructions = new FakeElement();
	harness.document.instructions.textContent = 'CLICK TO PLAY';
	harness.document.loadingBackground = new FakeElement();
	// Krunker hides the overlay by class rather than inline style here, so readiness depends on a
	// computed style read - the one call in this predicate that a document can refuse to answer.
	harness.document.computedDisplay = 'none';
	harness.document.styleReadsThrow = true;

	harness.triggerMutation();
	assert.equal(harness.reportCount, 0, 'an unreadable document is not evidence of a usable game');
	assert.equal(harness.errors.length > 0, true, 'the failure is reported for diagnosis');
	assert.equal(harness.disconnectCount, 0, 'the observer must keep watching');

	// Recovery needs no new observer: the next mutation is evaluated exactly as before.
	harness.document.styleReadsThrow = false;
	harness.triggerMutation();
	assert.equal(harness.reportCount, 1);

	// A readiness callback that throws is contained rather than escaping into Krunker's code.
	const throwingListener = createObservationHarness({
		onUsable: () => {
			throw new Error('listener failed');
		}
	});
	completeInitialLoading(throwingListener.document);
	throwingListener.triggerMutation();
	assert.equal(throwingListener.reportCount, 1);
	assert.equal(throwingListener.errors.length, 1);

	// Even a MutationObserver that cannot be created leaves pointer lock working.
	const brokenObserver = createObservationHarness({
		createMutationObserver: () => {
			throw new Error('no observer');
		}
	});
	assert.equal(brokenObserver.errors.length, 1);
	brokenObserver.document.pointerLockElement = {};
	brokenObserver.document.dispatch('pointerlockchange');
	assert.equal(brokenObserver.reportCount, 1);
	brokenObserver.stop();
});

test('the readiness snapshot describes why a load is stuck without ever throwing', () => {
	const loading = new FakeDocument();
	loading.readyState = 'interactive';
	loading.instructions = new FakeElement();
	loading.instructions.hasLoadingSpinner = true;
	loading.instructions.textContent = 'LOADING';
	loading.loadingBackground = new FakeElement();

	const stillLoading = describeGameUsability(loading as unknown as Document);
	assert.deepEqual(stillLoading, {
		instructionsPresent: true,
		instructionsSpinner: true,
		instructionsTextLength: 7,
		loadingBackgroundHidden: false,
		loadingBackgroundPresent: true,
		pointerLocked: false,
		readyState: 'interactive'
	});
	assert.equal(isGameUsable(stillLoading), false);
	assert.equal(
		formatGameUsabilitySnapshot(stillLoading),
		'readyState=interactive pointerLocked=false instructions=present instructionsText=7 spinner=true loadingBg=visible'
	);

	// Markup that WOK does not recognise at all - an error, login or ban screen, or a Krunker
	// change - is reported as missing rather than mistaken for readiness.
	const foreignPage = describeGameUsability(new FakeDocument() as unknown as Document);
	assert.equal(isGameUsable(foreignPage), false);
	assert.match(
		formatGameUsabilitySnapshot(foreignPage),
		/instructions=missing .*loadingBg=missing/u
	);

	const hostile = {
		get defaultView(): never {
			throw new Error('no view');
		},
		getElementById: () => {
			throw new Error('no elements');
		},
		get pointerLockElement(): never {
			throw new Error('no pointer lock');
		},
		get readyState(): never {
			throw new Error('no ready state');
		}
	};
	const errors: unknown[] = [];
	const snapshot = describeGameUsability(
		hostile as unknown as Document,
		error => {
			errors.push(error);
		}
	);
	assert.equal(isGameUsable(snapshot), false);
	assert.equal(snapshot.readyState, 'unknown');
	assert.equal(errors.length, 4);

	// Pointer lock alone is definitive, whatever the rest of the page looks like.
	const locked = new FakeDocument();
	locked.pointerLockElement = {};
	assert.equal(isGameUsable(describeGameUsability(locked as unknown as Document)), true);
});

test('pointer lock independently reports usability and cancellation detaches observers', () => {
	const pointerHarness = createObservationHarness();
	pointerHarness.document.dispatch('pointerlockchange');
	assert.equal(pointerHarness.reportCount, 0);
	pointerHarness.document.pointerLockElement = {};
	pointerHarness.document.dispatch('pointerlockchange');
	assert.equal(pointerHarness.reportCount, 1);
	assert.equal(pointerHarness.disconnectCount, 1);

	const cancelledHarness = createObservationHarness();
	cancelledHarness.stop();
	completeInitialLoading(cancelledHarness.document);
	cancelledHarness.triggerMutation();
	assert.equal(cancelledHarness.reportCount, 0);
	assert.equal(cancelledHarness.disconnectCount, 1);
	assert.equal(
		cancelledHarness.document.listenerCount(
			'pointerlockchange'
		),
		0
	);
});
