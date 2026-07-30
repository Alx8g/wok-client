import assert from 'node:assert/strict';
import test from 'node:test';
import { getPerformanceSnapshot, startPerformanceMonitor, stopPerformanceMonitor } from '../src/performance-monitor.ts';

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
		assert.equal(fakeWindow.crankshaftPerformance, undefined);
	} finally {
		stopPerformanceMonitor();
		restoreGlobals();
	}
});
