import assert from 'node:assert/strict';
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
	buildArtifactSealReasons,
	buildWindowsJobCleanupResult,
	calculateEtlRecorderDurationMs,
	electronHostRootIdentityViolation,
	etlRecorderReleaseAcknowledgmentViolation,
	exactArtifactRecordViolation,
	exactJobMembershipViolation,
	headlinePresentingProcessViolation,
	headlinePresentMonStreamViolation,
	parseElectronHostEvents,
	reverifyFileImmediatelyBeforeUse,
	selectedPidReplayEvidenceViolation,
	selectHeadlinePresentMonStream,
	selectPresentingProcessId,
	shouldRetainCandidateFirewall,
	startOfflineReplayProcess,
	unclassifiedInvalidResultViolation
} from '../src/controller/single-run.ts';
import { parseWindowsProcessTreeSample } from '../src/controller/windows-process-monitor.ts';
import {
	analyzePresentMonCsv,
	type PresentMonCsvAnalysis
} from '../src/host/presentmon-csv.ts';
import { sha256Hex } from '../src/shared/hash.ts';

const repositoryRoot = join(
	import.meta.dirname,
	'..',
	'..',
	'..'
);
const testOutputRoot = join(
	repositoryRoot,
	'.working',
	'runtime-lab',
	'tests'
);
await mkdir(testOutputRoot, { recursive: true });

test('ETL recording spans startup, foreground acquisition, benchmark and tail allowance', () => {
	assert.equal(
		calculateEtlRecorderDurationMs(30_000, 15_000),
		60_000
	);
	assert.equal(
		calculateEtlRecorderDurationMs(5_000, 1_000),
		21_000
	);
	assert.throws(
		() => calculateEtlRecorderDurationMs(0, 15_000),
		/positive integer/u
	);
	assert.throws(
		() => calculateEtlRecorderDurationMs(30_000, 999),
		/1,000 through 120,000/u
	);
});

test('controller establishes ETW readiness before candidate creation and resume', async () => {
	const controllerSource = await readFile(
		join(
			repositoryRoot,
			'lab',
			'offline-runtime',
			'src',
			'controller',
			'single-run.ts'
		),
		'utf8'
	);
	const readyWait = controllerSource.indexOf(
		'await waitForEtlRecorderReadyBytes('
	);
	const readyAssessment = controllerSource.indexOf(
		'recorderRun.readyAssessment = assessEtlRecorderReady('
	);
	const candidateCreation = controllerSource.indexOf(
		'candidateProcess = startWindowsJobProcess('
	);
	const firstSample = controllerSource.indexOf(
		'candidateProcess.firstSample',
		candidateCreation
	);
	const suspendedMembership = controllerSource.indexOf(
		'candidateProcess.snapshotProcessIds(',
		firstSample
	);
	const candidateResume = controllerSource.indexOf(
		'candidateProcess.resume()',
		suspendedMembership
	);

	for (const boundary of [
		readyWait,
		readyAssessment,
		candidateCreation,
		firstSample,
		suspendedMembership,
		candidateResume
	]) {
		assert.ok(boundary >= 0);
	}
	assert.ok(readyWait < readyAssessment);
	assert.ok(readyAssessment < candidateCreation);
	assert.ok(candidateCreation < firstSample);
	assert.ok(firstSample < suspendedMembership);
	assert.ok(suspendedMembership < candidateResume);
});

test('controller binds selected frames to one creation-qualified ETL lifetime before release', async () => {
	const controllerSource = await readFile(
		join(
			repositoryRoot,
			'lab',
			'offline-runtime',
			'src',
			'controller',
			'single-run.ts'
		),
		'utf8'
	);
	const runStart = controllerSource.indexOf(
		'export async function runRuntimeLabSingleRun('
	);
	assert.ok(runStart >= 0);
	const runSource = controllerSource.slice(runStart);
	const processNameReplay = runSource.indexOf(
		'await executeOfflinePresentMonReplay(\n\t\t\tprocessNameReplay'
	);
	const processIdReplay = runSource.indexOf(
		'await executeOfflinePresentMonReplay(\n\t\t\tprocessIdReplay'
	);
	const processInspection = runSource.indexOf(
		'await executeEtlProcessInspection('
	);
	const lifetimeDerivation = runSource.indexOf(
		'etlProcessLifetime = deriveEtlProcessLifetimes({'
	);
	const lifetimeEvidence = runSource.indexOf(
		'etlProcessLifetimeEvidence = await writeJsonArtifact('
	);
	const lifetimeBinding = runSource.indexOf(
		'presentMonProcessLifetimeBinding ='
	);
	const bindingEvidence = runSource.indexOf(
		'presentMonProcessLifetimeBindingEvidence = await writeJsonArtifact('
	);
	const finalEtlVerification = runSource.indexOf(
		'await verifyAcceptedEtlCapture(recorderRun.acceptedCapture);',
		bindingEvidence
	);
	const recorderRelease = runSource.indexOf(
		'const recorderRelease = await releaseEtlRecorder({'
	);

	for (const boundary of [
		processNameReplay,
		processIdReplay,
		processInspection,
		lifetimeDerivation,
		lifetimeEvidence,
		lifetimeBinding,
		bindingEvidence,
		finalEtlVerification,
		recorderRelease
	]) {
		assert.ok(boundary >= 0);
	}
	assert.ok(processNameReplay < processIdReplay);
	assert.ok(processIdReplay < processInspection);
	assert.ok(processInspection < lifetimeDerivation);
	assert.ok(lifetimeDerivation < lifetimeEvidence);
	assert.ok(lifetimeEvidence < lifetimeBinding);
	assert.ok(lifetimeBinding < bindingEvidence);
	assert.ok(bindingEvidence < finalEtlVerification);
	assert.ok(finalEtlVerification < recorderRelease);
	for (const mandatoryValidityCheck of [
		'&& etlProcessInspection?.processIdentity !== undefined',
		'&& etlProcessLifetimeEvidence !== undefined',
		'&& presentMonProcessLifetimeBinding?.valid',
		'&& presentMonProcessLifetimeBindingEvidence !== undefined'
	]) {
		assert.ok(runSource.includes(mandatoryValidityCheck));
	}
	for (const exactArtifactLabel of [
		'etl-process-event-evidence',
		'etl-process-lifetime-evidence',
		'presentmon-process-lifetime-binding-evidence'
	]) {
		assert.ok(runSource.includes(exactArtifactLabel));
	}
});

test('native recorder requires live process events without requesting rundown', async () => {
	const recorderSource = await readFile(
		join(
			repositoryRoot,
			'lab',
			'offline-runtime',
			'hosts',
			'windows',
			'WokEtlRecorder.cpp'
		),
		'utf8'
	);
	const presentMonPatch = await readFile(
		join(
			repositoryRoot,
			'lab',
			'offline-runtime',
			'hosts',
			'windows',
			'presentmon-v2.5.1-wok-recorder.patch'
		),
		'utf8'
	);
	const rundownDisabled = recorderSource.indexOf(
		'consumer.mTrackProcessState = false;'
	);
	const liveProcessEnable = recorderSource.indexOf(
		'providerStatus = EnableRequiredLiveProcessEvents('
	);
	const readySnapshot = recorderSource.indexOf(
		'initial = Snapshot(sessionHandle);'
	);

	assert.ok(rundownDisabled >= 0);
	assert.ok(liveProcessEnable > rundownDisabled);
	assert.ok(readySnapshot > liveProcessEnable);
	assert.ok(!recorderSource.includes('EVENT_CONTROL_CODE_CAPTURE_STATE'));
	assert.ok(
		recorderSource.includes('\\"processRundownRequested\\": false')
	);
	assert.ok(recorderSource.includes('constexpr ULONG kBufferSizeKiB = 64;'));
	assert.ok(recorderSource.includes('constexpr ULONG kMinimumBuffers = 256;'));
	assert.ok(recorderSource.includes('constexpr ULONG kMaximumBuffers = 1024;'));
	assert.ok(recorderSource.includes('constexpr ULONG kFlushTimerSeconds = 0;'));
	assert.ok(
		presentMonPatch.includes(
			'+constexpr ULONG kProviderEnableTimeoutMs = 10 * 1000;'
		)
	);
	assert.ok(
		presentMonPatch.includes(
			'+                kProviderEnableTimeoutMs, pparams);'
		)
	);
	assert.ok(presentMonPatch.includes('+        provider.ClearFilter();'));
	assert.ok(
		presentMonPatch.includes(
			'+        if (status != ERROR_SUCCESS) return status;'
		)
	);
});

test('ETL recorder release acknowledgment requires exact CRLF-framed bytes', () => {
	const token = '1'.repeat(32);
	assert.equal(
		etlRecorderReleaseAcknowledgmentViolation(
			`RELEASED|${token}\r\n`,
			token
		),
		undefined
	);
	for (const stdout of [
		`RELEASED|${token}`,
		`RELEASED|${token}\n`,
		`\r\nRELEASED|${token}\r\n`,
		`RELEASED|${token}\r\n\r\n`,
		`RELEASED|${'2'.repeat(32)}\r\n`
	]) {
		assert.equal(
			etlRecorderReleaseAcknowledgmentViolation(
				stdout,
				token
			),
			'etl-recorder-release-acknowledgment-not-exact'
		);
	}
});

test('pre-use verification rejects a runtime tool identity change', async () => {
	const directory = await mkdtemp(
		join(testOutputRoot, 'pre-use-identity-')
	);
	const toolPath = join(directory, 'runtime-tool.exe');
	const originalBytes = Buffer.from('runtime-tool-a', 'utf8');
	await writeFile(toolPath, originalBytes);
	const verified = {
		path: toolPath,
		sha256: sha256Hex(originalBytes),
		sizeBytes: originalBytes.byteLength
	};
	await reverifyFileImmediatelyBeforeUse(
		verified,
		'Runtime tool'
	);
	await writeFile(
		toolPath,
		Buffer.from('runtime-tool-b', 'utf8')
	);
	await assert.rejects(
		reverifyFileImmediatelyBeforeUse(
			verified,
			'Runtime tool'
		),
		/Runtime tool SHA-256 mismatch/u
	);
});

test('accepted ETL sidecar evidence rejects changed, resized and missing bytes', async () => {
	const directory = await mkdtemp(
		join(testOutputRoot, 'etl-sidecar-evidence-')
	);
	const sidecarPath = join(directory, 'ready.json');
	const acceptedBytes = Buffer.from('accepted-ready-sidecar', 'utf8');
	const evidence = {
		path: sidecarPath,
		sha256: sha256Hex(acceptedBytes),
		sizeBytes: acceptedBytes.byteLength
	};
	await writeFile(sidecarPath, acceptedBytes);
	assert.equal(
		await exactArtifactRecordViolation(
			evidence,
			'etl-recorder-ready-sidecar'
		),
		undefined
	);
	await writeFile(
		sidecarPath,
		Buffer.from('rejected-ready-sidecar', 'utf8')
	);
	assert.equal(
		await exactArtifactRecordViolation(
			evidence,
			'etl-recorder-ready-sidecar'
		),
		'etl-recorder-ready-sidecar-bytes-changed-after-acceptance'
	);
	await writeFile(sidecarPath, Buffer.from('resized', 'utf8'));
	assert.equal(
		await exactArtifactRecordViolation(
			evidence,
			'etl-recorder-ready-sidecar'
		),
		'etl-recorder-ready-sidecar-size-changed-after-acceptance'
	);
	await rename(sidecarPath, join(directory, 'removed-ready.json'));
	assert.equal(
		await exactArtifactRecordViolation(
			evidence,
			'etl-recorder-ready-sidecar'
		),
		'etl-recorder-ready-sidecar-missing-after-acceptance'
	);
});

test('controller reconciles exact Job membership with a fresh identity-bearing sample', () => {
	const sample = parseWindowsProcessTreeSample(JSON.stringify({
		capturedAtMs: 1_700_000_000_000,
		foregroundOwnedByCandidateTree: true,
		foregroundProcessId: 200,
		processes: [200, 201].map(processId => ({
			commandLine: '',
			creationTimeUtcTicks: `63890000000000${processId}0`,
			cpuPercent: 0,
			executableName: 'candidate.exe',
			executablePath: 'C:\\runtime\\candidate.exe',
			parentProcessId: processId === 200 ? 0 : 200,
			performanceCountersPresent: true,
			privateBytes: 0,
			processId,
			workingSetBytes: 0
		})),
		rootProcessId: 200
	}));

	assert.equal(
		exactJobMembershipViolation([201, 200], sample),
		undefined
	);
	assert.equal(
		exactJobMembershipViolation([200, 202], sample),
		'exact-job-membership-sample-mismatch:omitted=202;stale=201'
	);
	assert.equal(
		exactJobMembershipViolation([], sample),
		'exact-job-membership-empty'
	);
	assert.throws(
		() => exactJobMembershipViolation([200, 200], sample),
		/must not contain duplicate process IDs/u
	);
});

test('controller requires selected-PID evidence to agree across both ETL replays', () => {
	const header =
		'Application,ProcessID,SwapChainAddress,Dropped,TimeInMs,FrameTime';
	const processNameCsv = [
		header,
		'outside.exe,999,0xA,0,0,8',
		'candidate.exe,200,0xB,0,1,10',
		'candidate.exe,201,0xC,0,2,12',
		'candidate.exe,200,0xB,0,3,11'
	].join('\n');
	const processIdCsv = [
		header,
		'candidate.exe,200,0xB,0,1,10',
		'candidate.exe,200,0xB,0,3,11'
	].join('\n');

	assert.equal(
		selectedPidReplayEvidenceViolation(
			processNameCsv,
			processIdCsv,
			200
		),
		undefined
	);
	assert.equal(
		selectedPidReplayEvidenceViolation(
			processNameCsv,
			processIdCsv.replace(',0,3,11', ',0,3,12'),
			200
		),
		'offline-replay-selected-pid-evidence-mismatch'
	);
	assert.equal(
		selectedPidReplayEvidenceViolation(
			processNameCsv,
			[header, 'candidate.exe,201,0xC,0,2,12'].join('\n'),
			200
		),
		'process-id-replay-selected-pid-evidence-missing'
	);
	assert.equal(
		selectedPidReplayEvidenceViolation(
			[header, 'candidate.exe,201,0xC,0,2,12'].join('\n'),
			processIdCsv,
			200
		),
		'process-name-replay-selected-pid-evidence-missing'
	);
});

test('controller selects the busiest valid presenting stream inside the exact Job membership', () => {
	const csv = [
		'Application,ProcessID,SwapChainAddress,Dropped,TimeInMs,FrameTime',
		'outside.exe,999,0xA,0,0,8',
		'outside.exe,999,0xA,0,1,8',
		'candidate.exe,200,0xB,0,0,10',
		'candidate.exe,200,0xB,0,1,10',
		'candidate.exe,201,0xC,0,0,12'
	].join('\n');
	const analysis = analyzePresentMonCsv(csv, {
		minimumFrameSamples: 1,
		warmupMs: 0
	});
	assert.equal(selectPresentingProcessId(analysis, new Set([200, 201])), 200);
});

test('controller selects one deterministic headline stream for the replay-selected PID', () => {
	const analysis = analyzePresentMonCsv([
		'Application,ProcessID,SwapChainAddress,Dropped,TimeInMs,FrameTime',
		'outside.exe,999,0x0,0,0,1',
		'outside.exe,999,0x0,0,1,1',
		'outside.exe,999,0x0,0,2,1',
		'outside.exe,999,0x0,0,3,1',
		'candidate.exe,200,0xC,0,0,12',
		'candidate.exe,200,0xC,0,1,12',
		'candidate.exe,200,0xC,0,2,12',
		'candidate.exe,200,0xC,0,3,12',
		'candidate.exe,200,0xB,0,0,10',
		'candidate.exe,200,0xB,0,1,10',
		'candidate.exe,200,0xB,0,2,10',
		'candidate.exe,200,0xA,0,0,8',
		'candidate.exe,200,0xA,0,1,8',
		'candidate.exe,200,0xA,0,2,8'
	].join('\n'), {
		minimumFrameSamples: 1,
		warmupMs: 0
	});
	const selected = selectHeadlinePresentMonStream(
		analysis,
		200
	);
	assert.equal(
		selected?.key,
		'pid:200/swapchain:0xc'
	);
	assert.equal(
		headlinePresentMonStreamViolation(
			selected,
			200
		),
		undefined
	);

	const equalSampleCount = {
		...analysis,
		streams: analysis.streams.map(stream =>
			stream.key === 'pid:200/swapchain:0xc'
				? { ...stream, sampleCount: 3 }
				: stream
		)
	} satisfies PresentMonCsvAnalysis;
	assert.equal(
		selectHeadlinePresentMonStream(
			equalSampleCount,
			200
		)?.key,
		'pid:200/swapchain:0xa'
	);

	const invalidHeavy = {
		...analysis,
		streams: analysis.streams.map(stream =>
			stream.key === 'pid:200/swapchain:0xc'
				? {
					...stream,
					sampleCount: 100,
					valid: false
				}
				: stream
		)
	} satisfies PresentMonCsvAnalysis;
	assert.equal(
		selectHeadlinePresentMonStream(
			invalidHeavy,
			200
		)?.key,
		'pid:200/swapchain:0xa'
	);
	assert.equal(
		headlinePresentMonStreamViolation(
			undefined,
			200
		),
		'headline-presenting-stream-missing'
	);
	assert.equal(
		headlinePresentMonStreamViolation(
			invalidHeavy.streams.find(stream =>
				stream.key
					=== 'pid:200/swapchain:0xc'
			),
			200
		),
		'headline-presenting-stream-invalid'
	);
});

test('controller validates the headline PID against raw capture records', () => {
	const matching = analyzePresentMonCsv([
		'Application,ProcessID,SwapChainAddress,TimeInMs,FrameTime',
		'candidate.exe,200,0xA,0,10'
	].join('\n'), {
		minimumFrameSamples: 1,
		warmupMs: 0
	});
	assert.equal(headlinePresentingProcessViolation(matching, 200), undefined);
	assert.equal(headlinePresentingProcessViolation(matching, 201), 'headline-presenting-pid-mismatch');

	const unavailable = analyzePresentMonCsv([
		'Application,SwapChainAddress,TimeInMs,FrameTime',
		'candidate.exe,0xA,0,10'
	].join('\n'), {
		minimumFrameSamples: 1,
		warmupMs: 0
	});
	assert.equal(headlinePresentingProcessViolation(unavailable, 200), 'headline-presenting-pid-unavailable');
});

test('controller retains the candidate firewall until the Windows job is confirmed empty', () => {
	assert.equal(
		shouldRetainCandidateFirewall({
			candidateHostStarted: true,
			candidateProcessId: 200
		}),
		true
	);
	assert.equal(
		shouldRetainCandidateFirewall({
			candidateExit: { jobClean: true },
			candidateHostStarted: true,
			candidateProcessId: 200
		}),
		true
	);
	assert.equal(
		shouldRetainCandidateFirewall({
			candidateExit: { jobClean: true },
			candidateHostStarted: true,
			candidateProcessId: 200,
			cleanup: {
				jobClean: false,
				membership: {
					processIds: [201],
					status: 'reconciled'
				},
				orphanProcessIds: [201]
			}
		}),
		true
	);
	assert.equal(
		shouldRetainCandidateFirewall({
			candidateExit: { jobClean: true },
			candidateHostStarted: true,
			candidateProcessId: 200,
			cleanup: {
				jobClean: true,
				membership: {
					processIds: [],
					status: 'reconciled'
				},
				orphanProcessIds: []
			}
		}),
		false
	);
	assert.equal(
		shouldRetainCandidateFirewall({
			candidateExit: { jobClean: false },
			candidateHostStarted: true,
			cleanup: {
				jobClean: false,
				membership: {
					reason: 'owner exited without terminal evidence',
					status: 'unreconciled'
				},
				orphanProcessIds: []
			}
		}),
		true
	);
	assert.equal(
		shouldRetainCandidateFirewall({
			candidateHostStarted: false
		}),
		false
	);
});

test('controller finalization refuses an unexplained invalid result', () => {
	assert.equal(
		unclassifiedInvalidResultViolation({
			failures: [],
			headlineAnalysisValid: true,
			pageRunValid: false,
			resourceCoverageValid: true,
			resourceSampleCount: 5,
			violations: []
		}),
		'unclassified-invalid-result'
	);
	assert.equal(
		unclassifiedInvalidResultViolation({
			failures: [{
				details: {},
				kind: 'benchmark-failure',
				message: 'classified'
			}],
			headlineAnalysisValid: true,
			pageRunValid: false,
			resourceCoverageValid: true,
			resourceSampleCount: 5,
			violations: []
		}),
		undefined
	);
	assert.equal(
		unclassifiedInvalidResultViolation({
			failures: [],
			headlineAnalysisValid: true,
			pageRunValid: true,
			resourceCoverageValid: true,
			resourceSampleCount: 5,
			violations: []
		}),
		undefined
	);
});

test('cleanup derives orphans only from reconciled terminal Job membership', () => {
	const reconciled = buildWindowsJobCleanupResult({
		exitCode: 1,
		finishedAt: '2026-08-02T00:00:01.000Z',
		jobClean: false,
		membership: {
			processIds: [201, 202],
			status: 'reconciled'
		},
		signal: null,
		startedAt: '2026-08-02T00:00:00.000Z',
		stderr: '',
		stderrTruncated: false,
		stdout: '',
		stdoutTruncated: false,
		terminationRequested: true
	}, 200);
	assert.deepEqual(reconciled, {
		jobClean: false,
		membership: {
			processIds: [201, 202],
			status: 'reconciled'
		},
		orphanProcessIds: [201, 202],
		rootProcessId: 200,
		terminationAttempted: true
	});

	const unreconciled = buildWindowsJobCleanupResult({
		exitCode: null,
		finishedAt: '2026-08-02T00:00:01.000Z',
		jobClean: false,
		launchError: 'owner exited without terminal evidence',
		membership: {
			reason: 'owner exited without terminal evidence',
			status: 'unreconciled'
		},
		signal: 'SIGTERM',
		startedAt: '2026-08-02T00:00:00.000Z',
		stderr: '',
		stderrTruncated: false,
		stdout: '',
		stdoutTruncated: false,
		terminationRequested: false
	}, 200);
	assert.deepEqual(unreconciled, {
		jobClean: false,
		membership: {
			reason: 'owner exited without terminal evidence',
			status: 'unreconciled'
		},
		orphanProcessIds: [],
		rootProcessId: 200,
		terminationAttempted: false,
		terminationError: 'owner exited without terminal evidence'
	});
});

test('cleanup failures and verified orphans prevent artifact sealing', () => {
	assert.deepEqual(
		buildArtifactSealReasons(
			['server-cleanup:timed out'],
			[200, 201]
		),
		[
			'server-cleanup:timed out',
			'verified-orphan-process:200',
			'verified-orphan-process:201'
		]
	);
	assert.deepEqual(
		buildArtifactSealReasons(
			[],
			[],
			{
				reason: 'owner exited without terminal evidence',
				status: 'unreconciled'
			}
		),
		[
			'candidate-cleanup:windows-job-membership-unreconciled:'
				+ 'owner exited without terminal evidence'
		]
	);
});

test('Electron host focus transitions are preserved without invalidation', () => {
	const output = [
		'WOK_RUNTIME_HOST_EVENT '
			+ JSON.stringify({
				details: {
					isFocused: false,
					isMinimized: false,
					isVisible: true
				},
				epochMs: 1_700_000_002_000,
				monotonicMs: 2_000,
				pid: 200,
				type: 'window-blur'
			})
	].join('\n');
	const parsed = parseElectronHostEvents(output);
	assert.deepEqual(parsed.violations, []);
	assert.equal(parsed.events[0]?.type, 'window-blur');
	assert.equal(parsed.events[0]?.details.isFocused, false);
});

test('Electron host-started evidence binds to the native root lifetime', () => {
	const root = {
		creationTimeUtcTicks: '638900000000000000',
		executable: {
			fileIdHex: '0'.repeat(16),
			finalPath: 'C:\\runtime\\electron.exe',
			sha256: '0'.repeat(64),
			sizeBytes: 1,
			volumeSerialNumberHex: '0'.repeat(8)
		},
		executablePath: 'C:\\runtime\\electron.exe',
		processId: 200
	};
	const event = {
		details: {},
		epochMs: 1_700_000_000_000,
		monotonicMs: 100,
		pid: 200,
		type: 'host-started'
	};
	assert.equal(
		electronHostRootIdentityViolation([event], root),
		undefined
	);
	assert.equal(
		electronHostRootIdentityViolation(
			[{ ...event, pid: 201 }],
			root
		),
		'electron-runtime-root-pid-mismatch:201:200'
	);
	assert.equal(
		electronHostRootIdentityViolation([event, event], root),
		'electron-runtime-identity-count:2'
	);
	assert.equal(
		electronHostRootIdentityViolation([], root),
		'electron-runtime-identity-missing'
	);
});

test('Electron security-denial events invalidate controller integrity', () => {
	const output = [
		'ordinary output',
		'WOK_RUNTIME_HOST_EVENT '
			+ JSON.stringify({
				details: {
					url: 'http://127.0.0.1:9/'
				},
				epochMs: 1_700_000_000_000,
				monotonicMs: 100,
				pid: 200,
				type: 'request-denied'
			})
	].join('\n');
	const parsed = parseElectronHostEvents(output);
	assert.equal(parsed.events.length, 1);
	assert.deepEqual(parsed.violations, [
		'electron-integrity-event:request-denied'
	]);
});

test('controller rejects process-name replay PIDs outside exact Job membership', () => {
	const csv = [
		'Application,ProcessID,SwapChainAddress,Dropped,TimeInMs,FrameTime',
		'outside.exe,999,0xA,0,0,8'
	].join('\n');
	const analysis = analyzePresentMonCsv(csv, {
		minimumFrameSamples: 1,
		warmupMs: 0
	});
	assert.throws(
		() => selectPresentingProcessId(analysis, new Set([200])),
		/inside the exact Windows Job membership/u
	);
});

test('offline replay collector preserves exact binary stdout bytes', async () => {
	const directory = await mkdtemp(
		join(testOutputRoot, 'offline-replay-bytes-')
	);
	const outputPath = join(directory, 'replay.csv');
	const expected = Buffer.from([
		0x41,
		0x00,
		0xff,
		0x0a,
		0x42
	]);
	const replay = await startOfflineReplayProcess(
		process.execPath,
		[
			'-e',
			`process.stdout.write(Buffer.from([${[...expected].join(',')}]))`
		],
		outputPath
	);
	await replay.started;
	const [exit, capture] = await Promise.all([
		replay.completed,
		replay.outputCapture
	]);
	assert.equal(exit.exitCode, 0);
	assert.equal(exit.stdout, '');
	assert.equal(capture.stdoutComplete, true);
	assert.equal(capture.stdoutByteLimitExceeded, false);
	assert.equal(capture.stdoutSizeBytes, expected.byteLength);
	assert.equal(
		capture.stdoutSha256,
		sha256Hex(expected)
	);
	assert.equal(capture.outputSizeBytesAtOpen, expected.byteLength);
	assert.equal(capture.outputSizeBytesAfterRead, expected.byteLength);
	assert.equal(
		capture.outputSha256AfterRead,
		sha256Hex(expected)
	);
	assert.deepEqual(
		Buffer.from(capture.outputContents ?? []),
		expected
	);
	assert.equal(capture.outputExistsAfter, true);
	assert.deepEqual(
		capture.outputIdentityAfterRead,
		capture.outputIdentityAtOpen
	);
});

test('offline replay collector aborts before accepting an oversized chunk', async () => {
	const directory = await mkdtemp(
		join(testOutputRoot, 'offline-replay-limit-')
	);
	const outputPath = join(directory, 'replay.csv');
	const replay = await startOfflineReplayProcess(
		process.execPath,
		[
			'-e',
			'process.stdout.write(Buffer.alloc(32, 0x61)); setInterval(() => {}, 1000)'
		],
		outputPath,
		8
	);
	await replay.started;
	const [exit, capture] = await Promise.all([
		replay.completed,
		replay.outputCapture
	]);
	assert.notEqual(exit.exitCode, 0);
	assert.equal(replay.stdoutByteLimitExceeded(), true);
	assert.equal(capture.stdoutByteLimitExceeded, true);
	assert.equal(capture.stdoutComplete, false);
	assert.equal(capture.stdoutSizeBytes, 0);
	assert.equal(capture.outputSizeBytesAtOpen, 0);
	assert.deepEqual(
		Buffer.from(capture.outputContents ?? []),
		Buffer.alloc(0)
	);
	assert.equal(
		capture.stdoutSha256,
		sha256Hex(Buffer.alloc(0))
	);
	assert.equal(
		capture.outputSha256AfterRead,
		sha256Hex(Buffer.alloc(0))
	);
});

test('offline replay collector requires an exclusive fresh output path', async () => {
	const directory = await mkdtemp(
		join(testOutputRoot, 'offline-replay-exclusive-')
	);
	const outputPath = join(directory, 'replay.csv');
	await writeFile(outputPath, 'existing');
	await assert.rejects(
		startOfflineReplayProcess(
			process.execPath,
			['-e', 'process.exit(0)'],
			outputPath
		),
		/error|exist/iu
	);
});

test('offline replay collector exposes output-path replacement evidence', async () => {
	const directory = await mkdtemp(
		join(testOutputRoot, 'offline-replay-replaced-')
	);
	const outputPath = join(directory, 'replay.csv');
	const movedPath = join(directory, 'owned-replay.csv');
	const expected = Buffer.from('owned-output', 'utf8');
	const replay = await startOfflineReplayProcess(
		process.execPath,
		[
			'-e',
			`setTimeout(() => process.stdout.write(${JSON.stringify(expected.toString('utf8'))}), 150)`
		],
		outputPath
	);
	await replay.started;
	await rename(outputPath, movedPath);
	await writeFile(outputPath, 'replacement-output');
	const [exit, capture] = await Promise.all([
		replay.completed,
		replay.outputCapture
	]);
	assert.equal(exit.exitCode, 0);
	assert.deepEqual(
		Buffer.from(capture.outputContents ?? []),
		expected
	);
	assert.equal(capture.outputExistsAfter, true);
	assert.notDeepEqual(
		capture.outputIdentityAfterRead,
		capture.outputIdentityAtOpen
	);
});

test('offline replay collector bounds stderr independently from stdout', async () => {
	const directory = await mkdtemp(
		join(testOutputRoot, 'offline-replay-stderr-')
	);
	const outputPath = join(directory, 'replay.csv');
	const replay = await startOfflineReplayProcess(
		process.execPath,
		[
			'-e',
			'process.stderr.write(Buffer.alloc(1024 * 1024 + 32, 0x65))'
		],
		outputPath
	);
	await replay.started;
	const [exit, capture] = await Promise.all([
		replay.completed,
		replay.outputCapture
	]);
	assert.equal(exit.exitCode, 0);
	assert.equal(exit.stderrTruncated, true);
	assert.equal(Buffer.byteLength(exit.stderr), 1024 * 1024);
	assert.equal(exit.stdout, '');
	assert.equal(exit.stdoutTruncated, false);
	assert.equal(capture.stdoutComplete, true);
	assert.equal(capture.stdoutSizeBytes, 0);
	assert.equal(capture.outputSizeBytesAtOpen, 0);
	assert.deepEqual(
		Buffer.from(capture.outputContents ?? []),
		Buffer.alloc(0)
	);
});

test('offline replay collector rejects invalid stdout byte limits before launch', async () => {
	const directory = await mkdtemp(
		join(testOutputRoot, 'offline-replay-invalid-limit-')
	);
	for (const [index, byteLimit] of [
		0,
		Number.NaN,
		256 * 1024 * 1024 + 1
	].entries()) {
		await assert.rejects(
			startOfflineReplayProcess(
				process.execPath,
				['-e', 'process.exit(0)'],
				join(directory, `replay-${index}.csv`),
				byteLimit
			),
			/byte limit is invalid/u
		);
	}
});
