import assert from 'node:assert/strict';
import test from 'node:test';
import { startGameplayFpsLog, type GameplayFpsSample } from '../src/gameplay-fps-log.ts';

interface Harness {
	emitted: GameplayFpsSample[];
	recorded: number[];
	setActive(active: boolean): void;
	stop(): void;
	tick(frameTimeMs: number): void;
}

function createHarness(options: { emitIntervalMs?: number; warmupFrames?: number } = {}): Harness {
	const emitted: GameplayFpsSample[] = [];
	const recorded: number[] = [];
	let active = true;
	let clock = 0;
	let pending: ((timestamp: number) => void) | undefined;

	const stop = startGameplayFpsLog({
		emit: sample => { emitted.push(sample); },
		emitIntervalMs: options.emitIntervalMs ?? 100,
		isActive: () => active,
		now: () => clock,
		recordFrame: (_timestamp, frameTimeMs) => { recorded.push(frameTimeMs); },
		requestFrame: callback => { pending = callback; },
		snapshot: () => ({
			averageFps: recorded.length,
			onePercentLowFps: 1,
			p95FrameTimeMs: 2,
			sampleCount: recorded.length,
			windowSeconds: 10,
			worstFrameTimeMs: 3
		}),
		warmupFrames: options.warmupFrames ?? 2
	});

	return {
		emitted,
		recorded,
		setActive: value => { active = value; },
		stop,
		tick: frameTimeMs => {
			clock += frameTimeMs;
			const callback = pending;
			pending = undefined;
			assert.ok(callback, 'expected a scheduled frame');
			callback(clock);
		}
	};
}

test('records only gameplay frames and emits on the interval after warmup', () => {
	const harness = createHarness({ emitIntervalMs: 100, warmupFrames: 2 });

	harness.setActive(false);
	for (let index = 0; index < 5; index++) harness.tick(16);
	assert.deepEqual(harness.recorded, [], 'menu frames must not be recorded');
	assert.deepEqual(harness.emitted, [], 'menu frames must not emit');

	harness.setActive(true);
	for (let index = 0; index < 4; index++) harness.tick(10); // first tick establishes the baseline
	assert.deepEqual(harness.recorded, [10, 10, 10]);
	assert.equal(harness.emitted.length, 0, 'no emit before the interval elapses');

	for (let index = 0; index < 12; index++) harness.tick(10);
	assert.equal(harness.emitted.length, 1);
	// The snapshot reflects the moment of emission, not the end of the test.
	assert.ok(harness.emitted[0].sampleCount > 0);
	assert.ok(harness.emitted[0].sampleCount <= harness.recorded.length);
});

test('a gap in gameplay never becomes a recorded frame interval', () => {
	const harness = createHarness();
	harness.tick(10);
	harness.tick(10);
	assert.deepEqual(harness.recorded, [10]);

	// Leaving pointer lock (menu, scoreboard, alt-tab) and returning much later must not record
	// the entire absence as one enormous frame — that is exactly what corrupts worst-frame stats.
	harness.setActive(false);
	harness.tick(5_000);
	harness.setActive(true);
	harness.tick(10);
	assert.deepEqual(harness.recorded, [10], 'the gap must not be recorded');
	harness.tick(10);
	assert.deepEqual(harness.recorded, [10, 10]);
});

test('implausible frame intervals are discarded and stopping ends sampling', () => {
	const harness = createHarness();
	harness.tick(10);
	harness.tick(2_000); // beyond the plausible bound
	assert.deepEqual(harness.recorded, []);

	harness.tick(10);
	assert.deepEqual(harness.recorded, [10]);

	harness.stop();
	harness.tick(10);
	assert.deepEqual(harness.recorded, [10], 'no sampling after stop');
});
