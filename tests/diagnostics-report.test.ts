import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiagnosticsReport, type DiagnosticsReportInput } from '../src/diagnostics-report.ts';
import { createGraphicsProfileState, recordManualGraphicsGpuFailure, updateGraphicsDetection } from '../src/graphics-profile.ts';

const intelDevice = { active: true, deviceId: 0x46a6, vendorId: 0x8086 };
const softwareDevice = { active: false, deviceId: 0x008c, vendorId: 0x1414 };

function baseInput(): DiagnosticsReportInput {
	const graphicsProfile = updateGraphicsDetection(createGraphicsProfileState('win32', 1_000), 'win32', [intelDevice, softwareDevice], 1_000);
	return {
		appVersion: '1.0.0',
		electronVersion: '44.0.0-nightly.20260522',
		generatedAt: new Date('2026-08-03T12:00:00Z'),
		gpuFeatureStatus: { gpu_compositing: 'enabled', rasterization: 'enabled', webgl: 'enabled', webgl2: 'enabled' },
		graphicsProfile,
		graphicsSelection: { backend: 'd3d11on12', preference: 'auto', reason: 'D3D11on12 is the tuned profile for Windows systems using only Intel graphics.', source: 'auto' },
		osVersion: '10.0.26100',
		platform: 'win32',
		preferences: { competitiveMode: true, fpsUncap: true, fullscreen: 'windowed', graphicsBackend: 'auto', safeFlags_highPerformanceGpu: true }
	};
}

test('reports hardware, selection, and graceful placeholders without calibration evidence', () => {
	const report = buildDiagnosticsReport(baseInput());

	assert.ok(report.startsWith('WOK CLIENT DIAGNOSTICS — 2026-08-03T12:00:00.000Z'));
	assert.ok(report.includes('GPU: 8086:46a6 (active), 1414:8c'));
	assert.ok(report.includes('recommendation: d3d11on12'));
	assert.ok(report.includes('backend failures: none'));
	assert.ok(report.includes('CALIBRATION: never run'));
	assert.ok(report.includes('VALIDATION: no gameplay evidence yet'));
	assert.ok(report.includes('safeFlags_highPerformanceGpu=true'));
	assert.ok(report.includes('safeFlags_gpuRasterizing=unset'));
});

test('surfaces non-quarantining manual backend failures in the failure history', () => {
	const input = baseInput();
	input.graphicsProfile = recordManualGraphicsGpuFailure(
		{ ...input.graphicsProfile, launchPending: true },
		'd3d11',
		'GPU process crashed with exit code 5.',
		2_000
	);
	input.graphicsSelection = { backend: 'd3d11', preference: 'd3d11', reason: 'Using the manually selected d3d11 graphics backend.', source: 'manual' };

	const report = buildDiagnosticsReport(input);
	// Recorded and visible, yet never quarantined (audit C5).
	assert.ok(report.includes('quarantined backends: none'));
	assert.ok(report.includes('backend failures: d3d11 x1 — GPU process crashed with exit code 5.'));
	assert.ok(report.includes('last launch: gpu-failure — GPU process crashed with exit code 5.'));
});

test('surfaces artifact flags, verdicts, and validation sessions in the calibration sections', () => {
	const input = baseInput();
	const artifactMetrics = {
		averageFps: 90.95,
		contaminationFlags: ['fence-pacing-dominates-frame-interval'],
		eventLoopP95Ms: 1,
		longFrameRatio: 0.01,
		lowConfidenceReasons: [] as never[],
		onePercentLowFps: 20.7,
		p95FrameTimeMs: 16.3,
		sampleCount: 555,
		stallRatio: 0.73,
		success: true,
		webglRenderer: 'ANGLE (Intel, Iris Xe, D3D11on12, D3D11)',
		worstFrameTimeMs: 30
	};
	input.calibration = {
		candidates: [],
		competitiveModeWasEnabled: true,
		consentGrantedAt: 1,
		fieldRejectedCandidateIds: [],
		launchCount: 2,
		plan: [],
		rerunRequested: false,
		recommendedSelection: {
			backendVerification: { candidateBackend: 'd3d11on12', detectedBackend: 'd3d11on12', status: 'verified' },
			candidate: { backend: 'd3d11on12', framePolicy: 'uncapped', id: 'd3d11on12:uncapped' },
			metrics: artifactMetrics,
			score: 46.34
		},
		rejectedAttempts: [],
		results: [{
			backendVerification: { candidateBackend: 'd3d11on12', detectedBackend: 'd3d11on12', status: 'verified' },
			candidate: { backend: 'd3d11on12', framePolicy: 'uncapped', id: 'd3d11on12:uncapped' },
			metrics: artifactMetrics,
			score: 46.34,
			slotIndex: 0
		}],
		runRetriesUsed: 0,
		signature: { appVersion: '1.0.0', benchmarkVersion: 3, driverFingerprint: 'driver-a', electronVersion: '44.0.0', hardwareFingerprint: '8086:46a6', workloadVersion: 1 },
		status: 'awaiting-confirmation',
		updatedAt: 2,
		version: 2
	} as DiagnosticsReportInput['calibration'];
	input.adaptiveValidation = {
		baseline: {
			medianAverageFps: 400,
			profile: { activeBackend: 'd3d11on12', benchmarkSemanticVersion: 1, driverFingerprint: 'driver-a', electronVersion: '44.0.0', framePolicy: 'uncapped', hardwareFingerprint: '8086:46a6', profileSemanticVersion: 1 }
		},
		classification: 'inconclusive',
		profile: { activeBackend: 'd3d11on12', benchmarkSemanticVersion: 1, driverFingerprint: 'driver-a', electronVersion: '44.0.0', framePolicy: 'uncapped', hardwareFingerprint: '8086:46a6', profileSemanticVersion: 1 },
		profileChangeConfirmationRequired: true,
		sessions: [{
			completedAt: 100,
			durationMs: 60_000,
			id: 'adaptive-session-00000001',
			lowConfidenceReasons: [],
			metrics: { averageFps: 398.2, onePercentLowFps: 150.1, p95FrameTimeMs: 3.1, sampleCount: 20_000, worstFrameTimeMs: 12 }
		}],
		status: 'sampling',
		summary: { acceptedSessionCount: 1, cleanSessionCount: 1, maximumP95FrameTimeMs: 3.1, maximumWorstFrameTimeMs: 12, minimumAverageFps: 398.2, minimumOnePercentLowFps: 150.1, severeInstabilitySessionCount: 0, totalFrameSamples: 20_000 },
		updatedAt: 101,
		version: 1
	};

	const report = buildDiagnosticsReport(input);
	assert.ok(report.includes('CALIBRATION: awaiting-confirmation'));
	assert.ok(report.includes('[fence-pacing-dominates-frame-interval]'));
	assert.ok(report.includes('stall 0.73'));
	assert.ok(report.includes('recommended: d3d11on12:uncapped'));
	assert.ok(report.includes('baseline 400.0 fps (from d3d11on12)'));
	assert.ok(report.includes('session 1: avg 398.2'));
});
