import assert from 'node:assert/strict';
import test from 'node:test';
import {
	GameUsabilitySignal,
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
	private readonly listeners = new Map<
		string,
		Set<() => void>
	>();

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

function createObservationHarness() {
	const document = new FakeDocument();
	let callback: MutationCallback = () => {};
	let disconnectCount = 0;
	let reportCount = 0;
	const observedTargets: Node[] = [];
	const observedOptions: (MutationObserverInit | undefined)[] = [];
	const stop = observeGameUsability({
		createMutationObserver: nextCallback => {
			callback = nextCallback;
			return {
				disconnect: () => {
					disconnectCount += 1;
				},
				observe: (target, options) => {
					observedTargets.push(target);
					observedOptions.push(options);
				}
			};
		},
		document: document as unknown as Document,
		onUsable: () => {
			reportCount += 1;
		}
	});

	return {
		document,
		get disconnectCount() {
			return disconnectCount;
		},
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

	assert.equal(signal.report(), true);
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
