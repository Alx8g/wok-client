import assert from 'node:assert/strict';
import test from 'node:test';
import {
	assessIntegratedGpuUsage,
	beginGraphicsLaunch,
	clearKeptGraphicsBackend,
	completeGraphicsLaunch,
	createGraphicsProfileState,
	describeManualBackendFailures,
	GRAPHICS_QUARANTINE_BASE_MS,
	GRAPHICS_QUARANTINE_MAX_MS,
	graphicsBackendCooldownMs,
	graphicsHardwareFingerprint,
	isGraphicsBackendQuarantined,
	keepCurrentGraphicsBackend,
	normalizeGraphicsDevices,
	parseGraphicsProfileState,
	recommendGraphicsBackend,
	recordCleanGraphicsLaunchInterruption,
	recordGraphicsGpuFailure,
	recordManualGraphicsGpuFailure,
	recordUnknownGraphicsLaunchInterruption,
	recoverInterruptedGraphicsLaunch,
	selectGraphicsBackend,
	updateGraphicsDetection,
	updateGraphicsDriverIdentity
} from '../src/graphics-profile.ts';

const START_TIME = 1_000_000;
const intelDevice = { active: true, deviceId: 0x46a6, vendorId: 0x8086 };
const microsoftSoftwareDevice = { active: false, deviceId: 0x008c, vendorId: 0x1414 };
const nvidiaDevice = { active: false, deviceId: 0x2684, vendorId: 0x10de };

function intelGraphicsState(now = START_TIME) {
	return updateGraphicsDetection(createGraphicsProfileState('win32', now), 'win32', [intelDevice], now);
}

test('normalizes and orders Chromium GPU devices', () => {
	const devices = normalizeGraphicsDevices({
		gpuDevice: [
			nvidiaDevice,
			intelDevice,
			{ active: true, deviceId: 'invalid', vendorId: 1 }
		]
	});

	assert.deepEqual(devices, [intelDevice, nvidiaDevice]);
});

test('hardware identity ignores adapter activity and enumeration order', () => {
	const activeIntel = { ...intelDevice, active: true };
	const inactiveIntel = { ...intelDevice, active: false };
	const activeNvidia = { ...nvidiaDevice, active: true };
	const inactiveNvidia = { ...nvidiaDevice, active: false };

	assert.equal(
		graphicsHardwareFingerprint([activeIntel, inactiveNvidia]),
		graphicsHardwareFingerprint([activeNvidia, inactiveIntel])
	);
});

test('selects D3D11on12 only for Intel-only Windows hardware', () => {
	assert.equal(recommendGraphicsBackend('win32', [intelDevice]).recommendedBackend, 'd3d11on12');
	assert.equal(recommendGraphicsBackend('win32', [intelDevice, microsoftSoftwareDevice]).recommendedBackend, 'd3d11on12');
	assert.equal(recommendGraphicsBackend('win32', [intelDevice, nvidiaDevice]).recommendedBackend, 'default');
	assert.equal(recommendGraphicsBackend('linux', [intelDevice]).recommendedBackend, 'default');
	assert.equal(recommendGraphicsBackend('darwin', [intelDevice]).recommendedBackend, 'default');
});

test('preserves a supported manual override', () => {
	const state = createGraphicsProfileState('win32', START_TIME);
	const selection = selectGraphicsBackend('vulkan', state, 'win32', START_TIME);

	assert.equal(selection.backend, 'vulkan');
	assert.equal(selection.source, 'manual');
});

test('rejects Windows-only manual backends on other platforms', () => {
	const linuxState = createGraphicsProfileState('linux', START_TIME);
	const linuxSelection = selectGraphicsBackend('d3d11on12', linuxState, 'linux', START_TIME);
	assert.equal(linuxSelection.backend, 'default');
	assert.equal(linuxSelection.source, 'recovery');

	const macState = createGraphicsProfileState('darwin', START_TIME);
	const macSelection = selectGraphicsBackend('d3d11', macState, 'darwin', START_TIME);
	assert.equal(macSelection.backend, 'default');
	assert.equal(macSelection.source, 'recovery');
});

test('a clean early close clears the launch marker without changing backend health', () => {
	let state = intelGraphicsState();
	const automaticSelection = selectGraphicsBackend('auto', state, 'win32', START_TIME);
	state = beginGraphicsLaunch(state, automaticSelection, START_TIME + 1);
	state = recordCleanGraphicsLaunchInterruption(state, 'User closed the window before navigation completed.', START_TIME + 2);

	assert.equal(state.launchPending, false);
	assert.equal(state.lastLaunchOutcome, 'clean-interruption');
	assert.equal(state.lastInterruptionReason, 'User closed the window before navigation completed.');
	assert.equal(state.gpuFailureCount, 0);
	assert.deepEqual(state.backendFailures, []);
	assert.deepEqual(state.blockedBackends, []);

	const nextSelection = selectGraphicsBackend('auto', state, 'win32', START_TIME + 3);
	assert.equal(nextSelection.backend, 'd3d11on12');
	assert.equal(nextSelection.source, 'auto');
});

test('an unknown or network interruption is not classified as a GPU failure', () => {
	let state = intelGraphicsState();
	state = beginGraphicsLaunch(
		state,
		selectGraphicsBackend('auto', state, 'win32', START_TIME),
		START_TIME + 1
	);
	state = recordUnknownGraphicsLaunchInterruption(state, 'Remote navigation ended while the network was unavailable.', START_TIME + 2);

	assert.equal(state.launchPending, false);
	assert.equal(state.lastLaunchOutcome, 'unknown-interruption');
	assert.equal(state.lastInterruptionReason, 'Remote navigation ended while the network was unavailable.');
	assert.equal(state.lastFailureReason, undefined);
	assert.equal(state.gpuFailureCount, 0);
	assert.deepEqual(state.blockedBackends, []);
	assert.equal(selectGraphicsBackend('auto', state, 'win32', START_TIME + 3).backend, 'd3d11on12');
});

test('a stale pending marker is recovered as an unknown outcome rather than a failure', () => {
	let state = intelGraphicsState();
	state = beginGraphicsLaunch(
		state,
		selectGraphicsBackend('auto', state, 'win32', START_TIME),
		START_TIME + 1
	);
	state = recoverInterruptedGraphicsLaunch(state, undefined, START_TIME + 2);

	assert.equal(state.lastLaunchOutcome, 'unknown-interruption');
	assert.match(state.lastInterruptionReason ?? '', /ended before a success or GPU-failure signal/u);
	assert.equal(state.gpuFailureCount, 0);
	assert.deepEqual(state.blockedBackends, []);
});

test('a confirmed GPU-process failure immediately selects a safe fallback', () => {
	let state = intelGraphicsState();
	state = beginGraphicsLaunch(
		state,
		selectGraphicsBackend('auto', state, 'win32', START_TIME),
		START_TIME + 1
	);
	state = recordGraphicsGpuFailure(
		state,
		'd3d11on12',
		'GPU process crashed with exit code 34.',
		START_TIME + 2
	);

	assert.equal(state.launchPending, false);
	assert.equal(state.lastLaunchOutcome, 'gpu-failure');
	assert.equal(state.gpuFailureCount, 1);
	assert.deepEqual(state.blockedBackends, ['d3d11on12']);
	assert.deepEqual(state.backendFailures, [{
		backend: 'd3d11on12',
		failureCount: 1,
		lastFailedAt: START_TIME + 2,
		quarantineUntil: START_TIME + 2 + GRAPHICS_QUARANTINE_BASE_MS,
		reason: 'GPU process crashed with exit code 34.'
	}]);
	assert.equal(isGraphicsBackendQuarantined(state, 'd3d11on12', START_TIME + 3), true);

	const recoverySelection = selectGraphicsBackend('auto', state, 'win32', START_TIME + 3);
	assert.equal(recoverySelection.backend, 'default');
	assert.equal(recoverySelection.source, 'recovery');
});

test('duplicate GPU teardown events in one launch do not escalate quarantine', () => {
	let state = intelGraphicsState();
	state = beginGraphicsLaunch(
		state,
		selectGraphicsBackend('auto', state, 'win32', START_TIME),
		START_TIME + 1
	);
	state = recordGraphicsGpuFailure(state, 'd3d11on12', 'GPU process crashed.', START_TIME + 2);
	const firstFailureState = state;
	state = recordGraphicsGpuFailure(state, 'd3d11on12', 'GPU process abnormal-exit.', START_TIME + 3);

	assert.equal(state, firstFailureState);
	assert.equal(state.gpuFailureCount, 1);
	assert.equal(state.backendFailures[0].failureCount, 1);
	assert.equal(state.backendFailures[0].reason, 'GPU process crashed.');
});

test('GPU failure quarantine expires and a successful retry clears backend failure history', () => {
	let state = recordGraphicsGpuFailure(
		intelGraphicsState(),
		'd3d11on12',
		'GPU process launch-failed.',
		START_TIME
	);
	const quarantineUntil = state.backendFailures[0].quarantineUntil;

	assert.equal(selectGraphicsBackend('auto', state, 'win32', quarantineUntil - 1).backend, 'default');
	const retrySelection = selectGraphicsBackend('auto', state, 'win32', quarantineUntil);
	assert.equal(retrySelection.backend, 'd3d11on12');
	assert.equal(retrySelection.source, 'auto');

	state = beginGraphicsLaunch(state, retrySelection, quarantineUntil + 1);
	state = completeGraphicsLaunch(state, quarantineUntil + 2);
	assert.equal(state.lastLaunchOutcome, 'completed');
	assert.equal(state.gpuFailureCount, 0);
	assert.equal(state.lastFailureReason, undefined);
	assert.deepEqual(state.blockedBackends, []);
	assert.deepEqual(state.backendFailures, []);
});

test('repeated confirmed failures use an increasing cooldown capped at a bounded maximum', () => {
	let state = intelGraphicsState();
	let now = START_TIME;
	let previousCooldown = 0;

	for (let failureCount = 1; failureCount <= 20; failureCount++) {
		state = beginGraphicsLaunch(state, {
			backend: 'd3d11on12',
			preference: 'auto',
			reason: 'Synthetic confirmed launch attempt.',
			source: 'auto'
		}, now);
		state = recordGraphicsGpuFailure(state, 'd3d11on12', `GPU failure ${failureCount}.`, now + 1);
		const failure = state.backendFailures[0];
		const cooldown = failure.quarantineUntil - (now + 1);
		assert.equal(failure.failureCount, failureCount);
		assert.equal(cooldown, graphicsBackendCooldownMs(failureCount));
		assert.ok(cooldown >= previousCooldown);
		assert.ok(cooldown <= GRAPHICS_QUARANTINE_MAX_MS);
		previousCooldown = cooldown;
		now++;
	}

	assert.equal(previousCooldown, GRAPHICS_QUARANTINE_MAX_MS);
});

test('keeping the current backend overrides an unaccepted automatic recommendation', () => {
	let state = intelGraphicsState();
	state = keepCurrentGraphicsBackend(
		state,
		'default',
		'Keeping Chromium default after rejecting the calibration recommendation.',
		START_TIME + 1
	);

	const persistedState = parseGraphicsProfileState(JSON.parse(JSON.stringify(state)), START_TIME + 2);
	assert.ok(persistedState);
	const retainedSelection = selectGraphicsBackend('auto', persistedState, 'win32', START_TIME + 2);
	assert.equal(persistedState.recommendedBackend, 'd3d11on12');
	assert.equal(retainedSelection.backend, 'default');
	assert.equal(retainedSelection.source, 'retained');
	assert.equal(retainedSelection.reason, 'Keeping Chromium default after rejecting the calibration recommendation.');

	state = clearKeptGraphicsBackend(persistedState, START_TIME + 3);
	assert.equal(selectGraphicsBackend('auto', state, 'win32', START_TIME + 4).backend, 'd3d11on12');
});

test('a confirmed failure of a retained non-default backend still uses safe fallback during cooldown', () => {
	let state = keepCurrentGraphicsBackend(intelGraphicsState(), 'd3d11on12', undefined, START_TIME);
	state = recordGraphicsGpuFailure(state, 'd3d11on12', 'GPU process abnormal-exit.', START_TIME + 1);

	assert.equal(selectGraphicsBackend('auto', state, 'win32', START_TIME + 2).backend, 'default');
	const quarantineUntil = state.backendFailures[0].quarantineUntil;
	const retry = selectGraphicsBackend('auto', state, 'win32', quarantineUntil);
	assert.equal(retry.backend, 'd3d11on12');
	assert.equal(retry.source, 'retained');
});

test('hardware identity changes clear quarantines and identity-scoped keep decisions', () => {
	let state = updateGraphicsDriverIdentity(intelGraphicsState(), 'driver-a', START_TIME + 1);
	state = keepCurrentGraphicsBackend(state, 'default', undefined, START_TIME + 2);
	state = recordGraphicsGpuFailure(state, 'd3d11on12', 'GPU process crashed.', START_TIME + 3);
	state = updateGraphicsDetection(state, 'win32', [nvidiaDevice], START_TIME + 4);

	assert.deepEqual(state.blockedBackends, []);
	assert.deepEqual(state.backendFailures, []);
	assert.equal(state.gpuFailureCount, 0);
	assert.equal(state.driverFingerprint, '');
	assert.equal(state.lastFailureReason, undefined);
	assert.equal(state.retainedBackend, undefined);
	assert.equal(state.recommendedBackend, 'default');
	assert.equal(selectGraphicsBackend('auto', state, 'win32', START_TIME + 4).source, 'auto');
});

test('driver identity changes clear quarantines while the same driver preserves them', () => {
	let state = updateGraphicsDriverIdentity(intelGraphicsState(), 'driver-a', START_TIME + 1);
	state = keepCurrentGraphicsBackend(state, 'default', undefined, START_TIME + 2);
	state = recordGraphicsGpuFailure(state, 'd3d11on12', 'GPU process crashed.', START_TIME + 3);
	state = updateGraphicsDriverIdentity(state, 'driver-a', START_TIME + 4);

	assert.deepEqual(state.blockedBackends, ['d3d11on12']);
	assert.equal(state.retainedBackend, 'default');
	assert.equal(state.gpuFailureCount, 1);

	state = updateGraphicsDriverIdentity(state, 'driver-b', START_TIME + 5);
	assert.deepEqual(state.blockedBackends, []);
	assert.deepEqual(state.backendFailures, []);
	assert.equal(state.gpuFailureCount, 0);
	assert.equal(state.retainedBackend, undefined);
	const selection = selectGraphicsBackend('auto', state, 'win32', START_TIME + 6);
	assert.equal(selection.backend, 'd3d11on12');
	assert.equal(selection.source, 'auto');
});

test('legacy permanent blocks are migrated to a bounded cooldown', () => {
	const legacyProfile = {
		version: 1,
		devices: [intelDevice],
		hardwareFingerprint: '1:8086:46a6',
		recommendedBackend: 'd3d11on12',
		recommendationReason: 'Legacy recommendation.',
		blockedBackends: ['d3d11on12'],
		lastAppliedBackend: 'd3d11on12',
		lastSelectionSource: 'auto',
		launchPending: false,
		gpuFailureCount: 1,
		lastFailureReason: 'Legacy failed launch.',
		updatedAt: START_TIME
	};

	const duringCooldown = parseGraphicsProfileState(legacyProfile, START_TIME + 1);
	assert.ok(duringCooldown);
	assert.deepEqual(duringCooldown.blockedBackends, ['d3d11on12']);
	assert.equal(duringCooldown.backendFailures[0].quarantineUntil, START_TIME + GRAPHICS_QUARANTINE_BASE_MS);

	const afterCooldown = parseGraphicsProfileState(legacyProfile, START_TIME + GRAPHICS_QUARANTINE_BASE_MS);
	assert.ok(afterCooldown);
	assert.deepEqual(afterCooldown.blockedBackends, []);
	assert.equal(selectGraphicsBackend('auto', afterCooldown, 'win32', START_TIME + GRAPHICS_QUARANTINE_BASE_MS).backend, 'd3d11on12');
});

test('assessIntegratedGpuUsage flags Intel-active systems with an idle discrete adapter', () => {
	const activeIntel = { active: true, deviceId: 0x46a6, vendorId: 0x8086 };
	const idleNvidia = { active: false, deviceId: 0x2684, vendorId: 0x10de };
	const idleAmd = { active: false, deviceId: 0x744c, vendorId: 0x1002 };

	assert.deepEqual(assessIntegratedGpuUsage([activeIntel, idleNvidia]), {
		discreteVendorPresent: true,
		integratedActive: true,
		suspectedIntegratedFallback: true
	});
	assert.equal(assessIntegratedGpuUsage([activeIntel, idleAmd]).suspectedIntegratedFallback, true);
});

test('assessIntegratedGpuUsage stays quiet without discrete evidence or on discrete-active systems', () => {
	const activeIntel = { active: true, deviceId: 0x46a6, vendorId: 0x8086 };
	const activeNvidia = { active: true, deviceId: 0x2684, vendorId: 0x10de };
	const softwareDevice = { active: false, deviceId: 0x008c, vendorId: 0x1414 };

	// Intel-only laptop (the software rasterizer is not discrete hardware).
	assert.equal(assessIntegratedGpuUsage([activeIntel, softwareDevice]).suspectedIntegratedFallback, false);
	// Discrete adapter is the active one.
	assert.equal(assessIntegratedGpuUsage([{ ...activeIntel, active: false }, activeNvidia]).suspectedIntegratedFallback, false);
	// Both marked active: Chromium is already using the discrete adapter for rendering.
	assert.equal(assessIntegratedGpuUsage([activeIntel, activeNvidia]).suspectedIntegratedFallback, false);
	// No devices at all.
	assert.equal(assessIntegratedGpuUsage([]).suspectedIntegratedFallback, false);
});

test('assessIntegratedGpuUsage falls back to the renderer string when active flags are missing', () => {
	const unflaggedIntel = { active: false, deviceId: 0x46a6, vendorId: 0x8086 };
	const unflaggedNvidia = { active: false, deviceId: 0x2684, vendorId: 0x10de };
	const intelRenderer = 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
	const nvidiaRenderer = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)';

	assert.equal(assessIntegratedGpuUsage([unflaggedIntel, unflaggedNvidia], intelRenderer).suspectedIntegratedFallback, true);
	// Direct renderer evidence of the discrete vendor clears the suspicion.
	assert.equal(assessIntegratedGpuUsage([unflaggedIntel, unflaggedNvidia], nvidiaRenderer).suspectedIntegratedFallback, false);
	// No usable evidence in either direction.
	assert.equal(assessIntegratedGpuUsage([unflaggedIntel, unflaggedNvidia], '').suspectedIntegratedFallback, false);
});

test('manual-backend GPU failures are recorded without quarantine and keep the manual choice', () => {
	let state = intelGraphicsState();
	const manualSelection = selectGraphicsBackend('d3d11', state, 'win32', START_TIME);
	assert.equal(manualSelection.source, 'manual');

	state = beginGraphicsLaunch(state, manualSelection, START_TIME + 1);
	state = recordManualGraphicsGpuFailure(state, 'd3d11', 'GPU process crashed with exit code 5.', START_TIME + 2);

	// The failure is fully recorded...
	assert.equal(state.launchPending, false);
	assert.equal(state.lastLaunchOutcome, 'gpu-failure');
	assert.equal(state.gpuFailureCount, 1);
	assert.deepEqual(state.backendFailures, [{
		backend: 'd3d11',
		failureCount: 1,
		lastFailedAt: START_TIME + 2,
		quarantineUntil: START_TIME + 2,
		reason: 'GPU process crashed with exit code 5.'
	}]);
	// ...but never quarantined: the explicit manual choice keeps applying on the next launch.
	assert.equal(isGraphicsBackendQuarantined(state, 'd3d11', START_TIME + 3), false);
	assert.deepEqual(state.blockedBackends, []);
	assert.equal(selectGraphicsBackend('d3d11', state, 'win32', START_TIME + 3).backend, 'd3d11');
});

test('repeated manual failures accumulate history and duplicate teardown events stay deduplicated', () => {
	let state = intelGraphicsState();
	state = beginGraphicsLaunch(state, selectGraphicsBackend('d3d11', state, 'win32', START_TIME), START_TIME + 1);
	state = recordManualGraphicsGpuFailure(state, 'd3d11', 'GPU process crashed.', START_TIME + 2);
	const firstFailureState = state;
	// Same launch: Chromium can emit several teardown events for one failed GPU process.
	state = recordManualGraphicsGpuFailure(state, 'd3d11', 'GPU process abnormal-exit.', START_TIME + 3);
	assert.equal(state, firstFailureState);

	// Next crash-looping launch.
	state = beginGraphicsLaunch(state, selectGraphicsBackend('d3d11', state, 'win32', START_TIME + 10), START_TIME + 10);
	state = recordManualGraphicsGpuFailure(state, 'd3d11', 'GPU process crashed.', START_TIME + 11);
	assert.equal(state.backendFailures[0].failureCount, 2);
	assert.equal(isGraphicsBackendQuarantined(state, 'd3d11', START_TIME + 12), false);

	// The recorded history survives the profile's JSON round trip.
	const persisted = parseGraphicsProfileState(JSON.parse(JSON.stringify(state)), START_TIME + 12);
	assert.ok(persisted);
	assert.equal(persisted.backendFailures[0].failureCount, 2);
	assert.equal(isGraphicsBackendQuarantined(persisted, 'd3d11', START_TIME + 12), false);
});

test('a clean launch clears manual failure history exactly like a quarantined one', () => {
	let state = intelGraphicsState();
	state = beginGraphicsLaunch(state, selectGraphicsBackend('d3d11', state, 'win32', START_TIME), START_TIME + 1);
	state = recordManualGraphicsGpuFailure(state, 'd3d11', 'GPU process crashed.', START_TIME + 2);

	state = beginGraphicsLaunch(state, selectGraphicsBackend('d3d11', state, 'win32', START_TIME + 10), START_TIME + 10);
	state = completeGraphicsLaunch(state, START_TIME + 11);
	assert.deepEqual(state.backendFailures, []);
	assert.equal(state.gpuFailureCount, 0);
});

test('describeManualBackendFailures advises only about the crashing manual selection', () => {
	let state = intelGraphicsState();
	state = beginGraphicsLaunch(state, selectGraphicsBackend('d3d11', state, 'win32', START_TIME), START_TIME + 1);
	state = recordManualGraphicsGpuFailure(state, 'd3d11', 'GPU process crashed.', START_TIME + 2);

	const advisory = describeManualBackendFailures(state, { backend: 'd3d11', source: 'manual' });
	assert.match(advisory ?? '', /manually selected d3d11 backend crashed its GPU process once/u);
	assert.match(advisory ?? '', /never quarantined/u);

	// A second recent failure changes the count wording.
	state = beginGraphicsLaunch(state, selectGraphicsBackend('d3d11', state, 'win32', START_TIME + 10), START_TIME + 10);
	state = recordManualGraphicsGpuFailure(state, 'd3d11', 'GPU process crashed.', START_TIME + 11);
	assert.match(describeManualBackendFailures(state, { backend: 'd3d11', source: 'manual' }) ?? '', /2 times/u);

	// No advisory for other selection sources, other backends, or clean manual choices.
	assert.equal(describeManualBackendFailures(state, { backend: 'd3d11', source: 'auto' }), undefined);
	assert.equal(describeManualBackendFailures(state, { backend: 'vulkan', source: 'manual' }), undefined);
	assert.equal(describeManualBackendFailures(intelGraphicsState(), { backend: 'd3d11', source: 'manual' }), undefined);
});
