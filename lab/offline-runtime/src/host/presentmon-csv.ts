export const DEFAULT_PRESENTMON_WARMUP_MS = 10_000;
export const DEFAULT_PRESENTMON_MINIMUM_FRAME_SAMPLES = 50;
export const DEFAULT_PRESENTMON_FRAME_BUDGET_MS = 1_000 / 60;
export const DEFAULT_PRESENTMON_STUTTER_MULTIPLIER = 2;

export type PresentMonCsvSchema = 'v1' | 'v2' | 'unknown';
export type PresentMonFrameClassification = 'displayed' | 'dropped' | 'unknown';
export type PresentMonClassificationSource = 'displayed-column' | 'displayed-time-column' | 'dropped-column' | 'unavailable';
export type PresentMonTimestampFormat = 'date-explicit-zone' | 'date-zone-less' | 'numeric';

export interface PresentMonFrameRecord {
	application?: string;
	classification: PresentMonFrameClassification;
	displayLatencyMs?: number;
	frameTimeMs?: number;
	processId?: number;
	sourceRow: number;
	swapChainAddress?: string;
	timestampFormat?: PresentMonTimestampFormat;
	timestampMs?: number;
}

export interface PresentMonCsvDocument {
	classificationColumn?: string;
	classificationSource: PresentMonClassificationSource;
	frameTimeColumn?: string;
	malformedRowCount: number;
	records: PresentMonFrameRecord[];
	schema: PresentMonCsvSchema;
	timestampColumn?: string;
}

export interface PresentMonAnalysisOptions {
	captureClockToleranceMs?: number;
	captureProcessEndTimestampMs?: number;
	captureProcessStartTimestampMs?: number;
	captureTimezoneOffsetMinutes?: number;
	coverageToleranceMs?: number;
	endTimestampMs?: number;
	frameBudgetMs?: number;
	minimumFrameSamples?: number;
	startTimestampMs?: number;
	stutterMultiplier?: number;
	warmupMs?: number;
}

export interface PresentMonFrameMetrics {
	averageFps?: number;
	displayedFrameCount: number;
	droppedFrameCount: number;
	fixedBudgetMissCount: number;
	fixedBudgetMissRatio?: number;
	frameTimeP50Ms?: number;
	frameTimeP95Ms?: number;
	frameTimeP99Ms?: number;
	frameTimeTotalMs: number;
	frameTimeWorstMs?: number;
	onePercentLowFps?: number;
	reasons: string[];
	sampleCount: number;
	stutterCount: number;
	stutterRatio?: number;
	unknownDisplayStatusCount: number;
	valid: boolean;
}

export interface PresentMonStreamAnalysis extends PresentMonFrameMetrics {
	applicationNames: string[];
	firstTimestampMs?: number;
	key: string;
	lastTimestampMs?: number;
	processId?: number;
	recordCount: number;
	swapChainAddress?: string;
}

export interface PresentMonCsvAnalysis {
	captureFirstTimestampMs?: number;
	captureLastTimestampMs?: number;
	captureProcessEndTimestampMs?: number;
	captureProcessStartTimestampMs?: number;
	captureTimezoneOffsetMinutes?: number;
	capturedProcessIds: number[];
	classificationColumn?: string;
	classificationSource: PresentMonClassificationSource;
	coverageToleranceMs: number;
	endTimestampMs?: number;
	frameBudgetMs: number;
	frameTimeColumn?: string;
	malformedRowCount: number;
	overall: PresentMonFrameMetrics;
	postWarmupRecordCount: number;
	presentingProcessIds: number[];
	primaryStreamKey?: string;
	reasons: string[];
	schema: PresentMonCsvSchema;
	startTimestampMs?: number;
	streams: PresentMonStreamAnalysis[];
	stutterMultiplier: number;
	timestampAdjustmentMs?: number;
	timestampColumn?: string;
	totalRecordCount: number;
	valid: boolean;
	warmupMs: number;
	warnings: string[];
}

interface ColumnSelection {
	index: number;
	name: string;
	scale?: number;
	type?: 'date';
}

interface ResolvedOptions {
	captureClockToleranceMs: number;
	captureProcessEndTimestampMs?: number;
	captureProcessStartTimestampMs?: number;
	captureTimezoneOffsetMinutes?: number;
	coverageToleranceMs: number;
	endTimestampMs?: number;
	frameBudgetMs: number;
	minimumFrameSamples: number;
	startTimestampMs?: number;
	stutterMultiplier: number;
	warmupMs: number;
}

interface ParsedTimestamp {
	format: PresentMonTimestampFormat;
	timestampMs: number;
}

function normalizeColumnName(value: string): string {
	return value.replace(/^﻿/u, '').trim().toLowerCase().replaceAll(/[^a-z0-9]/gu, '');
}

function parseCsvRows(csv: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;

	for (let index = 0; index < csv.length; index += 1) {
		const character = csv[index];
		if (inQuotes) {
			if (character === '"') {
				if (csv[index + 1] === '"') {
					field += '"';
					index += 1;
				} else {
					inQuotes = false;
				}
			} else {
				field += character;
			}
			continue;
		}

		if (character === '"' && field.length === 0) {
			inQuotes = true;
		} else if (character === ',') {
			row.push(field);
			field = '';
		} else if (character === '\n' || character === '\r') {
			if (character === '\r' && csv[index + 1] === '\n') index += 1;
			row.push(field);
			if (row.some(value => value.length > 0)) rows.push(row);
			row = [];
			field = '';
		} else {
			field += character;
		}
	}

	if (inQuotes) throw new TypeError('PresentMon CSV contains an unterminated quoted field.');
	row.push(field);
	if (row.some(value => value.length > 0)) rows.push(row);
	return rows;
}

function buildColumnLookup(header: readonly string[]): Map<string, number> {
	const lookup = new Map<string, number>();
	for (let index = 0; index < header.length; index += 1) {
		const normalized = normalizeColumnName(header[index]);
		if (normalized.length > 0 && !lookup.has(normalized)) lookup.set(normalized, index);
	}
	return lookup;
}

function selectColumn(header: readonly string[], lookup: ReadonlyMap<string, number>, aliases: readonly string[]): ColumnSelection | undefined {
	for (const alias of aliases) {
		const index = lookup.get(normalizeColumnName(alias));
		if (index !== undefined) return { index, name: header[index].replace(/^﻿/u, '').trim() };
	}
	return undefined;
}

function selectTimestampColumn(header: readonly string[], lookup: ReadonlyMap<string, number>): ColumnSelection | undefined {
	const date = selectColumn(header, lookup, ['CPUStartDateTime']);
	if (date) return { ...date, type: 'date' };
	const millisecondAliases = ['TimeInMs', 'CPUStartTime', 'CPUStartTimeInMs', 'CPUStartQPCTime'];
	const milliseconds = selectColumn(header, lookup, millisecondAliases);
	if (milliseconds) return { ...milliseconds, scale: 1 };
	const seconds = selectColumn(header, lookup, ['TimeInSeconds']);
	if (seconds) return { ...seconds, scale: 1_000 };
	return undefined;
}

function parseFiniteNumber(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || /^(?:na|n\/a|null)$/iu.test(trimmed)) return undefined;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseTimestamp(value: string | undefined, column: ColumnSelection | undefined): ParsedTimestamp | undefined {
	if (!column || value === undefined) return undefined;
	if (column.type === 'date') {
		const trimmed = value.trim();
		if (/(?:Z|[+-]\d{2}:?\d{2})$/u.test(trimmed)) {
			const dateTime = trimmed.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:?\d{2}$)/u, '$1');
			const timestampMs = Date.parse(dateTime);
			return Number.isFinite(timestampMs)
				? { format: 'date-explicit-zone', timestampMs }
				: undefined;
		}
		const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/u.exec(trimmed);
		if (!match) return undefined;
		const [, year, month, day, hour, minute, second, fraction = ''] = match;
		const timestampMs = Date.UTC(
			Number(year),
			Number(month) - 1,
			Number(day),
			Number(hour),
			Number(minute),
			Number(second),
			Number(fraction.padEnd(3, '0').slice(0, 3))
		);
		return Number.isFinite(timestampMs)
			? { format: 'date-zone-less', timestampMs }
			: undefined;
	}
	const parsed = parseFiniteNumber(value);
	return parsed === undefined
		? undefined
		: {
			format: 'numeric',
			timestampMs: parsed * (column.scale ?? 1)
		};
}

function parseProcessId(value: string | undefined): number | undefined {
	const parsed = parseFiniteNumber(value);
	return parsed !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBooleanLike(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
	return undefined;
}

function classifyFrame(row: readonly string[], droppedColumn: ColumnSelection | undefined, displayedColumn: ColumnSelection | undefined, displayedTimeColumn: ColumnSelection | undefined): PresentMonFrameClassification {
	if (droppedColumn) {
		const raw = row[droppedColumn.index]?.trim().toLowerCase();
		if (raw === 'dropped') return 'dropped';
		if (raw === 'displayed') return 'displayed';
		const dropped = parseBooleanLike(raw);
		return dropped === undefined ? 'unknown' : dropped ? 'dropped' : 'displayed';
	}
	if (displayedColumn) {
		const raw = row[displayedColumn.index]?.trim().toLowerCase();
		if (raw === 'displayed') return 'displayed';
		if (raw === 'dropped') return 'dropped';
		const displayed = parseBooleanLike(raw);
		return displayed === undefined ? 'unknown' : displayed ? 'displayed' : 'dropped';
	}
	if (displayedTimeColumn) {
		const raw = row[displayedTimeColumn.index]?.trim();
		if (raw === undefined || raw.length === 0) return 'unknown';
		if (/^(?:na|n\/a|null)$/iu.test(raw)) return 'dropped';
		return parseFiniteNumber(raw) === undefined ? 'unknown' : 'displayed';
	}
	return 'unknown';
}

function classificationMetadata(droppedColumn: ColumnSelection | undefined, displayedColumn: ColumnSelection | undefined, displayedTimeColumn: ColumnSelection | undefined): Pick<PresentMonCsvDocument, 'classificationColumn' | 'classificationSource'> {
	if (droppedColumn) return { classificationColumn: droppedColumn.name, classificationSource: 'dropped-column' };
	if (displayedColumn) return { classificationColumn: displayedColumn.name, classificationSource: 'displayed-column' };
	if (displayedTimeColumn) return { classificationColumn: displayedTimeColumn.name, classificationSource: 'displayed-time-column' };
	return { classificationSource: 'unavailable' };
}

export function parsePresentMonCsv(csv: string): PresentMonCsvDocument {
	if (typeof csv !== 'string') throw new TypeError('PresentMon CSV input must be a string.');
	const rows = parseCsvRows(csv);
	if (rows.length === 0) throw new TypeError('PresentMon CSV is empty.');
	const header = rows[0];
	const lookup = buildColumnLookup(header);
	const frameTimeColumn = selectColumn(header, lookup, ['FrameTime', 'MsBetweenPresents']);
	const timestampColumn = selectTimestampColumn(header, lookup);
	const applicationColumn = selectColumn(header, lookup, ['Application', 'ProcessName']);
	const processIdColumn = selectColumn(header, lookup, ['ProcessID', 'PID']);
	const swapChainColumn = selectColumn(header, lookup, ['SwapChainAddress', 'SwapChain']);
	const displayLatencyColumn = selectColumn(header, lookup, ['DisplayLatency', 'MsUntilDisplayed']);
	const droppedColumn = selectColumn(header, lookup, ['Dropped', 'IsDropped']);
	const displayedColumn = selectColumn(header, lookup, ['Displayed', 'WasDisplayed']);
	const displayedTimeColumn = selectColumn(header, lookup, ['DisplayedTime']);
	const classification = classificationMetadata(droppedColumn, displayedColumn, displayedTimeColumn);
	const frameTimeColumnName = frameTimeColumn ? normalizeColumnName(frameTimeColumn.name) : '';
	const schema: PresentMonCsvSchema = frameTimeColumnName === 'frametime' ? 'v2' : frameTimeColumnName === 'msbetweenpresents' ? 'v1' : 'unknown';
	let malformedRowCount = 0;
	const records: PresentMonFrameRecord[] = [];

	for (let index = 1; index < rows.length; index += 1) {
		const row = rows[index];
		if (row.length !== header.length) malformedRowCount += 1;
		const application = applicationColumn ? row[applicationColumn.index]?.trim() : undefined;
		const swapChainAddress = swapChainColumn ? row[swapChainColumn.index]?.trim() : undefined;
		const frameTimeMs = frameTimeColumn ? parseFiniteNumber(row[frameTimeColumn.index]) : undefined;
		const displayLatencyMs = displayLatencyColumn ? parseFiniteNumber(row[displayLatencyColumn.index]) : undefined;
		const timestamp = timestampColumn ? parseTimestamp(row[timestampColumn.index], timestampColumn) : undefined;
		records.push({
			...(application && !/^(?:na|n\/a)$/iu.test(application) ? { application } : {}),
			classification: classifyFrame(row, droppedColumn, displayedColumn, displayedTimeColumn),
			...(displayLatencyMs !== undefined && displayLatencyMs >= 0 ? { displayLatencyMs } : {}),
			...(frameTimeMs !== undefined && frameTimeMs > 0 ? { frameTimeMs } : {}),
			...(processIdColumn ? { processId: parseProcessId(row[processIdColumn.index]) } : {}),
			sourceRow: index + 1,
			...(swapChainAddress && !/^(?:na|n\/a)$/iu.test(swapChainAddress) ? { swapChainAddress } : {}),
			...(timestamp === undefined
				? {}
				: {
					timestampFormat: timestamp.format,
					timestampMs: timestamp.timestampMs
				})
		});
	}

	return {
		...classification,
		...(frameTimeColumn ? { frameTimeColumn: frameTimeColumn.name } : {}),
		malformedRowCount,
		records,
		schema,
		...(timestampColumn ? { timestampColumn: timestampColumn.name } : {})
	};
}

function percentile(sorted: readonly number[], percentage: number): number | undefined {
	if (sorted.length === 0) return undefined;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1));
	return sorted[index];
}

function average(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function calculateFrameMetrics(records: readonly PresentMonFrameRecord[], options: ResolvedOptions): PresentMonFrameMetrics {
	const frameTimes = records.flatMap(record => record.frameTimeMs === undefined ? [] : [record.frameTimeMs]);
	const sorted = [...frameTimes].sort((left, right) => left - right);
	const frameTimeTotalMs = frameTimes.reduce((sum, value) => sum + value, 0);
	const meanFrameTime = average(frameTimes);
	const p50 = percentile(sorted, 50);
	const slowestFrameCount = frameTimes.length === 0 ? 0 : Math.max(1, Math.ceil(frameTimes.length * 0.01));
	const slowestAverage = slowestFrameCount === 0 ? undefined : average(sorted.slice(sorted.length - slowestFrameCount));
	const fixedBudgetMissCount = frameTimes.filter(frameTime => frameTime > options.frameBudgetMs).length;
	const stutterThreshold = p50 === undefined ? undefined : p50 * options.stutterMultiplier;
	const stutterCount = stutterThreshold === undefined ? 0 : frameTimes.filter(frameTime => frameTime > stutterThreshold).length;
	const reasons: string[] = [];
	if (frameTimes.length === 0) reasons.push('no-frame-time-samples');
	else if (frameTimes.length < options.minimumFrameSamples) reasons.push(`insufficient-frame-time-samples:${frameTimes.length}/${options.minimumFrameSamples}`);

	return {
		...(meanFrameTime === undefined ? {} : { averageFps: 1_000 / meanFrameTime }),
		displayedFrameCount: records.filter(record => record.classification === 'displayed').length,
		droppedFrameCount: records.filter(record => record.classification === 'dropped').length,
		fixedBudgetMissCount,
		...(frameTimes.length === 0 ? {} : { fixedBudgetMissRatio: fixedBudgetMissCount / frameTimes.length }),
		...(p50 === undefined ? {} : { frameTimeP50Ms: p50 }),
		...(percentile(sorted, 95) === undefined ? {} : { frameTimeP95Ms: percentile(sorted, 95) }),
		...(percentile(sorted, 99) === undefined ? {} : { frameTimeP99Ms: percentile(sorted, 99) }),
		frameTimeTotalMs,
		...(sorted.length === 0 ? {} : { frameTimeWorstMs: sorted[sorted.length - 1] }),
		...(slowestAverage === undefined ? {} : { onePercentLowFps: 1_000 / slowestAverage }),
		reasons,
		sampleCount: frameTimes.length,
		stutterCount,
		...(frameTimes.length === 0 ? {} : { stutterRatio: stutterCount / frameTimes.length }),
		unknownDisplayStatusCount: records.filter(record => record.classification === 'unknown').length,
		valid: reasons.length === 0
	};
}

function streamKey(record: PresentMonFrameRecord): string {
	const process = record.processId === undefined ? 'pid:unknown' : `pid:${record.processId}`;
	const swapChain = record.swapChainAddress === undefined ? 'swapchain:unknown' : `swapchain:${record.swapChainAddress.toLowerCase()}`;
	return `${process}/${swapChain}`;
}

function analyzeStreams(records: readonly PresentMonFrameRecord[], options: ResolvedOptions): PresentMonStreamAnalysis[] {
	const grouped = new Map<string, PresentMonFrameRecord[]>();
	for (const record of records) {
		const key = streamKey(record);
		const group = grouped.get(key);
		if (group) group.push(record);
		else grouped.set(key, [record]);
	}

	return [...grouped.entries()]
		.map(([key, streamRecords]) => {
			const processIds = uniqueStrings(streamRecords.flatMap(record => record.processId === undefined ? [] : [String(record.processId)]));
			const swapChains = uniqueStrings(streamRecords.flatMap(record => record.swapChainAddress === undefined ? [] : [record.swapChainAddress]));
			let firstTimestampMs: number | undefined;
			let lastTimestampMs: number | undefined;
			for (const record of streamRecords) {
				if (record.timestampMs === undefined) continue;
				firstTimestampMs = firstTimestampMs === undefined
					? record.timestampMs
					: Math.min(firstTimestampMs, record.timestampMs);
				lastTimestampMs = lastTimestampMs === undefined
					? record.timestampMs
					: Math.max(lastTimestampMs, record.timestampMs);
			}
			return {
				applicationNames: uniqueStrings(streamRecords.flatMap(record => record.application === undefined ? [] : [record.application])),
				...(firstTimestampMs === undefined ? {} : { firstTimestampMs }),
				key,
				...(lastTimestampMs === undefined ? {} : { lastTimestampMs }),
				...(processIds.length === 1 ? { processId: Number(processIds[0]) } : {}),
				recordCount: streamRecords.length,
				...(swapChains.length === 1 ? { swapChainAddress: swapChains[0] } : {}),
				...calculateFrameMetrics(streamRecords, options)
			};
		})
		.sort((left, right) => right.sampleCount - left.sampleCount || left.key.localeCompare(right.key));
}

function resolveOptions(options: PresentMonAnalysisOptions): ResolvedOptions {
	const resolved: ResolvedOptions = {
		captureClockToleranceMs: options.captureClockToleranceMs ?? 1_000,
		...(options.captureProcessEndTimestampMs === undefined
			? {}
			: { captureProcessEndTimestampMs: options.captureProcessEndTimestampMs }),
		...(options.captureProcessStartTimestampMs === undefined
			? {}
			: { captureProcessStartTimestampMs: options.captureProcessStartTimestampMs }),
		...(options.captureTimezoneOffsetMinutes === undefined
			? {}
			: { captureTimezoneOffsetMinutes: options.captureTimezoneOffsetMinutes }),
		coverageToleranceMs: options.coverageToleranceMs ?? 100,
		...(options.endTimestampMs === undefined ? {} : { endTimestampMs: options.endTimestampMs }),
		frameBudgetMs: options.frameBudgetMs ?? DEFAULT_PRESENTMON_FRAME_BUDGET_MS,
		minimumFrameSamples: options.minimumFrameSamples ?? DEFAULT_PRESENTMON_MINIMUM_FRAME_SAMPLES,
		...(options.startTimestampMs === undefined ? {} : { startTimestampMs: options.startTimestampMs }),
		stutterMultiplier: options.stutterMultiplier ?? DEFAULT_PRESENTMON_STUTTER_MULTIPLIER,
		warmupMs: options.warmupMs ?? DEFAULT_PRESENTMON_WARMUP_MS
	};
	if (!Number.isFinite(resolved.captureClockToleranceMs) || resolved.captureClockToleranceMs < 0 || resolved.captureClockToleranceMs > 10_000) {
		throw new TypeError('captureClockToleranceMs must be from zero through 10,000.');
	}
	if (!Number.isFinite(resolved.coverageToleranceMs) || resolved.coverageToleranceMs < 0 || resolved.coverageToleranceMs > 10_000) {
		throw new TypeError('coverageToleranceMs must be from zero through 10,000.');
	}
	if (!Number.isFinite(resolved.frameBudgetMs) || resolved.frameBudgetMs <= 0) throw new TypeError('frameBudgetMs must be greater than zero.');
	if (!Number.isInteger(resolved.minimumFrameSamples) || resolved.minimumFrameSamples < 1) throw new TypeError('minimumFrameSamples must be a positive integer.');
	if (!Number.isFinite(resolved.stutterMultiplier) || resolved.stutterMultiplier <= 1) throw new TypeError('stutterMultiplier must be greater than one.');
	if (!Number.isFinite(resolved.warmupMs) || resolved.warmupMs < 0) throw new TypeError('warmupMs must be greater than or equal to zero.');
	if ((resolved.captureProcessStartTimestampMs === undefined) !== (resolved.captureProcessEndTimestampMs === undefined)) {
		throw new TypeError('captureProcessStartTimestampMs and captureProcessEndTimestampMs must be provided together.');
	}
	if (resolved.captureProcessStartTimestampMs !== undefined) {
		if (!Number.isFinite(resolved.captureProcessStartTimestampMs) || !Number.isFinite(resolved.captureProcessEndTimestampMs)) {
			throw new TypeError('Capture-process timestamp boundaries must be finite.');
		}
		if ((resolved.captureProcessEndTimestampMs as number) <= resolved.captureProcessStartTimestampMs) {
			throw new TypeError('captureProcessEndTimestampMs must be greater than captureProcessStartTimestampMs.');
		}
	}
	if (resolved.captureTimezoneOffsetMinutes !== undefined) {
		if (!Number.isFinite(resolved.captureTimezoneOffsetMinutes) || Math.abs(resolved.captureTimezoneOffsetMinutes) > 24 * 60) {
			throw new TypeError('captureTimezoneOffsetMinutes must be a finite offset within 24 hours.');
		}
	}
	if ((resolved.startTimestampMs === undefined) !== (resolved.endTimestampMs === undefined)) {
		throw new TypeError('startTimestampMs and endTimestampMs must be provided together.');
	}
	if (resolved.startTimestampMs !== undefined) {
		if (!Number.isFinite(resolved.startTimestampMs) || !Number.isFinite(resolved.endTimestampMs)) {
			throw new TypeError('Timestamp range boundaries must be finite.');
		}
		if ((resolved.endTimestampMs as number) <= resolved.startTimestampMs) {
			throw new TypeError('endTimestampMs must be greater than startTimestampMs.');
		}
	}
	return resolved;
}

function alignZoneLessCaptureTimestamps(
	records: readonly PresentMonFrameRecord[],
	options: ResolvedOptions
): {
	reason?: string;
	records: PresentMonFrameRecord[];
	timestampAdjustmentMs?: number;
} {
	const formats = new Set(records.flatMap(record => record.timestampFormat === undefined ? [] : [record.timestampFormat]));
	if (!formats.has('date-zone-less') || options.captureProcessStartTimestampMs === undefined || options.captureProcessEndTimestampMs === undefined) {
		return { records: [...records] };
	}
	if (formats.size !== 1) {
		return {
			reason: 'capture-clock-format-mixed',
			records: [...records]
		};
	}
	const timestamps = records.flatMap(record => record.timestampMs === undefined ? [] : [record.timestampMs]);
	if (timestamps.length === 0) return { records: [...records] };
	const firstTimestampMs = Math.min(...timestamps);
	const lastTimestampMs = Math.max(...timestamps);
	const captureProcessStartTimestampMs = options.captureProcessStartTimestampMs;
	const captureProcessEndTimestampMs = options.captureProcessEndTimestampMs;
	const timezoneOffsetMinutes = options.captureTimezoneOffsetMinutes
		?? new Date(captureProcessStartTimestampMs).getTimezoneOffset();
	const timezoneOffsetMs = timezoneOffsetMinutes * 60_000;
	const candidateAdjustments = [...new Set([0, timezoneOffsetMs, timezoneOffsetMs * 2])];
	const matchingAdjustments = candidateAdjustments.filter(adjustment =>
		firstTimestampMs + adjustment >= captureProcessStartTimestampMs - options.captureClockToleranceMs
		&& lastTimestampMs + adjustment <= captureProcessEndTimestampMs + options.captureClockToleranceMs
	);
	if (matchingAdjustments.length === 0) {
		return {
			reason: 'capture-clock-alignment-failed',
			records: [...records]
		};
	}
	if (matchingAdjustments.length > 1) {
		return {
			reason: 'capture-clock-alignment-ambiguous',
			records: [...records]
		};
	}
	const timestampAdjustmentMs = matchingAdjustments[0];
	return {
		records: records.map(record =>
			record.timestampMs === undefined
				? { ...record }
				: {
					...record,
					timestampMs: record.timestampMs + timestampAdjustmentMs
				}
		),
		timestampAdjustmentMs
	};
}

function invalidAnalysis(error: unknown, options: ResolvedOptions): PresentMonCsvAnalysis {
	const message = error instanceof Error ? error.message : String(error);
	const overall = calculateFrameMetrics([], options);
	return {
		...(options.captureProcessEndTimestampMs === undefined
			? {}
			: { captureProcessEndTimestampMs: options.captureProcessEndTimestampMs }),
		...(options.captureProcessStartTimestampMs === undefined
			? {}
			: { captureProcessStartTimestampMs: options.captureProcessStartTimestampMs }),
		...(options.captureTimezoneOffsetMinutes === undefined
			? {}
			: { captureTimezoneOffsetMinutes: options.captureTimezoneOffsetMinutes }),
		capturedProcessIds: [],
		classificationSource: 'unavailable',
		coverageToleranceMs: options.coverageToleranceMs,
		...(options.endTimestampMs === undefined ? {} : { endTimestampMs: options.endTimestampMs }),
		frameBudgetMs: options.frameBudgetMs,
		malformedRowCount: 0,
		overall,
		postWarmupRecordCount: 0,
		presentingProcessIds: [],
		reasons: [`malformed-csv:${message}`],
		schema: 'unknown',
		...(options.startTimestampMs === undefined ? {} : { startTimestampMs: options.startTimestampMs }),
		streams: [],
		stutterMultiplier: options.stutterMultiplier,
		totalRecordCount: 0,
		valid: false,
		warmupMs: options.warmupMs,
		warnings: []
	};
}

export function analyzePresentMonCsv(csv: string, options: PresentMonAnalysisOptions = {}): PresentMonCsvAnalysis {
	const resolved = resolveOptions(options);
	let document: PresentMonCsvDocument;
	try {
		document = parsePresentMonCsv(csv);
	} catch (error) {
		return invalidAnalysis(error, resolved);
	}

	const reasons: string[] = [];
	const warnings: string[] = [];
	const alignment = alignZoneLessCaptureTimestamps(document.records, resolved);
	const records = alignment.records;
	if (alignment.reason) reasons.push(alignment.reason);
	if (!document.frameTimeColumn) reasons.push('missing-frame-time-column');
	if (records.length === 0) reasons.push('no-present-records');
	if (document.malformedRowCount > 0) reasons.push(`malformed-row-count:${document.malformedRowCount}`);
	if (document.classificationSource === 'unavailable') warnings.push('display-classification-unavailable');
	const captureTimestamps = records.flatMap(record => record.timestampMs === undefined ? [] : [record.timestampMs]);
	const captureFirstTimestampMs = captureTimestamps.length === 0 ? undefined : Math.min(...captureTimestamps);
	const captureLastTimestampMs = captureTimestamps.length === 0 ? undefined : Math.max(...captureTimestamps);
	if (records.every(record => record.processId === undefined && record.swapChainAddress === undefined)) warnings.push('present-stream-identifiers-unavailable');

	let postWarmupRecords: PresentMonFrameRecord[] = [];
	if (alignment.reason) {
		postWarmupRecords = [];
	} else if (resolved.startTimestampMs !== undefined && resolved.endTimestampMs !== undefined) {
		if (!document.timestampColumn) {
			reasons.push('range-timestamp-column-unavailable');
		} else if (records.every(record => record.timestampMs === undefined)) {
			reasons.push('range-timestamps-unparseable');
		} else {
			const startTimestampMs = resolved.startTimestampMs;
			const endTimestampMs = resolved.endTimestampMs;
			if (captureFirstTimestampMs !== undefined && captureFirstTimestampMs > startTimestampMs + resolved.coverageToleranceMs) {
				reasons.push(`capture-start-coverage-missing:${captureFirstTimestampMs - startTimestampMs}`);
			}
			if (captureLastTimestampMs !== undefined && captureLastTimestampMs < endTimestampMs - resolved.coverageToleranceMs) {
				reasons.push(`capture-end-coverage-missing:${endTimestampMs - captureLastTimestampMs}`);
			}
			postWarmupRecords = records.filter(
				record => record.timestampMs !== undefined && record.timestampMs >= startTimestampMs && record.timestampMs <= endTimestampMs
			);
		}
	} else if (resolved.warmupMs === 0) {
		postWarmupRecords = records;
	} else if (!document.timestampColumn) {
		reasons.push('warmup-timestamp-column-unavailable');
	} else {
		const timestamps = records.flatMap(record => record.timestampMs === undefined ? [] : [record.timestampMs]);
		const captureStartMs = timestamps.length === 0 ? undefined : Math.min(...timestamps);
		if (captureStartMs === undefined) reasons.push('warmup-timestamps-unparseable');
		else postWarmupRecords = records.filter(record => record.timestampMs !== undefined && record.timestampMs - captureStartMs >= resolved.warmupMs);
	}
	if (records.length > 0 && postWarmupRecords.length === 0 && !reasons.some(reason => /^(?:capture-clock|range|warmup)-/u.test(reason))) {
		reasons.push(resolved.startTimestampMs === undefined ? 'no-present-records-after-warmup' : 'no-present-records-in-range');
	}

	const overall = calculateFrameMetrics(postWarmupRecords, resolved);
	reasons.push(...overall.reasons);
	if (overall.unknownDisplayStatusCount > 0 && document.classificationSource !== 'unavailable') warnings.push(`unknown-display-status-count:${overall.unknownDisplayStatusCount}`);
	const streams = analyzeStreams(postWarmupRecords, resolved);
	if (streams.length > 1) warnings.push('multiple-present-streams-use-per-stream-metrics');
	if (streams.length > 0 && !streams.some(stream => stream.valid)) reasons.push('no-present-stream-meets-minimum-samples');
	const capturedProcessIds = [...new Set(records.flatMap(record => record.processId === undefined ? [] : [record.processId]))].sort((left, right) => left - right);
	const presentingProcessIds = [...new Set(postWarmupRecords.flatMap(record => record.processId === undefined ? [] : [record.processId]))].sort((left, right) => left - right);
	const uniqueReasons = uniqueStrings(reasons);

	return {
		...(captureFirstTimestampMs === undefined ? {} : { captureFirstTimestampMs }),
		...(captureLastTimestampMs === undefined ? {} : { captureLastTimestampMs }),
		...(resolved.captureProcessEndTimestampMs === undefined
			? {}
			: { captureProcessEndTimestampMs: resolved.captureProcessEndTimestampMs }),
		...(resolved.captureProcessStartTimestampMs === undefined
			? {}
			: { captureProcessStartTimestampMs: resolved.captureProcessStartTimestampMs }),
		...(resolved.captureTimezoneOffsetMinutes === undefined
			? {}
			: { captureTimezoneOffsetMinutes: resolved.captureTimezoneOffsetMinutes }),
		capturedProcessIds,
		...(document.classificationColumn ? { classificationColumn: document.classificationColumn } : {}),
		classificationSource: document.classificationSource,
		coverageToleranceMs: resolved.coverageToleranceMs,
		...(resolved.endTimestampMs === undefined ? {} : { endTimestampMs: resolved.endTimestampMs }),
		frameBudgetMs: resolved.frameBudgetMs,
		...(document.frameTimeColumn ? { frameTimeColumn: document.frameTimeColumn } : {}),
		malformedRowCount: document.malformedRowCount,
		overall,
		postWarmupRecordCount: postWarmupRecords.length,
		presentingProcessIds,
		...(streams[0] ? { primaryStreamKey: streams[0].key } : {}),
		reasons: uniqueReasons,
		schema: document.schema,
		...(resolved.startTimestampMs === undefined ? {} : { startTimestampMs: resolved.startTimestampMs }),
		streams,
		stutterMultiplier: resolved.stutterMultiplier,
		...(alignment.timestampAdjustmentMs === undefined ? {} : { timestampAdjustmentMs: alignment.timestampAdjustmentMs }),
		...(document.timestampColumn ? { timestampColumn: document.timestampColumn } : {}),
		totalRecordCount: records.length,
		valid: uniqueReasons.length === 0,
		warmupMs: resolved.warmupMs,
		warnings: uniqueStrings(warnings)
	};
}
