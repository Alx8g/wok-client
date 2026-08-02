import assert from 'node:assert/strict';
import test from 'node:test';
import {
	DeadlineExceededError,
	type DeadlineScheduler,
	runBeforeDeadline
} from '../src/absolute-deadline.ts';

function createScheduler() {
	let callback: (() => void) | undefined;
	let cancelled = 0;
	let scheduledDelay = 0;
	const scheduler: DeadlineScheduler = {
		cancel() {
			cancelled += 1;
		},
		schedule(nextCallback, delayMs) {
			callback = nextCallback;
			scheduledDelay = delayMs;
			return Symbol('deadline');
		}
	};
	return {
		fire() { callback?.(); },
		get cancelled() { return cancelled; },
		get scheduledDelay() { return scheduledDelay; },
		scheduler
	};
}

test('uses the remaining time from one absolute deadline and clears the timer on success', async () => {
	const scheduled = createScheduler();
	const result = await runBeforeDeadline(
		async () => 'done',
		1_500,
		'Calibration phase',
		{ now: () => 1_000, scheduler: scheduled.scheduler }
	);

	assert.equal(result, 'done');
	assert.equal(scheduled.scheduledDelay, 500);
	assert.equal(scheduled.cancelled, 1);
});

test('does not start work after the absolute deadline is exhausted', async () => {
	let started = false;
	await assert.rejects(
		runBeforeDeadline(
			async () => {
				started = true;
			},
			1_000,
			'Calibration phase',
			{ now: () => 1_000 }
		),
		DeadlineExceededError
	);
	assert.equal(started, false);
});

test('rejects pending work when the shared deadline fires', async () => {
	const scheduled = createScheduler();
	const pending = runBeforeDeadline(
		() => new Promise<never>(() => {}),
		2_000,
		'Calibration renderer',
		{ now: () => 1_000, scheduler: scheduled.scheduler }
	);
	scheduled.fire();

	await assert.rejects(pending, /Calibration renderer timed out/u);
	assert.equal(scheduled.cancelled, 1);
});

test('propagates synchronous and asynchronous operation failures', async () => {
	await assert.rejects(
		runBeforeDeadline(() => { throw new Error('sync'); }, Date.now() + 1_000, 'Operation'),
		/sync/u
	);
	await assert.rejects(
		runBeforeDeadline(async () => { throw new Error('async'); }, Date.now() + 1_000, 'Operation'),
		/async/u
	);
});
