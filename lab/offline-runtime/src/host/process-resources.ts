export interface ProcessResourceReading {
	cpuPercent: number;
	executableName: string;
	parentProcessId?: number;
	performanceCountersPresent?: boolean;
	privateBytes: number;
	processId: number;
	workingSetBytes: number;
}

export interface ProcessTreeResourceSample {
	capturedAtMs: number;
	processes: readonly ProcessResourceReading[];
	rootProcessId: number;
}

export interface AggregatedProcessTreeResourceSample {
	capturedAtMs: number;
	processCount: number;
	rootPresent: boolean;
	rootProcessId: number;
	totalCpuPercent: number;
	totalPrivateBytes: number;
	totalWorkingSetBytes: number;
}

export interface ProcessTreeResourceCoverage {
	expectedMinimumSamples: number;
	firstCapturedAtMs?: number;
	lastCapturedAtMs?: number;
	maximumGapMs?: number;
	reasons: string[];
	sampleCount: number;
	valid: boolean;
}

export interface ProcessTreeResourceSummary {
	averageCpuPercent?: number;
	averagePrivateBytes?: number;
	averageProcessCount?: number;
	averageWorkingSetBytes?: number;
	firstCapturedAtMs?: number;
	lastCapturedAtMs?: number;
	maximumProcessCount?: number;
	minimumProcessCount?: number;
	peakCpuPercent?: number;
	peakPrivateBytes?: number;
	peakWorkingSetBytes?: number;
	sampleCount: number;
}

function assertProcessId(value: number, label: string): void {
	if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) throw new TypeError(`${label} must be a positive 32-bit process ID.`);
}

function assertParentProcessId(value: number, label: string): void {
	if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new TypeError(`${label} must be a non-negative 32-bit process ID.`);
}

function assertNonNegativeFinite(value: number, label: string): void {
	if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a finite number greater than or equal to zero.`);
}

function assertByteCount(value: number, label: string): void {
	assertNonNegativeFinite(value, label);
	if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer byte count.`);
}

function average(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function aggregateProcessTreeResourceSample(sample: ProcessTreeResourceSample): AggregatedProcessTreeResourceSample {
	assertNonNegativeFinite(sample.capturedAtMs, 'capturedAtMs');
	assertProcessId(sample.rootProcessId, 'rootProcessId');
	if (!Array.isArray(sample.processes)) throw new TypeError('processes must be an array.');

	const seenProcessIds = new Set<number>();
	let totalCpuPercent = 0;
	let totalPrivateBytes = 0;
	let totalWorkingSetBytes = 0;
	for (let index = 0; index < sample.processes.length; index += 1) {
		const process = sample.processes[index];
		assertProcessId(process.processId, `processes[${index}].processId`);
		if (process.parentProcessId !== undefined) assertParentProcessId(process.parentProcessId, `processes[${index}].parentProcessId`);
		if (process.performanceCountersPresent !== undefined && typeof process.performanceCountersPresent !== 'boolean') {
			throw new TypeError(`processes[${index}].performanceCountersPresent must be boolean when provided.`);
		}
		if (seenProcessIds.has(process.processId)) throw new TypeError(`processes contains duplicate process ID ${process.processId}.`);
		seenProcessIds.add(process.processId);
		if (typeof process.executableName !== 'string' || process.executableName.length === 0 || process.executableName.length > 1_024) {
			throw new TypeError(`processes[${index}].executableName must be a non-empty bounded string.`);
		}
		assertNonNegativeFinite(process.cpuPercent, `processes[${index}].cpuPercent`);
		assertByteCount(process.privateBytes, `processes[${index}].privateBytes`);
		assertByteCount(process.workingSetBytes, `processes[${index}].workingSetBytes`);
		totalCpuPercent += process.cpuPercent;
		totalPrivateBytes += process.privateBytes;
		totalWorkingSetBytes += process.workingSetBytes;
	}

	if (!Number.isSafeInteger(totalPrivateBytes) || !Number.isSafeInteger(totalWorkingSetBytes)) throw new RangeError('Aggregated memory byte counts exceed the safe integer range.');
	return {
		capturedAtMs: sample.capturedAtMs,
		processCount: sample.processes.length,
		rootPresent: seenProcessIds.has(sample.rootProcessId),
		rootProcessId: sample.rootProcessId,
		totalCpuPercent,
		totalPrivateBytes,
		totalWorkingSetBytes
	};
}

export function assessProcessTreeResourceCoverage(
	samples: readonly ProcessTreeResourceSample[],
	options: {
		endTimestampMs: number;
		intervalMs: number;
		minimumCoverageRatio?: number;
		startTimestampMs: number;
	}
): ProcessTreeResourceCoverage {
	if (!Array.isArray(samples)) throw new TypeError('samples must be an array.');
	const { endTimestampMs, intervalMs, startTimestampMs } = options;
	const minimumCoverageRatio = options.minimumCoverageRatio ?? 0.7;
	if (!Number.isFinite(startTimestampMs) || !Number.isFinite(endTimestampMs) || endTimestampMs <= startTimestampMs) {
		throw new TypeError('Resource coverage timestamps must define a finite positive interval.');
	}
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError('intervalMs must be positive.');
	if (!Number.isFinite(minimumCoverageRatio) || minimumCoverageRatio <= 0 || minimumCoverageRatio > 1) {
		throw new TypeError('minimumCoverageRatio must be greater than zero and no greater than one.');
	}
	const allAggregates = samples
		.map(aggregateProcessTreeResourceSample)
		.sort((left, right) => left.capturedAtMs - right.capturedAtMs);
	const aggregates = allAggregates.filter(
		sample => sample.capturedAtMs >= startTimestampMs && sample.capturedAtMs <= endTimestampMs
	);
	const coveredSamples: readonly ProcessTreeResourceSample[] = samples.filter(
		(sample: ProcessTreeResourceSample) => sample.capturedAtMs >= startTimestampMs && sample.capturedAtMs <= endTimestampMs
	);
	const durationMs = endTimestampMs - startTimestampMs;
	const expectedMinimumSamples = Math.max(2, Math.ceil((durationMs / intervalMs) * minimumCoverageRatio));
	const reasons: string[] = [];
	if (aggregates.length < expectedMinimumSamples) {
		reasons.push(`insufficient-resource-samples:${aggregates.length}/${expectedMinimumSamples}`);
	}
	if (aggregates.some(sample => !sample.rootPresent)) reasons.push('resource-root-process-missing');
	if (aggregates.some(sample => sample.processCount === 0)) reasons.push('resource-process-tree-empty');
	if (coveredSamples.some(sample => sample.processes.some(process => process.performanceCountersPresent === false))) {
		reasons.push('resource-performance-counters-missing');
	}
	const firstCapturedAtMs = aggregates[0]?.capturedAtMs;
	const lastCapturedAtMs = aggregates.at(-1)?.capturedAtMs;
	const predecessor = allAggregates.findLast(sample => sample.capturedAtMs < startTimestampMs);
	const successor = allAggregates.find(sample => sample.capturedAtMs > endTimestampMs);
	const nearestStart = [predecessor, aggregates[0]]
		.filter(sample => sample !== undefined)
		.sort((left, right) => Math.abs(left.capturedAtMs - startTimestampMs) - Math.abs(right.capturedAtMs - startTimestampMs))[0];
	const nearestEnd = [aggregates.at(-1), successor]
		.filter(sample => sample !== undefined)
		.sort((left, right) => Math.abs(left.capturedAtMs - endTimestampMs) - Math.abs(right.capturedAtMs - endTimestampMs))[0];
	const boundaryToleranceMs = intervalMs * 2;
	if (nearestStart === undefined || Math.abs(nearestStart.capturedAtMs - startTimestampMs) > boundaryToleranceMs) {
		reasons.push('resource-coverage-start-missing');
	}
	if (nearestEnd === undefined || Math.abs(nearestEnd.capturedAtMs - endTimestampMs) > boundaryToleranceMs) {
		reasons.push('resource-coverage-end-missing');
	}
	const cadenceAggregates = [predecessor, ...aggregates, successor]
		.filter(sample => sample !== undefined);
	let maximumGapMs: number | undefined;
	for (let index = 1; index < cadenceAggregates.length; index += 1) {
		const gap = cadenceAggregates[index].capturedAtMs - cadenceAggregates[index - 1].capturedAtMs;
		maximumGapMs = maximumGapMs === undefined ? gap : Math.max(maximumGapMs, gap);
	}
	if (maximumGapMs !== undefined && maximumGapMs > intervalMs * 4) {
		reasons.push(`resource-sampling-gap:${maximumGapMs}`);
	}
	return {
		expectedMinimumSamples,
		...(firstCapturedAtMs === undefined ? {} : { firstCapturedAtMs }),
		...(lastCapturedAtMs === undefined ? {} : { lastCapturedAtMs }),
		...(maximumGapMs === undefined ? {} : { maximumGapMs }),
		reasons,
		sampleCount: aggregates.length,
		valid: reasons.length === 0
	};
}

export function summarizeProcessTreeResourceSamples(samples: readonly ProcessTreeResourceSample[]): ProcessTreeResourceSummary {
	if (!Array.isArray(samples)) throw new TypeError('samples must be an array.');
	const aggregates = samples.map(aggregateProcessTreeResourceSample).sort((left, right) => left.capturedAtMs - right.capturedAtMs);
	if (aggregates.length === 0) return { sampleCount: 0 };
	const cpu = aggregates.map(sample => sample.totalCpuPercent);
	const privateBytes = aggregates.map(sample => sample.totalPrivateBytes);
	const workingSetBytes = aggregates.map(sample => sample.totalWorkingSetBytes);
	const processCounts = aggregates.map(sample => sample.processCount);

	return {
		averageCpuPercent: average(cpu),
		averagePrivateBytes: average(privateBytes),
		averageProcessCount: average(processCounts),
		averageWorkingSetBytes: average(workingSetBytes),
		firstCapturedAtMs: aggregates[0].capturedAtMs,
		lastCapturedAtMs: aggregates[aggregates.length - 1].capturedAtMs,
		maximumProcessCount: Math.max(...processCounts),
		minimumProcessCount: Math.min(...processCounts),
		peakCpuPercent: Math.max(...cpu),
		peakPrivateBytes: Math.max(...privateBytes),
		peakWorkingSetBytes: Math.max(...workingSetBytes),
		sampleCount: aggregates.length
	};
}
