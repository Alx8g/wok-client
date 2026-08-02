import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRuntimeLabResult } from '../src/shared/protocol.ts';
import { createTestResult } from './test-result.ts';

const expected = {
	candidateId: 'candidate-a',
	inputMode: 'off' as const,
	pageSha256: 'a'.repeat(64),
	runId: 'run-a',
	workloadVersion: 1
};

test('valid runtime-lab result is normalized and accepted', () => {
	const result = validateRuntimeLabResult(createTestResult(), expected);
	assert.equal(result.runId, expected.runId);
	assert.equal(result.benchmark.averageFps, 240);
	assert.equal(result.identity.userAgentBrands?.[0].brand, 'Test');
	assert.equal(result.input.dispatchedEvents, 0);
	assert.deepEqual(result.foregroundEvents, [{
		hasFocus: true,
		performanceNowMs: 10,
		type: 'initial-state',
		visibilityState: 'visible'
	}]);
});

test('runtime-lab result identity and page hashes must match the active run', () => {
	assert.throws(
		() => validateRuntimeLabResult(createTestResult({ runId: 'other-run' }), expected),
		/does not match this run/u
	);
	assert.throws(
		() => validateRuntimeLabResult(createTestResult({ pageSha256: 'b'.repeat(64) }), expected),
		/does not match the served page/u
	);
});

test('runtime-lab result rejects synthetic input loss or corruption', () => {
	const syntheticInput = {
		dispatchChecksum: 123,
		dispatchIntervalMs: 16,
		dispatchedEvents: 100,
		mode: 'synthetic' as const,
		p95DispatchLatenessMs: 1.2,
		receivedChecksum: 123,
		receivedEvents: 100,
		worstDispatchLatenessMs: 4.5
	};
	const syntheticExpected = { ...expected, inputMode: 'synthetic' as const };
	const lostInput = createTestResult({ input: { ...syntheticInput, receivedEvents: 99 } });
	assert.throws(() => validateRuntimeLabResult(lostInput, syntheticExpected), /event count mismatch/u);

	const corruptedInput = createTestResult({ input: { ...syntheticInput, receivedChecksum: 124 } });
	assert.throws(() => validateRuntimeLabResult(corruptedInput, syntheticExpected), /checksum mismatch/u);
});

test('runtime-lab result rejects malformed metrics and impossible timing order', () => {
	const malformedMetrics = createTestResult();
	(malformedMetrics.benchmark as { averageFps: number }).averageFps = Number.NaN;
	assert.throws(() => validateRuntimeLabResult(malformedMetrics, expected), /averageFps/u);

	const malformedTimings = createTestResult({
		timings: {
			benchmarkCompletedMs: 200,
			benchmarkInvokedMs: 100,
			domReadyMs: 50,
			pageScriptStartMs: 80,
			timeOriginEpochMs: 1
		}
	});
	assert.throws(() => validateRuntimeLabResult(malformedTimings, expected), /domReadyMs precedes/u);
});

test('runtime-lab result preserves ordered foreground transitions', () => {
	const result = validateRuntimeLabResult(createTestResult({
		foregroundEvents: [
			{
				hasFocus: true,
				performanceNowMs: 10,
				type: 'initial-state',
				visibilityState: 'visible'
			},
			{
				hasFocus: false,
				performanceNowMs: 2_000,
				type: 'window-blur',
				visibilityState: 'visible'
			}
		]
	}), expected);
	assert.equal(result.foregroundEvents[1]?.type, 'window-blur');
	assert.equal(result.foregroundEvents[1]?.hasFocus, false);

	assert.throws(
		() => validateRuntimeLabResult(createTestResult({
			foregroundEvents: [
				{
					hasFocus: true,
					performanceNowMs: 10,
					type: 'initial-state',
					visibilityState: 'visible'
				},
				{
					hasFocus: false,
					performanceNowMs: 9,
					type: 'window-blur',
					visibilityState: 'visible'
				}
			]
		}), expected),
		/not ordered/u
	);
});

test('runtime-lab result accepts ordered controller and foreground timing evidence', () => {
	const result = validateRuntimeLabResult(createTestResult({
		timings: {
			benchmarkCompletedMs: 31_600,
			benchmarkInvokedMs: 1_600,
			controllerReleasedMs: 1_000,
			domReadyMs: 100,
			foregroundStableMs: 1_600,
			pageScriptStartMs: 10,
			timeOriginEpochMs: 1_700_000_000_000
		}
	}), expected);
	assert.equal(result.timings.controllerReleasedMs, 1_000);
	assert.equal(result.timings.foregroundStableMs, 1_600);
});

test('runtime-lab result rejects impossible foreground lifecycle timing order', () => {
	const baseTimings = {
		benchmarkCompletedMs: 31_600,
		benchmarkInvokedMs: 1_600,
		controllerReleasedMs: 1_000,
		domReadyMs: 100,
		foregroundStableMs: 1_500,
		pageScriptStartMs: 10,
		timeOriginEpochMs: 1_700_000_000_000
	};
	assert.throws(
		() => validateRuntimeLabResult(createTestResult({
			timings: { ...baseTimings, controllerReleasedMs: 99 }
		}), expected),
		/controllerReleasedMs precedes/u
	);
	assert.throws(
		() => validateRuntimeLabResult(createTestResult({
			timings: { ...baseTimings, foregroundStableMs: 999 }
		}), expected),
		/foregroundStableMs precedes/u
	);
	assert.throws(
		() => validateRuntimeLabResult(createTestResult({
			timings: { ...baseTimings, benchmarkInvokedMs: 1_499 }
		}), expected),
		/benchmarkInvokedMs precedes/u
	);
});

test('runtime-lab result accepts empty synthetic evidence only for unsuccessful pre-benchmark runs', () => {
	const base = createTestResult();
	const emptySyntheticInput = {
		dispatchChecksum: 0,
		dispatchIntervalMs: 0,
		dispatchedEvents: 0,
		mode: 'synthetic' as const,
		p95DispatchLatenessMs: 0,
		receivedChecksum: 0,
		receivedEvents: 0,
		worstDispatchLatenessMs: 0
	};
	const syntheticExpected = { ...expected, inputMode: 'synthetic' as const };
	const failed = createTestResult({
		benchmark: {
			...base.benchmark,
			lowConfidenceReasons: ['foreground-not-stable-before-start'],
			rejected: true,
			rejectionReasons: ['foreground-not-stable-before-start'],
			success: false
		},
		input: emptySyntheticInput
	});
	const parsed = validateRuntimeLabResult(failed, syntheticExpected);
	assert.equal(parsed.input.mode, 'synthetic');
	assert.equal(parsed.input.dispatchedEvents, 0);

	const successful = createTestResult({ input: emptySyntheticInput });
	assert.throws(
		() => validateRuntimeLabResult(successful, syntheticExpected),
		/did not dispatch any events/u
	);
});
