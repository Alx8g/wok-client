import assert from 'node:assert/strict';
import test from 'node:test';
import {
	formatLoadingDeadlineEvent,
	formatLoadingOverrunMessage,
	SPLASH_REVEAL_DEADLINE_MS,
	startLoadingDeadline,
	WINDOW_REVEAL_DEADLINE_MS,
	type LoadingDeadlineEvent,
	type LoadingDeadlineOptions,
	type LoadingDeadlineResolution
} from '../src/loading-deadline.ts';

class FakeClock {
	public nowMs = 0;
	private nextId = 1;
	private readonly timers = new Map<
		number,
		{ at: number; callback: () => void }
	>();

	public cancel = (handle: unknown): void => {
		this.timers.delete(handle as number);
	};

	public now = (): number => this.nowMs;

	public schedule = (
		callback: () => void,
		delayMs: number
	): unknown => {
		const id = this.nextId;
		this.nextId += 1;
		this.timers.set(id, { at: this.nowMs + delayMs, callback });
		return id;
	};

	public get pending(): number {
		return this.timers.size;
	}

	public advance(ms: number): void {
		const target = this.nowMs + ms;
		for (;;) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((first, second) => first[1].at - second[1].at)[0];
			if (!due) break;
			this.timers.delete(due[0]);
			this.nowMs = due[1].at;
			due[1].callback();
		}
		this.nowMs = target;
	}
}

function createHarness(overrides: Partial<LoadingDeadlineOptions> = {}) {
	const clock = new FakeClock();
	const events: LoadingDeadlineEvent[] = [];
	const failsafes: unknown[] = [];
	const lateReady: number[] = [];
	const resolutions: LoadingDeadlineResolution[] = [];
	let listener: (() => void) | undefined;
	let unsubscribeCount = 0;

	const deadline = startLoadingDeadline({
		deadlineMs: 20_000,
		now: clock.now,
		onDiagnostic: event => {
			events.push(event);
		},
		onFailsafe: error => {
			failsafes.push(error);
		},
		onLateReady: elapsedMs => {
			lateReady.push(elapsedMs);
		},
		onResolve: resolution => {
			resolutions.push(resolution);
		},
		scheduler: { cancel: clock.cancel, schedule: clock.schedule },
		subscribe: nextListener => {
			listener = nextListener;
			return () => {
				unsubscribeCount += 1;
				listener = undefined;
			};
		},
		...overrides
	});

	return {
		clock,
		deadline,
		events,
		failsafes,
		lateReady,
		reportReady: () => {
			assert.ok(listener, 'the readiness subscription is no longer active');
			listener();
		},
		resolutions,
		get subscribed() {
			return listener !== undefined;
		},
		get unsubscribeCount() {
			return unsubscribeCount;
		}
	};
}

test('readiness arriving normally reveals once and leaves nothing running', () => {
	const harness = createHarness();
	assert.equal(harness.resolutions.length, 0);
	assert.equal(harness.clock.pending, 1);

	harness.clock.advance(1_800);
	harness.reportReady();

	assert.deepEqual(harness.resolutions, [
		{ elapsedMs: 1_800, error: undefined, outcome: 'ready' }
	]);
	assert.equal(harness.clock.pending, 0, 'the deadline timer must be cancelled');
	assert.equal(harness.unsubscribeCount, 1);
	assert.equal(harness.subscribed, false);

	// Nothing that happens afterwards may reveal, or resolve, a second time.
	harness.clock.advance(120_000);
	harness.deadline.dispose();
	assert.equal(harness.resolutions.length, 1);
	assert.equal(harness.lateReady.length, 0);
	assert.equal(harness.deadline.resolution?.outcome, 'ready');
});

test('readiness that is already true when the wait starts arms nothing', () => {
	const clock = new FakeClock();
	const resolutions: LoadingDeadlineResolution[] = [];
	let unsubscribeCount = 0;
	const deadline = startLoadingDeadline({
		deadlineMs: 20_000,
		now: clock.now,
		onResolve: resolution => {
			resolutions.push(resolution);
		},
		scheduler: { cancel: clock.cancel, schedule: clock.schedule },
		subscribe: listener => {
			listener();
			return () => {
				unsubscribeCount += 1;
			};
		}
	});

	assert.deepEqual(resolutions, [
		{ elapsedMs: 0, error: undefined, outcome: 'ready' }
	]);
	assert.equal(clock.pending, 0, 'no timer may outlive a wait that never had to happen');
	assert.equal(unsubscribeCount, 1, 'the subscription is detached even when it resolved during setup');
	assert.equal(deadline.resolution?.outcome, 'ready');
});

test('readiness that never arrives is revealed by the deadline', () => {
	const harness = createHarness();

	harness.clock.advance(19_999);
	assert.equal(harness.resolutions.length, 0, 'nothing may reveal before the deadline');

	harness.clock.advance(1);
	assert.deepEqual(harness.resolutions, [
		{ elapsedMs: 20_000, error: undefined, outcome: 'overrun' }
	]);
	assert.equal(harness.clock.pending, 0);
	// The subscription is deliberately kept: readiness may still turn up.
	assert.equal(harness.subscribed, true);
	assert.equal(harness.unsubscribeCount, 0);

	harness.clock.advance(600_000);
	assert.equal(harness.resolutions.length, 1);
});

test('readiness arriving after the deadline retires the notice exactly once', () => {
	const harness = createHarness();
	harness.clock.advance(20_000);
	assert.equal(harness.resolutions[0].outcome, 'overrun');

	harness.clock.advance(14_000);
	harness.reportReady();
	assert.deepEqual(harness.lateReady, [34_000]);
	assert.equal(harness.unsubscribeCount, 1, 'a late arrival ends the subscription');
	assert.equal(harness.resolutions.length, 1, 'the reveal already happened');
	assert.equal(harness.deadline.resolution?.outcome, 'overrun');

	// A duplicate signal, then teardown, must both be inert.
	harness.deadline.dispose();
	assert.equal(harness.lateReady.length, 1);
	assert.equal(harness.resolutions.length, 1);
});

test('an exception anywhere in the readiness path still reveals the game', () => {
	const subscribeFailure = new Error('subscribe failed');
	const failedSubscribe = createHarness({
		subscribe: () => {
			throw subscribeFailure;
		}
	});
	assert.equal(failedSubscribe.resolutions.length, 1);
	assert.equal(failedSubscribe.resolutions[0].outcome, 'failed');
	assert.equal(failedSubscribe.resolutions[0].error, subscribeFailure);
	assert.equal(failedSubscribe.clock.pending, 0, 'a failed start must not arm a timer');

	// A scheduler that cannot schedule would otherwise mean an unbounded wait.
	const schedulerFailure = new Error('scheduler failed');
	const failedScheduler = createHarness({
		scheduler: {
			cancel: () => {},
			schedule: () => {
				throw schedulerFailure;
			}
		}
	});
	assert.equal(failedScheduler.resolutions[0].outcome, 'failed');
	assert.equal(failedScheduler.resolutions[0].error, schedulerFailure);
	assert.equal(failedScheduler.unsubscribeCount, 1);

	// The reveal itself throwing is the worst case: the failsafe is the only thing left.
	const revealFailure = new Error('reveal failed');
	const failsafes: unknown[] = [];
	const events: LoadingDeadlineEvent[] = [];
	const clock = new FakeClock();
	const failedReveal = startLoadingDeadline({
		deadlineMs: 20_000,
		now: clock.now,
		onDiagnostic: event => {
			events.push(event);
			if (event.kind === 'started') throw new Error('diagnostics failed');
		},
		onFailsafe: error => {
			failsafes.push(error);
		},
		onResolve: () => {
			throw revealFailure;
		},
		scheduler: { cancel: clock.cancel, schedule: clock.schedule },
		subscribe: () => () => {}
	});
	clock.advance(20_000);
	assert.deepEqual(failsafes, [revealFailure]);
	assert.equal(failedReveal.resolution?.outcome, 'overrun');
	assert.ok(
		events.some(event => event.kind === 'error' && event.detail?.stage === 'resolve'),
		'the failure is recorded for diagnosis'
	);

	// A readiness signal that arrives late and then throws is contained too.
	const lateFailure = createHarness({
		onLateReady: () => {
			throw new Error('late listener failed');
		}
	});
	lateFailure.clock.advance(20_000);
	lateFailure.reportReady();
	assert.equal(lateFailure.resolutions.length, 1);
	assert.ok(
		lateFailure.events.some(event => event.kind === 'error' && event.detail?.stage === 'late-ready')
	);
});

test('teardown cancels everything and never leaves the wait unresolved', () => {
	const harness = createHarness();
	harness.clock.advance(2_500);
	harness.deadline.dispose();

	assert.deepEqual(harness.resolutions, [
		{ elapsedMs: 2_500, error: undefined, outcome: 'disposed' }
	]);
	assert.equal(harness.clock.pending, 0);
	assert.equal(harness.unsubscribeCount, 1);
	assert.equal(harness.subscribed, false);

	harness.deadline.dispose();
	harness.clock.advance(120_000);
	assert.equal(harness.resolutions.length, 1);

	// An unsubscribe that throws during teardown is reported, not propagated.
	const noisyTeardown = createHarness({
		subscribe: () => () => {
			throw new Error('unsubscribe failed');
		}
	});
	noisyTeardown.deadline.dispose();
	assert.equal(noisyTeardown.resolutions[0].outcome, 'disposed');
	assert.ok(
		noisyTeardown.events.some(event => event.kind === 'error' && event.detail?.stage === 'unsubscribe')
	);
});

test('a broken clock or deadline still bounds the wait', () => {
	const clock = new FakeClock();
	const resolutions: LoadingDeadlineResolution[] = [];
	const deadline = startLoadingDeadline({
		deadlineMs: Number.NaN,
		now: () => {
			throw new Error('clock failed');
		},
		onResolve: resolution => {
			resolutions.push(resolution);
		},
		scheduler: { cancel: clock.cancel, schedule: clock.schedule },
		subscribe: () => () => {}
	});

	clock.advance(0);
	assert.equal(resolutions.length, 1);
	assert.equal(resolutions[0].outcome, 'overrun');
	assert.equal(resolutions[0].elapsedMs, 0);
	assert.equal(deadline.resolution?.outcome, 'overrun');
});

test('the deadlines are ordered so the renderer explains an overrun first', () => {
	// A weak machine's slowest measured launch is 11.15 s; see the constants for the full evidence.
	assert.ok(SPLASH_REVEAL_DEADLINE_MS > 11_150 * 1.5);
	assert.ok(SPLASH_REVEAL_DEADLINE_MS <= 30_000, 'nobody should sit on a covered screen for half a minute');
	assert.ok(WINDOW_REVEAL_DEADLINE_MS > SPLASH_REVEAL_DEADLINE_MS);
});

test('overrun wording states plainly what happened', () => {
	assert.equal(
		formatLoadingOverrunMessage(20_400),
		'Krunker is still loading after 20 seconds. WOK Client has removed its loading screen so you can see and use the page underneath.'
	);
	assert.match(formatLoadingOverrunMessage(Number.NaN), /after 0 seconds/u);

	assert.equal(
		formatLoadingDeadlineEvent('splash', {
			detail: { outcome: 'overrun', reason: 'Error: broken\nmarkup' },
			elapsedMs: 20_000.4,
			kind: 'resolved'
		}),
		'splash resolved elapsed=20000ms outcome=overrun reason=Error: broken markup'
	);
	assert.equal(
		formatLoadingDeadlineEvent('splash', { elapsedMs: 12, kind: 'late-ready' }),
		'splash late-ready elapsed=12ms'
	);
});
