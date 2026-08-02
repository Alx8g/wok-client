import assert from 'node:assert/strict';
import test from 'node:test';
import {
	acceptEtlRecorderPair,
	assessEtlRecorderPair,
	assessEtlRecorderReady,
	assessEtlRecorderStatus,
	assessOfflinePresentMonReplay,
	buildEtlProcessEventInspectionArguments,
	buildEtlRecorderLaunchArguments,
	buildOfflinePresentMonArguments,
	captureFileTimeUtcToUnixMs,
	parseEtlRecorderReadySidecar,
	parseEtlRecorderStatusSidecar,
	type EtlRecorderExpectedIdentity,
	type OfflinePresentMonReplayEvidence
} from '../src/host/presentmon-etl.ts';
import { sha256Hex } from '../src/shared/hash.ts';

const ETL_PATH = String.raw`C:\runtime-lab\run-a\capture.etl`;
const OPERATIONAL_ETL_PATH = String.raw`\\?\Volume{11111111-1111-4111-8111-111111111111}\runtime-lab\run-a\capture.etl`;
const READY_PATH = String.raw`C:\runtime-lab\run-a\recorder-ready.json`;
const STATUS_PATH = String.raw`C:\runtime-lab\run-a\recorder-status.json`;
const CSV_PATH = String.raw`C:\runtime-lab\run-a\presentmon.csv`;
const SESSION_NAME = 'WOKRuntimeLabFile-run-a-00000000-0000-4000-8000-000000000000';
const ETL_VOLUME_SERIAL_NUMBER = '305419896';
const ETL_FILE_INDEX = '0123456789abcdef';
const CAPTURE_START_FILETIME_UTC =
	'134300160000001234';
const CAPTURE_STOP_FILETIME_UTC =
	'134300160350001234';
const ETL_SHA256 = 'a'.repeat(64);
const PRESENTMON_V2_REPLAY_HEADER = [
	'Application',
	'ProcessID',
	'SwapChainAddress',
	'PresentRuntime',
	'SyncInterval',
	'PresentFlags',
	'AllowsTearing',
	'PresentMode',
	'CPUStartDateTime',
	'FrameTime',
	'CPUBusy',
	'CPUWait',
	'DisplayLatency',
	'DisplayedTime',
	'AnimationError',
	'AnimationTime',
	'MsFlipDelay'
].join(',');
const VALID_REPLAY_CSV = [
	PRESENTMON_V2_REPLAY_HEADER,
	'wok-electron-44.exe,42424,0x1,DXGI,0,0,1,Hardware: Independent Flip,2026-08-01 12:00:00.000000000,8.0000,6.0000,2.0000,1.0000,8.0000,NA,100.0000,NA',
	'wok-electron-44.exe,42424,0x1,DXGI,0,0,1,Hardware: Independent Flip,2026-08-01 12:00:00.008000000,8.0000,6.0000,2.0000,1.0000,8.0000,NA,108.0000,NA',
	''
].join('\r\n');
function replayCsvBytes(csv: string): Buffer {
	return Buffer.from(csv, 'utf8');
}

const VALID_REPLAY_BYTES = replayCsvBytes(VALID_REPLAY_CSV);

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		queryStatus: 0,
		bufferSizeKiB: 64,
		minimumBuffers: 256,
		maximumBuffers: 1024,
		numberOfBuffers: 256,
		freeBuffers: 255,
		eventsLost: 0,
		buffersWritten: 0,
		logBuffersLost: 0,
		realTimeBuffersLost: 0,
		...overrides
	};
}

function readySidecar(overrides: Record<string, unknown> = {}): Buffer {
	return Buffer.from(JSON.stringify({
		version: 5,
		phase: 'ready',
		captureStartFileTimeUtc:
			CAPTURE_START_FILETIME_UTC,
		sessionName: SESSION_NAME,
		etlPath: ETL_PATH,
		operationalEtlPath: OPERATIONAL_ETL_PATH,
		etlVolumeSerialNumber: ETL_VOLUME_SERIAL_NUMBER,
		etlFileIndex: ETL_FILE_INDEX,
		etlIdentityVerifiedForCapture: true,
		durationMs: 35_000,
		filterEventIds: true,
		processEventsRequired: true,
		processEventsEnabled: true,
		processRundownRequested: false,
		isWin11OrGreater: true,
		requested: {
			bufferSizeKiB: 64,
			minimumBuffers: 256,
			maximumBuffers: 1024,
			flushTimerSeconds: 0
		},
		effective: snapshot(),
		...overrides
	}));
}

function statusSidecar(overrides: Record<string, unknown> = {}): Buffer {
	return Buffer.from(JSON.stringify({
		version: 5,
		phase: 'completed',
		valid: true,
		captureStartFileTimeUtc:
			CAPTURE_START_FILETIME_UTC,
		captureStopFileTimeUtc:
			CAPTURE_STOP_FILETIME_UTC,
		sessionName: SESSION_NAME,
		etlPath: ETL_PATH,
		operationalEtlPath: OPERATIONAL_ETL_PATH,
		etlVolumeSerialNumber: ETL_VOLUME_SERIAL_NUMBER,
		etlFileIndex: ETL_FILE_INDEX,
		etlIdentityVerifiedForCapture: true,
		etlIdentityVerifiedAfterStop: true,
		durationMs: 35_000,
		filterEventIds: true,
		processEventsRequired: true,
		processEventsEnabled: true,
		processRundownRequested: false,
		startStatus: 0,
		providerStatus: 0,
		initial: snapshot(),
		waitStatus: 258,
		beforeStop: snapshot({ buffersWritten: 100 }),
		stopStatus: 0,
		cleanupStopStatus: 0,
		stopAttemptStatuses: [0],
		etlFinalized: true,
		stopped: snapshot({ buffersWritten: 101 }),
		etlExists: true,
		etlSizeBytes: 12_345_678,
		etlSha256: ETL_SHA256,
		etlReadLease:
			'held-until-controller-release',
		...overrides
	}));
}

function expectedIdentity(): EtlRecorderExpectedIdentity {
	return {
		sessionName: SESSION_NAME,
		etlPath: ETL_PATH,
		durationMs: 35_000
	};
}

function acceptedCapture() {
	return acceptEtlRecorderPair(
		parseEtlRecorderReadySidecar(readySidecar()),
		parseEtlRecorderStatusSidecar(statusSidecar()),
		expectedIdentity()
	);
}

function replayEvidence(overrides: Partial<OfflinePresentMonReplayEvidence> = {}): OfflinePresentMonReplayEvidence {
	const outputContents = Object.hasOwn(
		overrides,
		'outputContents'
	)
		? overrides.outputContents
		: VALID_REPLAY_BYTES;
	const outputSha256 = outputContents === undefined
		? undefined
		: sha256Hex(outputContents);
	const outputSizeBytes = outputContents?.byteLength ?? 0;
	return {
		exitCode: 0,
		outputContents,
		outputExistedBefore: false,
		outputExistsAfter: true,
		outputIdentityAfterRead: {
			fileIndex: '1111111111111111',
			volumeSerialNumber: ETL_VOLUME_SERIAL_NUMBER
		},
		outputIdentityAtOpen: {
			fileIndex: '1111111111111111',
			volumeSerialNumber: ETL_VOLUME_SERIAL_NUMBER
		},
		outputPath: CSV_PATH,
		outputSha256AfterRead: outputSha256,
		outputSizeBytesAfterRead: outputSizeBytes,
		outputSizeBytesAtOpen: outputSizeBytes,
		stderr: '',
		stderrComplete: true,
		stdoutByteLimitExceeded: false,
		stdoutComplete: true,
		stdoutSha256:
			outputSha256 ?? sha256Hex(Buffer.alloc(0)),
		stdoutSizeBytes: outputSizeBytes,
		terminatedByController: false,
		...overrides
	};
}

function valueAfter(args: readonly string[], option: string): string | undefined {
	const index = args.indexOf(option);
	return index === -1 ? undefined : args[index + 1];
}

test('ETL recorder launch uses fresh same-parent immutable artifact identities', () => {
	const options = {
		durationMs: 35_000,
		etlPath: ETL_PATH,
		readyPath: READY_PATH,
		runId: 'run-a',
		statusPath: STATUS_PATH
	};
	const first = buildEtlRecorderLaunchArguments(options);
	const second = buildEtlRecorderLaunchArguments(options);

	assert.notEqual(first.sessionName.toLowerCase(), second.sessionName.toLowerCase());
	assert.match(first.sessionName, /^WOKRuntimeLabFile-run-a-[0-9a-f-]{36}$/u);
	assert.equal(valueAfter(first.args, '--session-name'), first.sessionName);
	assert.equal(valueAfter(first.args, '--etl-file'), ETL_PATH);
	assert.equal(valueAfter(first.args, '--ready-file'), READY_PATH);
	assert.equal(valueAfter(first.args, '--status-file'), STATUS_PATH);
	assert.equal(valueAfter(first.args, '--duration-ms'), '35000');
	assert.match(first.releaseToken, /^[0-9a-f]{32}$/u);
	assert.equal(
		valueAfter(first.args, '--release-token'),
		first.releaseToken
	);
	assert.notEqual(first.releaseToken, second.releaseToken);
});

test('offline PresentMon replays the accepted operational ETL for one exact process ID', () => {
	const launch = buildOfflinePresentMonArguments({
		acceptedCapture: acceptedCapture(),
		outputCsvPath: CSV_PATH,
		targetProcessId: 42_424
	});

	assert.equal(valueAfter(launch.args, '--etl_file'), OPERATIONAL_ETL_PATH);
	assert.equal(valueAfter(launch.args, '--process_id'), '42424');
	assert.ok(!launch.args.includes('--process_name'));
	assert.ok(launch.args.includes('--output_stdout'));
	assert.ok(!launch.args.includes('--output_file'));
	assert.ok(launch.args.includes('--date_time'));
	assert.ok(launch.args.includes('--v2_metrics'));
	assert.ok(launch.args.includes('--no_console_stats'));
	assert.ok(launch.args.includes('--no_track_gpu'));
	assert.ok(launch.args.includes('--no_track_input'));
	assert.equal(valueAfter(launch.args, '--set_circular_buffer_size'), '16384');
	assert.ok(!launch.args.includes('--timed'));
	assert.ok(!launch.args.includes('--terminate_after_timed'));
	assert.ok(!launch.args.includes('--terminate_on_proc_exit'));
	assert.ok(!launch.args.includes('--session_name'));
});

test('offline PresentMon process-name replay uses one executable basename for Job-bounded discovery', () => {
	const launch = buildOfflinePresentMonArguments({
		acceptedCapture: acceptedCapture(),
		outputCsvPath: CSV_PATH,
		targetProcessName: 'wok-electron-44.exe'
	});

	assert.equal(valueAfter(launch.args, '--process_name'), 'wok-electron-44.exe');
	assert.ok(!launch.args.includes('--process_id'));
});

test('ETL process inspection binds exact accepted bytes and target PID', () => {
	const launch = buildEtlProcessEventInspectionArguments({
		acceptedCapture: acceptedCapture(),
		candidateId: 'electron-44',
		runId: 'run-a',
		targetProcessId: 42_424
	});

	assert.equal(launch.etlPath, OPERATIONAL_ETL_PATH);
	assert.equal(launch.targetProcessId, 42_424);
	assert.deepEqual(launch.args, [
		'--inspect-etl', OPERATIONAL_ETL_PATH,
		'--expected-etl-sha256', ETL_SHA256,
		'--expected-etl-size-bytes', '12345678',
		'--expected-etl-file-index', ETL_FILE_INDEX,
		'--expected-etl-volume-serial-number', ETL_VOLUME_SERIAL_NUMBER,
		'--target-process-id', '42424',
		'--inspection-run-id', 'run-a',
		'--inspection-candidate-id', 'electron-44'
	]);
	assert.deepEqual(launch.invocation, {
		candidateId: 'electron-44',
		etlFileIndex: ETL_FILE_INDEX,
		etlPath: OPERATIONAL_ETL_PATH,
		etlSha256: ETL_SHA256,
		etlSizeBytes: 12_345_678,
		etlVolumeSerialNumber: ETL_VOLUME_SERIAL_NUMBER,
		outputArtifactRelativePath: 'captures/etl-process-events.json',
		role: 'etl-process-inspector',
		runId: 'run-a',
		targetProcessId: 42_424
	});
});

test('ETL process inspection rejects forged captures and invalid target PIDs', () => {
	const accepted = acceptedCapture();
	assert.throws(
		() => buildEtlProcessEventInspectionArguments({
			acceptedCapture: { ...accepted },
			candidateId: 'electron-44',
			runId: 'run-a',
			targetProcessId: 42_424
		}),
		/acceptEtlRecorderPair/u
	);
	for (const targetProcessId of [0, -1, 1.5, 0x1_0000_0000]) {
		assert.throws(
			() => buildEtlProcessEventInspectionArguments({
				acceptedCapture: accepted,
				candidateId: 'electron-44',
				runId: 'run-a',
				targetProcessId
			}),
			/positive uint32/u
		);
	}
	for (const [candidateId, runId] of [
		['bad/candidate', 'run-a'],
		['electron-44', 'bad/run'],
		['', 'run-a'],
		['electron-44', '']
	] as const) {
		assert.throws(
			() => buildEtlProcessEventInspectionArguments({
				acceptedCapture: accepted,
				candidateId,
				runId,
				targetProcessId: 42_424
			}),
			/valid runtime-lab identifier/u
		);
	}
});

test('schema-v5 sidecars bind one immutable zero-loss capture', () => {
	const ready = parseEtlRecorderReadySidecar(readySidecar());
	const status = parseEtlRecorderStatusSidecar(statusSidecar());

	assert.equal(ready.version, 5);
	assert.equal(ready.processEventsRequired, true);
	assert.equal(ready.processEventsEnabled, true);
	assert.equal(ready.processRundownRequested, false);
	assert.equal(
		ready.captureStartFileTimeUtc,
		CAPTURE_START_FILETIME_UTC
	);
	assert.equal(ready.operationalEtlPath, OPERATIONAL_ETL_PATH);
	assert.equal(ready.etlVolumeSerialNumber, ETL_VOLUME_SERIAL_NUMBER);
	assert.equal(ready.etlFileIndex, ETL_FILE_INDEX);
	assert.equal(status.etlIdentityVerifiedAfterStop, true);
	assert.equal(status.etlSha256, ETL_SHA256);
	assert.equal(
		status.etlReadLease,
		'held-until-controller-release'
	);
	assert.deepEqual(assessEtlRecorderReady(ready, expectedIdentity()), {
		reasons: [],
		valid: true
	});
	assert.deepEqual(assessEtlRecorderStatus(status, expectedIdentity()), {
		reasons: [],
		valid: true
	});
	assert.deepEqual(assessEtlRecorderPair(ready, status, expectedIdentity()), {
		reasons: [],
		valid: true
	});
	const accepted = acceptEtlRecorderPair(
		ready,
		status,
		expectedIdentity()
	);
	assert.equal(
		accepted.captureStartFileTimeUtc,
		CAPTURE_START_FILETIME_UTC
	);
	assert.equal(
		accepted.captureStopFileTimeUtc,
		CAPTURE_STOP_FILETIME_UTC
	);
	assert.equal(accepted.etlSha256, ETL_SHA256);
	assert.equal(
		accepted.etlReadLease,
		'held-until-controller-release'
	);
});

test('recorder readiness requires canonical bounded file-mode buffering', () => {
	const ready = parseEtlRecorderReadySidecar(readySidecar({
		requested: {
			bufferSizeKiB: 1024,
			minimumBuffers: 256,
			maximumBuffers: 512,
			flushTimerSeconds: 1
		}
	}));

	assert.deepEqual(
		assessEtlRecorderReady(ready, expectedIdentity()),
		{
			reasons: [
				'requested-buffer-size-mismatch',
				'requested-maximum-buffers-mismatch',
				'requested-flush-timer-mismatch',
				'effective-buffer-size-too-small'
			],
			valid: false
		}
	);
});

test('recorder evidence rejects full-system process rundown requests', () => {
	const ready = parseEtlRecorderReadySidecar(
		readySidecar({ processRundownRequested: true })
	);
	const status = parseEtlRecorderStatusSidecar(
		statusSidecar({ processRundownRequested: true })
	);

	assert.deepEqual(
		assessEtlRecorderReady(ready, expectedIdentity()),
		{ reasons: ['process-rundown-requested'], valid: false }
	);
	assert.ok(
		assessEtlRecorderStatus(status, expectedIdentity())
			.reasons.includes('process-rundown-requested')
	);
	assert.throws(
		() => acceptEtlRecorderPair(ready, status, expectedIdentity()),
		/process-rundown-requested/u
	);
});

test('capture FILETIME conversion floors starts and ceils stops', () => {
	assert.equal(
		captureFileTimeUtcToUnixMs(
			'116444736000019999',
			'start'
		),
		1
	);
	assert.equal(
		captureFileTimeUtcToUnixMs(
			'116444736000019999',
			'stop'
		),
		2
	);
	assert.throws(
		() => captureFileTimeUtcToUnixMs(
			'116444735999999999',
			'start'
		),
		/at or after the Unix epoch/u
	);
});

test('completion assessment requires ordered native boundaries, ETL hash, and held lease', () => {
	const invalid = parseEtlRecorderStatusSidecar(
		statusSidecar({
			captureStopFileTimeUtc:
				CAPTURE_START_FILETIME_UTC,
			etlReadLease: 'unavailable',
			etlSha256: '0'.repeat(64)
		})
	);
	const assessment = assessEtlRecorderStatus(
		invalid,
		expectedIdentity()
	);
	assert.equal(assessment.valid, false);
	assert.ok(
		assessment.reasons.includes(
			'capture-boundary-order-invalid'
		)
	);
	assert.ok(
		assessment.reasons.includes(
			'etl-sha256-unavailable'
		)
	);
	assert.ok(
		assessment.reasons.includes(
			'etl-read-lease-unavailable'
		)
	);
});

test('ready/status pair requires one exact native capture start', () => {
	const ready = parseEtlRecorderReadySidecar(
		readySidecar()
	);
	const status = parseEtlRecorderStatusSidecar(
		statusSidecar({
			captureStartFileTimeUtc:
				'134300160000001235'
		})
	);
	const assessment = assessEtlRecorderPair(
		ready,
		status,
		expectedIdentity()
	);
	assert.equal(assessment.valid, false);
	assert.ok(
		assessment.reasons.includes(
			'ready-status-capture-start-mismatch'
		)
	);
});

test('completion assessment rejects every recorder-side loss counter', () => {
	const status = parseEtlRecorderStatusSidecar(statusSidecar({
		beforeStop: snapshot({
			eventsLost: 3,
			logBuffersLost: 2,
			realTimeBuffersLost: 1
		})
	}));
	const assessment = assessEtlRecorderStatus(status, expectedIdentity());

	assert.equal(assessment.valid, false);
	assert.ok(assessment.reasons.includes('before-stop-events-lost:3'));
	assert.ok(assessment.reasons.includes('before-stop-log-buffers-lost:2'));
	assert.ok(assessment.reasons.includes('before-stop-realtime-buffers-lost:1'));
});

test('completion assessment rejects missing identity, finalization, and ETL evidence', () => {
	const status = parseEtlRecorderStatusSidecar(statusSidecar({
		valid: false,
		etlIdentityVerifiedForCapture: false,
		etlIdentityVerifiedAfterStop: false,
		stopped: snapshot({ queryStatus: 5 }),
		etlFinalized: false,
		etlExists: false,
		etlSizeBytes: 0
	}));
	const assessment = assessEtlRecorderStatus(status, expectedIdentity());

	assert.equal(assessment.valid, false);
	assert.ok(assessment.reasons.includes('etl-identity-not-verified-for-capture'));
	assert.ok(assessment.reasons.includes('etl-identity-not-verified-after-stop'));
	assert.ok(assessment.reasons.includes('stopped-query-status:5'));
	assert.ok(assessment.reasons.includes('etl-not-finalized'));
	assert.ok(assessment.reasons.includes('etl-missing'));
	assert.ok(assessment.reasons.includes('etl-empty'));
	assert.ok(assessment.reasons.includes('recorder-reported-invalid'));
});

test('completion assessment accepts only the exact successful stop sequence [0]', () => {
	for (const stopAttemptStatuses of [[0, 0], [0, 5, 0], [5, 0]]) {
		const status = parseEtlRecorderStatusSidecar(statusSidecar({ stopAttemptStatuses }));
		const assessment = assessEtlRecorderStatus(status, expectedIdentity());
		assert.equal(assessment.valid, false);
		assert.ok(assessment.reasons.includes('stop-attempt-sequence-invalid'));
	}
});

test('ready/status pair assessment rejects snapshot, identity, path, and capability drift', () => {
	const ready = parseEtlRecorderReadySidecar(readySidecar());
	const status = parseEtlRecorderStatusSidecar(statusSidecar({
		operationalEtlPath: String.raw`\\?\Volume{11111111-1111-4111-8111-111111111111}\runtime-lab\run-a\other.etl`,
		etlFileIndex: 'fedcba9876543210',
		filterEventIds: false,
		initial: snapshot({ buffersWritten: 1 }),
		valid: false
	}));
	const assessment = assessEtlRecorderPair(ready, status, expectedIdentity());

	assert.equal(assessment.valid, false);
	assert.ok(assessment.reasons.includes('ready-status-operational-etl-path-mismatch'));
	assert.ok(assessment.reasons.includes('ready-status-etl-file-index-mismatch'));
	assert.ok(assessment.reasons.includes('ready-status-filter-capability-mismatch'));
	assert.ok(assessment.reasons.includes('ready-status-initial-snapshot-mismatch'));
});

test('closed sidecar parsers reject omitted, extra, malformed, and obsolete schema fields', () => {
	const incompleteSnapshot = snapshot();
	delete incompleteSnapshot.logBuffersLost;
	assert.throws(
		() => parseEtlRecorderStatusSidecar(statusSidecar({ stopped: incompleteSnapshot })),
		/status\.stopped\.logBuffersLost/u
	);

	const missingCapability = JSON.parse(statusSidecar().toString('utf8')) as Record<string, unknown>;
	delete missingCapability.processEventsEnabled;
	assert.throws(
		() => parseEtlRecorderStatusSidecar(Buffer.from(JSON.stringify(missingCapability))),
		/status\.processEventsEnabled/u
	);

	assert.throws(
		() => parseEtlRecorderReadySidecar(readySidecar({ unexpected: true })),
		/ready\.unexpected/u
	);
	assert.throws(
		() => parseEtlRecorderReadySidecar(readySidecar({ version: 2 })),
		/ready\.version/u
	);
	assert.throws(
		() => parseEtlRecorderReadySidecar(readySidecar({ etlVolumeSerialNumber: '001' })),
		/etlVolumeSerialNumber/u
	);
	assert.throws(
		() => parseEtlRecorderStatusSidecar(statusSidecar({ etlFileIndex: 'ABCDEF0123456789' })),
		/etlFileIndex/u
	);
	assert.throws(
		() => parseEtlRecorderReadySidecar(readySidecar({ operationalEtlPath: ETL_PATH })),
		/volume-GUID/u
	);
});

test('sidecar parsing rejects impossible native values, noncanonical paths, and invalid UTF-8 bytes', () => {
	assert.throws(
		() => parseEtlRecorderReadySidecar(readySidecar({ durationMs: 99 })),
		/durationMs/u
	);
	assert.throws(
		() => parseEtlRecorderReadySidecar(readySidecar({ sessionName: 'a'.repeat(1_024) })),
		/1023/u
	);
	assert.throws(
		() => parseEtlRecorderReadySidecar(readySidecar({
			operationalEtlPath: String.raw`\\?\Volume{11111111-1111-4111-8111-111111111111}\runtime-lab\run-a\.\capture.etl`
		})),
		/relative path segments|normalized final path/u
	);
	assert.throws(
		() => parseEtlRecorderReadySidecar(readySidecar({
			operationalEtlPath: String.raw`\\?\Volume{11111111-1111-4111-8111-111111111111}\runtime-lab/run-a/capture.etl`
		})),
		/backslash separators/u
	);
	assert.throws(
		() => parseEtlRecorderReadySidecar(Uint8Array.of(0xff)),
		/valid UTF-8/u
	);
	assert.throws(
		() => parseEtlRecorderReadySidecar(readySidecar().toString('utf8') as unknown as Uint8Array),
		/exact file bytes/u
	);
});

test('recorder assessment rejects filename-case drift and impossible snapshot chronology', () => {
	const ready = parseEtlRecorderReadySidecar(readySidecar({
		operationalEtlPath: OPERATIONAL_ETL_PATH.replace('capture.etl', 'Capture.etl')
	}));
	const readyAssessment = assessEtlRecorderReady(ready, expectedIdentity());
	assert.ok(readyAssessment.reasons.includes('operational-etl-filename-mismatch'));

	const status = parseEtlRecorderStatusSidecar(statusSidecar({
		stopped: snapshot({ buffersWritten: 99 })
	}));
	const statusAssessment = assessEtlRecorderStatus(status, expectedIdentity());
	assert.ok(statusAssessment.reasons.includes('stopped-buffersWritten-regressed'));
});

test('recorder pair acceptance requires immutable parser-produced sidecars', () => {
	const ready = parseEtlRecorderReadySidecar(readySidecar());
	const status = parseEtlRecorderStatusSidecar(statusSidecar());

	assert.ok(Object.isFrozen(ready));
	assert.ok(Object.isFrozen(ready.effective));
	assert.ok(Object.isFrozen(ready.requested));
	assert.ok(Object.isFrozen(status));
	assert.ok(Object.isFrozen(status.beforeStop));
	assert.ok(Object.isFrozen(status.stopAttemptStatuses));
	assert.throws(
		() => acceptEtlRecorderPair(
			{ ...ready },
			status,
			expectedIdentity()
		),
		/ready must come from parseEtlRecorderReadySidecar/u
	);
	assert.throws(
		() => acceptEtlRecorderPair(
			ready,
			{ ...status },
			expectedIdentity()
		),
		/status must come from parseEtlRecorderStatusSidecar/u
	);
	assert.throws(
		() => {
			ready.effective.eventsLost = 1;
		},
		TypeError
	);
	assert.throws(
		() => {
			status.stopAttemptStatuses.push(0);
		},
		TypeError
	);
	assert.doesNotThrow(
		() => acceptEtlRecorderPair(
			ready,
			status,
			expectedIdentity()
		)
	);
});

test('ETL launch validation mirrors native duration, path buffer, parent, filename, and DOS-device constraints', () => {
	const launch = (overrides: Partial<Parameters<typeof buildEtlRecorderLaunchArguments>[0]> = {}) => buildEtlRecorderLaunchArguments({
		durationMs: 1_000,
		etlPath: ETL_PATH,
		readyPath: READY_PATH,
		runId: 'run-a',
		statusPath: STATUS_PATH,
		...overrides
	});

	assert.throws(() => launch({ durationMs: 99 }), /durationMs/u);
	assert.throws(() => launch({ etlPath: 'relative.etl' }), /absolute/u);
	assert.throws(() => launch({ statusPath: String.raw`C:\runtime-lab\run-b\recorder-status.json` }), /share one parent/u);
	assert.throws(() => launch({ statusPath: READY_PATH }), /distinct/u);
	assert.throws(() => launch({ statusPath: String.raw`C:\RUNTIME-LAB\RUN-A\RECORDER-READY.JSON` }), /Windows path semantics/u);
	assert.throws(() => launch({ etlPath: String.raw`C:\runtime-lab\run-a\NUL.foo.etl` }), /reserved DOS device/u);
	assert.throws(() => launch({ etlPath: String.raw`C:\runtime-lab\run-a\COM1.anything.etl` }), /reserved DOS device/u);
	assert.throws(() => launch({ etlPath: String.raw`C:\runtime-lab\run-a\capture stream.etl` }), /only ASCII/u);
	assert.throws(() => launch({ etlPath: String.raw`C:\runtime-lab\run-a\capturé.etl` }), /only ASCII/u);
	assert.throws(() => launch({ etlPath: String.raw`C:\runtime-lab\run-a\capture.etl:stream` }), /only ASCII/u);
	assert.throws(() => launch({ etlPath: `C:\\runtime-lab\\run-a\\${'a'.repeat(237)}.etl` }), /1 through 240/u);
	assert.throws(() => launch({ etlPath: `C:\\${'a\\'.repeat(16_382)}capture.etl` }), /native recorder buffer/u);
});

test('offline replay builder rejects unsafe targets without a legacy output-path limit', () => {
	const replay = (overrides: Partial<Parameters<typeof buildOfflinePresentMonArguments>[0]> = {}) => buildOfflinePresentMonArguments({
		acceptedCapture: acceptedCapture(),
		outputCsvPath: CSV_PATH,
		targetProcessId: 1,
		...overrides
	});

	assert.throws(() => replay({ targetProcessId: 0 }), /process ID/u);
	assert.throws(() => buildOfflinePresentMonArguments({
		acceptedCapture: acceptedCapture(),
		outputCsvPath: CSV_PATH
	}), /Exactly one/u);
	assert.throws(() => buildOfflinePresentMonArguments({
		acceptedCapture: {
			captureStartFileTimeUtc:
				CAPTURE_START_FILETIME_UTC,
			captureStopFileTimeUtc:
				CAPTURE_STOP_FILETIME_UTC,
			etlFileIndex: ETL_FILE_INDEX,
			etlReadLease:
				'held-until-controller-release',
			etlSha256: ETL_SHA256,
			etlSizeBytes: 1,
			etlVolumeSerialNumber: ETL_VOLUME_SERIAL_NUMBER,
			operationalEtlPath: OPERATIONAL_ETL_PATH,
			sessionName: SESSION_NAME
		},
		outputCsvPath: CSV_PATH,
		targetProcessId: 1
	}), /acceptEtlRecorderPair/u);
	assert.throws(() => replay({ targetProcessId: 1, targetProcessName: 'candidate.exe' }), /Exactly one/u);
	assert.throws(() => buildOfflinePresentMonArguments({
		acceptedCapture: acceptedCapture(),
		outputCsvPath: CSV_PATH,
		targetProcessName: String.raw`C:\candidate.exe`
	}), /only ASCII|base name/u);
	assert.doesNotThrow(() => replay({
		outputCsvPath: `C:\\${'a'.repeat(125)}\\${'b'.repeat(125)}\\presentmon.csv`
	}));
});

test('offline replay assessment accepts a fresh, stable, complete exact-PID CSV', () => {
	const assessment = assessOfflinePresentMonReplay(replayEvidence(), {
		expectedApplicationName: 'wok-electron-44.exe',
		expectedOutputPath: CSV_PATH,
		mode: 'process-id',
		minimumFrameRecords: 2,
		targetProcessId: 42_424
	});

	assert.deepEqual(assessment, {
		applicationNames: ['wok-electron-44.exe'],
		capturedProcessIds: [42_424],
		malformedRowCount: 0,
		reasons: [],
		recordCount: 2,
		valid: true
	});
});

test('offline replay assessment is bound to the launch output path', () => {
	const assessment = assessOfflinePresentMonReplay(
		replayEvidence(),
		{
			expectedApplicationName: 'wok-electron-44.exe',
			expectedOutputPath:
				String.raw`C:\runtime-lab\run-b\presentmon.csv`,
			mode: 'process-id',
			targetProcessId: 42_424
		}
	);

	assert.equal(assessment.valid, false);
	assert.ok(
		assessment.reasons.includes(
			'replay-output-path-mismatch'
		)
	);
});

test('offline replay assessment requires stdout UTF-8 framing, full header, and complete streams', () => {
	const expectation = {
		expectedApplicationName: 'wok-electron-44.exe',
		expectedOutputPath: CSV_PATH,
		mode: 'process-id',
		targetProcessId: 42_424
	} as const;
	const withBom = Buffer.concat([
		Buffer.from([0xef, 0xbb, 0xbf]),
		VALID_REPLAY_BYTES
	]);
	const unexpectedBom = assessOfflinePresentMonReplay(
		replayEvidence({
			outputContents: withBom,
			outputSizeBytesAfterRead: withBom.byteLength,
			outputSizeBytesAtOpen: withBom.byteLength
		}),
		expectation
	);
	assert.ok(
		unexpectedBom.reasons.includes(
			'replay-output-unexpected-utf8-bom'
		)
	);

	const withoutTerminalCrlf = replayCsvBytes(VALID_REPLAY_CSV.slice(0, -2));
	const incompleteDocument = assessOfflinePresentMonReplay(replayEvidence({
		outputContents: withoutTerminalCrlf,
		outputSizeBytesAfterRead: withoutTerminalCrlf.byteLength,
		outputSizeBytesAtOpen: withoutTerminalCrlf.byteLength,
		stderrComplete: false,
		stdoutComplete: false
	}), expectation);
	assert.ok(incompleteDocument.reasons.includes('replay-output-terminal-crlf-missing'));
	assert.ok(incompleteDocument.reasons.includes('replay-stderr-incomplete'));
	assert.ok(incompleteDocument.reasons.includes('replay-stdout-incomplete'));

	const partialHeaderCsv = VALID_REPLAY_CSV.replace(
		PRESENTMON_V2_REPLAY_HEADER,
		'Application,ProcessID,SwapChainAddress,CPUStartDateTime,FrameTime,DisplayedTime'
	);
	const partialHeaderBytes = replayCsvBytes(partialHeaderCsv);
	const partialHeader = assessOfflinePresentMonReplay(replayEvidence({
		outputContents: partialHeaderBytes,
		outputSizeBytesAfterRead: partialHeaderBytes.byteLength,
		outputSizeBytesAtOpen: partialHeaderBytes.byteLength
	}), expectation);
	assert.ok(partialHeader.reasons.includes('replay-output-header-mismatch'));

	const invalidUtf8 = Buffer.from([0xff]);
	const invalidEncoding = assessOfflinePresentMonReplay(replayEvidence({
		outputContents: invalidUtf8,
		outputSizeBytesAfterRead: invalidUtf8.byteLength,
		outputSizeBytesAtOpen: invalidUtf8.byteLength
	}), expectation);
	assert.ok(invalidEncoding.reasons.includes('replay-output-invalid-utf8'));
});

test('offline replay assessment rejects stale, missing, replaced, empty, and header-only output', () => {
	const expectation = {
		expectedApplicationName: 'wok-electron-44.exe',
		expectedOutputPath: CSV_PATH,
		mode: 'process-id',
		targetProcessId: 42_424
	} as const;
	const stale = assessOfflinePresentMonReplay(
		replayEvidence({ outputExistedBefore: true }),
		expectation
	);
	assert.ok(stale.reasons.includes('replay-output-pre-existed'));

	const missing = assessOfflinePresentMonReplay(replayEvidence({
		outputContents: undefined,
		outputExistsAfter: false,
		outputIdentityAfterRead: undefined,
		outputIdentityAtOpen: undefined,
		outputSizeBytesAfterRead: 0,
		outputSizeBytesAtOpen: 0
	}), expectation);
	assert.ok(missing.reasons.includes('replay-output-missing'));
	assert.ok(missing.reasons.includes('replay-output-identity-unverified'));
	assert.ok(missing.reasons.includes('replay-output-unreadable'));

	const replaced = assessOfflinePresentMonReplay(replayEvidence({
		outputIdentityAfterRead: {
			fileIndex: '2222222222222222',
			volumeSerialNumber: ETL_VOLUME_SERIAL_NUMBER
		}
	}), expectation);
	assert.ok(replaced.reasons.includes('replay-output-identity-changed'));

	const headerOnlyBytes = replayCsvBytes(`${PRESENTMON_V2_REPLAY_HEADER}\r\n`);
	const headerOnly = assessOfflinePresentMonReplay(replayEvidence({
		outputContents: headerOnlyBytes,
		outputSizeBytesAfterRead: headerOnlyBytes.byteLength,
		outputSizeBytesAtOpen: headerOnlyBytes.byteLength
	}), expectation);
	assert.ok(headerOnly.reasons.includes('replay-output-header-only'));
	assert.ok(headerOnly.reasons.includes('replay-target-process-id-missing'));
});

test('offline replay assessment rejects overflow, warnings, nonzero exits, and forced termination', () => {
	const assessment = assessOfflinePresentMonReplay(replayEvidence({
		exitCode: 5,
		stderr: 'warning: 12 overflowed present events detected.\nwarning: trace was truncated.',
		terminatedByController: true
	}), {
		expectedApplicationName: 'wok-electron-44.exe',
		expectedOutputPath: CSV_PATH,
		mode: 'process-id',
		targetProcessId: 42_424
	});

	assert.equal(assessment.valid, false);
	assert.ok(assessment.reasons.includes('replay-exit-code:5'));
	assert.ok(assessment.reasons.includes('replay-terminated-by-controller'));
	assert.ok(assessment.reasons.includes('replay-present-event-overflow'));
	assert.ok(assessment.reasons.includes('replay-warning-output'));
});

test('offline replay assessment rejects malformed, partial, insufficient, and wrong-target CSV rows', () => {
	const malformedCsv = [
		PRESENTMON_V2_REPLAY_HEADER,
		'wok-electron-44.exe,999,0x1,DXGI,0,0,1,Hardware: Independent Flip,2026-08-01 12:00:00.000000000,8.0000,6.0000,2.0000,1.0000,8.0000,NA,100.0000,NA,extra',
		'wok-electron-44.exe,999,0x1,DXGI,0,0,1,Hardware: Independent Flip,,,6.0000,2.0000,1.0000,,NA,100.0000,NA',
		''
	].join('\r\n');
	const malformedBytes = replayCsvBytes(malformedCsv);
	const assessment = assessOfflinePresentMonReplay(replayEvidence({
		outputContents: malformedBytes,
		outputSizeBytesAfterRead: malformedBytes.byteLength,
		outputSizeBytesAtOpen: malformedBytes.byteLength
	}), {
		expectedApplicationName: 'wok-electron-44.exe',
		expectedOutputPath: CSV_PATH,
		mode: 'process-id',
		minimumFrameRecords: 3,
		targetProcessId: 42_424
	});

	assert.equal(assessment.valid, false);
	assert.ok(assessment.reasons.includes('replay-malformed-row-count:1'));
	assert.ok(assessment.reasons.includes('replay-record-count:2/3'));
	assert.ok(assessment.reasons.includes('replay-frame-times-missing:1'));
	assert.ok(assessment.reasons.includes('replay-timestamps-missing:1'));
	assert.ok(assessment.reasons.includes('replay-target-process-id-missing'));
	assert.ok(assessment.reasons.includes('replay-unexpected-process-id'));
});

test('offline exact-PID replay assessment binds the PID to its expected application identity', () => {
	const wrongNameCsv = VALID_REPLAY_CSV.replaceAll('wok-electron-44.exe', 'helper.exe');
	const wrongNameBytes = replayCsvBytes(wrongNameCsv);
	const assessment = assessOfflinePresentMonReplay(replayEvidence({
		outputContents: wrongNameBytes,
		outputSizeBytesAfterRead: wrongNameBytes.byteLength,
		outputSizeBytesAtOpen: wrongNameBytes.byteLength
	}), {
		expectedApplicationName: 'wok-electron-44.exe',
		expectedOutputPath: CSV_PATH,
		mode: 'process-id',
		targetProcessId: 42_424
	});

	assert.ok(assessment.reasons.includes('replay-expected-application-missing'));
	assert.ok(assessment.reasons.includes('replay-unexpected-application'));
});

test('offline process-name replay assessment rejects unexpected names and out-of-job PIDs', () => {
	const wrongNameCsv = VALID_REPLAY_CSV
		.replaceAll('wok-electron-44.exe', 'helper.exe')
		.replaceAll('42424', '999');
	const wrongNameBytes = replayCsvBytes(wrongNameCsv);
	const assessment = assessOfflinePresentMonReplay(replayEvidence({
		outputContents: wrongNameBytes,
		outputSizeBytesAfterRead: wrongNameBytes.byteLength,
		outputSizeBytesAtOpen: wrongNameBytes.byteLength
	}), {
		allowedProcessIds: [42_424],
		expectedOutputPath: CSV_PATH,
		mode: 'process-name',
		targetProcessName: 'wok-electron-44.exe'
	});

	assert.equal(assessment.valid, false);
	assert.ok(assessment.reasons.includes('replay-target-process-name-missing'));
	assert.ok(assessment.reasons.includes('replay-unexpected-process-name'));
	assert.ok(assessment.reasons.includes('replay-process-id-outside-job'));
	assert.throws(
		() => assessOfflinePresentMonReplay(replayEvidence(), {
			allowedProcessIds: [42_424, 42_424],
			expectedOutputPath: CSV_PATH,
			mode: 'process-name',
			targetProcessName: 'wok-electron-44.exe'
		}),
		/duplicate process IDs/u
	);
});
