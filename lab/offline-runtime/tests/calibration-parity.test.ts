import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildCalibrationTrialPage } from '../../../src/calibration-window.ts';
import { WORKLOAD_VERSION } from '../../../src/calibration-workload.ts';
import { buildCalibrationParityPage } from '../src/page/calibration-parity.ts';
import { sha256Hex } from '../src/shared/hash.ts';
import {
	RUNTIME_LAB_FOREGROUND_SETTLE_MS,
	RUNTIME_LAB_FOREGROUND_TIMEOUT_MS,
	RUNTIME_LAB_PAGE_ID,
	type RuntimeLabBenchmarkResult
} from '../src/shared/protocol.ts';

const repositoryRoot = join(import.meta.dirname, '..', '..', '..');
const markSvg = await readFile(join(repositoryRoot, 'assets', 'wok-mark.svg'), 'utf8');

test('Tier 1 page embeds the exact production calibration source before lab transport', () => {
	const page = buildCalibrationParityPage(markSvg);
	const productionSource = buildCalibrationTrialPage({ backend: 'default', framePolicy: 'uncapped', id: 'runtime-lab-tier1' }, 1, 1, markSvg);

	assert.equal(page.calibrationSourceHtml, productionSource);
	assert.equal(page.calibrationSourceSha256, sha256Hex(productionSource));
	assert.equal(page.workloadVersion, WORKLOAD_VERSION);
	assert.equal(page.pageId, RUNTIME_LAB_PAGE_ID);
});

test('Tier 1 generated page is deterministic and run-neutral', () => {
	const first = buildCalibrationParityPage(markSvg);
	const second = buildCalibrationParityPage(markSvg);
	assert.equal(first.html, second.html);
	assert.equal(first.sha256, second.sha256);
	assert.equal(first.sha256, sha256Hex(first.html));
	assert.doesNotMatch(first.html, /run-a|candidate-a|token-a/u);
});

test('Tier 1 page contains only WOK-owned local transport and no forbidden game or remote origins', () => {
	const page = buildCalibrationParityPage(markSvg);
	assert.match(page.html, /window\.wokRunBenchmark/u);
	assert.match(page.html, /\/v1\/results\//u);
	assert.match(page.html, /\/v1\/start\//u);
	assert.match(page.html, /createWorkload/u);
	assert.match(page.html, /createSyntheticInputProbe/u);
	assert.match(page.html, /dispatchChecksum/u);
	assert.doesNotMatch(page.html, /krunker/iu);
	assert.doesNotMatch(page.html, /wss?:\/\//iu);
	assert.doesNotMatch(page.html.replaceAll('http://www.w3.org/2000/svg', ''), /https?:\/\//iu);
});

type TestListener = (event: { type: string }) => void;

class TestEventTarget {
	private readonly listeners = new Map<string, Set<TestListener>>();

	addEventListener(type: string, listener: TestListener): void {
		const listeners = this.listeners.get(type) ?? new Set<TestListener>();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	dispatch(type: string): void {
		for (const listener of this.listeners.get(type) ?? []) listener({ type });
	}

	dispatchEvent(event: { type: string }): boolean {
		this.dispatch(event.type);
		return true;
	}

	removeEventListener(type: string, listener: TestListener): void {
		this.listeners.get(type)?.delete(listener);
	}
}

interface TestTimer {
	at: number;
	callback: () => void;
	id: number;
}

class TestClock {
	private nextTimerId = 1;
	private readonly timers = new Map<number, TestTimer>();
	nowMs = 0;

	advance(durationMs: number): void {
		const target = this.nowMs + durationMs;
		while (true) {
			const next = [...this.timers.values()]
				.filter(timer => timer.at <= target)
				.sort((left, right) => left.at - right.at || left.id - right.id)[0];
			if (!next) break;
			this.timers.delete(next.id);
			this.nowMs = next.at;
			next.callback();
		}
		this.nowMs = target;
	}

	clearTimeout = (timerId: number | undefined): void => {
		if (timerId !== undefined) this.timers.delete(timerId);
	};

	setTimeout = (callback: () => void, delayMs = 0): number => {
		const id = this.nextTimerId++;
		this.timers.set(id, {
			at: this.nowMs + Math.max(0, delayMs),
			callback,
			id
		});
		return id;
	};
}

function successfulBenchmark(): RuntimeLabBenchmarkResult {
	return {
		averageFps: 240,
		contaminationFlags: [],
		cpuSubmitP50Ms: 1,
		cpuSubmitP95Ms: 2,
		environment: {
			devicePixelRatio: 1,
			drawingBufferHeight: 720,
			drawingBufferWidth: 1280
		},
		eventLoopP95Ms: 1,
		eventLoopWorstMs: 2,
		gpuDisjointDiscardCount: 0,
		gpuImplausibleCount: 0,
		gpuSampleCount: 10,
		gpuTimingStatus: 'measured',
		longFrameRatio: 0,
		lowConfidenceReasons: [],
		onePercentLowFps: 200,
		p95FrameTimeMs: 5,
		rejected: false,
		rejectionReasons: [],
		sampleCount: 120,
		stallRatio: 0,
		stalledTicks: 0,
		success: true,
		totalTicks: 120,
		webglRenderer: 'test-renderer',
		worstFrameTimeMs: 6
	};
}

interface GeneratedPageHarnessOptions {
	focused: boolean;
	inputMode?: 'off' | 'synthetic';
	visible: boolean;
	wokRunBenchmark?: () => unknown | Promise<unknown>;
}

function extractAutoRunScript(html: string): string {
	const scriptStart = html.lastIndexOf('<script>');
	const scriptEnd = html.indexOf('</script>', scriptStart);
	assert.notEqual(scriptStart, -1);
	assert.notEqual(scriptEnd, -1);
	return html.slice(scriptStart + '<script>'.length, scriptEnd);
}

function createGeneratedPageHarness(options: GeneratedPageHarnessOptions) {
	const clock = new TestClock();
	const documentTarget = new TestEventTarget();
	const windowTarget = new TestEventTarget();
	const benchmarkTarget = new TestEventTarget();
	const results: Record<string, unknown>[] = [];
	let benchmarkCalls = 0;
	let focused = options.focused;
	let focusReader = () => focused;
	let visibilityState = options.visible ? 'visible' : 'hidden';

	const document = Object.assign(documentTarget, {
		documentElement: { dataset: {} as Record<string, string> },
		getElementById: (id: string) => id === 'benchmark' ? benchmarkTarget : null,
		hasFocus: () => focusReader(),
		readyState: 'complete',
		title: '',
		get visibilityState() {
			return visibilityState;
		}
	});
	const window = Object.assign(windowTarget, {
		devicePixelRatio: 1,
		innerHeight: 720,
		innerWidth: 1280,
		wokRunBenchmark: async () => {
			benchmarkCalls++;
			return await (options.wokRunBenchmark?.() ?? successfulBenchmark());
		}
	});
	const fetch = async (url: string, init?: { body?: unknown }) => {
		if (url.startsWith('/v1/results/')) {
			results.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		}
		return { ok: true, status: 200 };
	};
	const page = buildCalibrationParityPage(markSvg);
	const search = new URLSearchParams({
		benchmarkMs: '1000',
		candidate: 'candidate-a',
		input: options.inputMode ?? 'off',
		minSamples: '10',
		page: 'a'.repeat(64),
		run: 'run-a',
		start: 'controller',
		token: 'token-a'
	});

	runInNewContext(extractAutoRunScript(page.html), {
		Array,
		Error,
		JSON,
		Math,
		Number,
		Promise,
		String,
		URLSearchParams,
		clearTimeout: clock.clearTimeout,
		document,
		encodeURIComponent,
		fetch,
		location: { search: `?${search.toString()}` },
		navigator: {
			hardwareConcurrency: 8,
			language: 'en-NZ',
			platform: 'Win32',
			userAgent: 'runtime-lab-test'
		},
		performance: {
			now: () => clock.nowMs,
			timeOrigin: 1_000_000
		},
		setTimeout: clock.setTimeout,
		window
	});

	return {
		clock,
		document,
		get benchmarkCalls() {
			return benchmarkCalls;
		},
		results,
		setFocus(value: boolean, dispatch = true) {
			focused = value;
			if (dispatch) windowTarget.dispatch(value ? 'focus' : 'blur');
		},
		setFocusReader(reader: () => boolean) {
			focusReader = reader;
		},
		setVisibility(value: 'hidden' | 'visible') {
			visibilityState = value;
			documentTarget.dispatch('visibilitychange');
		},
		window: windowTarget
	};
}

async function settleAsyncWork(): Promise<void> {
	for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}

async function advanceHarness(
	harness: ReturnType<typeof createGeneratedPageHarness>,
	durationMs: number
): Promise<void> {
	harness.clock.advance(durationMs);
	await settleAsyncWork();
}

for (const state of [
	{ focused: false, label: 'unfocused', visible: true },
	{ focused: true, label: 'hidden', visible: false }
]) {
	test(`Tier 1 page does not start while ${state.label}`, async () => {
		const harness = createGeneratedPageHarness(state);
		await settleAsyncWork();
		await advanceHarness(harness, RUNTIME_LAB_FOREGROUND_SETTLE_MS * 2);
		assert.equal(harness.benchmarkCalls, 0);
		assert.equal(harness.results.length, 0);
	});
}

test('Tier 1 page requires a continuous foreground settle interval', async () => {
	const harness = createGeneratedPageHarness({ focused: false, visible: true });
	await settleAsyncWork();
	await advanceHarness(harness, RUNTIME_LAB_FOREGROUND_SETTLE_MS);
	assert.equal(harness.benchmarkCalls, 0);

	harness.setFocus(true);
	await advanceHarness(harness, RUNTIME_LAB_FOREGROUND_SETTLE_MS - 1);
	assert.equal(harness.benchmarkCalls, 0);
	await advanceHarness(harness, 1);
	assert.equal(harness.benchmarkCalls, 1);
	assert.equal(harness.results.length, 1);

	const timings = harness.results[0]?.timings as Record<string, number>;
	assert.equal(timings.controllerReleasedMs, 0);
	assert.equal(timings.foregroundStableMs, RUNTIME_LAB_FOREGROUND_SETTLE_MS * 2);
	assert.equal(timings.benchmarkInvokedMs, timings.foregroundStableMs);
	assert.ok(timings.benchmarkCompletedMs >= timings.benchmarkInvokedMs);
});

test('Tier 1 page resets foreground settling on blur and visibility changes', async () => {
	for (const disturbance of ['blur', 'visibility'] as const) {
		const harness = createGeneratedPageHarness({ focused: true, visible: true });
		await settleAsyncWork();
		await advanceHarness(harness, RUNTIME_LAB_FOREGROUND_SETTLE_MS - 100);

		if (disturbance === 'blur') {
			harness.setFocus(false);
			harness.setFocus(true);
		} else {
			harness.setVisibility('hidden');
			harness.setVisibility('visible');
		}

		await advanceHarness(harness, RUNTIME_LAB_FOREGROUND_SETTLE_MS - 1);
		assert.equal(harness.benchmarkCalls, 0, disturbance);
		await advanceHarness(harness, 1);
		assert.equal(harness.benchmarkCalls, 1, disturbance);
	}
});

test('Tier 1 page rechecks foreground state at the settle boundary', async () => {
	const harness = createGeneratedPageHarness({ focused: true, visible: true });
	await settleAsyncWork();
	let boundaryReads = 0;
	harness.setFocusReader(() => {
		if (harness.clock.nowMs !== RUNTIME_LAB_FOREGROUND_SETTLE_MS) return true;
		boundaryReads++;
		return boundaryReads === 1;
	});

	await advanceHarness(harness, RUNTIME_LAB_FOREGROUND_SETTLE_MS);
	assert.equal(harness.benchmarkCalls, 0);
	assert.equal(boundaryReads, 2);

	harness.setFocus(false, false);
	harness.setFocusReader(() => false);
	await advanceHarness(harness, 100);
	assert.equal(harness.benchmarkCalls, 0);

	harness.setFocusReader(() => true);
	harness.setFocus(true);
	await advanceHarness(harness, RUNTIME_LAB_FOREGROUND_SETTLE_MS);
	assert.equal(harness.benchmarkCalls, 1);
});

test('Tier 1 page still reports a blur observed after benchmark invocation', async () => {
	let resolveBenchmark: ((value: unknown) => void) | undefined;
	const benchmark = new Promise<unknown>(resolve => {
		resolveBenchmark = resolve;
	});
	const harness = createGeneratedPageHarness({
		focused: true,
		visible: true,
		wokRunBenchmark: () => benchmark
	});
	await settleAsyncWork();
	await advanceHarness(harness, RUNTIME_LAB_FOREGROUND_SETTLE_MS);
	assert.equal(harness.benchmarkCalls, 1);
	assert.equal(harness.results.length, 0);

	harness.setFocus(false);
	resolveBenchmark?.({
		...successfulBenchmark(),
		contaminationFlags: ['window-blurred'],
		lowConfidenceReasons: ['window-blurred'],
		rejected: true,
		rejectionReasons: ['window-blurred'],
		success: false
	});
	await settleAsyncWork();

	assert.equal(harness.results.length, 1);
	const envelope = harness.results[0];
	assert.ok(envelope);
	const result = envelope.benchmark as Record<string, unknown>;
	const foregroundEvents =
		envelope.foregroundEvents as Record<string, unknown>[];
	assert.equal(result.success, false);
	assert.deepEqual(result.rejectionReasons, ['window-blurred']);
	assert.deepEqual(
		foregroundEvents.map(event => event.type),
		['initial-state', 'window-blur']
	);
	assert.deepEqual(
		foregroundEvents[1],
		{
			hasFocus: false,
			performanceNowMs: RUNTIME_LAB_FOREGROUND_SETTLE_MS,
			type: 'window-blur',
			visibilityState: 'visible'
		}
	);
});

test('Tier 1 page reports a bounded foreground timeout without starting input or benchmark work', async () => {
	const harness = createGeneratedPageHarness({
		focused: false,
		inputMode: 'synthetic',
		visible: true
	});
	await settleAsyncWork();
	await advanceHarness(harness, RUNTIME_LAB_FOREGROUND_TIMEOUT_MS);

	assert.equal(harness.benchmarkCalls, 0);
	assert.equal(harness.results.length, 1);
	const envelope = harness.results[0];
	const benchmark = envelope?.benchmark as Record<string, unknown>;
	const input = envelope?.input as Record<string, unknown>;
	const timings = envelope?.timings as Record<string, number>;
	assert.equal(benchmark.success, false);
	assert.deepEqual(benchmark.rejectionReasons, ['foreground-not-stable-before-start']);
	assert.equal(input.mode, 'synthetic');
	assert.equal(input.dispatchedEvents, 0);
	assert.equal(input.receivedEvents, 0);
	assert.equal(timings.controllerReleasedMs, 0);
	assert.equal(timings.foregroundStableMs, undefined);
	assert.equal(timings.benchmarkInvokedMs, RUNTIME_LAB_FOREGROUND_TIMEOUT_MS);
});
