import assert from 'node:assert/strict';
import test from 'node:test';
import {
	bindSelectedPresentMonFramesToProcessLifetime,
	deriveEtlProcessLifetimes,
	parseEtlProcessEventEvidence,
	parseEtlProcessLifetimeArtifact,
	parsePresentMonProcessLifetimeBinding,
	type AcceptedEtlProcessEvidenceIdentity,
	type EtlProcessEventEvidenceArtifact,
	type ProcessLifetimeIdentityExpectation
} from '../src/host/etl-process-lifetimes.ts';
import {
	analyzePresentMonCsv,
	type PresentMonStreamAnalysis
} from '../src/host/presentmon-csv.ts';
import { sha256Hex } from '../src/shared/hash.ts';

const DOTNET_FILETIME_EPOCH_OFFSET_TICKS = 504_911_232_000_000_000n;
const FILETIME_UNIX_EPOCH_TICKS = 116_444_736_000_000_000n;
const ETL_SHA256 = '1'.repeat(64);
const EVIDENCE_SHA256 = '2'.repeat(64);
const ETL_PATH = 'C:/runtime-lab/capture.etl';
const PROCESS_ID = 4_242;
const EXECUTABLE_PATH = 'C:/runtime-lab/app.exe';
const CAPTURE_START_MS = Date.parse('2026-08-02T12:00:00.000Z');
const CAPTURE_STOP_MS = Date.parse('2026-08-02T12:00:10.000Z');

function fileTimeFromUnixMs(timestampMs: number): string {
	return (
		BigInt(timestampMs) * 10_000n
		+ FILETIME_UNIX_EPOCH_TICKS
	).toString(10);
}

function creationTicksFromUnixMs(timestampMs: number): string {
	const fileTime = BigInt(fileTimeFromUnixMs(timestampMs));
	const ticks = fileTime + DOTNET_FILETIME_EPOCH_OFFSET_TICKS;
	return (ticks - ticks % 10n).toString(10);
}

const PROCESS_CREATION_MS = CAPTURE_START_MS + 1_000;
const PROCESS_CREATION_TICKS = creationTicksFromUnixMs(PROCESS_CREATION_MS);

function acceptedCapture(): AcceptedEtlProcessEvidenceIdentity {
	return {
		captureStartFileTimeUtc: fileTimeFromUnixMs(CAPTURE_START_MS),
		captureStopFileTimeUtc: fileTimeFromUnixMs(CAPTURE_STOP_MS),
		etlFileIndex: '0000000000000042',
		etlSha256: ETL_SHA256,
		etlSizeBytes: 4096,
		etlVolumeSerialNumber: '123456789',
		operationalEtlPath: ETL_PATH
	};
}

function expectedProcess(
	overrides: Partial<ProcessLifetimeIdentityExpectation> = {}
): ProcessLifetimeIdentityExpectation {
	return {
		creationTimeUtcTicks: PROCESS_CREATION_TICKS,
		executableName: 'app.exe',
		executablePath: EXECUTABLE_PATH,
		processId: PROCESS_ID,
		...overrides
	};
}

function startEvent(options: {
	creationMs?: number;
	eventMs: number;
	executableName?: string;
	sequence: number;
}): Record<string, unknown> {
	const creationMs = options.creationMs ?? PROCESS_CREATION_MS;
	return {
		kind: 'start',
		sequence: options.sequence,
		processId: PROCESS_ID,
		eventVersion: 3,
		eventTimestampFileTimeUtc: fileTimeFromUnixMs(options.eventMs),
		createTimeFileTimeUtc: fileTimeFromUnixMs(creationMs),
		creationTimeUtcTicks: creationTicksFromUnixMs(creationMs),
		parentProcessId: 100,
		executableName: options.executableName ?? 'app.exe'
	};
}

function stopEvent(options: {
	creationMs?: number;
	eventMs: number;
	sequence: number;
}): Record<string, unknown> {
	const creationMs = options.creationMs ?? PROCESS_CREATION_MS;
	return {
		kind: 'stop',
		sequence: options.sequence,
		processId: PROCESS_ID,
		eventVersion: 2,
		eventTimestampFileTimeUtc: fileTimeFromUnixMs(options.eventMs),
		createTimeFileTimeUtc: fileTimeFromUnixMs(creationMs),
		creationTimeUtcTicks: creationTicksFromUnixMs(creationMs),
		exitTimeFileTimeUtc: fileTimeFromUnixMs(options.eventMs)
	};
}

function evidenceBytes(events: readonly Record<string, unknown>[]): Buffer {
	return Buffer.from(`${JSON.stringify({
		version: 2,
		phase: 'etl-process-events',
		etlPath: ETL_PATH,
		etlVolumeSerialNumber: '123456789',
		etlFileIndex: '0000000000000042',
		etlSizeBytes: 4096,
		etlSha256: ETL_SHA256,
		targetProcessId: PROCESS_ID,
		inspectionInvocation: {
			candidateId: 'candidate-a',
			etlFileIndex: '0000000000000042',
			etlPath: ETL_PATH,
			etlSha256: ETL_SHA256,
			etlSizeBytes: 4096,
			etlVolumeSerialNumber: '123456789',
			outputArtifactRelativePath:
				'captures/etl-process-events.json',
			role: 'etl-process-inspector',
			runId: 'run-a',
			targetProcessId: PROCESS_ID
		},
		inspectorProcessIdentity: {
			creationTimeUtcTicks: creationTicksFromUnixMs(
				CAPTURE_START_MS - 1_000
			),
			executable: {
				fileIdHex: '0000000000000001',
				finalPath: 'C:/runtime-lab/WokEtlRecorder.exe',
				sha256: '3'.repeat(64),
				sizeBytes: 8192,
				volumeSerialNumberHex: '00000001'
			},
			executablePath: 'C:/runtime-lab/WokEtlRecorder.exe',
			processId: 9001
		},
		events
	})}\r\n`, 'utf8');
}

function parseEvidence(
	events: readonly Record<string, unknown>[]
): EtlProcessEventEvidenceArtifact {
	return parseEtlProcessEventEvidence(evidenceBytes(events));
}

function stream(
	firstTimestampMs: number,
	lastTimestampMs: number
): PresentMonStreamAnalysis {
	const first = new Date(firstTimestampMs).toISOString().replace('.000Z', '.000000000Z');
	const last = new Date(lastTimestampMs).toISOString().replace('.000Z', '.000000000Z');
	const csv = [
		'Application,ProcessID,SwapChainAddress,CPUStartDateTime,FrameTime,DisplayedTime',
		`app.exe,${PROCESS_ID},0x1,${first},10,10`,
		`app.exe,${PROCESS_ID},0x1,${last},10,10`
	].join('\n');
	const analysis = analyzePresentMonCsv(csv, {
		minimumFrameSamples: 1,
		warmupMs: 0
	});
	assert.equal(analysis.valid, true);
	const selected = analysis.streams[0];
	assert.ok(selected);
	return selected;
}

function derive(options: {
	events: readonly Record<string, unknown>[];
	expected?: ProcessLifetimeIdentityExpectation;
}) {
	return deriveEtlProcessLifetimes({
		acceptedCapture: acceptedCapture(),
		evidence: parseEvidence(options.events),
		expectedProcess: options.expected ?? expectedProcess(),
		processEventEvidenceSha256: EVIDENCE_SHA256
	});
}

test('process-event parser accepts exact same-ETL start and stop evidence', () => {
	const contents = evidenceBytes([
		startEvent({ eventMs: PROCESS_CREATION_MS, sequence: 0 }),
		stopEvent({ eventMs: CAPTURE_START_MS + 8_000, sequence: 1 })
	]);
	const evidence = parseEtlProcessEventEvidence(contents);
	assert.equal(evidence.targetProcessId, PROCESS_ID);
	assert.equal(evidence.etlSha256, ETL_SHA256);
	assert.equal(evidence.events.length, 2);
	assert.equal(evidence.events[0]?.kind, 'start');
	assert.equal(evidence.events[1]?.kind, 'stop');
	assert.equal(sha256Hex(contents).length, 64);
});

test('selected frames bind to one creation-qualified lifetime active at capture stop', () => {
	const lifetimeArtifact = derive({
		events: [startEvent({ eventMs: PROCESS_CREATION_MS, sequence: 0 })]
	});
	const binding = bindSelectedPresentMonFramesToProcessLifetime({
		expectedProcess: expectedProcess(),
		lifetimeArtifact,
		stream: stream(
			CAPTURE_START_MS + 2_000,
			CAPTURE_START_MS + 7_000
		)
	});
	assert.equal(binding.valid, true);
	assert.equal(binding.creationTimeUtcTicks, PROCESS_CREATION_TICKS);
	assert.equal(binding.lifetimeStart.kind, 'etl-process-start');
	assert.equal(binding.lifetimeEnd.kind, 'active-at-capture-stop');
	assert.equal(binding.etlSha256, ETL_SHA256);
	assert.equal(binding.processEventEvidenceSha256, EVIDENCE_SHA256);
});

test('selected frames bind within an exact stopped lifetime', () => {
	const lifetimeArtifact = derive({
		events: [
			startEvent({ eventMs: PROCESS_CREATION_MS, sequence: 0 }),
			stopEvent({ eventMs: CAPTURE_START_MS + 8_000, sequence: 1 })
		]
	});
	const binding = bindSelectedPresentMonFramesToProcessLifetime({
		expectedProcess: expectedProcess(),
		lifetimeArtifact,
		stream: stream(
			CAPTURE_START_MS + 2_000,
			CAPTURE_START_MS + 7_000
		)
	});
	assert.equal(binding.lifetimeEnd.kind, 'etl-process-stop');
});

test('candidate root still requires one same-ETL ProcessStart', () => {
	assert.throws(
		() => derive({ events: [] }),
		/exactly one selected process lifetime/iu
	);
});

test('missing process events fail for a non-root selected process', () => {
	assert.throws(
		() => derive({ events: [] }),
		/exactly one selected process lifetime/iu
	);
});

test('creation-time mismatch fails closed', () => {
	const lifetimeArtifact = derive({
		events: [startEvent({ eventMs: PROCESS_CREATION_MS, sequence: 0 })]
	});
	assert.throws(
		() => bindSelectedPresentMonFramesToProcessLifetime({
			expectedProcess: expectedProcess({
				creationTimeUtcTicks: creationTicksFromUnixMs(
					PROCESS_CREATION_MS + 1
				)
			}),
			lifetimeArtifact,
			stream: stream(
				CAPTURE_START_MS + 2_000,
				CAPTURE_START_MS + 7_000
			)
		}),
		/exactly one selected process lifetime/iu
	);
});

test('duplicate process starts fail closed', () => {
	assert.throws(
		() => derive({
			events: [
				startEvent({ eventMs: PROCESS_CREATION_MS, sequence: 0 }),
				startEvent({ eventMs: PROCESS_CREATION_MS + 1, sequence: 1 })
			]
		}),
		/duplicate lifetime boundaries/iu
	);
});

test('overlapping PID-reuse lifetimes fail closed', () => {
	const secondCreationMs = CAPTURE_START_MS + 3_000;
	assert.throws(
		() => derive({
			events: [
				startEvent({ eventMs: PROCESS_CREATION_MS, sequence: 0 }),
				startEvent({
					creationMs: secondCreationMs,
					eventMs: secondCreationMs,
					sequence: 1
				}),
				stopEvent({ eventMs: CAPTURE_START_MS + 5_000, sequence: 2 })
			]
		}),
		/overlapping same-PID lifetimes/iu
	);
});

test('frames before process start fail closed', () => {
	const lifetimeArtifact = derive({
		events: [startEvent({ eventMs: PROCESS_CREATION_MS, sequence: 0 })]
	});
	assert.throws(
		() => bindSelectedPresentMonFramesToProcessLifetime({
			expectedProcess: expectedProcess(),
			lifetimeArtifact,
			stream: stream(
				CAPTURE_START_MS + 500,
				CAPTURE_START_MS + 2_000
			)
		}),
		/outside the creation-qualified process lifetime/iu
	);
});

test('frames after process stop fail closed', () => {
	const lifetimeArtifact = derive({
		events: [
			startEvent({ eventMs: PROCESS_CREATION_MS, sequence: 0 }),
			stopEvent({ eventMs: CAPTURE_START_MS + 5_000, sequence: 1 })
		]
	});
	assert.throws(
		() => bindSelectedPresentMonFramesToProcessLifetime({
			expectedProcess: expectedProcess(),
			lifetimeArtifact,
			stream: stream(
				CAPTURE_START_MS + 2_000,
				CAPTURE_START_MS + 6_000
			)
		}),
		/outside the creation-qualified process lifetime/iu
	);
});

test('stop-only evidence is rejected without a same-ETL ProcessStart', () => {
	assert.throws(
		() => derive({
			events: [
				stopEvent({ eventMs: CAPTURE_START_MS + 5_000, sequence: 0 })
			]
		}),
		/without a same-ETL ProcessStart/iu
	);
});

test('accepted ETL identity mismatch fails closed', () => {
	const evidence = parseEvidence([
		startEvent({ eventMs: PROCESS_CREATION_MS, sequence: 0 })
	]);
	assert.throws(
		() => deriveEtlProcessLifetimes({
			acceptedCapture: {
				...acceptedCapture(),
				etlSha256: 'f'.repeat(64)
			},
			evidence,
			expectedProcess: expectedProcess(),
			processEventEvidenceSha256: EVIDENCE_SHA256
		}),
		/does not identify the accepted ETL/iu
	);
});

test('process-event parser rejects noncanonical and internally inconsistent evidence', () => {
	const valid = JSON.parse(
		evidenceBytes([
			startEvent({ eventMs: PROCESS_CREATION_MS, sequence: 0 })
		]).toString('utf8')
	) as { events: Array<Record<string, unknown>> };
	assert.throws(
		() => parseEtlProcessEventEvidence(
			Buffer.from(`${JSON.stringify(valid)}\n`, 'utf8')
		),
		/canonical UTF-8 CRLF framing/iu
	);
	if (valid.events[0] !== undefined) {
		valid.events[0].creationTimeUtcTicks = creationTicksFromUnixMs(
			PROCESS_CREATION_MS + 1
		);
	}
	assert.throws(
		() => parseEtlProcessEventEvidence(
			Buffer.from(`${JSON.stringify(valid)}\r\n`, 'utf8')
		),
		/does not match its FILETIME evidence/iu
	);
});

test('process-event parser rejects forged inspector and invocation bindings', () => {
	const valid = JSON.parse(
		evidenceBytes([
			startEvent({ eventMs: PROCESS_CREATION_MS, sequence: 0 })
		]).toString('utf8')
	) as {
		etlSha256: string;
		inspectionInvocation: {
			etlSha256: string;
			outputArtifactRelativePath: string;
		};
		inspectorProcessIdentity: {
			creationTimeUtcTicks: string;
			executable: {
				fileIdHex: string;
				unexpected?: boolean;
			};
		};
	};
	const parseMutation = (mutation: (artifact: typeof valid) => void) => {
		const artifact = structuredClone(valid);
		mutation(artifact);
		return () => parseEtlProcessEventEvidence(
			Buffer.from(`${JSON.stringify(artifact)}\r\n`, 'utf8')
		);
	};

	assert.throws(
		parseMutation(artifact => {
			artifact.inspectionInvocation.etlSha256 = 'f'.repeat(64);
		}),
		/invocation does not identify its root evidence/iu
	);
	assert.throws(
		parseMutation(artifact => {
			artifact.inspectorProcessIdentity.creationTimeUtcTicks =
				(BigInt(
					artifact.inspectorProcessIdentity.creationTimeUtcTicks
				) + 1n).toString(10);
		}),
		/not a canonical process creation time/iu
	);
	assert.throws(
		parseMutation(artifact => {
			artifact.inspectorProcessIdentity.executable.fileIdHex =
				'0'.repeat(32);
		}),
		/fileIdHex is not canonical lowercase hexadecimal/iu
	);
	assert.throws(
		parseMutation(artifact => {
			artifact.inspectorProcessIdentity.executable.unexpected = true;
		}),
		/inspectorProcessIdentity\.executable does not match the closed schema/iu
	);
	assert.throws(
		parseMutation(artifact => {
			artifact.inspectionInvocation.outputArtifactRelativePath =
				'captures/copied-process-events.json';
		}),
		/outputArtifactRelativePath must equal captures\/etl-process-events\.json/iu
	);
});

test('derived lifetime and binding artifacts round-trip through closed parsers', () => {
	const lifetimeArtifact = derive({
		events: [startEvent({ eventMs: PROCESS_CREATION_MS, sequence: 0 })]
	});
	const binding = bindSelectedPresentMonFramesToProcessLifetime({
		expectedProcess: expectedProcess(),
		lifetimeArtifact,
		stream: stream(
			CAPTURE_START_MS + 2_000,
			CAPTURE_START_MS + 7_000
		)
	});
	const lifetimeBytes = Buffer.from(
		`${JSON.stringify(lifetimeArtifact, null, '\t')}\n`,
		'utf8'
	);
	const bindingBytes = Buffer.from(
		`${JSON.stringify(binding, null, '\t')}\n`,
		'utf8'
	);
	assert.deepEqual(
		parseEtlProcessLifetimeArtifact(lifetimeBytes),
		lifetimeArtifact
	);
	assert.deepEqual(
		parsePresentMonProcessLifetimeBinding(bindingBytes),
		binding
	);
});

test('derived artifact parsers reject noncanonical and contradictory evidence', () => {
	const lifetimeArtifact = derive({
		events: [startEvent({ eventMs: PROCESS_CREATION_MS, sequence: 0 })]
	});
	const binding = bindSelectedPresentMonFramesToProcessLifetime({
		expectedProcess: expectedProcess(),
		lifetimeArtifact,
		stream: stream(
			CAPTURE_START_MS + 2_000,
			CAPTURE_START_MS + 7_000
		)
	});
	assert.throws(
		() => parseEtlProcessLifetimeArtifact(
			Buffer.from(JSON.stringify(lifetimeArtifact), 'utf8')
		),
		/canonical UTF-8 LF framing/iu
	);
	assert.throws(
		() => parseEtlProcessLifetimeArtifact(
			Buffer.from(`${JSON.stringify({
				...lifetimeArtifact,
				unexpected: true
			}, null, '\t')}\n`, 'utf8')
		),
		/closed schema/iu
	);
	assert.throws(
		() => parsePresentMonProcessLifetimeBinding(
			Buffer.from(`${JSON.stringify({
				...binding,
				lastFrameTimestampMs: CAPTURE_STOP_MS + 1
			}, null, '\t')}\n`, 'utf8')
		),
		/frames fall outside its lifetime/iu
	);
});
