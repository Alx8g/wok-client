import { basename } from 'node:path';
import type { PresentMonStreamAnalysis } from './presentmon-csv.ts';

const DOTNET_FILETIME_EPOCH_OFFSET_TICKS = 504_911_232_000_000_000n;
const FILETIME_UNIX_EPOCH_TICKS = 116_444_736_000_000_000n;
const MAX_DOTNET_DATE_TIME_TICKS = 3_155_378_975_999_999_999n;
const MAX_FILETIME_TICKS =
	MAX_DOTNET_DATE_TIME_TICKS - DOTNET_FILETIME_EPOCH_OFFSET_TICKS;
const MAX_PROCESS_EVENT_COUNT = 100_000;

export interface EtlProcessStartEventEvidence {
	createTimeFileTimeUtc: string;
	creationTimeUtcTicks: string;
	eventTimestampFileTimeUtc: string;
	eventVersion: number;
	executableName: string;
	kind: 'start';
	parentProcessId: number;
	processId: number;
	sequence: number;
}

export interface EtlProcessStopEventEvidence {
	createTimeFileTimeUtc: string;
	creationTimeUtcTicks: string;
	eventTimestampFileTimeUtc: string;
	eventVersion: number;
	exitTimeFileTimeUtc: string;
	kind: 'stop';
	processId: number;
	sequence: number;
}

export type EtlProcessEventEvidence =
	| EtlProcessStartEventEvidence
	| EtlProcessStopEventEvidence;

export interface EtlProcessEventEvidenceArtifact {
	etlFileIndex: string;
	etlPath: string;
	etlSha256: string;
	etlSizeBytes: number;
	etlVolumeSerialNumber: string;
	events: readonly EtlProcessEventEvidence[];
	phase: 'etl-process-events';
	targetProcessId: number;
	version: 1;
}

export interface EtlProcessLifetimeStart {
	kind: 'etl-process-start';
	timestampMs: number;
}

export type EtlProcessLifetimeEnd =
	| {
		kind: 'etl-process-stop';
		timestampMs: number;
	}
	| {
		captureStopTimestampMs: number;
		kind: 'active-at-capture-stop';
	};

export interface EtlProcessLifetimeEvidence {
	creationTimeUtcTicks: string;
	executableName: string;
	processId: number;
	start: EtlProcessLifetimeStart;
	end: EtlProcessLifetimeEnd;
}

export interface EtlProcessLifetimeArtifact {
	captureStartTimestampMs: number;
	captureStopTimestampMs: number;
	etlSha256: string;
	lifetimes: readonly EtlProcessLifetimeEvidence[];
	processEventEvidenceSha256: string;
	targetProcessId: number;
	version: 1;
}

export interface ProcessLifetimeIdentityExpectation {
	creationTimeUtcTicks: string;
	executableName: string;
	executablePath: string;
	processId: number;
}

export interface AcceptedEtlProcessEvidenceIdentity {
	captureStartFileTimeUtc: string;
	captureStopFileTimeUtc: string;
	etlFileIndex: string;
	etlSha256: string;
	etlSizeBytes: number;
	etlVolumeSerialNumber: string;
	operationalEtlPath: string;
}

export interface PresentMonProcessLifetimeBinding {
	creationTimeUtcTicks: string;
	etlSha256: string;
	executableName: string;
	executablePath: string;
	firstFrameTimestampMs: number;
	lastFrameTimestampMs: number;
	lifetimeEnd: EtlProcessLifetimeEnd;
	lifetimeStart: EtlProcessLifetimeStart;
	processEventEvidenceSha256: string;
	processId: number;
	recordCount: number;
	streamKey: string;
	valid: true;
	version: 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(
	record: Record<string, unknown>,
	expected: readonly string[],
	label: string
): void {
	const actual = Object.keys(record).sort();
	const canonicalExpected = [...expected].sort();
	if (
		actual.length !== canonicalExpected.length
		|| actual.some((key, index) => key !== canonicalExpected[index])
	) {
		throw new TypeError(`${label} does not match the closed schema.`);
	}
}

function requiredString(
	record: Record<string, unknown>,
	key: string,
	label: string,
	maximumLength: number
): string {
	const value = record[key];
	if (
		typeof value !== 'string'
		|| value.length < 1
		|| value.length > maximumLength
	) {
		throw new TypeError(`${label}.${key} is invalid.`);
	}
	return value;
}

function requiredInteger(
	record: Record<string, unknown>,
	key: string,
	label: string,
	minimum: number,
	maximum: number
): number {
	const value = record[key];
	if (
		typeof value !== 'number'
		|| !Number.isSafeInteger(value)
		|| value < minimum
		|| value > maximum
	) {
		throw new TypeError(`${label}.${key} is invalid.`);
	}
	return value;
}

function requiredTimestampMs(
	record: Record<string, unknown>,
	key: string,
	label: string
): number {
	const value = record[key];
	if (
		typeof value !== 'number'
		|| !Number.isSafeInteger(value)
		|| value < 0
	) {
		throw new TypeError(`${label}.${key} is invalid.`);
	}
	return value;
}

function requiredLiteral<T extends string | number | boolean>(
	record: Record<string, unknown>,
	key: string,
	literal: T,
	label: string
): T {
	if (record[key] !== literal) {
		throw new TypeError(`${label}.${key} must equal ${String(literal)}.`);
	}
	return literal;
}

function canonicalUnsignedDecimal(
	value: unknown,
	label: string,
	maximum: bigint
): string {
	if (
		typeof value !== 'string'
		|| !/^(?:0|[1-9][0-9]*)$/u.test(value)
		|| BigInt(value) > maximum
	) {
		throw new TypeError(`${label} is not a canonical unsigned decimal.`);
	}
	return value;
}

function canonicalFileTime(value: unknown, label: string): string {
	const result = canonicalUnsignedDecimal(value, label, MAX_FILETIME_TICKS);
	if (BigInt(result) < FILETIME_UNIX_EPOCH_TICKS) {
		throw new TypeError(`${label} predates the supported Unix epoch.`);
	}
	return result;
}

function canonicalCreationTimeUtcTicks(
	value: unknown,
	label: string
): string {
	const result = canonicalUnsignedDecimal(
		value,
		label,
		MAX_DOTNET_DATE_TIME_TICKS
	);
	if (result === '0' || BigInt(result) % 10n !== 0n) {
		throw new TypeError(`${label} is not a canonical process creation time.`);
	}
	return result;
}

function creationTicksFromFileTime(fileTime: string): string {
	const ticks = BigInt(fileTime) + DOTNET_FILETIME_EPOCH_OFFSET_TICKS;
	return (ticks - ticks % 10n).toString(10);
}

function canonicalExecutableName(value: unknown, label: string): string {
	if (
		typeof value !== 'string'
		|| value.length < 1
		|| value.length > 1_024
		|| /[\\/\0\r\n]/u.test(value)
	) {
		throw new TypeError(`${label} is not one executable basename.`);
	}
	return value;
}

function parseProcessEvent(
	value: unknown,
	index: number,
	targetProcessId: number
): EtlProcessEventEvidence {
	if (!isRecord(value)) {
		throw new TypeError(`events[${index}] must be an object.`);
	}
	const label = `events[${index}]`;
	const kind = requiredString(value, 'kind', label, 5);
	if (kind !== 'start' && kind !== 'stop') {
		throw new TypeError(`${label}.kind is invalid.`);
	}
	assertExactKeys(
		value,
		kind === 'start'
			? [
				'kind',
				'sequence',
				'processId',
				'eventVersion',
				'eventTimestampFileTimeUtc',
				'createTimeFileTimeUtc',
				'creationTimeUtcTicks',
				'parentProcessId',
				'executableName'
			]
			: [
				'kind',
				'sequence',
				'processId',
				'eventVersion',
				'eventTimestampFileTimeUtc',
				'createTimeFileTimeUtc',
				'creationTimeUtcTicks',
				'exitTimeFileTimeUtc'
			],
		label
	);
	const processId = requiredInteger(
		value,
		'processId',
		label,
		1,
		0xffff_ffff
	);
	if (processId !== targetProcessId) {
		throw new TypeError(`${label}.processId does not match the target PID.`);
	}
	const createTimeFileTimeUtc = canonicalFileTime(
		value.createTimeFileTimeUtc,
		`${label}.createTimeFileTimeUtc`
	);
	const creationTimeUtcTicks = canonicalCreationTimeUtcTicks(
		value.creationTimeUtcTicks,
		`${label}.creationTimeUtcTicks`
	);
	if (
		creationTimeUtcTicks
		!== creationTicksFromFileTime(createTimeFileTimeUtc)
	) {
		throw new TypeError(
			`${label} creation time does not match its FILETIME evidence.`
		);
	}
	const common = {
		createTimeFileTimeUtc,
		creationTimeUtcTicks,
		eventTimestampFileTimeUtc: canonicalFileTime(
			value.eventTimestampFileTimeUtc,
			`${label}.eventTimestampFileTimeUtc`
		),
		eventVersion: requiredInteger(
			value,
			'eventVersion',
			label,
			0,
			0xff
		),
		processId,
		sequence: requiredInteger(
			value,
			'sequence',
			label,
			0,
			MAX_PROCESS_EVENT_COUNT - 1
		)
	};
	if (kind === 'start') {
		return Object.freeze({
			...common,
			executableName: canonicalExecutableName(
				value.executableName,
				`${label}.executableName`
			),
			kind,
			parentProcessId: requiredInteger(
				value,
				'parentProcessId',
				label,
				0,
				0xffff_ffff
			)
		});
	}
	return Object.freeze({
		...common,
		exitTimeFileTimeUtc: canonicalFileTime(
			value.exitTimeFileTimeUtc,
			`${label}.exitTimeFileTimeUtc`
		),
		kind
	});
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength
		&& left.every((value, index) => value === right[index]);
}

export function parseEtlProcessEventEvidence(
	contents: Uint8Array
): EtlProcessEventEvidenceArtifact {
	if (contents.byteLength < 2 || contents.byteLength > 16 * 1024 * 1024) {
		throw new TypeError('ETL process-event evidence size is invalid.');
	}
	const text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
	if (
		text.charCodeAt(0) === 0xfeff
		|| !text.endsWith('\r\n')
		|| /[\r\n]/u.test(text.slice(0, -2))
		|| !equalBytes(new TextEncoder().encode(text), contents)
	) {
		throw new TypeError(
			'ETL process-event evidence is not canonical UTF-8 CRLF framing.'
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(0, -2)) as unknown;
	} catch (error) {
		throw new TypeError('ETL process-event evidence is not valid JSON.', {
			cause: error
		});
	}
	if (!isRecord(parsed)) {
		throw new TypeError('ETL process-event evidence must be an object.');
	}
	assertExactKeys(parsed, [
		'version',
		'phase',
		'etlPath',
		'etlVolumeSerialNumber',
		'etlFileIndex',
		'etlSizeBytes',
		'etlSha256',
		'targetProcessId',
		'events'
	], 'ETL process-event evidence');
	requiredLiteral(parsed, 'version', 1, 'ETL process-event evidence');
	requiredLiteral(
		parsed,
		'phase',
		'etl-process-events',
		'ETL process-event evidence'
	);
	const targetProcessId = requiredInteger(
		parsed,
		'targetProcessId',
		'ETL process-event evidence',
		1,
		0xffff_ffff
	);
	if (
		!Array.isArray(parsed.events)
		|| parsed.events.length > MAX_PROCESS_EVENT_COUNT
	) {
		throw new TypeError('ETL process-event evidence events are invalid.');
	}
	const events = parsed.events.map((event, index) =>
		parseProcessEvent(event, index, targetProcessId)
	);
	for (let index = 0; index < events.length; index += 1) {
		if (events[index]?.sequence !== index) {
			throw new TypeError(
				'ETL process-event evidence sequence is not contiguous.'
			);
		}
		if (
			index > 0
			&& BigInt(events[index]?.eventTimestampFileTimeUtc ?? '0')
				< BigInt(events[index - 1]?.eventTimestampFileTimeUtc ?? '0')
		) {
			throw new TypeError(
				'ETL process-event evidence timestamps are out of order.'
			);
		}
	}
	const etlSha256 = requiredString(
		parsed,
		'etlSha256',
		'ETL process-event evidence',
		64
	);
	if (!/^[0-9a-f]{64}$/u.test(etlSha256)) {
		throw new TypeError('ETL process-event evidence SHA-256 is invalid.');
	}
	const etlFileIndex = requiredString(
		parsed,
		'etlFileIndex',
		'ETL process-event evidence',
		16
	);
	if (!/^[0-9a-f]{16}$/u.test(etlFileIndex)) {
		throw new TypeError('ETL process-event evidence file index is invalid.');
	}
	return Object.freeze({
		etlFileIndex,
		etlPath: requiredString(
			parsed,
			'etlPath',
			'ETL process-event evidence',
			32_767
		),
		etlSha256,
		etlSizeBytes: requiredInteger(
			parsed,
			'etlSizeBytes',
			'ETL process-event evidence',
			1,
			Number.MAX_SAFE_INTEGER
		),
		etlVolumeSerialNumber: canonicalUnsignedDecimal(
			parsed.etlVolumeSerialNumber,
			'ETL process-event evidence.etlVolumeSerialNumber',
			0xffff_ffffn
		),
		events: Object.freeze(events),
		phase: 'etl-process-events',
		targetProcessId,
		version: 1
	});
}

function parseCanonicalPrettyJsonArtifact(
	contents: Uint8Array,
	label: string
): Record<string, unknown> {
	if (contents.byteLength < 3 || contents.byteLength > 16 * 1024 * 1024) {
		throw new TypeError(`${label} size is invalid.`);
	}
	const text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
	if (
		text.charCodeAt(0) === 0xfeff
		|| !text.endsWith('\n')
		|| !equalBytes(new TextEncoder().encode(text), contents)
	) {
		throw new TypeError(`${label} is not canonical UTF-8 LF framing.`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		throw new TypeError(`${label} is not valid JSON.`, { cause: error });
	}
	if (!isRecord(parsed)) {
		throw new TypeError(`${label} must be an object.`);
	}
	if (`${JSON.stringify(parsed, null, '\t')}\n` !== text) {
		throw new TypeError(`${label} is not canonical pretty JSON.`);
	}
	return parsed;
}

function parseLifetimeStart(
	value: unknown,
	label: string
): EtlProcessLifetimeStart {
	if (!isRecord(value)) {
		throw new TypeError(`${label} must be an object.`);
	}
	const kind = requiredString(value, 'kind', label, 32);
	if (kind !== 'etl-process-start') {
		throw new TypeError(`${label}.kind is invalid.`);
	}
	assertExactKeys(value, ['kind', 'timestampMs'], label);
	return Object.freeze({
		kind,
		timestampMs: requiredTimestampMs(value, 'timestampMs', label)
	});
}

function parseLifetimeEnd(
	value: unknown,
	label: string,
	captureStopTimestampMs?: number
): EtlProcessLifetimeEnd {
	if (!isRecord(value)) {
		throw new TypeError(`${label} must be an object.`);
	}
	const kind = requiredString(value, 'kind', label, 32);
	if (kind === 'etl-process-stop') {
		assertExactKeys(value, ['kind', 'timestampMs'], label);
		return Object.freeze({
			kind,
			timestampMs: requiredTimestampMs(value, 'timestampMs', label)
		});
	}
	if (kind === 'active-at-capture-stop') {
		assertExactKeys(
			value,
			['captureStopTimestampMs', 'kind'],
			label
		);
		const timestampMs = requiredTimestampMs(
			value,
			'captureStopTimestampMs',
			label
		);
		if (
			captureStopTimestampMs !== undefined
			&& timestampMs !== captureStopTimestampMs
		) {
			throw new TypeError(
				`${label} does not match the capture stop boundary.`
			);
		}
		return Object.freeze({
			captureStopTimestampMs: timestampMs,
			kind
		});
	}
	throw new TypeError(`${label}.kind is invalid.`);
}

export function parseEtlProcessLifetimeArtifact(
	contents: Uint8Array
): EtlProcessLifetimeArtifact {
	const parsed = parseCanonicalPrettyJsonArtifact(
		contents,
		'ETL process-lifetime artifact'
	);
	assertExactKeys(parsed, [
		'captureStartTimestampMs',
		'captureStopTimestampMs',
		'etlSha256',
		'lifetimes',
		'processEventEvidenceSha256',
		'targetProcessId',
		'version'
	], 'ETL process-lifetime artifact');
	requiredLiteral(parsed, 'version', 1, 'ETL process-lifetime artifact');
	const captureStartTimestampMs = requiredTimestampMs(
		parsed,
		'captureStartTimestampMs',
		'ETL process-lifetime artifact'
	);
	const captureStopTimestampMs = requiredTimestampMs(
		parsed,
		'captureStopTimestampMs',
		'ETL process-lifetime artifact'
	);
	if (captureStopTimestampMs <= captureStartTimestampMs) {
		throw new TypeError(
			'ETL process-lifetime artifact capture boundaries are not ordered.'
		);
	}
	const etlSha256 = requiredString(
		parsed,
		'etlSha256',
		'ETL process-lifetime artifact',
		64
	);
	assertSha256(etlSha256, 'ETL process-lifetime artifact.etlSha256');
	const processEventEvidenceSha256 = requiredString(
		parsed,
		'processEventEvidenceSha256',
		'ETL process-lifetime artifact',
		64
	);
	assertSha256(
		processEventEvidenceSha256,
		'ETL process-lifetime artifact.processEventEvidenceSha256'
	);
	const targetProcessId = requiredInteger(
		parsed,
		'targetProcessId',
		'ETL process-lifetime artifact',
		1,
		0xffff_ffff
	);
	if (
		!Array.isArray(parsed.lifetimes)
		|| parsed.lifetimes.length < 1
		|| parsed.lifetimes.length > MAX_PROCESS_EVENT_COUNT
	) {
		throw new TypeError('ETL process-lifetime artifact lifetimes are invalid.');
	}
	const lifetimes = parsed.lifetimes.map((value, index) => {
		const label = `ETL process-lifetime artifact.lifetimes[${index}]`;
		if (!isRecord(value)) {
			throw new TypeError(`${label} must be an object.`);
		}
		assertExactKeys(
			value,
			['creationTimeUtcTicks', 'end', 'executableName', 'processId', 'start'],
			label
		);
		const processId = requiredInteger(
			value,
			'processId',
			label,
			1,
			0xffff_ffff
		);
		if (processId !== targetProcessId) {
			throw new TypeError(`${label}.processId does not match the target PID.`);
		}
		const start = parseLifetimeStart(
			value.start,
			`${label}.start`
		);
		const end = parseLifetimeEnd(
			value.end,
			`${label}.end`,
			captureStopTimestampMs
		);
		const startMs = processLifetimeStartMs(start);
		const endMs = processLifetimeEndMs(end);
		if (
			startMs < captureStartTimestampMs
			|| endMs > captureStopTimestampMs
			|| endMs < startMs
		) {
			throw new TypeError(`${label} falls outside the capture boundaries.`);
		}
		return Object.freeze({
			creationTimeUtcTicks: canonicalCreationTimeUtcTicks(
				value.creationTimeUtcTicks,
				`${label}.creationTimeUtcTicks`
			),
			end,
			executableName: canonicalExecutableName(
				value.executableName,
				`${label}.executableName`
			),
			processId,
			start
		});
	});
	const creationTimes = new Set<string>();
	for (let index = 0; index < lifetimes.length; index += 1) {
		const lifetime = lifetimes[index];
		if (lifetime === undefined) continue;
		if (creationTimes.has(lifetime.creationTimeUtcTicks)) {
			throw new TypeError(
				'ETL process-lifetime artifact repeats a creation time.'
			);
		}
		creationTimes.add(lifetime.creationTimeUtcTicks);
		const previous = lifetimes[index - 1];
		if (
			previous !== undefined
			&& processLifetimeStartMs(lifetime.start)
				<= processLifetimeEndMs(previous.end)
		) {
			throw new TypeError(
				'ETL process-lifetime artifact is not ordered and nonoverlapping.'
			);
		}
	}
	return Object.freeze({
		captureStartTimestampMs,
		captureStopTimestampMs,
		etlSha256,
		lifetimes: Object.freeze(lifetimes),
		processEventEvidenceSha256,
		targetProcessId,
		version: 1
	});
}

export function parsePresentMonProcessLifetimeBinding(
	contents: Uint8Array
): PresentMonProcessLifetimeBinding {
	const parsed = parseCanonicalPrettyJsonArtifact(
		contents,
		'PresentMon process-lifetime binding'
	);
	assertExactKeys(parsed, [
		'creationTimeUtcTicks',
		'etlSha256',
		'executableName',
		'executablePath',
		'firstFrameTimestampMs',
		'lastFrameTimestampMs',
		'lifetimeEnd',
		'lifetimeStart',
		'processEventEvidenceSha256',
		'processId',
		'recordCount',
		'streamKey',
		'valid',
		'version'
	], 'PresentMon process-lifetime binding');
	requiredLiteral(parsed, 'version', 1, 'PresentMon process-lifetime binding');
	requiredLiteral(parsed, 'valid', true, 'PresentMon process-lifetime binding');
	const firstFrameTimestampMs = requiredTimestampMs(
		parsed,
		'firstFrameTimestampMs',
		'PresentMon process-lifetime binding'
	);
	const lastFrameTimestampMs = requiredTimestampMs(
		parsed,
		'lastFrameTimestampMs',
		'PresentMon process-lifetime binding'
	);
	if (lastFrameTimestampMs < firstFrameTimestampMs) {
		throw new TypeError(
			'PresentMon process-lifetime binding frame boundaries are not ordered.'
		);
	}
	const lifetimeStart = parseLifetimeStart(
		parsed.lifetimeStart,
		'PresentMon process-lifetime binding.lifetimeStart'
	);
	const lifetimeEnd = parseLifetimeEnd(
		parsed.lifetimeEnd,
		'PresentMon process-lifetime binding.lifetimeEnd'
	);
	if (
		firstFrameTimestampMs < processLifetimeStartMs(lifetimeStart)
		|| lastFrameTimestampMs > processLifetimeEndMs(lifetimeEnd)
	) {
		throw new TypeError(
			'PresentMon process-lifetime binding frames fall outside its lifetime.'
		);
	}
	const etlSha256 = requiredString(
		parsed,
		'etlSha256',
		'PresentMon process-lifetime binding',
		64
	);
	assertSha256(etlSha256, 'PresentMon process-lifetime binding.etlSha256');
	const processEventEvidenceSha256 = requiredString(
		parsed,
		'processEventEvidenceSha256',
		'PresentMon process-lifetime binding',
		64
	);
	assertSha256(
		processEventEvidenceSha256,
		'PresentMon process-lifetime binding.processEventEvidenceSha256'
	);
	const executableName = canonicalExecutableName(
		parsed.executableName,
		'PresentMon process-lifetime binding.executableName'
	);
	const executablePath = requiredString(
		parsed,
		'executablePath',
		'PresentMon process-lifetime binding',
		32_767
	);
	if (!sameExecutableName(executableName, basename(executablePath))) {
		throw new TypeError(
			'PresentMon process-lifetime binding executable path does not match its name.'
		);
	}
	return Object.freeze({
		creationTimeUtcTicks: canonicalCreationTimeUtcTicks(
			parsed.creationTimeUtcTicks,
			'PresentMon process-lifetime binding.creationTimeUtcTicks'
		),
		etlSha256,
		executableName,
		executablePath,
		firstFrameTimestampMs,
		lastFrameTimestampMs,
		lifetimeEnd,
		lifetimeStart,
		processEventEvidenceSha256,
		processId: requiredInteger(
			parsed,
			'processId',
			'PresentMon process-lifetime binding',
			1,
			0xffff_ffff
		),
		recordCount: requiredInteger(
			parsed,
			'recordCount',
			'PresentMon process-lifetime binding',
			1,
			Number.MAX_SAFE_INTEGER
		),
		streamKey: requiredString(
			parsed,
			'streamKey',
			'PresentMon process-lifetime binding',
			32_767
		),
		valid: true,
		version: 1
	});
}

function fileTimeToUnixMs(
	value: string,
	boundary: 'start' | 'stop'
): number {
	const delta = BigInt(value) - FILETIME_UNIX_EPOCH_TICKS;
	const milliseconds = boundary === 'start'
		? delta / 10_000n
		: (delta + 9_999n) / 10_000n;
	if (milliseconds < 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new RangeError('ETL process-event timestamp is outside the safe range.');
	}
	return Number(milliseconds);
}

function samePath(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

function sameExecutableName(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

function processLifetimeStartMs(start: EtlProcessLifetimeStart): number {
	return start.timestampMs;
}

function processLifetimeEndMs(end: EtlProcessLifetimeEnd): number {
	return end.kind === 'etl-process-stop'
		? end.timestampMs
		: end.captureStopTimestampMs;
}

function assertSha256(value: string, label: string): void {
	if (!/^[0-9a-f]{64}$/u.test(value)) {
		throw new TypeError(`${label} must be one lowercase SHA-256 digest.`);
	}
}

function assertIdentityExpectation(
	value: ProcessLifetimeIdentityExpectation,
	label: string
): void {
	if (
		!Number.isInteger(value.processId)
		|| value.processId < 1
		|| value.processId > 0xffff_ffff
	) {
		throw new TypeError(`${label}.processId is invalid.`);
	}
	canonicalCreationTimeUtcTicks(
		value.creationTimeUtcTicks,
		`${label}.creationTimeUtcTicks`
	);
	canonicalExecutableName(value.executableName, `${label}.executableName`);
	if (value.executablePath.length < 1 || value.executablePath.length > 32_767) {
		throw new TypeError(`${label}.executablePath is invalid.`);
	}
}

export function deriveEtlProcessLifetimes(options: {
	acceptedCapture: AcceptedEtlProcessEvidenceIdentity;
	evidence: EtlProcessEventEvidenceArtifact;
	expectedProcess: ProcessLifetimeIdentityExpectation;
	processEventEvidenceSha256: string;
}): EtlProcessLifetimeArtifact {
	assertIdentityExpectation(options.expectedProcess, 'expectedProcess');
	assertSha256(
		options.processEventEvidenceSha256,
		'processEventEvidenceSha256'
	);
	const { acceptedCapture, evidence, expectedProcess } = options;
	if (
		evidence.targetProcessId !== expectedProcess.processId
		|| evidence.etlSha256 !== acceptedCapture.etlSha256
		|| evidence.etlSizeBytes !== acceptedCapture.etlSizeBytes
		|| evidence.etlFileIndex !== acceptedCapture.etlFileIndex
		|| evidence.etlVolumeSerialNumber
			!== acceptedCapture.etlVolumeSerialNumber
		|| !samePath(evidence.etlPath, acceptedCapture.operationalEtlPath)
	) {
		throw new Error(
			'ETL process-event evidence does not identify the accepted ETL and target PID.'
		);
	}
	const captureStartTimestampMs = fileTimeToUnixMs(
		canonicalFileTime(
			acceptedCapture.captureStartFileTimeUtc,
			'acceptedCapture.captureStartFileTimeUtc'
		),
		'start'
	);
	const captureStopTimestampMs = fileTimeToUnixMs(
		canonicalFileTime(
			acceptedCapture.captureStopFileTimeUtc,
			'acceptedCapture.captureStopFileTimeUtc'
		),
		'stop'
	);
	if (captureStopTimestampMs <= captureStartTimestampMs) {
		throw new Error('Accepted ETL capture boundaries are not ordered.');
	}
	const captureStartTicks = BigInt(acceptedCapture.captureStartFileTimeUtc);
	const captureStopTicks = BigInt(acceptedCapture.captureStopFileTimeUtc);
	const groups = new Map<string, {
		starts: EtlProcessStartEventEvidence[];
		stops: EtlProcessStopEventEvidence[];
	}>();
	for (const event of evidence.events) {
		const eventTicks = BigInt(event.eventTimestampFileTimeUtc);
		if (eventTicks < captureStartTicks || eventTicks > captureStopTicks) {
			throw new Error(
				'ETL process event falls outside the native capture boundaries.'
			);
		}
		const group = groups.get(event.creationTimeUtcTicks) ?? {
			starts: [],
			stops: []
		};
		if (event.kind === 'start') group.starts.push(event);
		else group.stops.push(event);
		groups.set(event.creationTimeUtcTicks, group);
	}
	const lifetimes: EtlProcessLifetimeEvidence[] = [];
	for (const [creationTimeUtcTicks, group] of groups) {
		if (group.starts.length > 1 || group.stops.length > 1) {
			throw new Error(
				'ETL process evidence contains duplicate lifetime boundaries.'
			);
		}
		const startEvent = group.starts[0];
		const stopEvent = group.stops[0];
		if (startEvent === undefined) {
			throw new Error(
				'ETL process evidence contains a lifetime without a same-ETL ProcessStart.'
			);
		}
		const start: EtlProcessLifetimeStart = {
			kind: 'etl-process-start',
			timestampMs: fileTimeToUnixMs(
				startEvent.eventTimestampFileTimeUtc,
				'start'
			)
		};
		const end: EtlProcessLifetimeEnd = stopEvent === undefined
			? {
				captureStopTimestampMs,
				kind: 'active-at-capture-stop'
			}
			: {
				kind: 'etl-process-stop',
				timestampMs: fileTimeToUnixMs(
					stopEvent.eventTimestampFileTimeUtc,
					'stop'
				)
			};
		if (processLifetimeEndMs(end) < processLifetimeStartMs(start)) {
			throw new Error('ETL process lifetime ends before it starts.');
		}
		lifetimes.push(Object.freeze({
			creationTimeUtcTicks,
			executableName: startEvent?.executableName
				?? basename(expectedProcess.executablePath),
			processId: expectedProcess.processId,
			start: Object.freeze(start),
			end: Object.freeze(end)
		}));
	}
	if (
		lifetimes.filter(lifetime =>
			lifetime.creationTimeUtcTicks
				=== expectedProcess.creationTimeUtcTicks
		).length !== 1
	) {
		throw new Error(
			'ETL process evidence does not contain exactly one selected process lifetime.'
		);
	}
	lifetimes.sort((left, right) =>
		processLifetimeStartMs(left.start) - processLifetimeStartMs(right.start)
	);
	for (let left = 0; left < lifetimes.length; left += 1) {
		for (let right = left + 1; right < lifetimes.length; right += 1) {
			const earlier = lifetimes[left];
			const later = lifetimes[right];
			if (
			earlier !== undefined
			&& later !== undefined
			&& processLifetimeStartMs(later.start)
				<= processLifetimeEndMs(earlier.end)
			) {
				throw new Error(
					'ETL process evidence contains overlapping same-PID lifetimes.'
				);
			}
		}
	}
	return Object.freeze({
		captureStartTimestampMs,
		captureStopTimestampMs,
		etlSha256: acceptedCapture.etlSha256,
		lifetimes: Object.freeze(lifetimes),
		processEventEvidenceSha256: options.processEventEvidenceSha256,
		targetProcessId: expectedProcess.processId,
		version: 1
	});
}

export function bindSelectedPresentMonFramesToProcessLifetime(options: {
	expectedProcess: ProcessLifetimeIdentityExpectation;
	lifetimeArtifact: EtlProcessLifetimeArtifact;
	stream: PresentMonStreamAnalysis;
}): PresentMonProcessLifetimeBinding {
	assertIdentityExpectation(options.expectedProcess, 'expectedProcess');
	const { expectedProcess, lifetimeArtifact, stream } = options;
	if (
		!stream.valid
		|| stream.processId !== expectedProcess.processId
		|| stream.firstTimestampMs === undefined
		|| stream.lastTimestampMs === undefined
		|| !Number.isFinite(stream.firstTimestampMs)
		|| !Number.isFinite(stream.lastTimestampMs)
		|| stream.firstTimestampMs > stream.lastTimestampMs
		|| !Number.isInteger(stream.recordCount)
		|| stream.recordCount < 1
	) {
		throw new Error(
			'Selected PresentMon stream lacks valid PID-qualified frame bounds.'
		);
	}
	if (
		lifetimeArtifact.targetProcessId !== expectedProcess.processId
		|| lifetimeArtifact.lifetimes.some(
			lifetime => lifetime.processId !== expectedProcess.processId
		)
	) {
		throw new Error(
			'ETL lifetime artifact does not identify the selected process ID.'
		);
	}
	const matches = lifetimeArtifact.lifetimes.filter(
		lifetime => lifetime.creationTimeUtcTicks
			=== expectedProcess.creationTimeUtcTicks
	);
	if (matches.length !== 1) {
		throw new Error(
			'ETL lifetime artifact does not contain exactly one selected process lifetime.'
		);
	}
	const [lifetime] = matches;
	if (lifetime === undefined) {
		throw new Error('Selected ETL process lifetime is unavailable.');
	}
	if (
		!sameExecutableName(
			lifetime.executableName,
			expectedProcess.executableName
		)
		|| !sameExecutableName(
			lifetime.executableName,
			basename(expectedProcess.executablePath)
		)
	) {
		throw new Error(
			'ETL process lifetime executable does not match the sampled process.'
		);
	}
	const lifetimeStartMs = processLifetimeStartMs(lifetime.start);
	const lifetimeEndMs = processLifetimeEndMs(lifetime.end);
	if (
		stream.firstTimestampMs < lifetimeStartMs
		|| stream.lastTimestampMs > lifetimeEndMs
	) {
		throw new Error(
			'Selected PresentMon frames fall outside the creation-qualified process lifetime.'
		);
	}
	for (const other of lifetimeArtifact.lifetimes) {
		if (other === lifetime) continue;
		if (
			stream.firstTimestampMs <= processLifetimeEndMs(other.end)
			&& stream.lastTimestampMs >= processLifetimeStartMs(other.start)
		) {
			throw new Error(
				'Selected PresentMon frames overlap another same-PID lifetime.'
			);
		}
	}
	return Object.freeze({
		creationTimeUtcTicks: expectedProcess.creationTimeUtcTicks,
		etlSha256: lifetimeArtifact.etlSha256,
		executableName: lifetime.executableName,
		executablePath: expectedProcess.executablePath,
		firstFrameTimestampMs: stream.firstTimestampMs,
		lastFrameTimestampMs: stream.lastTimestampMs,
		lifetimeEnd: lifetime.end,
		lifetimeStart: lifetime.start,
		processEventEvidenceSha256:
			lifetimeArtifact.processEventEvidenceSha256,
		processId: expectedProcess.processId,
		recordCount: stream.recordCount,
		streamKey: stream.key,
		valid: true,
		version: 1
	});
}
