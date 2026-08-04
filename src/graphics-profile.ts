export const GRAPHICS_BACKENDS = ['auto', 'default', 'd3d11', 'd3d11on12', 'vulkan'] as const;

export type GraphicsBackend = (typeof GRAPHICS_BACKENDS)[number];
export type AppliedGraphicsBackend = Exclude<GraphicsBackend, 'auto'>;
export type GraphicsSelectionSource = 'auto' | 'calibration' | 'manual' | 'recovery' | 'retained';
export type GraphicsLaunchInterruptionKind = 'clean' | 'unknown';
export type GraphicsLaunchOutcome = 'idle' | 'pending' | 'completed' | 'clean-interruption' | 'unknown-interruption' | 'gpu-failure';

export interface GraphicsDevice {
	active: boolean;
	deviceId: number;
	vendorId: number;
}

export interface GraphicsBackendFailure {
	backend: AppliedGraphicsBackend;
	failureCount: number;
	lastFailedAt: number;
	quarantineUntil: number;
	reason: string;
}

export interface GraphicsProfileState {
	version: 1;
	devices: GraphicsDevice[];
	hardwareFingerprint: string;
	driverFingerprint: string;
	recommendedBackend: AppliedGraphicsBackend;
	recommendationReason: string;
	/** Active quarantines retained for compatibility with calibration callers. */
	blockedBackends: AppliedGraphicsBackend[];
	backendFailures: GraphicsBackendFailure[];
	retainedBackend?: AppliedGraphicsBackend;
	retainedBackendReason?: string;
	lastAppliedBackend: AppliedGraphicsBackend;
	lastSelectionSource: GraphicsSelectionSource;
	launchPending: boolean;
	lastLaunchOutcome: GraphicsLaunchOutcome;
	gpuFailureCount: number;
	lastFailureReason?: string;
	lastInterruptionReason?: string;
	updatedAt: number;
}

export interface GraphicsSelection {
	backend: AppliedGraphicsBackend;
	preference: GraphicsBackend;
	reason: string;
	source: GraphicsSelectionSource;
}

const INTEL_VENDOR_ID = 0x8086;
const MICROSOFT_SOFTWARE_VENDOR_ID = 0x1414;
const NVIDIA_VENDOR_ID = 0x10de;
const AMD_VENDOR_ID = 0x1002;
const PROFILE_VERSION = 1;
export const GRAPHICS_QUARANTINE_BASE_MS = 5 * 60 * 1_000;
export const GRAPHICS_QUARANTINE_MAX_MS = 24 * 60 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAppliedGraphicsBackend(value: unknown): value is AppliedGraphicsBackend {
	return value === 'default' || value === 'd3d11' || value === 'd3d11on12' || value === 'vulkan';
}

function isGraphicsSelectionSource(value: unknown): value is GraphicsSelectionSource {
	return value === 'auto' || value === 'calibration' || value === 'manual' || value === 'recovery' || value === 'retained';
}

function isGraphicsLaunchOutcome(value: unknown): value is GraphicsLaunchOutcome {
	return value === 'idle'
		|| value === 'pending'
		|| value === 'completed'
		|| value === 'clean-interruption'
		|| value === 'unknown-interruption'
		|| value === 'gpu-failure';
}

function finiteTimestamp(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function normalizeGraphicsBackend(value: unknown): GraphicsBackend {
	return typeof value === 'string' && GRAPHICS_BACKENDS.includes(value as GraphicsBackend)
		? value as GraphicsBackend
		: 'auto';
}

export function normalizeGraphicsDevices(value: unknown): GraphicsDevice[] {
	if (!isRecord(value) || !Array.isArray(value.gpuDevice)) return [];

	return value.gpuDevice
		.filter(isRecord)
		.filter(device => Number.isInteger(device.vendorId) && Number.isInteger(device.deviceId))
		.map(device => ({
			active: device.active === true,
			deviceId: Number(device.deviceId),
			vendorId: Number(device.vendorId)
		}))
		.sort((left, right) => {
			if (left.active !== right.active) return left.active ? -1 : 1;
			return left.vendorId - right.vendorId || left.deviceId - right.deviceId;
		});
}

export function graphicsHardwareFingerprint(devices: GraphicsDevice[]): string {
	return [...devices]
		.sort((left, right) => left.vendorId - right.vendorId || left.deviceId - right.deviceId)
		.map(device => `${device.vendorId.toString(16)}:${device.deviceId.toString(16)}`)
		.join('|');
}

export interface IntegratedGpuAssessment {
	discreteVendorPresent: boolean;
	integratedActive: boolean;
	/** True when the Intel adapter is active while an NVIDIA or AMD adapter is also present. */
	suspectedIntegratedFallback: boolean;
}

/**
 * Flags the one clearly detectable dual-GPU misconfiguration: an NVIDIA or AMD adapter is present
 * but the Intel adapter is the active one, so the game is probably running on the power-saving
 * GPU. Advisory only — vendor IDs cannot distinguish every hybrid layout (Intel Arc discrete,
 * AMD APU plus AMD discrete), so this never drives an automatic action.
 */
export function assessIntegratedGpuUsage(devices: GraphicsDevice[], webglRenderer = ''): IntegratedGpuAssessment {
	const discreteVendorPresent = devices.some(device => device.vendorId === NVIDIA_VENDOR_ID || device.vendorId === AMD_VENDOR_ID);
	const activeDevices = devices.filter(device => device.active);
	const rendererLooksIntel = /\bintel\b/iu.test(webglRenderer);
	const rendererLooksDiscrete = /nvidia|geforce|quadro|radeon|\bamd\b/iu.test(webglRenderer);
	const integratedActive = activeDevices.length > 0
		? activeDevices.every(device => device.vendorId === INTEL_VENDOR_ID)
		: rendererLooksIntel;
	// A renderer string that contradicts the device flags (ANGLE already reporting the discrete
	// vendor) clears the suspicion rather than warning against direct evidence.
	const suspectedIntegratedFallback = discreteVendorPresent && integratedActive && !rendererLooksDiscrete;
	return { discreteVendorPresent, integratedActive, suspectedIntegratedFallback };
}

export function recommendGraphicsBackend(platform: NodeJS.Platform, devices: GraphicsDevice[]): Pick<GraphicsProfileState, 'recommendedBackend' | 'recommendationReason'> {
	if (platform !== 'win32') {
		return {
			recommendedBackend: 'default',
			recommendationReason: 'Chromium default is the conservative profile outside Windows.'
		};
	}

	const hardwareDevices = devices.filter(device =>
		device.vendorId > 0
		&& device.vendorId !== 0xffff
		&& device.vendorId !== MICROSOFT_SOFTWARE_VENDOR_ID
	);
	const vendorIds = new Set(hardwareDevices.map(device => device.vendorId));

	if (hardwareDevices.length > 0 && vendorIds.size === 1 && vendorIds.has(INTEL_VENDOR_ID)) {
		return {
			recommendedBackend: 'd3d11on12',
			recommendationReason: 'D3D11on12 is the tuned profile for Windows systems using only Intel graphics.'
		};
	}

	return {
		recommendedBackend: 'default',
		recommendationReason: 'Chromium default is retained for hybrid, AMD, NVIDIA, unknown, or software-rendered systems.'
	};
}

export function graphicsBackendCooldownMs(failureCount: number): number {
	const normalizedCount = Number.isFinite(failureCount) ? Math.max(1, Math.trunc(failureCount)) : 1;
	const exponent = Math.min(normalizedCount - 1, 30);
	return Math.min(GRAPHICS_QUARANTINE_BASE_MS * (2 ** exponent), GRAPHICS_QUARANTINE_MAX_MS);
}

function activeQuarantinedBackends(state: GraphicsProfileState, now: number): AppliedGraphicsBackend[] {
	const failuresByBackend = new Map(state.backendFailures.map(failure => [failure.backend, failure]));
	const active = new Set<AppliedGraphicsBackend>();

	for (const failure of state.backendFailures) {
		if (failure.backend !== 'default' && failure.quarantineUntil > now) active.add(failure.backend);
	}

	// Profiles written before bounded quarantine had only blockedBackends. Treat those
	// entries as one short cooldown instead of preserving a permanent block.
	for (const backend of state.blockedBackends) {
		if (
			backend !== 'default'
			&& !failuresByBackend.has(backend)
			&& state.updatedAt + GRAPHICS_QUARANTINE_BASE_MS > now
		) active.add(backend);
	}

	return GRAPHICS_BACKENDS.filter((backend): backend is AppliedGraphicsBackend => backend !== 'auto' && active.has(backend));
}

export function isGraphicsBackendQuarantined(
	state: GraphicsProfileState,
	backend: AppliedGraphicsBackend,
	now: number = Date.now()
): boolean {
	return activeQuarantinedBackends(state, now).includes(backend);
}

export function releaseExpiredGraphicsQuarantines(
	state: GraphicsProfileState,
	now: number = Date.now()
): GraphicsProfileState {
	const blockedBackends = activeQuarantinedBackends(state, now);
	if (arraysEqual(blockedBackends, state.blockedBackends)) return state;
	return {
		...state,
		blockedBackends,
		updatedAt: now
	};
}

export function createGraphicsProfileState(
	platform: NodeJS.Platform = process.platform,
	now: number = Date.now()
): GraphicsProfileState {
	const recommendation = recommendGraphicsBackend(platform, []);

	return {
		version: PROFILE_VERSION,
		devices: [],
		hardwareFingerprint: '',
		driverFingerprint: '',
		...recommendation,
		blockedBackends: [],
		backendFailures: [],
		lastAppliedBackend: 'default',
		lastSelectionSource: 'auto',
		launchPending: false,
		lastLaunchOutcome: 'idle',
		gpuFailureCount: 0,
		updatedAt: now
	};
}

function parseBackendFailures(value: unknown): GraphicsBackendFailure[] {
	if (!Array.isArray(value)) return [];
	const byBackend = new Map<AppliedGraphicsBackend, GraphicsBackendFailure>();

	for (const entry of value) {
		if (!isRecord(entry) || !isAppliedGraphicsBackend(entry.backend)) continue;
		const lastFailedAt = finiteTimestamp(entry.lastFailedAt, -1);
		const quarantineUntil = finiteTimestamp(entry.quarantineUntil, -1);
		if (lastFailedAt < 0 || quarantineUntil < lastFailedAt) continue;
		const failureCount = Number.isInteger(entry.failureCount) && Number(entry.failureCount) > 0
			? Number(entry.failureCount)
			: 1;
		const failure: GraphicsBackendFailure = {
			backend: entry.backend,
			failureCount,
			lastFailedAt,
			quarantineUntil,
			reason: typeof entry.reason === 'string' ? entry.reason : ''
		};
		const existing = byBackend.get(failure.backend);
		if (!existing || failure.lastFailedAt >= existing.lastFailedAt) byBackend.set(failure.backend, failure);
	}

	return [...byBackend.values()];
}

export function parseGraphicsProfileState(
	value: unknown,
	now: number = Date.now()
): GraphicsProfileState | undefined {
	if (!isRecord(value) || value.version !== PROFILE_VERSION) return undefined;

	const recommendedBackend = normalizeGraphicsBackend(value.recommendedBackend);
	const lastAppliedBackend = normalizeGraphicsBackend(value.lastAppliedBackend);
	if (recommendedBackend === 'auto' || lastAppliedBackend === 'auto') return undefined;

	const persistedBlockedBackends = Array.isArray(value.blockedBackends)
		? value.blockedBackends
			.map(normalizeGraphicsBackend)
			.filter((backend): backend is AppliedGraphicsBackend => backend !== 'auto')
		: [];
	if (!isGraphicsSelectionSource(value.lastSelectionSource)) return undefined;

	const devices = Array.isArray(value.devices)
		? value.devices
			.filter(isRecord)
			.filter(device => Number.isInteger(device.vendorId) && Number.isInteger(device.deviceId))
			.map(device => ({
				active: device.active === true,
				deviceId: Number(device.deviceId),
				vendorId: Number(device.vendorId)
			}))
		: [];
	const updatedAt = finiteTimestamp(value.updatedAt, now);
	const gpuFailureCount = Number.isInteger(value.gpuFailureCount) && Number(value.gpuFailureCount) >= 0
		? Number(value.gpuFailureCount)
		: 0;
	const backendFailures = parseBackendFailures(value.backendFailures);
	for (const backend of new Set(persistedBlockedBackends)) {
		if (backend === 'default' || backendFailures.some(failure => failure.backend === backend)) continue;
		backendFailures.push({
			backend,
			failureCount: 1,
			lastFailedAt: updatedAt,
			quarantineUntil: updatedAt + GRAPHICS_QUARANTINE_BASE_MS,
			reason: typeof value.lastFailureReason === 'string' ? value.lastFailureReason : 'Legacy graphics backend recovery cooldown.'
		});
	}
	const launchPending = value.launchPending === true;
	const lastLaunchOutcome = launchPending
		? 'pending'
		: isGraphicsLaunchOutcome(value.lastLaunchOutcome)
			? value.lastLaunchOutcome
			: gpuFailureCount > 0 && typeof value.lastFailureReason === 'string'
				? 'gpu-failure'
				: 'idle';
	const retainedBackend = isAppliedGraphicsBackend(value.retainedBackend) ? value.retainedBackend : undefined;

	const state: GraphicsProfileState = {
		version: PROFILE_VERSION,
		devices,
		hardwareFingerprint: typeof value.hardwareFingerprint === 'string' ? value.hardwareFingerprint : graphicsHardwareFingerprint(devices),
		driverFingerprint: typeof value.driverFingerprint === 'string' ? value.driverFingerprint : '',
		recommendedBackend,
		recommendationReason: typeof value.recommendationReason === 'string' ? value.recommendationReason : '',
		blockedBackends: [...new Set(persistedBlockedBackends)],
		backendFailures,
		...(retainedBackend ? { retainedBackend } : {}),
		...(retainedBackend && typeof value.retainedBackendReason === 'string' ? { retainedBackendReason: value.retainedBackendReason } : {}),
		lastAppliedBackend,
		lastSelectionSource: value.lastSelectionSource,
		launchPending,
		lastLaunchOutcome,
		gpuFailureCount,
		...(typeof value.lastFailureReason === 'string' ? { lastFailureReason: value.lastFailureReason } : {}),
		...(typeof value.lastInterruptionReason === 'string' ? { lastInterruptionReason: value.lastInterruptionReason } : {}),
		updatedAt
	};
	return releaseExpiredGraphicsQuarantines(state, now);
}

function clearIdentityScopedGraphicsState(state: GraphicsProfileState): GraphicsProfileState {
	return {
		...state,
		blockedBackends: [],
		backendFailures: [],
		retainedBackend: undefined,
		retainedBackendReason: undefined,
		gpuFailureCount: 0,
		lastFailureReason: undefined,
		lastLaunchOutcome: state.lastLaunchOutcome === 'gpu-failure' ? 'idle' : state.lastLaunchOutcome
	};
}

export function updateGraphicsDetection(
	state: GraphicsProfileState,
	platform: NodeJS.Platform,
	devices: GraphicsDevice[],
	now: number = Date.now()
): GraphicsProfileState {
	const hardwareFingerprint = graphicsHardwareFingerprint(devices);
	const hardwareChanged = state.hardwareFingerprint !== '' && state.hardwareFingerprint !== hardwareFingerprint;
	const recommendation = recommendGraphicsBackend(platform, devices);
	const identityState = hardwareChanged ? clearIdentityScopedGraphicsState(state) : state;

	return releaseExpiredGraphicsQuarantines({
		...identityState,
		devices,
		hardwareFingerprint,
		driverFingerprint: hardwareChanged ? '' : identityState.driverFingerprint,
		...recommendation,
		updatedAt: now
	}, now);
}

export function updateGraphicsDriverIdentity(
	state: GraphicsProfileState,
	driverFingerprint: string,
	now: number = Date.now()
): GraphicsProfileState {
	const normalizedFingerprint = driverFingerprint.trim();
	if (normalizedFingerprint === '') return releaseExpiredGraphicsQuarantines(state, now);
	const driverChanged = state.driverFingerprint !== '' && state.driverFingerprint !== normalizedFingerprint;
	const identityState = driverChanged ? clearIdentityScopedGraphicsState(state) : state;
	return releaseExpiredGraphicsQuarantines({
		...identityState,
		driverFingerprint: normalizedFingerprint,
		updatedAt: now
	}, now);
}

export function keepCurrentGraphicsBackend(
	state: GraphicsProfileState,
	backend: AppliedGraphicsBackend,
	reason = 'Keeping the current graphics backend after the alternative was rejected.',
	now: number = Date.now()
): GraphicsProfileState {
	return {
		...state,
		retainedBackend: backend,
		retainedBackendReason: reason,
		updatedAt: now
	};
}

export function clearKeptGraphicsBackend(
	state: GraphicsProfileState,
	now: number = Date.now()
): GraphicsProfileState {
	if (!state.retainedBackend && !state.retainedBackendReason) return state;
	return {
		...state,
		retainedBackend: undefined,
		retainedBackendReason: undefined,
		updatedAt: now
	};
}

function recordGpuFailure(
	state: GraphicsProfileState,
	backend: AppliedGraphicsBackend,
	reason: string,
	quarantine: boolean,
	now: number
): GraphicsProfileState {
	// Chromium can report several teardown events for one failed GPU process. Once this
	// launch has recorded its confirmed failure, later same-run events are diagnostics,
	// not independent launches that should lengthen the backend quarantine.
	if (!state.launchPending && state.lastLaunchOutcome === 'gpu-failure') return state;

	const previous = state.backendFailures.find(failure => failure.backend === backend);
	const previousIsRecent = previous && now <= previous.quarantineUntil + GRAPHICS_QUARANTINE_MAX_MS;
	const failureCount = previousIsRecent ? previous.failureCount + 1 : 1;
	// A non-quarantining record (and any 'default' failure, which has no safer fallback) keeps
	// the failure history without ever blocking the backend: quarantineUntil never lies in the
	// future, so activeQuarantinedBackends ignores the entry.
	const quarantineUntil = !quarantine || backend === 'default' ? now : now + graphicsBackendCooldownMs(failureCount);
	const failure: GraphicsBackendFailure = {
		backend,
		failureCount,
		lastFailedAt: now,
		quarantineUntil,
		reason
	};
	const backendFailures = [
		...state.backendFailures.filter(existing => existing.backend !== backend),
		failure
	];
	const failedState: GraphicsProfileState = {
		...state,
		backendFailures,
		launchPending: false,
		lastLaunchOutcome: 'gpu-failure',
		gpuFailureCount: state.gpuFailureCount + 1,
		lastFailureReason: reason,
		lastInterruptionReason: undefined,
		updatedAt: now
	};
	return releaseExpiredGraphicsQuarantines(failedState, now);
}

export function recordGraphicsGpuFailure(
	state: GraphicsProfileState,
	backend: AppliedGraphicsBackend,
	reason: string,
	now: number = Date.now()
): GraphicsProfileState {
	return recordGpuFailure(state, backend, reason, true, now);
}

/**
 * Records a GPU-process failure for a manually selected backend without quarantining it (audit
 * C5): the user's explicit choice keeps applying on the next launch, but the crash enters the
 * failure history so the settings advisory and the diagnostics report can show a crash-looping
 * manual selection instead of dropping the evidence. A later clean launch of the same backend
 * clears the history exactly like a quarantined one.
 */
export function recordManualGraphicsGpuFailure(
	state: GraphicsProfileState,
	backend: AppliedGraphicsBackend,
	reason: string,
	now: number = Date.now()
): GraphicsProfileState {
	return recordGpuFailure(state, backend, reason, false, now);
}

/**
 * Advisory for a crash-looping manual backend selection. Manual selections are exempt from
 * quarantine by design, so this advisory (surfaced through gpuAdvisory) and the diagnostics
 * failure history are the only places their GPU-process failures become visible.
 */
export function describeManualBackendFailures(
	state: GraphicsProfileState,
	selection: Pick<GraphicsSelection, 'backend' | 'source'>
): string | undefined {
	if (selection.source !== 'manual') return undefined;
	const failure = state.backendFailures.find(entry => entry.backend === selection.backend);
	if (!failure) return undefined;
	const times = failure.failureCount === 1 ? 'once' : `${failure.failureCount} times`;
	return `The manually selected ${selection.backend} backend crashed its GPU process ${times} recently. Manual selections are never quarantined; switch the graphics backend to Auto if the crashes continue.`;
}

/** @deprecated Use recordGraphicsGpuFailure for an explicitly observed GPU-process failure. */
export function recordGraphicsFailure(
	state: GraphicsProfileState,
	backend: AppliedGraphicsBackend,
	reason: string,
	now: number = Date.now()
): GraphicsProfileState {
	return recordGraphicsGpuFailure(state, backend, reason, now);
}

export function recordGraphicsLaunchInterruption(
	state: GraphicsProfileState,
	kind: GraphicsLaunchInterruptionKind,
	reason: string,
	now: number = Date.now()
): GraphicsProfileState {
	if (!state.launchPending) return releaseExpiredGraphicsQuarantines(state, now);
	return releaseExpiredGraphicsQuarantines({
		...state,
		launchPending: false,
		lastLaunchOutcome: kind === 'clean' ? 'clean-interruption' : 'unknown-interruption',
		lastInterruptionReason: reason,
		updatedAt: now
	}, now);
}

export function recordCleanGraphicsLaunchInterruption(
	state: GraphicsProfileState,
	reason = 'The graphics launch ended during a clean application shutdown.',
	now: number = Date.now()
): GraphicsProfileState {
	return recordGraphicsLaunchInterruption(state, 'clean', reason, now);
}

export function recordUnknownGraphicsLaunchInterruption(
	state: GraphicsProfileState,
	reason = 'The graphics launch ended without a success or GPU-failure signal.',
	now: number = Date.now()
): GraphicsProfileState {
	return recordGraphicsLaunchInterruption(state, 'unknown', reason, now);
}

export function recoverInterruptedGraphicsLaunch(
	state: GraphicsProfileState,
	reason?: string,
	now: number = Date.now()
): GraphicsProfileState {
	if (!state.launchPending) return releaseExpiredGraphicsQuarantines(state, now);
	const selectionLabel = state.lastSelectionSource === 'calibration' ? 'calibrated' : state.lastSelectionSource;
	return recordUnknownGraphicsLaunchInterruption(
		state,
		reason ?? `The previous ${selectionLabel} ${state.lastAppliedBackend} launch ended before a success or GPU-failure signal was recorded.`,
		now
	);
}

/** @deprecated Interrupted launches are unknown outcomes, not automatic GPU failures. */
export function recoverInterruptedAutoLaunch(
	state: GraphicsProfileState,
	now: number = Date.now()
): GraphicsProfileState {
	return recoverInterruptedGraphicsLaunch(state, undefined, now);
}

function backendSupportedOnPlatform(backend: AppliedGraphicsBackend, platform: NodeJS.Platform): boolean {
	return platform === 'win32' || (backend !== 'd3d11' && backend !== 'd3d11on12');
}

export function selectGraphicsBackend(
	preferenceValue: unknown,
	state: GraphicsProfileState,
	platform: NodeJS.Platform = process.platform,
	now: number = Date.now()
): GraphicsSelection {
	const preference = normalizeGraphicsBackend(preferenceValue);

	if (preference !== 'auto') {
		if (!backendSupportedOnPlatform(preference, platform)) {
			return {
				backend: 'default',
				preference,
				reason: `${preference} is Windows-only; Chromium default is being used on ${platform}.`,
				source: 'recovery'
			};
		}

		return {
			backend: preference,
			preference,
			reason: `Using the manually selected ${preference} graphics backend.`,
			source: 'manual'
		};
	}

	if (state.retainedBackend) {
		if (!backendSupportedOnPlatform(state.retainedBackend, platform)) {
			return {
				backend: 'default',
				preference,
				reason: `${state.retainedBackend} was kept on another platform; Chromium default is being used on ${platform}.`,
				source: 'recovery'
			};
		}
		if (isGraphicsBackendQuarantined(state, state.retainedBackend, now)) {
			return {
				backend: 'default',
				preference,
				reason: `${state.retainedBackend} is cooling down after a confirmed GPU-process failure; Chromium default is being used.`,
				source: 'recovery'
			};
		}
		return {
			backend: state.retainedBackend,
			preference,
			reason: state.retainedBackendReason ?? `Keeping the explicitly retained ${state.retainedBackend} graphics backend.`,
			source: 'retained'
		};
	}

	if (isGraphicsBackendQuarantined(state, state.recommendedBackend, now)) {
		return {
			backend: 'default',
			preference,
			reason: `${state.recommendedBackend} is cooling down after a confirmed GPU-process failure; Chromium default is being used.`,
			source: 'recovery'
		};
	}

	return {
		backend: state.recommendedBackend,
		preference,
		reason: state.recommendationReason,
		source: 'auto'
	};
}

export function beginGraphicsLaunch(
	state: GraphicsProfileState,
	selection: GraphicsSelection,
	now: number = Date.now()
): GraphicsProfileState {
	return {
		...state,
		lastAppliedBackend: selection.backend,
		lastSelectionSource: selection.source,
		launchPending: true,
		lastLaunchOutcome: 'pending',
		lastInterruptionReason: undefined,
		updatedAt: now
	};
}

export function completeGraphicsLaunch(
	state: GraphicsProfileState,
	now: number = Date.now()
): GraphicsProfileState {
	const backendFailures = state.backendFailures.filter(failure => failure.backend !== state.lastAppliedBackend);
	const latestRemainingFailure = [...backendFailures].sort((left, right) => right.lastFailedAt - left.lastFailedAt)[0];
	const completedState: GraphicsProfileState = {
		...state,
		blockedBackends: state.blockedBackends.filter(backend => backend !== state.lastAppliedBackend),
		backendFailures,
		launchPending: false,
		lastLaunchOutcome: 'completed',
		gpuFailureCount: backendFailures.reduce((count, failure) => count + failure.failureCount, 0),
		lastFailureReason: latestRemainingFailure?.reason,
		lastInterruptionReason: undefined,
		updatedAt: now
	};
	return releaseExpiredGraphicsQuarantines(completedState, now);
}
