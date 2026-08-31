import type { CalibrationResult, CalibrationState } from './calibration.ts';
import type { GraphicsProfileState, GraphicsSelection } from './graphics-profile.ts';

export interface DiagnosticsReportInput {
	appVersion: string;
	calibration?: CalibrationState;
	electronVersion: string;
	generatedAt?: Date;
	gpuFeatureStatus: Record<string, string>;
	graphicsProfile: GraphicsProfileState;
	graphicsSelection: GraphicsSelection;
	osVersion: string;
	platform: NodeJS.Platform;
	preferences: Record<string, unknown>;
}

const REPORTED_PREFERENCE_KEYS = [

	'display',
	'fpsUncap',
	'fullscreen',
	'graphicsBackend',
	'safeFlags_disableBackgrounding',
	'safeFlags_gpuRasterizing',
	'safeFlags_highPerformanceGpu',
	'experimentalFlags_experimental'
] as const;

function deviceLine(profile: GraphicsProfileState): string {
	if (profile.devices.length === 0) return 'no adapters recorded yet';
	return profile.devices
		.map(device => `${device.vendorId.toString(16)}:${device.deviceId.toString(16)}${device.active ? ' (active)' : ''}`)
		.join(', ');
}

function calibrationResultLine(result: CalibrationResult): string {
	const metrics = result.metrics;
	const flags = (metrics.contaminationFlags ?? []).length > 0 ? `  [${(metrics.contaminationFlags ?? []).join(', ')}]` : '';
	const lowConfidence = (metrics.lowConfidenceReasons ?? []).length > 0 ? `  (low confidence: ${(metrics.lowConfidenceReasons ?? []).join(', ')})` : '';
	const failure = result.failureReason ? `  FAILED: ${result.failureReason}` : '';
	if (!metrics.success) return `  ${result.candidate.id}  no valid samples${failure}`;
	const stall = typeof metrics.stallRatio === 'number' ? `  stall ${metrics.stallRatio.toFixed(2)}` : '';
	return `  ${result.candidate.id}  score ${result.score.toFixed(2)}  avg ${metrics.averageFps.toFixed(1)}  1%low ${metrics.onePercentLowFps.toFixed(1)}  p95 ${metrics.p95FrameTimeMs.toFixed(2)}ms${stall}${flags}${lowConfidence}${failure}`;
}

function calibrationSection(calibration: CalibrationState | undefined): string[] {
	if (!calibration) return ['CALIBRATION: never run'];
	const lines = [`CALIBRATION: ${calibration.status}${calibration.confirmation ? ` (confirmation: ${calibration.confirmation})` : ''}`];

	if (calibration.completionReason) lines.push(`  ${calibration.completionReason}`);
	for (const result of calibration.results) lines.push(calibrationResultLine(result));
	if (calibration.recommendedSelection) lines.push(`  recommended: ${calibration.recommendedSelection.candidate.id}`);
	if (calibration.activeSelection) lines.push(`  applied: ${calibration.activeSelection.candidate.id}`);
	return lines;
}

export function buildDiagnosticsReport(input: DiagnosticsReportInput): string {
	const profile = input.graphicsProfile;
	const quarantined = profile.blockedBackends.length > 0 ? profile.blockedBackends.join(', ') : 'none';

	const backendFailures = profile.backendFailures.length > 0
		? profile.backendFailures
			.map(failure => `${failure.backend} x${failure.failureCount}${failure.reason ? ` — ${failure.reason}` : ''}`)
			.join('; ')
		: 'none';
	const features = Object.entries(input.gpuFeatureStatus)
		.filter(([key]) => key === 'webgl' || key === 'webgl2' || key === 'gpu_compositing' || key === 'rasterization')
		.map(([key, value]) => `${key}=${value}`)
		.join(' ') || 'not reported yet';
	const preferences = REPORTED_PREFERENCE_KEYS
		.map(key => `${key}=${String(input.preferences[key] ?? 'unset')}`)
		.join(' ');

	const lines = [
		`WOK CLIENT DIAGNOSTICS — ${(input.generatedAt ?? new Date()).toISOString()}`,
		`version ${input.appVersion} · electron ${input.electronVersion} · ${input.platform} ${input.osVersion}`,
		`GPU: ${deviceLine(profile)}`,
		`backend: ${profile.lastAppliedBackend} (source: ${profile.lastSelectionSource}) — ${input.graphicsSelection.reason}`,
		`recommendation: ${profile.recommendedBackend} — ${profile.recommendationReason}`,
		`quarantined backends: ${quarantined}`,
		`backend failures: ${backendFailures}`,
		`last launch: ${profile.lastLaunchOutcome}${profile.lastFailureReason ? ` — ${profile.lastFailureReason}` : ''}`,
		`gpu features: ${features}`,
		...calibrationSection(input.calibration),
		`PREFS: ${preferences}`
	];
	return lines.join('\n');
}
