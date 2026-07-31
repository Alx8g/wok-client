import { createHash } from 'crypto';
import { join as pathJoin, resolve as pathResolve } from 'path';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { BrowserWindow, Menu, type MenuItem, type MenuItemConstructorOptions, app, clipboard, dialog, ipcMain, protocol, session, shell, screen, type BrowserWindowConstructorOptions, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { aboutSubmenu, macAppMenuArr, csMenuTemplate, constructDevtoolsSubmenu } from './menu.ts';
import { applyCommandLineSwitches } from './switches.ts';
import RequestHandler from './requesthandler.ts';
import {
	beginGraphicsLaunch,
	clearKeptGraphicsBackend,
	completeGraphicsLaunch,
	createGraphicsProfileState,
	isGraphicsBackendQuarantined,
	keepCurrentGraphicsBackend,
	normalizeGraphicsDevices,
	parseGraphicsProfileState,
	recordCleanGraphicsLaunchInterruption,
	recordGraphicsGpuFailure,
	recordUnknownGraphicsLaunchInterruption,
	recoverInterruptedGraphicsLaunch,
	releaseExpiredGraphicsQuarantines,
	selectGraphicsBackend,
	updateGraphicsDetection,
	updateGraphicsDriverIdentity,
	type GraphicsProfileState,
	type GraphicsSelection
} from './graphics-profile.ts';
import { APP_ID, APP_PROTOCOL, LEGACY_APP_PROTOCOL, UPSTREAM_REPO_URL, WEBSITE_URL } from './branding.ts';
import { migrateLegacyConfigs } from './config-migration.ts';
import {
	CALIBRATION_BENCHMARK_MS,
	CALIBRATION_LOW_CONFIDENCE_REASONS,
	CALIBRATION_VERSION,
	CALIBRATION_WARMUP_MS,
	collectStableGraphicsDriverFields,
	completeCalibration,
	createCalibrationCandidates,
	createCalibrationSignature,
	finalizeCalibration,
	getPendingCalibrationCandidate,
	parseCalibrationState,
	prepareCalibrationState,
	recordCalibrationResult,
	requestCalibrationRerun,
	type CalibrationCandidate,
	type CalibrationLowConfidenceReason,
	type CalibrationMetrics,
	type CalibrationState,
	type FramePolicy
} from './calibration.ts';
import type { CompetitiveGameSettings } from './competitive-mode.ts';
import { parseUserPreferencePatch } from './user-preferences.ts';
import {
	ADAPTIVE_VALIDATION_PROFILE_SEMANTIC_VERSION,
	adaptiveValidationProfileIdentitiesEqual,
	dismissAdaptiveValidationRecommendation,
	parseAdaptiveValidationProfileIdentity,
	parseAdaptiveValidationState,
	parseAdaptiveValidationSubmission,
	prepareAdaptiveValidationState,
	recordAdaptiveValidationSession,
	type AdaptiveValidationProfileIdentity,
	type AdaptiveValidationState
} from './adaptive-validation.ts';

// Diagnostic-only startup marks. Inert unless WOK_PERF_MARKS is set in the environment.
const perfMarksEnabled = Boolean(process.env.WOK_PERF_MARKS);
const perfProcessStartWallClockMs = perfMarksEnabled ? Date.now() - process.uptime() * 1_000 : 0;
const perfExitAfterLoadMs = Number.parseInt(process.env.WOK_PERF_EXIT_MS ?? '', 10);
let perfExitScheduled = false;

function logPerfMark(name: string, wallClockMs = Date.now()) {
	if (!perfMarksEnabled) return;
	console.log(`[wok-mark] ${name} ${(wallClockMs - perfProcessStartWallClockMs).toFixed(1)}`);
}

if (perfMarksEnabled) {
	ipcMain.on('wok_perf_mark', (_event, name: unknown, wallClockMs: unknown) => {
		if (typeof name !== 'string' || name.length > 64 || typeof wallClockMs !== 'number' || !Number.isFinite(wallClockMs)) return;
		logPerfMark(name, wallClockMs);
	});
}
logPerfMark('main-module-eval-start');

const configPath = pathJoin(app.getPath('userData'), 'config');
const legacyRoamingConfigPath = pathJoin(app.getPath('appData'), 'crankshaft', 'config');
const legacyDocumentsConfigPath = pathJoin(app.getPath('documents'), 'Crankshaft');
const windowScale = 0.8; // In windowed mode, the window will cover 80% of the height/width of the screen.

let clientUrlStartup: string | null = null;
const clientProtocols = [APP_PROTOCOL, LEGACY_APP_PROTOCOL] as const;

function isKrunkerHostname(hostname: string): boolean {
	return hostname === 'krunker.io' || hostname.endsWith('.krunker.io');
}

function parseKrunkerUrl(value: string, allowEditor = false): URL | undefined {
	if (typeof value !== 'string' || value.length > 2_048) return undefined;
	try {
		const url = new URL(value);
		if (
			url.protocol !== 'https:'
			|| !isKrunkerHostname(url.hostname)
			|| (!allowEditor && url.hostname === 'editor.krunker.io')
			|| url.username
			|| url.password
		) return undefined;
		return url;
	} catch (_error) {
		return undefined;
	}
}

function parseExternalUrl(value: unknown): URL | undefined {
	if (typeof value !== 'string' || value.length > 2_048) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password ? url : undefined;
	} catch (_error) {
		return undefined;
	}
}

function parseClientUrl(value: string): string | undefined {
	if (typeof value !== 'string' || value.length > 4_096) return undefined;
	try {
		const url = new URL(value);
		return clientProtocols.some(clientProtocol => url.protocol === `${clientProtocol}:`)
			? url.toString()
			: undefined;
	} catch (_error) {
		return undefined;
	}
}

function findClientUrl(args: string[]): string | undefined {
	for (const argument of args) {
		const parsed = parseClientUrl(argument);
		if (parsed) return parsed;
	}
	return undefined;
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
	app.quit();
} else {
	const protocolClientArguments = process.defaultApp && process.argv.length >= 2
		? [pathResolve(process.argv[1])]
		: undefined;
	for (const clientProtocol of clientProtocols) {
		const isProtocolClient = protocolClientArguments
			? app.isDefaultProtocolClient(clientProtocol, process.execPath, protocolClientArguments)
			: app.isDefaultProtocolClient(clientProtocol);
		if (isProtocolClient) continue;

		if (protocolClientArguments) app.setAsDefaultProtocolClient(clientProtocol, process.execPath, protocolClientArguments);
		else app.setAsDefaultProtocolClient(clientProtocol);
	}

	app.on('second-instance', (_event, commandLine, _workingDirectory) => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
		}
		const url = findClientUrl(commandLine);
		if (!url) return;
		if (mainWindow) mainWindow.webContents.send('process-startup-url', url);
		else clientUrlStartup = url;
	});

	// macOS delivers custom protocol links through open-url rather than process.argv.
	app.on('open-url', (event, rawUrl) => {
		event.preventDefault();
		const url = parseClientUrl(rawUrl);
		if (!url) return;
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
			mainWindow.webContents.send('process-startup-url', url);
		} else {
			clientUrlStartup = url;
		}
	});

try {
	const migration = migrateLegacyConfigs(configPath, [
		{ label: 'Crankshaft AppData', path: legacyRoamingConfigPath },
		{ label: 'Crankshaft Documents', path: legacyDocumentsConfigPath }
	]);
	if (migration.foundSources.length > 0) {
		console.log(`Migrated ${migration.copiedFiles} legacy configuration files from ${migration.foundSources.join(', ')}; preserved ${migration.skippedConflicts} existing WOK Client files.`);
	}
} catch (error) {
	console.error('Failed to migrate legacy Crankshaft configuration. The original files were left untouched.', error);
}

const swapperPath = pathJoin(configPath, 'swapper');
const settingsPath = pathJoin(configPath, 'settings.json');
const graphicsProfilePath = pathJoin(configPath, 'graphics-profile.json');
const calibrationPath = pathJoin(configPath, 'calibration.json');
const adaptiveValidationPath = pathJoin(configPath, 'adaptive-validation.json');
const competitiveModeBackupPath = pathJoin(configPath, 'competitive-mode-backup.json');
const safetyBaselinePath = pathJoin(configPath, 'safety-baseline-v1.json');
const filtersPath = pathJoin(configPath, 'filters.txt');
const cssPath = pathJoin(configPath, 'css');
const exampleCssPath = pathJoin(cssPath, 'example.css');

const settingsSkeleton = {
	fpsUncap: true,
	graphicsBackend: 'auto',
	competitiveMode: false,
	performanceOverlay: false,
	menuTimer: false,
	quickClassPicker: false,
	fullscreen: 'windowed', // windowed, maximized, fullscreen, borderless
	resourceSwapper: false,
	cssSwapper: 'None',
	clientSplash: true,
	immersiveSplash: false,
	discordRPC: false,
	extendedRPC: true,
	saveMatchResultJSONButton: false,
	overrideURL: undefined as string | undefined,
	alwaysWaitForDevTools: false,
	safeFlags_disableBackgrounding: true,
	safeFlags_gpuRasterizing: true,
	experimentalFlags_increaseLimits: false,
	experimentalFlags_experimental: false,
	matchmaker: false,
	competitionAutomation: false,
	matchmakerKey: {
		shift: false,
		alt: false,
		ctrl: false,
		key: "F1"
	},
	matchmakerAcceptKey: {
		shift: false,
		alt: false,
		ctrl: false,
		key: "Enter"
	},
	matchmakerCancelKey: {
		shift: false,
		alt: false,
		ctrl: false,
		key: "Escape"
	},
	matchmaker_openServerWindow: true,
	matchmaker_regions: [] as string[],
	matchmaker_gamemodes: [] as string[],
	matchmaker_minPlayers: 1,
	matchmaker_maxPlayers: 6,
	matchmaker_minRemainingTime: 120,
	hideAds: 'off',
	customFilters: false,
	regionTimezones: false,
	immersiveSplashBackgroundColor: '#0A0A0A',
	loadingSplashTitleCardBackgroundColor: '#0A0A0A'
};

const userPrefs = settingsSkeleton;

if (!existsSync(configPath)) mkdirSync(configPath, { recursive: true });
if (!existsSync(settingsPath)) writeFileSync(settingsPath, JSON.stringify(settingsSkeleton, null, 2), { encoding: 'utf-8', flag: 'wx' });
try {
	Object.assign(
		userPrefs,
		parseUserPreferencePatch(JSON.parse(readFileSync(settingsPath, { encoding: 'utf-8' })))
	);
} catch (error) {
	console.error('Failed to read WOK Client settings; using safe defaults', error);
}

function loadGraphicsProfile(): GraphicsProfileState {
	if (!existsSync(graphicsProfilePath)) return createGraphicsProfileState();

	try {
		return parseGraphicsProfileState(JSON.parse(readFileSync(graphicsProfilePath, 'utf-8')))
			?? createGraphicsProfileState();
	} catch (error) {
		console.error('Failed to read the graphics profile; using safe defaults', error);
		return createGraphicsProfileState();
	}
}

function writeGraphicsProfileSync(state: GraphicsProfileState) {
	try {
		writeFileSync(graphicsProfilePath, JSON.stringify(state, null, 2), { encoding: 'utf-8' });
	} catch (error) {
		console.error('Failed to persist graphics recovery state', error);
	}
}

function loadCalibrationState(): CalibrationState | undefined {
	if (!existsSync(calibrationPath)) return undefined;
	try {
		return parseCalibrationState(JSON.parse(readFileSync(calibrationPath, 'utf-8')));
	} catch (error) {
		console.error('Failed to read WOK Client calibration state', error);
		return undefined;
	}
}

function writeCalibrationStateSync(state: CalibrationState) {
	try {
		writeFileSync(calibrationPath, JSON.stringify(state, null, 2), { encoding: 'utf-8' });
	} catch (error) {
		console.error('Failed to persist WOK Client calibration state', error);
	}
}

function loadAdaptiveValidationState(): AdaptiveValidationState | undefined {
	if (!existsSync(adaptiveValidationPath)) return undefined;
	try {
		return parseAdaptiveValidationState(JSON.parse(readFileSync(adaptiveValidationPath, 'utf-8')));
	} catch (error) {
		console.error('Failed to read adaptive gameplay validation state', error);
		return undefined;
	}
}

function writeAdaptiveValidationStateSync(state: AdaptiveValidationState) {
	try {
		writeFileSync(adaptiveValidationPath, JSON.stringify(state, null, 2), { encoding: 'utf-8' });
	} catch (error) {
		console.error('Failed to persist adaptive gameplay validation state', error);
	}
}

function failedCalibrationMetrics(): CalibrationMetrics {
	return {
		averageFps: 0,
		eventLoopP95Ms: 0,
		eventLoopWorstMs: 0,
		longFrameRatio: 1,
		lowConfidenceReasons: [],
		onePercentLowFps: 0,
		p95FrameTimeMs: 0,
		sampleCount: 0,
		success: false,
		webglRenderer: '',
		worstFrameTimeMs: 0
	};
}

function calibrationDriverFingerprint(gpuInfo: unknown): string {
	const driverValues = collectStableGraphicsDriverFields(gpuInfo);
	return createHash('sha256').update(driverValues.join('|') || 'unknown-driver').digest('hex');
}

function normalizeBenchmarkMetrics(value: unknown): CalibrationMetrics {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return failedCalibrationMetrics();
	const metrics = value as Record<string, unknown>;
	const numberValue = (key: string) => typeof metrics[key] === 'number' && Number.isFinite(metrics[key]) ? Number(metrics[key]) : 0;
	const lowConfidenceReasons = Array.isArray(metrics.lowConfidenceReasons)
		? [...new Set(metrics.lowConfidenceReasons.filter(
			(reason): reason is CalibrationLowConfidenceReason =>
				typeof reason === 'string'
				&& CALIBRATION_LOW_CONFIDENCE_REASONS.includes(reason as CalibrationLowConfidenceReason)
		))]
		: [];
	return {
		averageFps: numberValue('averageFps'),
		eventLoopP95Ms: numberValue('eventLoopP95Ms'),
		eventLoopWorstMs: numberValue('eventLoopWorstMs'),
		longFrameRatio: numberValue('longFrameRatio'),
		lowConfidenceReasons,
		onePercentLowFps: numberValue('onePercentLowFps'),
		p95FrameTimeMs: numberValue('p95FrameTimeMs'),
		sampleCount: Math.max(0, Math.trunc(numberValue('sampleCount'))),
		success: metrics.success === true,
		webglRenderer: typeof metrics.webglRenderer === 'string' ? metrics.webglRenderer.slice(0, 1_024) : '',
		worstFrameTimeMs: numberValue('worstFrameTimeMs')
	};
}

let graphicsProfileState = releaseExpiredGraphicsQuarantines(
	recoverInterruptedGraphicsLaunch(loadGraphicsProfile())
);
let calibrationState = loadCalibrationState();
let queuedCalibrationCandidate = calibrationState ? getPendingCalibrationCandidate(calibrationState) : undefined;
if (
	queuedCalibrationCandidate
	&& graphicsProfileState.lastSelectionSource === 'calibration'
	&& graphicsProfileState.lastAppliedBackend === queuedCalibrationCandidate.backend
	&& graphicsProfileState.lastLaunchOutcome === 'gpu-failure'
	&& typeof graphicsProfileState.lastFailureReason === 'string'
	&& graphicsProfileState.updatedAt > calibrationState.updatedAt
) {
	calibrationState = recordCalibrationResult(
		calibrationState,
		queuedCalibrationCandidate,
		failedCalibrationMetrics(),
		graphicsProfileState.lastFailureReason
	);
	writeCalibrationStateSync(calibrationState);
	queuedCalibrationCandidate = getPendingCalibrationCandidate(calibrationState);
}

const activeCalibrationSelection = userPrefs.competitiveMode && calibrationState?.status === 'complete'
	? calibrationState.activeSelection
	: undefined;
const calibratedCandidate = queuedCalibrationCandidate ?? activeCalibrationSelection?.candidate;
const graphicsSelection: GraphicsSelection = process.argv.includes('--safe-graphics')
	? {
		backend: 'default',
		preference: 'default',
		reason: 'Safe graphics mode was requested from the command line.',
		source: 'recovery'
	}
	: calibratedCandidate && !isGraphicsBackendQuarantined(graphicsProfileState, calibratedCandidate.backend)
		? {
			backend: calibratedCandidate.backend,
			preference: 'auto',
			reason: queuedCalibrationCandidate
				? `Running calibration profile ${calibratedCandidate.id}.`
				: `Using calibrated Competitive mode profile ${calibratedCandidate.id}.`,
			source: 'calibration'
		}
		: selectGraphicsBackend(userPrefs.graphicsBackend, graphicsProfileState);
const effectiveFramePolicy: FramePolicy = queuedCalibrationCandidate?.framePolicy
	?? activeCalibrationSelection?.candidate.framePolicy
	?? (userPrefs.fpsUncap ? 'uncapped' : 'capped');
graphicsProfileState = beginGraphicsLaunch(graphicsProfileState, graphicsSelection);
writeGraphicsProfileSync(graphicsProfileState);
console.log(`Graphics profile: ${graphicsSelection.reason}`);

let adaptiveValidationState = loadAdaptiveValidationState();

function getAdaptiveValidationProfileIdentity(): AdaptiveValidationProfileIdentity | undefined {
	const calibrationSignature = calibrationState?.signature;
	return parseAdaptiveValidationProfileIdentity({
		activeBackend: graphicsSelection.backend,
		benchmarkSemanticVersion: calibrationSignature?.benchmarkVersion ?? CALIBRATION_VERSION,
		driverFingerprint: graphicsProfileState.driverFingerprint || calibrationSignature?.driverFingerprint || '',
		electronVersion: process.versions.electron,
		framePolicy: effectiveFramePolicy,
		hardwareFingerprint: graphicsProfileState.hardwareFingerprint || calibrationSignature?.hardwareFingerprint || '',
		profileSemanticVersion: ADAPTIVE_VALIDATION_PROFILE_SEMANTIC_VERSION
	});
}

function prepareCurrentAdaptiveValidationState(): AdaptiveValidationState | undefined {
	const profile = getAdaptiveValidationProfileIdentity();
	if (!profile) return undefined;
	const preparedState = prepareAdaptiveValidationState(adaptiveValidationState, profile);
	if (preparedState !== adaptiveValidationState) writeAdaptiveValidationStateSync(preparedState);
	adaptiveValidationState = preparedState;
	return preparedState;
}

if (userPrefs.competitiveMode) prepareCurrentAdaptiveValidationState();

function ensureFilterStorage() {
	if (existsSync(filtersPath)) return;
	writeFileSync(filtersPath,
		`# Welcome to the filters file! Filters follow the URL pattern format:
# https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns
# Hashtags are used for comments, and each line is a new filter.
# Here's an example of a filter that blocks the cosmetic bundle popup audio:
# *://assets.krunker.io/sound/bundle_*.mp3*
`);
}

function ensureCssStorage() {
	if (!existsSync(cssPath)) mkdirSync(cssPath, { recursive: true });
	if (!existsSync(exampleCssPath)) {
		writeFileSync(exampleCssPath,
			`/* This is an example of a css file that can be loaded by WOK Client. */
/* Files in this directory automatically show up in the CSS Swapper setting's dropdown. */`);
	}
}

function ensureOptionalFeatureStorage() {
	if (!existsSync(swapperPath)) mkdirSync(swapperPath, { recursive: true });
	ensureFilterStorage();
	ensureCssStorage();
}

if (userPrefs.customFilters) ensureFilterStorage();
if (userPrefs.cssSwapper !== 'None') ensureCssStorage();


// convert legacy settings files to newer formats
let modifiedSettings = false;
let writeSafetyBaseline = false;

const indexedUserPrefs = userPrefs as UserPrefs;
for (const obsoletePreference of ['inProcessGPU', 'userscripts']) {
	if (!Object.hasOwn(indexedUserPrefs, obsoletePreference)) continue;
	delete indexedUserPrefs[obsoletePreference];
	modifiedSettings = true;
}

// Existing Crankshaft/WOK profiles may have Terms-sensitive features enabled by default.
// Reset them once, then preserve any later explicit user choice.
if (!existsSync(safetyBaselinePath)) {
	const safeFeatureDefaults: Partial<UserPrefs> = {
		competitionAutomation: false,
		customFilters: false,
		hideAds: 'off',
		matchmaker: false,
		resourceSwapper: false
	};
	for (const [key, value] of Object.entries(safeFeatureDefaults)) {
		if (indexedUserPrefs[key] === value || value === undefined) continue;
		indexedUserPrefs[key] = value;
		modifiedSettings = true;
	}
	writeSafetyBaseline = true;
}

// initially, fullscreen was a true/false, now it's "windowed", "fullscreen" or "borderless"
if (typeof userPrefs.fullscreen === 'boolean') {
	modifiedSettings = true;
	if (userPrefs.fullscreen === true) userPrefs.fullscreen = 'fullscreen'; else userPrefs.fullscreen = 'windowed';
}

// borderless is now broken on windows, and I don't think there's a fix?
if (process.platform === "win32" && userPrefs.fullscreen === 'borderless') {
	userPrefs.fullscreen = 'windowed';
}

// initially, hideAds was a true/false, now it's "block", "hide" or "off"
if (typeof userPrefs.hideAds === 'boolean') {
	modifiedSettings = true;
	if (userPrefs.hideAds === true) userPrefs.hideAds = 'hide'; else userPrefs.hideAds = 'off';
}

// Move untouched Crankshaft splash defaults to the WOK palette while preserving custom colours.
if (userPrefs.immersiveSplashBackgroundColor === '#171717') {
	userPrefs.immersiveSplashBackgroundColor = '#0A0A0A';
	modifiedSettings = true;
}
if (userPrefs.loadingSplashTitleCardBackgroundColor === '#363636') {
	userPrefs.loadingSplashTitleCardBackgroundColor = '#0A0A0A';
	modifiedSettings = true;
}

// write the new settings format to the settings.json file right after the conversion
if (modifiedSettings) writeFileSync(settingsPath, JSON.stringify(userPrefs, null, 2), { encoding: 'utf-8' });
if (writeSafetyBaseline) {
	writeFileSync(safetyBaselinePath, JSON.stringify({ appliedAt: Date.now(), version: 1 }, null, 2), {
		encoding: 'utf-8',
		flag: 'wx'
	});
}

let mainWindow: BrowserWindow;
let gpuFeatureStatus: Record<string, string> = {};

function isTrustedGameIpcSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
	if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
	if (event.senderFrame !== mainWindow.webContents.mainFrame) return false;
	return parseKrunkerUrl(event.senderFrame.url, true) !== undefined;
}

app.on('gpu-info-update', () => {
	gpuFeatureStatus = Object.fromEntries(
		Object.entries(app.getGPUFeatureStatus())
			.filter((entry): entry is [string, string] => typeof entry[1] === 'string')
	);
});

function getGraphicsRuntimeInfo(): GraphicsRuntimeInfo {
	return {
		activeBackend: graphicsSelection.backend,
		preference: graphicsSelection.preference,
		recommendation: graphicsProfileState.recommendedBackend,
		reason: graphicsSelection.reason,
		source: graphicsSelection.source,
		features: gpuFeatureStatus
	};
}

const competitiveGameSettingKeys = new Set([
	'antiAlias',
	'ambientShading',
	'bloom',
	'highResShad',
	'muzzleFlash',
	'particles',
	'postProcessing',
	'reflection',
	'screenShake',
	'shadows',
	'shadowsDynamic',
	'softShad',
	'ssao',
	'weaponShine'
]);

interface CompetitiveModeBackup {
	createdAt: number;
	settings: CompetitiveGameSettings;
	version: 1;
}

function parseCompetitiveModeBackup(value: unknown): CompetitiveModeBackup | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const backup = value as Record<string, unknown>;
	if (backup.version !== 1 || !backup.settings || typeof backup.settings !== 'object' || Array.isArray(backup.settings)) return undefined;

	const settings = Object.fromEntries(
		Object.entries(backup.settings as Record<string, unknown>)
			.filter(([key, settingValue]) => competitiveGameSettingKeys.has(key) && (typeof settingValue === 'boolean' || typeof settingValue === 'number' || typeof settingValue === 'string'))
	) as CompetitiveGameSettings;
	if (Object.keys(settings).length === 0) return undefined;
	return {
		createdAt: typeof backup.createdAt === 'number' ? backup.createdAt : Date.now(),
		settings,
		version: 1
	};
}

function loadCompetitiveModeBackup(): CompetitiveModeBackup | undefined {
	if (!existsSync(competitiveModeBackupPath)) return undefined;
	try {
		return parseCompetitiveModeBackup(JSON.parse(readFileSync(competitiveModeBackupPath, 'utf-8')));
	} catch (error) {
		console.error('Failed to read Competitive mode game-settings backup', error);
		return undefined;
	}
}

function writeCompetitiveModeBackup(settings: CompetitiveGameSettings): CompetitiveModeBackup {
	const existing = loadCompetitiveModeBackup();
	if (existing) return existing;
	const backup = parseCompetitiveModeBackup({ createdAt: Date.now(), settings, version: 1 });
	if (!backup) throw new Error('Competitive mode supplied no valid game settings to back up.');
	writeFileSync(competitiveModeBackupPath, JSON.stringify(backup, null, 2), { encoding: 'utf-8', flag: 'wx' });
	return backup;
}

const SETTINGS_WRITE_DELAY_MS = 200;
let settingsWriteTimer: ReturnType<typeof setTimeout> | undefined;
let settingsWriteQueue: Promise<void> = Promise.resolve();
let settingsRevision = 0;
let persistedSettingsRevision = 0;
let settingsReadyToQuit = false;

function persistGraphicsProfile() {
	// Recovery state is tiny and must reach disk before a GPU/process failure can terminate the app.
	writeGraphicsProfileSync(graphicsProfileState);
}

function enqueueSettingsWrite() {
	const revision = settingsRevision;
	const contents = JSON.stringify(userPrefs, null, 2);
	settingsWriteQueue = settingsWriteQueue
		.then(() => writeFile(settingsPath, contents, { encoding: 'utf-8' }))
		.then(() => { persistedSettingsRevision = Math.max(persistedSettingsRevision, revision); })
		.catch(error => { console.error('Failed to save WOK Client settings', error); });
}

function scheduleSettingsWrite() {
	if (settingsWriteTimer) clearTimeout(settingsWriteTimer);
	settingsWriteTimer = setTimeout(() => {
		settingsWriteTimer = undefined;
		enqueueSettingsWrite();
	}, SETTINGS_WRITE_DELAY_MS);
}

app.on('before-quit', () => {
	if (!graphicsProfileState.launchPending) return;
	graphicsProfileState = recordCleanGraphicsLaunchInterruption(graphicsProfileState);
	persistGraphicsProfile();
});

app.on('before-quit', event => {
	if (settingsReadyToQuit || (!settingsWriteTimer && persistedSettingsRevision >= settingsRevision)) return;

	event.preventDefault();
	if (settingsWriteTimer) {
		clearTimeout(settingsWriteTimer);
		settingsWriteTimer = undefined;
		enqueueSettingsWrite();
	}

	void settingsWriteQueue.finally(() => {
		settingsReadyToQuit = true;
		app.quit();
	});
});

const graphicsFailureReasons = new Set(['abnormal-exit', 'crashed', 'oom', 'launch-failed', 'integrity-failure']);
let activeCalibrationFailureReason: string | undefined;
app.on('child-process-gone', (_event, details) => {
	if (
		details.type !== 'GPU'
		|| !graphicsFailureReasons.has(details.reason)
		|| !['auto', 'calibration', 'retained'].includes(graphicsSelection.source)
	) return;

	const reason = `GPU process ${details.reason} with exit code ${details.exitCode}.`;
	graphicsProfileState = recordGraphicsGpuFailure(graphicsProfileState, graphicsSelection.backend, reason);
	persistGraphicsProfile();
	if (queuedCalibrationCandidate) activeCalibrationFailureReason = reason;
	console.error(`${graphicsSelection.source === 'calibration' ? 'Calibrated' : 'Automatic'} graphics backend ${graphicsSelection.backend} failed and will fall back on the next launch.`);
});

function relaunchClient() {
	const args = process.argv.slice(1).filter(argument => argument !== '--safe-graphics');
	app.relaunch({ args });
	app.exit(0);
}

let adaptiveValidationPromptPending = false;

async function maybePromptAdaptiveRecalibration(): Promise<void> {
	const state = adaptiveValidationState;
	if (
		adaptiveValidationPromptPending
		|| !userPrefs.competitiveMode
		|| !state
		|| state.status !== 'complete'
		|| state.classification !== 'recalibration-recommended'
		|| state.recommendationDismissedAt !== undefined
		|| !mainWindow
		|| mainWindow.isDestroyed()
	) return;

	adaptiveValidationPromptPending = true;
	try {
		const result = await dialog.showMessageBox(mainWindow, {
			buttons: ['Recalibrate now', 'Not now'],
			cancelId: 1,
			defaultId: 0,
			detail: `All three clean gameplay sessions showed severe instability. Worst observed p95 frame time: ${state.summary.maximumP95FrameTimeMs.toFixed(2)} ms. Calibration will still ask before applying a different profile.`,
			message: 'WOK recommends rerunning graphics calibration.',
			noLink: true,
			title: 'WOK performance recommendation',
			type: 'warning'
		});
		if (adaptiveValidationState !== state) return;

		if (result.response === 0) {
			if (calibrationState) {
				calibrationState = requestCalibrationRerun(calibrationState);
				writeCalibrationStateSync(calibrationState);
			}
			relaunchClient();
			return;
		}

		adaptiveValidationState = dismissAdaptiveValidationRecommendation(state);
		writeAdaptiveValidationStateSync(adaptiveValidationState);
	} catch (error) {
		console.error('Failed to show adaptive gameplay validation recommendation', error);
	} finally {
		adaptiveValidationPromptPending = false;
	}
}

ipcMain.handle('adaptiveValidation_recordSession', (event, value: unknown) => {
	if (!userPrefs.competitiveMode || !isTrustedGameIpcSender(event)) return undefined;
	const currentState = prepareCurrentAdaptiveValidationState();
	if (!currentState) return undefined;
	const submission = parseAdaptiveValidationSubmission(value);
	if (!submission || !adaptiveValidationProfileIdentitiesEqual(submission.profile, currentState.profile)) return currentState;

	const nextState = recordAdaptiveValidationSession(currentState, submission.session);
	if (nextState !== currentState) writeAdaptiveValidationStateSync(nextState);
	adaptiveValidationState = nextState;
	void maybePromptAdaptiveRecalibration();
	return nextState;
});

ipcMain.handle('competitiveMode_getBackup', event => (
	isTrustedGameIpcSender(event) ? loadCompetitiveModeBackup() : undefined
));
ipcMain.handle('competitiveMode_storeBackup', (event, settings: CompetitiveGameSettings) => {
	if (!isTrustedGameIpcSender(event)) return undefined;
	try {
		return writeCompetitiveModeBackup(settings);
	} catch (error) {
		console.error('Rejected invalid Competitive mode backup', error);
		return undefined;
	}
});
ipcMain.handle('competitiveMode_clearBackup', event => {
	if (!isTrustedGameIpcSender(event)) return false;
	if (existsSync(competitiveModeBackupPath)) unlinkSync(competitiveModeBackupPath);
	return true;
});
ipcMain.on('calibration_request_rerun', event => {
	if (!isTrustedGameIpcSender(event)) return;
	if (calibrationState) {
		calibrationState = requestCalibrationRerun(calibrationState);
		writeCalibrationStateSync(calibrationState);
	}
	relaunchClient();
});

// initial request of settings to populate the settingsUI
ipcMain.on('settingsUI_requests_userPrefs', event => {
	if (!isTrustedGameIpcSender(event)) return;
	ensureOptionalFeatureStorage();
	const paths = { settingsPath, swapperPath, cssPath, filtersPath, configPath };
	mainWindow.webContents.send('m_userPrefs_for_settingsUI', paths, userPrefs);
});

// Preload requests the latest settings to feed into matchmaker.
ipcMain.on('matchmaker_requests_userPrefs', event => {
	if (!isTrustedGameIpcSender(event)) return;
	mainWindow.webContents.send('matchmakerRedirect', userPrefs);
});

// Coalesce validated renderer updates and persist them without blocking the UI or main process.
ipcMain.on('settingsUI_updates_userPrefs', (event, data: unknown) => {
	if (!isTrustedGameIpcSender(event)) return;
	const parsedUpdates = parseUserPreferencePatch(data);
	const validUpdates = Object.fromEntries(
		Object.entries(parsedUpdates).filter(([key]) => Object.hasOwn(userPrefs, key))
	);
	if (Object.keys(validUpdates).length === 0) return;

	Object.assign(userPrefs, validUpdates);
	settingsRevision++;
	scheduleSettingsWrite();
});

// Allow the trusted preload to quit the entire Electron process.
ipcMain.on('closeClient', event => {
	if (isTrustedGameIpcSender(event)) app.quit();
});

const $assets = pathResolve(import.meta.dirname, '..', 'assets');

function calibrationDataUrl(html: string): string {
	return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createCalibrationWindow(): BrowserWindow {
	const calibrationWindow = new BrowserWindow({
		alwaysOnTop: true,
		backgroundColor: '#0A0A0A',
		center: true,
		height: 680,
		minHeight: 620,
		minWidth: 860,
		show: false,
		width: 960,
		webPreferences: {
			backgroundThrottling: false,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			spellcheck: false
		}
	});
	calibrationWindow.setAutoHideMenuBar(true);
	calibrationWindow.setMenuBarVisibility(false);
	calibrationWindow.once('ready-to-show', () => {
		calibrationWindow.show();
		calibrationWindow.focus();
	});
	return calibrationWindow;
}

async function runCalibrationTrial(candidate: CalibrationCandidate, step: number, total: number): Promise<CalibrationMetrics> {
	const [{ buildCalibrationTrialPage }, markSvg] = await Promise.all([
		import('./calibration-window.ts'),
		readFile(pathJoin($assets, 'wok-mark.svg'), 'utf-8')
	]);
	mainWindow = createCalibrationWindow();
	await mainWindow.loadURL(calibrationDataUrl(buildCalibrationTrialPage(candidate, step, total, markSvg)));

	const timeoutMs = CALIBRATION_WARMUP_MS + CALIBRATION_BENCHMARK_MS + 5_000;
	const timeout = new Promise<never>((_resolve, reject) => {
		setTimeout(() => reject(new Error('Calibration renderer timed out.')), timeoutMs);
	});
	const closed = new Promise<never>((_resolve, reject) => {
		mainWindow.once('closed', () => reject(new Error('Calibration window was closed.')));
	});
	const benchmark = mainWindow.webContents.executeJavaScript(
		`window.wokRunBenchmark(${JSON.stringify({ warmupMs: CALIBRATION_WARMUP_MS, benchmarkMs: CALIBRATION_BENCHMARK_MS })})`
	);
	return normalizeBenchmarkMetrics(await Promise.race([benchmark, timeout, closed]));
}

async function showCalibrationDecision(state: CalibrationState): Promise<'apply' | 'keep'> {
	const [{ buildCalibrationResultPage }, markSvg] = await Promise.all([
		import('./calibration-window.ts'),
		readFile(pathJoin($assets, 'wok-mark.svg'), 'utf-8')
	]);
	if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createCalibrationWindow();
	await mainWindow.loadURL(calibrationDataUrl(buildCalibrationResultPage(
		state.results,
		state.recommendedSelection,
		markSvg,
		state.competitiveModeWasEnabled
	)));
	return mainWindow.webContents.executeJavaScript('window.wokWaitForCalibrationDecision()') as Promise<'apply' | 'keep'>;
}

function prepareCalibrationForGpuInfo(gpuInfo: unknown): CalibrationState {
	const signature = createCalibrationSignature(
		app.getVersion(),
		process.versions.electron,
		graphicsProfileState.hardwareFingerprint,
		calibrationDriverFingerprint(gpuInfo)
	);
	const releasedGraphicsState = releaseExpiredGraphicsQuarantines(graphicsProfileState);
	if (releasedGraphicsState !== graphicsProfileState) {
		graphicsProfileState = releasedGraphicsState;
		persistGraphicsProfile();
	}

	const candidates = createCalibrationCandidates({
		blockedBackends: graphicsProfileState.blockedBackends,
		currentBackend: graphicsSelection.backend,
		currentFramePolicy: effectiveFramePolicy,
		platform: process.platform,
		recommendedBackend: graphicsProfileState.recommendedBackend
	});
	const preparedState = prepareCalibrationState(calibrationState, signature, candidates, Boolean(userPrefs.competitiveMode));
	if (preparedState !== calibrationState) writeCalibrationStateSync(preparedState);
	calibrationState = preparedState;
	return preparedState;
}

async function runCalibrationFlow(gpuInfo: unknown): Promise<boolean> {
	if (process.argv.includes('--safe-graphics')) return false;

	prepareCalibrationForGpuInfo(gpuInfo);
	if (!calibrationState || calibrationState.status === 'complete') return false;

	let pendingCandidate = getPendingCalibrationCandidate(calibrationState);
	while (pendingCandidate && isGraphicsBackendQuarantined(graphicsProfileState, pendingCandidate.backend)) {
		calibrationState = recordCalibrationResult(
			calibrationState,
			pendingCandidate,
			failedCalibrationMetrics(),
			`${pendingCandidate.backend} is blocked after a previous GPU-process failure.`
		);
		writeCalibrationStateSync(calibrationState);
		pendingCandidate = getPendingCalibrationCandidate(calibrationState);
	}

	if (calibrationState.status === 'running' && pendingCandidate) {
		if (pendingCandidate.backend !== graphicsSelection.backend || pendingCandidate.framePolicy !== effectiveFramePolicy) {
			relaunchClient();
			return true;
		}

		const step = calibrationState.results.length + 1;
		let metrics = failedCalibrationMetrics();
		let failureReason: string | undefined;
		try {
			metrics = await runCalibrationTrial(pendingCandidate, step, calibrationState.candidates.length);
			failureReason = activeCalibrationFailureReason;
			if (failureReason) metrics = failedCalibrationMetrics();
			else if (!metrics.success) failureReason = 'WebGL calibration did not return valid frame samples.';
		} catch (error) {
			if (!mainWindow || mainWindow.isDestroyed()) {
				if (graphicsProfileState.launchPending) {
					graphicsProfileState = completeGraphicsLaunch(graphicsProfileState);
					persistGraphicsProfile();
				}
				app.quit();
				return true;
			}
			failureReason = error instanceof Error ? error.message : String(error);
		}

		calibrationState = recordCalibrationResult(calibrationState, pendingCandidate, metrics, failureReason);
		writeCalibrationStateSync(calibrationState);
		if (graphicsProfileState.launchPending) {
			graphicsProfileState = completeGraphicsLaunch(graphicsProfileState);
			persistGraphicsProfile();
		}

		if (getPendingCalibrationCandidate(calibrationState)) {
			relaunchClient();
			return true;
		}
	}

	if (calibrationState.status === 'running') {
		calibrationState = finalizeCalibration(calibrationState);
		writeCalibrationStateSync(calibrationState);
	}
	if (graphicsProfileState.launchPending) {
		graphicsProfileState = completeGraphicsLaunch(graphicsProfileState);
		persistGraphicsProfile();
	}

	try {
		const decision = await showCalibrationDecision(calibrationState);
		const applyRecommendation = decision === 'apply' && Boolean(calibrationState.recommendedSelection);
		calibrationState = completeCalibration(calibrationState, applyRecommendation);
		writeCalibrationStateSync(calibrationState);

		if (applyRecommendation && calibrationState.activeSelection) {
			graphicsProfileState = clearKeptGraphicsBackend(graphicsProfileState);
			persistGraphicsProfile();
			userPrefs.competitiveMode = true;
			userPrefs.graphicsBackend = 'auto';
			userPrefs.fpsUncap = calibrationState.activeSelection.candidate.framePolicy === 'uncapped';
			writeFileSync(settingsPath, JSON.stringify(userPrefs, null, 2), { encoding: 'utf-8' });
		} else {
			const retainedBackend = calibrationState.activeSelection?.candidate.backend
				?? calibrationState.candidates[0]?.backend
				?? graphicsSelection.backend;
			graphicsProfileState = keepCurrentGraphicsBackend(
				graphicsProfileState,
				retainedBackend,
				`Keeping ${retainedBackend} after the calibration recommendation was declined.`
			);
			persistGraphicsProfile();
		}
		relaunchClient();
	} catch (error) {
		console.error('Calibration confirmation was interrupted', error);
		app.quit();
	}
	return true;
}

// apply settings and flags
applyCommandLineSwitches(userPrefs, graphicsSelection.backend, effectiveFramePolicy);

if (userPrefs.resourceSwapper) {
	protocol.registerSchemesAsPrivileged([ {
		scheme: 'krunker-resource-swapper',
		privileges: {
			secure: true,
			corsEnabled: true
		}
	} ]);
}

async function refreshCompleteGraphicsInfo(): Promise<unknown> {
	try {
		const gpuInfo = await app.getGPUInfo('complete');
		const devices = normalizeGraphicsDevices(gpuInfo);
		graphicsProfileState = updateGraphicsDetection(graphicsProfileState, process.platform, devices);
		graphicsProfileState = updateGraphicsDriverIdentity(
			graphicsProfileState,
			calibrationDriverFingerprint(gpuInfo)
		);
		persistGraphicsProfile();
		console.log(`Detected ${devices.length} graphics adapter${devices.length === 1 ? '' : 's'}; next-launch recommendation: ${graphicsProfileState.recommendedBackend}`);
		return gpuInfo;
	} catch (error) {
		console.error('Failed to detect graphics adapters', error);
		return {};
	}
}

// Listen for app to get ready
app.on('ready', async () => {
	logPerfMark('app-ready');
	app.setAppUserModelId(APP_ID);

	const calibrationBlocksStartup = calibrationState === undefined
		|| calibrationState.status !== 'complete'
		|| calibrationState.rerunRequested;

	// Overlap DNS/TCP/TLS setup for the game origin with the rest of startup.
	if (!calibrationBlocksStartup && !process.argv.includes('--safe-graphics')) {
		try {
			session.defaultSession.preconnect({ numSockets: 2, url: 'https://krunker.io' });
		} catch (error) {
			console.error('Failed to preconnect to the game origin', error);
		}
	}

	let completeGraphicsIdentityReady = false;
	if (calibrationBlocksStartup) {
		const gpuInfo = await refreshCompleteGraphicsInfo();
		completeGraphicsIdentityReady = true;
		if (await runCalibrationFlow(gpuInfo)) return;
	}

	const screenSize = screen.getPrimaryDisplay().size;

	clientUrlStartup ??= findClientUrl(process.argv) ?? null;

	// Hand the preload everything it needs to inject CSS and mount the splash at document
	// start instead of waiting for did-finish-load. The preload falls back to the
	// injectClientCSS IPC message when the argument is missing or unparsable.
	const bootPayloadArguments = (() => {
		try {
			const payload = encodeURIComponent(JSON.stringify({ cssPath, userPrefs, version: app.getVersion() }));
			// Stay far below the Windows command-line length limit.
			return payload.length <= 24_000 ? [`--wok-boot=${payload}`] : [];
		} catch (error) {
			console.error('Failed to serialize the preload boot payload', error);
			return [];
		}
	})();

	const mainWindowProps: BrowserWindowConstructorOptions = {
		show: false,
		width: screenSize.width * windowScale,
		height: screenSize.height * windowScale,
		center: true,
		webPreferences: {
			additionalArguments: bootPayloadArguments,
			preload: pathJoin(import.meta.dirname, 'preload.ts'),
			spellcheck: false,
			backgroundThrottling: false,
			nodeIntegration: false,
			// not ideal, but preload does a lot of interaction w/ the page
			// turning this on will also likely require transpiling the preload script to js
			contextIsolation: false,
			sandbox: false,
			// Cache V8 code for Krunker's multi-MB bundle without waiting for Blink's
			// seen-it-twice heat heuristic, shifting compile work off early relaunches.
			v8CacheOptions: 'bypassHeatCheck'
		},
		backgroundColor: '#000000'
	};

	// userPrefs.fullscreen = maximized gets handled later
	switch (userPrefs.fullscreen) {
		case 'fullscreen':
			mainWindowProps.fullscreen = true;
			break;
		case 'borderless': {
			const dimensions = screen.getPrimaryDisplay().bounds;
			const borderlessProps: BrowserWindowConstructorOptions = {
				frame: false,
				kiosk: true,
				fullscreenable: false,
				fullscreen: false,
				width: dimensions.width,
				height: dimensions.height
			};

			Object.assign(mainWindowProps, borderlessProps);
			break;
		}
		case 'windowed':
		default:
			mainWindowProps.fullscreen = false;
			break;
	}

	mainWindow = new BrowserWindow(mainWindowProps);
	logPerfMark('window-created');
	if (userPrefs.fullscreen === 'borderless') mainWindow.moveTop();

	let discordRPCReady = false;
	let updateDiscordRPC: ((data: RPCargs) => void) | undefined;
	let destroyDiscordRPC: (() => Promise<void>) | undefined;

	ipcMain.on('preload_updates_DiscordRPC', (event, value: unknown) => {
		if (!isTrustedGameIpcSender(event) || !value || typeof value !== 'object' || Array.isArray(value)) return;
		const data = value as Record<string, unknown>;
		if (
			typeof data.details !== 'string'
			|| data.details.length > 128
			|| typeof data.state !== 'string'
			|| data.state.length > 128
		) return;
		updateDiscordRPC?.({ details: data.details, state: data.state });
	});

	if (userPrefs.discordRPC) {
		void import('./discord-rpc.ts').then(({ DiscordRpcClient }) => {
			const rpc = new DiscordRpcClient('988529967220523068');
			const startTimestamp = new Date();
			destroyDiscordRPC = () => rpc.destroy();

			updateDiscordRPC = ({ details, state }: RPCargs) => {
				const data: Parameters<typeof rpc.setActivity>[0] = {
					details,
					state,
					timestamps: { start: Math.floor(startTimestamp.getTime() / 1000) },
					assets: {
						large_image: 'logo',
						large_text: 'Playing Krunker'
					}
				};
				if (userPrefs.extendedRPC) {
					data.buttons = [
						{ label: 'WOK Client', url: WEBSITE_URL },
						{ label: 'Crankshaft upstream', url: UPSTREAM_REPO_URL }
					];
				}
				void rpc.setActivity(data).catch(console.error);
			};

			rpc.on('ready', () => {
				discordRPCReady = true;
				if (!mainWindow.webContents.isLoading()) mainWindow.webContents.send('initDiscordRPC');
			});
			void rpc.login().catch(console.error);
		}).catch(error => { console.error('Failed to initialize Discord RPC', error); });
	}

	app.on('before-quit', () => {
		if (!destroyDiscordRPC) return;
		const destroy = destroyDiscordRPC;
		destroyDiscordRPC = undefined;
		void destroy().catch(console.error);
	});

	// general ready to show, runs when window refreshes or loads url
	mainWindow.on('ready-to-show', () => {
		if (userPrefs.fullscreen === 'maximized' && !mainWindow.isMaximized()) mainWindow.maximize();
		if (!mainWindow.isVisible()) mainWindow.show();

	});

	mainWindow.webContents.on('dom-ready', () => {
		logPerfMark('dom-ready');
		if (!graphicsProfileState.launchPending) return;
		graphicsProfileState = completeGraphicsLaunch(graphicsProfileState);
		persistGraphicsProfile();
	});

	mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
		if (!isMainFrame || !graphicsProfileState.launchPending) return;
		graphicsProfileState = recordUnknownGraphicsLaunchInterruption(
			graphicsProfileState,
			`Main-frame navigation to ${validatedUrl || 'Krunker'} failed (${errorCode}: ${errorDescription || 'unknown error'}).`
		);
		persistGraphicsProfile();
	});

	mainWindow.webContents.on('did-finish-load', () => {
		logPerfMark('did-finish-load');
		if (Number.isFinite(perfExitAfterLoadMs) && perfExitAfterLoadMs > 0 && !perfExitScheduled) {
			perfExitScheduled = true;
			setTimeout(() => { app.quit(); }, perfExitAfterLoadMs);
		}
		const currentAdaptiveValidationState = userPrefs.competitiveMode && completeGraphicsIdentityReady
			? prepareCurrentAdaptiveValidationState()
			: undefined;
		mainWindow.webContents.send('main_did-finish-load', userPrefs, getGraphicsRuntimeInfo(), {
			adaptiveValidationState: currentAdaptiveValidationState,
			hasGameSettingsBackup: Boolean(loadCompetitiveModeBackup())
		});
		if (currentAdaptiveValidationState) void maybePromptAdaptiveRecalibration();
		mainWindow.webContents.send('injectClientCSS', userPrefs, app.getVersion(), cssPath);

		if (clientUrlStartup) {
			mainWindow.webContents.send('process-startup-url', clientUrlStartup);
			clientUrlStartup = null;
		}
		if (discordRPCReady) mainWindow.webContents.send('initDiscordRPC');
	});

	/** submenu for in-game shortcuts */
	const gameSubmenu: (MenuItemConstructorOptions | MenuItem) = {
		label: 'Game',
		submenu: [
			{ label: 'Reload this game', accelerator: 'F5', click: () => { mainWindow.reload(); } },
			{ label: 'Copy game link to clipboard', accelerator: 'F7', click: () => { clipboard.writeText(mainWindow.webContents.getURL()); } },
			{
				label: 'Join game link from clipboard',
				accelerator: 'CommandOrControl+F7',
				click: () => {
					const copiedUrl = parseKrunkerUrl(clipboard.readText());
					if (copiedUrl?.searchParams.has('game')) void mainWindow.webContents.loadURL(copiedUrl.toString());
				}
			},
			{ type: 'separator' },
			...constructDevtoolsSubmenu(mainWindow, userPrefs.alwaysWaitForDevTools || null)
		]
	};

	if (process.platform !== 'darwin') csMenuTemplate.push({ label: 'About', submenu: aboutSubmenu });

	// the other submenus are defined in menu.ts
	const csMenu = Menu.buildFromTemplate([...macAppMenuArr, gameSubmenu, ...csMenuTemplate]);

	Menu.setApplicationMenu(csMenu);

	mainWindow.setMenu(csMenu);
	mainWindow.setAutoHideMenuBar(true);
	mainWindow.setMenuBarVisibility(false);

	mainWindow.webContents.setWindowOpenHandler(details => {
		const gameUrl = parseKrunkerUrl(details.url);
		if (gameUrl) {
			void mainWindow.loadURL(gameUrl.toString());
			return { action: 'deny' };
		}

		const externalUrl = parseExternalUrl(details.url);
		if (externalUrl) void shell.openExternal(externalUrl.toString());
		return { action: 'deny' };
	});
	mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
		if (parseKrunkerUrl(navigationUrl)) return;
		event.preventDefault();
		const externalUrl = parseExternalUrl(navigationUrl);
		if (externalUrl) void shell.openExternal(externalUrl.toString());
	});

	const crankshaftFilterHandler = new RequestHandler(
		mainWindow,
		swapperPath,
		userPrefs.resourceSwapper,
		userPrefs.hideAds === 'block',
		userPrefs.customFilters,
		userPrefs.hideAds === 'block' ? readFileSync(pathJoin($assets, 'blockFilters.txt'), 'utf-8') : '',
		filtersPath
	);
	await crankshaftFilterHandler.start();
	if (userPrefs.resourceSwapper) {
		protocol.registerFileProtocol('krunker-resource-swapper', (request, callback) => {
			const localPath = crankshaftFilterHandler.resolveSwapProtocolRequest(request.url);
			callback(localPath ?? { error: -6 });
		});
	}

	if (!calibrationBlocksStartup) {
		// Refresh the complete GPU identity well after load: did-finish-load is the game's
		// heaviest startup moment and nothing consumes the result until the next launch.
		const GPU_IDENTITY_REFRESH_DELAY_MS = 15_000;
		let gpuIdentityRefreshTimer: ReturnType<typeof setTimeout> | undefined;
		const clearGpuIdentityRefreshTimer = () => {
			if (gpuIdentityRefreshTimer === undefined) return;
			clearTimeout(gpuIdentityRefreshTimer);
			gpuIdentityRefreshTimer = undefined;
		};
		app.on('before-quit', clearGpuIdentityRefreshTimer);
		mainWindow.on('closed', clearGpuIdentityRefreshTimer);
		mainWindow.webContents.once('did-finish-load', () => {
			gpuIdentityRefreshTimer = setTimeout(() => {
				gpuIdentityRefreshTimer = undefined;
				if (mainWindow.isDestroyed()) return;
				void refreshCompleteGraphicsInfo().then(gpuInfo => {
					completeGraphicsIdentityReady = true;
					const previousCalibrationState = calibrationState;
					const preparedState = prepareCalibrationForGpuInfo(gpuInfo);
					if (preparedState !== previousCalibrationState && preparedState.status === 'running') {
						console.log('Graphics identity changed; calibration is staged for the next launch.');
					}

					const currentAdaptiveValidationState = userPrefs.competitiveMode
						? prepareCurrentAdaptiveValidationState()
						: undefined;
					if (!mainWindow.isDestroyed()) {
						mainWindow.webContents.send('adaptiveValidation_stateUpdated', currentAdaptiveValidationState);
					}
					if (currentAdaptiveValidationState) void maybePromptAdaptiveRecalibration();
				});
			}, GPU_IDENTITY_REFRESH_DELAY_MS);
		});
	}

	logPerfMark('loadurl-called');
	await mainWindow.loadURL('https://krunker.io');
});
}
