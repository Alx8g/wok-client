export type RuntimeLabFailureKind = 'timeout' | 'crash' | 'context-loss' | 'benchmark-failure' | 'capture-failure' | 'orphan-process' | 'integrity-violation';

export interface RuntimeLabFailure {
	details: Record<string, unknown>;
	kind: RuntimeLabFailureKind;
	message: string;
}

export interface RuntimeLabTimeoutEvidence {
	elapsedMs: number;
	limitMs: number;
}

export interface RuntimeLabProcessExitEvidence {
	exitCode: number | null;
	expected: boolean;
	signal?: string | null;
}

export interface RuntimeLabContextLossEvidence {
	message?: string;
	source?: string;
}

export interface RuntimeLabCaptureEvidence {
	analysisReasons?: readonly string[];
	analysisValid?: boolean;
	completed: boolean;
	exitCode?: number | null;
	launchError?: string;
	rawCsvExists?: boolean;
	rawCsvPath?: string;
	started: boolean;
}

export interface RuntimeLabBenchmarkEvidence {
	eventLoopP95Ms?: number;
	eventLoopWorstMs?: number;
	lowConfidenceReasons?: readonly string[];
	pageValid: boolean;
	rejected: boolean;
	rejectionReasons?: readonly string[];
	success: boolean;
}

export interface RuntimeLabFailureEvidence {
	benchmark?: RuntimeLabBenchmarkEvidence;
	capture?: RuntimeLabCaptureEvidence;
	contextLoss?: RuntimeLabContextLossEvidence;
	integrityViolations?: readonly string[];
	orphanProcessIds?: readonly number[];
	processExit?: RuntimeLabProcessExitEvidence;
	timeout?: RuntimeLabTimeoutEvidence;
}

const FAILURE_KINDS = new Set<RuntimeLabFailureKind>(['timeout', 'crash', 'context-loss', 'benchmark-failure', 'capture-failure', 'orphan-process', 'integrity-violation']);

function finiteNonNegative(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function cleanReasons(reasons: readonly string[] | undefined): string[] {
	if (!reasons) return [];
	return [...new Set(reasons.map(reason => reason.trim()).filter(reason => reason.length > 0))];
}

function cleanProcessIds(processIds: readonly number[] | undefined): number[] {
	if (!processIds) return [];
	return [...new Set(processIds.filter(processId => Number.isInteger(processId) && processId > 0 && processId <= 0xffff_ffff))].sort((left, right) => left - right);
}

function classifyCaptureFailure(capture: RuntimeLabCaptureEvidence): RuntimeLabFailure | undefined {
	const reasons: string[] = [];
	if (!capture.started) reasons.push('capture-not-started');
	if (capture.launchError?.trim()) reasons.push(`launch-error:${capture.launchError.trim()}`);
	if (capture.started && !capture.completed) reasons.push('capture-not-completed');
	if (capture.exitCode !== undefined && capture.exitCode !== null && capture.exitCode !== 0) reasons.push(`capture-exit-code:${capture.exitCode}`);
	if (capture.rawCsvExists === false) reasons.push('raw-csv-missing');
	if (capture.analysisValid === false) {
		const analysisReasons = cleanReasons(capture.analysisReasons);
		reasons.push(...(analysisReasons.length === 0 ? ['analysis-invalid'] : analysisReasons.map(reason => `analysis:${reason}`)));
	}
	if (reasons.length === 0) return undefined;
	return {
		details: {
			...(capture.exitCode === undefined ? {} : { exitCode: capture.exitCode }),
			...(capture.rawCsvPath ? { rawCsvPath: capture.rawCsvPath } : {}),
			reasons
		},
		kind: 'capture-failure',
		message: `PresentMon capture failed: ${reasons.join(', ')}.`
	};
}

function classifyBenchmarkFailure(benchmark: RuntimeLabBenchmarkEvidence): RuntimeLabFailure | undefined {
	if (benchmark.eventLoopP95Ms !== undefined && !finiteNonNegative(benchmark.eventLoopP95Ms)) {
		throw new TypeError('Benchmark eventLoopP95Ms must be finite and non-negative.');
	}
	if (benchmark.eventLoopWorstMs !== undefined && !finiteNonNegative(benchmark.eventLoopWorstMs)) {
		throw new TypeError('Benchmark eventLoopWorstMs must be finite and non-negative.');
	}

	const rejectionReasons = cleanReasons(benchmark.rejectionReasons);
	const reasons = rejectionReasons.filter(reason => reason !== 'webgl-context-lost');
	if (!benchmark.success) reasons.push('benchmark-unsuccessful');
	if (benchmark.rejected && rejectionReasons.length === 0) {
		reasons.push('benchmark-rejected-without-rejection-reason');
	}
	if (!benchmark.pageValid && benchmark.success && !benchmark.rejected && rejectionReasons.length === 0) {
		reasons.push('page-run-invalid-without-reason');
	}
	const uniqueReasons = cleanReasons(reasons);
	if (uniqueReasons.length === 0) return undefined;

	const lowConfidenceReasons = cleanReasons(benchmark.lowConfidenceReasons);
	return {
		details: {
			...(benchmark.eventLoopP95Ms === undefined ? {} : { eventLoopP95Ms: benchmark.eventLoopP95Ms }),
			...(benchmark.eventLoopWorstMs === undefined ? {} : { eventLoopWorstMs: benchmark.eventLoopWorstMs }),
			...(lowConfidenceReasons.length === 0 ? {} : { lowConfidenceReasons }),
			pageValid: benchmark.pageValid,
			reasons: uniqueReasons,
			rejected: benchmark.rejected,
			success: benchmark.success
		},
		kind: 'benchmark-failure',
		message: benchmark.rejected
			? `The benchmark rejected the page result: ${uniqueReasons.join(', ')}.`
			: `The benchmark page result was invalid: ${uniqueReasons.join(', ')}.`
	};
}

export function isRuntimeLabFailureKind(value: unknown): value is RuntimeLabFailureKind {
	return typeof value === 'string' && FAILURE_KINDS.has(value as RuntimeLabFailureKind);
}

export function classifyRuntimeLabFailures(evidence: RuntimeLabFailureEvidence): RuntimeLabFailure[] {
	const failures: RuntimeLabFailure[] = [];
	if (evidence.timeout) {
		if (!finiteNonNegative(evidence.timeout.elapsedMs) || !finiteNonNegative(evidence.timeout.limitMs)) throw new TypeError('Timeout durations must be finite non-negative numbers.');
		failures.push({
			details: { elapsedMs: evidence.timeout.elapsedMs, limitMs: evidence.timeout.limitMs },
			kind: 'timeout',
			message: `Runtime lab exceeded its ${evidence.timeout.limitMs} ms deadline after ${evidence.timeout.elapsedMs} ms.`
		});
	}

	if (evidence.processExit && !evidence.processExit.expected && !evidence.timeout) {
		const { exitCode, signal } = evidence.processExit;
		if (exitCode !== null && !Number.isInteger(exitCode)) throw new TypeError('Process exitCode must be an integer or null.');
		failures.push({
			details: { exitCode, ...(signal ? { signal } : {}) },
			kind: 'crash',
			message: signal ? `Runtime process exited unexpectedly from signal ${signal}.` : `Runtime process exited unexpectedly with code ${exitCode ?? 'unknown'}.`
		});
	}

	if (evidence.contextLoss) {
		const source = evidence.contextLoss.source?.trim();
		const message = evidence.contextLoss.message?.trim();
		failures.push({
			details: { ...(source ? { source } : {}), ...(message ? { reportedMessage: message } : {}) },
			kind: 'context-loss',
			message: message || 'The benchmark reported graphics context loss.'
		});
	}

	if (evidence.benchmark) {
		const failure = classifyBenchmarkFailure(evidence.benchmark);
		if (failure) failures.push(failure);
	}

	if (evidence.capture) {
		const failure = classifyCaptureFailure(evidence.capture);
		if (failure) failures.push(failure);
	}

	const orphanProcessIds = cleanProcessIds(evidence.orphanProcessIds);
	if (orphanProcessIds.length > 0) {
		failures.push({
			details: { processIds: orphanProcessIds },
			kind: 'orphan-process',
			message: `Runtime lab left orphan processes running: ${orphanProcessIds.join(', ')}.`
		});
	}

	const integrityViolations = cleanReasons(evidence.integrityViolations);
	if (integrityViolations.length > 0) {
		failures.push({
			details: { violations: integrityViolations },
			kind: 'integrity-violation',
			message: `Runtime lab integrity checks failed: ${integrityViolations.join(', ')}.`
		});
	}

	return failures;
}
