import assert from 'node:assert/strict';
import test from 'node:test';
import {
	getNetworkDiagnosticsSnapshot,
	getPerformanceSnapshot,
	startPerformanceMonitor,
	stopPerformanceMonitor
} from '../src/performance-monitor.ts';

type TestListener = (event: Event) => void;

function createEventTarget() {
	const listeners = new Map<string, Set<TestListener>>();
	return {
		addEventListener(type: string, listener: TestListener) {
			let typeListeners = listeners.get(type);
			if (!typeListeners) {
				typeListeners = new Set();
				listeners.set(type, typeListeners);
			}
			typeListeners.add(listener);
		},
		removeEventListener(type: string, listener: TestListener) {
			listeners.get(type)?.delete(listener);
		},
		dispatch(type: string) {
			for (const listener of listeners.get(type) ?? []) listener(new Event(type));
		},
		listenerCount() {
			let count = 0;
			for (const typeListeners of listeners.values()) count += typeListeners.size;
			return count;
		}
	};
}

test('sampling follows overlay and document visibility lifecycle', () => {
	const originalDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
	const installGlobal = (key: PropertyKey, value: unknown) => {
		originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
	};
	const restoreGlobals = () => {
		for (const [key, descriptor] of originalDescriptors) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};

	const documentEvents = createEventTarget();
	const windowEvents = createEventTarget();
	const animationFrames = new Map<number, FrameRequestCallback>();
	let nextAnimationFrame = 1;
	let overlayRemoved = false;
	const overlay = {
		hidden: false,
		id: '',
		style: {},
		textContent: '',
		setAttribute() {},
		remove() { overlayRemoved = true; }
	} as unknown as HTMLPreElement;
	const fakeDocument = {
		visibilityState: 'visible',
		body: { append() {} },
		createElement: () => overlay,
		addEventListener: documentEvents.addEventListener,
		removeEventListener: documentEvents.removeEventListener
	} as unknown as Document;
	const fakeWindow = {
		addEventListener: windowEvents.addEventListener,
		removeEventListener: windowEvents.removeEventListener
	} as unknown as Window;

	installGlobal('document', fakeDocument);
	installGlobal('window', fakeWindow);
	installGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		const handle = nextAnimationFrame++;
		animationFrames.set(handle, callback);
		return handle;
	});
	installGlobal('cancelAnimationFrame', (handle: number) => {
		animationFrames.delete(handle);
	});

	const runAnimationFrame = (now: number) => {
		const next = animationFrames.entries().next().value as [number, FrameRequestCallback] | undefined;
		assert.ok(next);
		animationFrames.delete(next[0]);
		next[1](now);
	};

	try {
		const runtimeInfo: GraphicsRuntimeInfo = {
			activeBackend: 'default',
			preference: 'auto',
			recommendation: 'default',
			reason: 'test',
			source: 'test',
			features: {}
		};
		const startTime = performance.now();
		startPerformanceMonitor(runtimeInfo);
		assert.equal(animationFrames.size, 1);

		runAnimationFrame(startTime + 5);
		runAnimationFrame(startTime + 10);
		assert.equal(getPerformanceSnapshot(startTime + 10).sampleCount, 1);

		fakeWindow.wokPerformance?.setVisible(false);
		assert.equal(animationFrames.size, 0);
		assert.equal(overlay.hidden, true);

		fakeWindow.wokPerformance?.setVisible(true);
		assert.equal(animationFrames.size, 1);
		assert.equal(overlay.hidden, false);

		Object.defineProperty(fakeDocument, 'visibilityState', { configurable: true, value: 'hidden', writable: true });
		documentEvents.dispatch('visibilitychange');
		assert.equal(animationFrames.size, 0);

		Object.defineProperty(fakeDocument, 'visibilityState', { configurable: true, value: 'visible', writable: true });
		documentEvents.dispatch('visibilitychange');
		assert.equal(animationFrames.size, 1);

		stopPerformanceMonitor();
		assert.equal(animationFrames.size, 0);
		assert.equal(documentEvents.listenerCount(), 0);
		assert.equal(windowEvents.listenerCount(), 0);
		assert.equal(overlayRemoved, true);
		assert.equal(fakeWindow.wokPerformance, undefined);
	} finally {
		stopPerformanceMonitor();
		restoreGlobals();
	}
});

test('network telemetry follows the overlay lifecycle and retains Krunker semantics', () => {
	const originalDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
	const installGlobal = (key: PropertyKey, value: unknown) => {
		originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
	};
	const restoreGlobals = () => {
		for (const [key, descriptor] of originalDescriptors) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};

	const documentEvents = createEventTarget();
	const windowEvents = createEventTarget();
	const animationFrames = new Map<number, FrameRequestCallback>();
	let nextAnimationFrame = 1;
	let mutationCallback: (() => void) | undefined;
	let observerDisconnects = 0;
	const pingElement = { hidden: false, style: {}, textContent: '24' } as HTMLElement;
	const tickElement = { hidden: false, style: {}, textContent: '30 TPS' } as HTMLElement;
	const lagElement = { hidden: false, style: { display: 'none' }, textContent: 'Network Lag Detected!' } as HTMLElement;
	const elements = new Map<string, HTMLElement>([
		['pingText', pingElement],
		['tickPacketCount', tickElement],
		['networkLag', lagElement]
	]);
	const overlay = {
		hidden: false,
		id: '',
		style: {},
		textContent: '',
		setAttribute() {},
		remove() {}
	} as unknown as HTMLPreElement;
	const fakeDocument = {
		visibilityState: 'visible',
		body: { append() {} },
		createElement: () => overlay,
		getElementById: (id: string) => elements.get(id) ?? null,
		addEventListener: documentEvents.addEventListener,
		removeEventListener: documentEvents.removeEventListener
	} as unknown as Document;
	const fakeWindow = {
		location: { search: '' },
		getGameActivity: () => ({ id: 'SYD:lk6tt' }),
		addEventListener: windowEvents.addEventListener,
		removeEventListener: windowEvents.removeEventListener
	} as unknown as Window;
	class FakeMutationObserver {
		public constructor(callback: MutationCallback) {
			mutationCallback = () => callback([], this as unknown as MutationObserver);
		}

		public disconnect() {
			observerDisconnects += 1;
		}

		public observe() {}
	}

	installGlobal('document', fakeDocument);
	installGlobal('window', fakeWindow);
	installGlobal('MutationObserver', FakeMutationObserver);
	installGlobal('getComputedStyle', (element: HTMLElement) => ({
		display: element.style.display || 'block',
		opacity: element.style.opacity || '1',
		visibility: element.style.visibility || 'visible'
	}));
	installGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		const handle = nextAnimationFrame++;
		animationFrames.set(handle, callback);
		return handle;
	});
	installGlobal('cancelAnimationFrame', (handle: number) => {
		animationFrames.delete(handle);
	});

	try {
		startPerformanceMonitor({
			activeBackend: 'default',
			preference: 'auto',
			recommendation: 'default',
			reason: 'test',
			source: 'test',
			features: {}
		});
		const initial = getNetworkDiagnosticsSnapshot(performance.now());
		assert.equal(initial.currentReportedPingMs, 24);
		assert.equal(initial.medianReportedPingMs, 24);
		assert.equal(initial.reportedPingSampleCount, 1);
		assert.equal(initial.regionCode, 'SYD');
		assert.equal(initial.reportedTps, 30);
		assert.equal(initial.networkLagWarning, false);
		assert.match(overlay.textContent ?? '', /KRUNKER-REPORTED NETWORK \(not RTT\)/u);
		assert.match(overlay.textContent ?? '', /server\s+SYD · TPS 30/u);

		pingElement.textContent = '80';
		mutationCallback?.();
		lagElement.style.display = 'block';
		const updated = fakeWindow.wokPerformance?.networkSnapshot();
		assert.ok(updated);
		assert.equal(updated.currentReportedPingMs, 80);
		assert.equal(updated.p95ReportedPingMs, 80);
		assert.equal(updated.reportedPingVariationMs, 56);
		assert.equal(updated.networkLagWarning, true);

		fakeWindow.wokPerformance?.setVisible(false);
		assert.equal(animationFrames.size, 0);
		assert.ok(observerDisconnects >= 1);
		pingElement.textContent = '120';
		mutationCallback?.();
		assert.equal(getNetworkDiagnosticsSnapshot(performance.now()).reportedPingSampleCount, 2);

		fakeWindow.wokPerformance?.setVisible(true);
		const resumed = getNetworkDiagnosticsSnapshot(performance.now());
		assert.equal(resumed.currentReportedPingMs, 120);
		assert.equal(resumed.reportedPingSampleCount, 3);

		stopPerformanceMonitor();
		assert.equal(fakeWindow.wokPerformance, undefined);
	} finally {
		stopPerformanceMonitor();
		restoreGlobals();
	}
});
