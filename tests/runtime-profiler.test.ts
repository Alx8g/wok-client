import assert from 'node:assert/strict';
import test from 'node:test';
import {
	RUNTIME_PROFILE_DURATION_MS,
	RUNTIME_PROFILE_SAMPLE_INTERVAL_US,
	RuntimeProfiler,
	type RuntimeProfileEnvironment,
	type RuntimeProfileRequest
} from '../src/runtime-profiler.ts';

function request(overrides: Partial<RuntimeProfileRequest> = {}): RuntimeProfileRequest {
	return {
		durationMs: RUNTIME_PROFILE_DURATION_MS,
		metadata: { build: 'test' },
		paths: {
			cpuProfile: 'profile.cpuprofile',
			manifest: 'manifest.json',
			trace: 'trace.json'
		},
		sampleIntervalUs: RUNTIME_PROFILE_SAMPLE_INTERVAL_US,
		traceCategories: ['v8', 'blink'],
		...overrides
	};
}

function environment(options: {
	alreadyAttached?: boolean;
	failCommand?: string;
	wait?: (durationMs: number) => Promise<void>;
} = {}) {
	const calls: string[] = [];
	const writes = new Map<string, unknown>();
	let attached = Boolean(options.alreadyAttached);
	let clock = 0;
	const value: RuntimeProfileEnvironment = {
		debugger: {
			attach(version) {
				calls.push(`attach:${version}`);
				attached = true;
			},
			detach() {
				calls.push('detach');
				attached = false;
			},
			isAttached: () => attached,
			async sendCommand(method, parameters) {
				calls.push(parameters ? `${method}:${JSON.stringify(parameters)}` : method);
				if (method === options.failCommand) throw new Error(`failed ${method}`);
				if (method === 'Profiler.stop') return { profile: { endTime: 2, nodes: [], startTime: 1 } };
				return {};
			}
		},
		now() {
			const result = new Date(`2026-08-28T00:00:0${clock}.000Z`);
			clock++;
			return result;
		},
		async startTracing(categories) {
			calls.push(`trace-start:${categories.join(',')}`);
		},
		async stopTracing(path) {
			calls.push(`trace-stop:${path}`);
			return path;
		},
		wait: options.wait ?? (async durationMs => {
			calls.push(`wait:${durationMs}`);
		}),
		async writeJson(path, contents) {
			calls.push(`write:${path}`);
			writes.set(path, contents);
		}
	};
	return { calls, environment: value, writes };
}

test('captures matching renderer CPU and Chromium trace artifacts, then detaches cleanly', async () => {
	const fixture = environment();
	const profiler = new RuntimeProfiler(fixture.environment);

	const result = await profiler.capture(request());

	assert.deepEqual(fixture.calls, [
		'attach:1.3',
		'Profiler.enable',
		`Profiler.setSamplingInterval:{"interval":${RUNTIME_PROFILE_SAMPLE_INTERVAL_US}}`,
		'trace-start:v8,blink',
		'Profiler.start',
		`wait:${RUNTIME_PROFILE_DURATION_MS}`,
		'Profiler.stop',
		'trace-stop:trace.json',
		'write:profile.cpuprofile',
		'write:manifest.json',
		'Profiler.disable',
		'detach'
	]);
	assert.deepEqual(fixture.writes.get('profile.cpuprofile'), { endTime: 2, nodes: [], startTime: 1 });
	assert.deepEqual(result, {
		completedAt: '2026-08-28T00:00:01.000Z',
		cpuProfilePath: 'profile.cpuprofile',
		durationMs: RUNTIME_PROFILE_DURATION_MS,
		startedAt: '2026-08-28T00:00:00.000Z',
		tracePath: 'trace.json'
	});
	assert.equal(profiler.isRunning(), false);
});

test('rejects overlap while a capture is waiting and becomes reusable afterward', async () => {
	let releaseWait: (() => void) | undefined;
	const waiting = new Promise<void>(resolve => { releaseWait = resolve; });
	const fixture = environment({ wait: () => waiting });
	const profiler = new RuntimeProfiler(fixture.environment);
	const first = profiler.capture(request());

	await Promise.resolve();
	await Promise.resolve();
	assert.equal(profiler.isRunning(), true);
	await assert.rejects(profiler.capture(request()), /already running/);

	releaseWait?.();
	await first;
	assert.equal(profiler.isRunning(), false);
});

test('does not disturb a renderer already attached to Developer Tools', async () => {
	const fixture = environment({ alreadyAttached: true });
	const profiler = new RuntimeProfiler(fixture.environment);

	await assert.rejects(profiler.capture(request()), /Close Developer Tools/);
	assert.deepEqual(fixture.calls, []);
});

test('stops tracing, disables profiling and detaches after a profiling failure', async () => {
	const fixture = environment({ failCommand: 'Profiler.start' });
	const profiler = new RuntimeProfiler(fixture.environment);

	await assert.rejects(profiler.capture(request()), /failed Profiler\.start/);
	assert.deepEqual(fixture.calls, [
		'attach:1.3',
		'Profiler.enable',
		`Profiler.setSamplingInterval:{"interval":${RUNTIME_PROFILE_SAMPLE_INTERVAL_US}}`,
		'trace-start:v8,blink',
		'Profiler.start',
		'trace-stop:trace.json',
		'Profiler.disable',
		'detach'
	]);
	assert.equal(profiler.isRunning(), false);
});

test('validates duration, sampling interval, paths and categories before attaching', async () => {
	const fixture = environment();
	const profiler = new RuntimeProfiler(fixture.environment);

	await assert.rejects(profiler.capture(request({ durationMs: 999 })), /duration/);
	await assert.rejects(profiler.capture(request({ sampleIntervalUs: 99 })), /sampling interval/);
	await assert.rejects(profiler.capture(request({ paths: { cpuProfile: '', manifest: 'm', trace: 't' } })), /paths/);
	await assert.rejects(profiler.capture(request({ traceCategories: [] })), /categories/);
	assert.deepEqual(fixture.calls, []);
});
