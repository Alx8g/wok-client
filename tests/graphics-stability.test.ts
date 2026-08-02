import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createGraphicsStabilityConfirmation,
	type GraphicsStabilityScheduler
} from '../src/graphics-stability.ts';

class DeferredScheduler implements GraphicsStabilityScheduler {
	readonly delays: number[] = [];
	readonly callbacks: Array<() => void> = [];
	cancelledHandles: unknown[] = [];

	cancel(handle: unknown): void {
		this.cancelledHandles.push(handle);
	}

	schedule(callback: () => void, delayMs: number): unknown {
		const handle = this.callbacks.length;
		this.callbacks.push(callback);
		this.delays.push(delayMs);
		return handle;
	}

	run(index: number): void {
		this.callbacks[index]?.();
	}
}

test('graphics stability confirms after one continuously surviving main-frame load', () => {
	const scheduler = new DeferredScheduler();
	let confirmations = 0;
	const stability = createGraphicsStabilityConfirmation({
		delayMs: 30_000,
		onStable: () => { confirmations++; },
		scheduler
	});

	stability.mainFrameLoadStarted();
	stability.mainFrameLoadFinished();

	assert.deepEqual(scheduler.delays, [30_000]);
	assert.equal(confirmations, 0);
	scheduler.run(0);
	assert.equal(confirmations, 1);
});

test('a navigation invalidates the old confirmation and restarts after the new load', () => {
	const scheduler = new DeferredScheduler();
	let confirmations = 0;
	const stability = createGraphicsStabilityConfirmation({
		delayMs: 30_000,
		onStable: () => { confirmations++; },
		scheduler
	});

	stability.mainFrameLoadFinished();
	stability.mainFrameLoadStarted();
	scheduler.run(0);
	assert.equal(confirmations, 0, 'a stale queued callback must not confirm the previous load');

	stability.mainFrameLoadFinished();
	scheduler.run(1);
	assert.equal(confirmations, 1);
});

test('a renderer exit invalidates an already queued success callback', () => {
	const scheduler = new DeferredScheduler();
	let confirmations = 0;
	const stability = createGraphicsStabilityConfirmation({
		delayMs: 30_000,
		onStable: () => { confirmations++; },
		scheduler
	});

	stability.mainFrameLoadFinished();
	stability.cancel();
	scheduler.run(0);

	assert.equal(confirmations, 0);
	assert.deepEqual(scheduler.cancelledHandles, [0]);
});
