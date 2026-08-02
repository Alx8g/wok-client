import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRuntimeLabFailures, isRuntimeLabFailureKind } from '../src/host/failure-classification.ts';

test('failure classification emits every independent terminal failure category', () => {
	const failures = classifyRuntimeLabFailures({
		capture: {
			analysisReasons: ['no-frame-time-samples'],
			analysisValid: false,
			completed: true,
			exitCode: 0,
			rawCsvExists: true,
			rawCsvPath: 'raw.csv',
			started: true
		},
		contextLoss: { message: 'WebGL context lost.', source: 'page-result' },
		integrityViolations: ['unexpected-host', 'unexpected-host', 'unknown-route'],
		orphanProcessIds: [202, 201, 202],
		processExit: { exitCode: -1, expected: false, signal: 'SIGABRT' }
	});

	assert.deepEqual(failures.map(failure => failure.kind), ['crash', 'context-loss', 'capture-failure', 'orphan-process', 'integrity-violation']);
	assert.deepEqual(failures.find(failure => failure.kind === 'orphan-process')?.details.processIds, [201, 202]);
	assert.deepEqual(failures.find(failure => failure.kind === 'integrity-violation')?.details.violations, ['unexpected-host', 'unknown-route']);
	assert.match(failures.find(failure => failure.kind === 'capture-failure')?.message ?? '', /analysis:no-frame-time-samples/u);
});

test('timeout classification does not double-count timeout termination as a crash', () => {
	const failures = classifyRuntimeLabFailures({
		processExit: { exitCode: 1, expected: false, signal: 'SIGKILL' },
		timeout: { elapsedMs: 60_100, limitMs: 60_000 }
	});
	assert.deepEqual(failures.map(failure => failure.kind), ['timeout']);
	assert.equal(failures[0].details.limitMs, 60_000);
});

test('successful completion has no classified failures', () => {
	assert.deepEqual(
		classifyRuntimeLabFailures({
			capture: { analysisValid: true, completed: true, exitCode: 0, rawCsvExists: true, started: true },
			processExit: { exitCode: 0, expected: true }
		}),
		[]
	);
});

test('rejected benchmark results retain their reasons and event-loop evidence', () => {
	const [failure] = classifyRuntimeLabFailures({
		benchmark: {
			eventLoopP95Ms: 4.18,
			eventLoopWorstMs: 104.53,
			lowConfidenceReasons: ['severe-event-loop-disturbance'],
			pageValid: false,
			rejected: true,
			rejectionReasons: ['severe-event-loop-disturbance'],
			success: true
		}
	});
	assert.equal(failure.kind, 'benchmark-failure');
	assert.deepEqual(failure.details.reasons, ['severe-event-loop-disturbance']);
	assert.equal(failure.details.eventLoopP95Ms, 4.18);
	assert.equal(failure.details.eventLoopWorstMs, 104.53);
});

test('reasonless and unsuccessful benchmarks receive deterministic fallback reasons', () => {
	const [failure] = classifyRuntimeLabFailures({
		benchmark: {
			lowConfidenceReasons: ['page-error:synthetic failure'],
			pageValid: false,
			rejected: true,
			rejectionReasons: [],
			success: false
		}
	});
	assert.equal(failure.kind, 'benchmark-failure');
	assert.deepEqual(failure.details.reasons, [
		'benchmark-unsuccessful',
		'benchmark-rejected-without-rejection-reason'
	]);
	assert.deepEqual(failure.details.lowConfidenceReasons, [
		'page-error:synthetic failure'
	]);
});

test('an unexplained invalid page result is still classified', () => {
	const [failure] = classifyRuntimeLabFailures({
		benchmark: {
			pageValid: false,
			rejected: false,
			success: true
		}
	});
	assert.equal(failure.kind, 'benchmark-failure');
	assert.deepEqual(failure.details.reasons, [
		'page-run-invalid-without-reason'
	]);
});

test('context loss remains specialized while other rejection reasons stay visible', () => {
	const contextOnly = classifyRuntimeLabFailures({
		benchmark: {
			pageValid: false,
			rejected: true,
			rejectionReasons: ['webgl-context-lost'],
			success: true
		},
		contextLoss: { source: 'page-result' }
	});
	assert.deepEqual(contextOnly.map(failure => failure.kind), ['context-loss']);

	const mixed = classifyRuntimeLabFailures({
		benchmark: {
			pageValid: false,
			rejected: true,
			rejectionReasons: [
				'webgl-context-lost',
				'severe-event-loop-disturbance'
			],
			success: true
		},
		contextLoss: { source: 'page-result' }
	});
	assert.deepEqual(mixed.map(failure => failure.kind), [
		'context-loss',
		'benchmark-failure'
	]);
	assert.deepEqual(mixed[1].details.reasons, [
		'severe-event-loop-disturbance'
	]);
});

test('capture launch, completion, exit, raw-file and analysis failures are retained as reasons', () => {
	const [failure] = classifyRuntimeLabFailures({
		capture: {
			analysisReasons: ['insufficient-frame-time-samples'],
			analysisValid: false,
			completed: false,
			exitCode: 5,
			launchError: 'access denied',
			rawCsvExists: false,
			started: false
		}
	});
	assert.equal(failure.kind, 'capture-failure');
	assert.deepEqual(failure.details.reasons, [
		'capture-not-started',
		'launch-error:access denied',
		'capture-exit-code:5',
		'raw-csv-missing',
		'analysis:insufficient-frame-time-samples'
	]);
});

test('invalid capture analysis remains a failure when the analyzer supplied no reasons', () => {
	const [failure] = classifyRuntimeLabFailures({
		capture: { analysisValid: false, completed: true, exitCode: 0, rawCsvExists: true, started: true }
	});
	assert.equal(failure.kind, 'capture-failure');
	assert.deepEqual(failure.details.reasons, ['analysis-invalid']);
});

test('failure kind guard accepts only protocol failure kinds', () => {
	assert.equal(isRuntimeLabFailureKind('context-loss'), true);
	assert.equal(isRuntimeLabFailureKind('benchmark-failure'), true);
	assert.equal(isRuntimeLabFailureKind('raf-slow'), false);
});
