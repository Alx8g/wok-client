import {
	RUNTIME_LAB_PAGE_ID,
	RUNTIME_LAB_PROTOCOL_VERSION,
	RUNTIME_LAB_WORKLOAD_VERSION,
	type RuntimeLabResultEnvelope
} from '../src/shared/protocol.ts';

export function createTestResult(overrides: Partial<RuntimeLabResultEnvelope> = {}): RuntimeLabResultEnvelope {
	return {
		benchmark: {
			averageFps: 240,
			contaminationFlags: [],
			cpuSubmitP50Ms: 1.2,
			cpuSubmitP95Ms: 2.4,
			environment: {
				devicePixelRatio: 1,
				drawingBufferHeight: 720,
				drawingBufferWidth: 1_280,
				onBattery: false,
				refreshRateHz: 240
			},
			eventLoopP95Ms: 1.1,
			eventLoopWorstMs: 3.5,
			gpuDisjointDiscardCount: 0,
			gpuImplausibleCount: 0,
			gpuSampleCount: 100,
			gpuTimeP50Ms: 2.1,
			gpuTimeP95Ms: 3.2,
			gpuTimingStatus: 'measured',
			longFrameRatio: 0,
			lowConfidenceReasons: [],
			onePercentLowFps: 180,
			p95FrameTimeMs: 5.2,
			rejected: false,
			rejectionReasons: [],
			sampleCount: 1_000,
			stallRatio: 0,
			stalledTicks: 0,
			success: true,
			totalTicks: 1_002,
			webglRenderer: 'ANGLE test renderer',
			worstFrameTimeMs: 12.3
		},
		candidateId: 'candidate-a',
		foregroundEvents: [{
			hasFocus: true,
			performanceNowMs: 10,
			type: 'initial-state',
			visibilityState: 'visible'
		}],
		identity: {
			deviceMemoryGiB: 16,
			hardwareConcurrency: 16,
			language: 'en-US',
			platform: 'Win32',
			userAgent: 'Runtime Lab Test',
			userAgentBrands: [{ brand: 'Test', version: '1' }],
			userAgentMobile: false,
			userAgentPlatform: 'Windows'
		},
		input: {
			dispatchChecksum: 0,
			dispatchIntervalMs: 0,
			dispatchedEvents: 0,
			mode: 'off',
			p95DispatchLatenessMs: 0,
			receivedChecksum: 0,
			receivedEvents: 0,
			worstDispatchLatenessMs: 0
		},
		pageId: RUNTIME_LAB_PAGE_ID,
		pageSha256: 'a'.repeat(64),
		protocolVersion: RUNTIME_LAB_PROTOCOL_VERSION,
		runId: 'run-a',
		timings: {
			benchmarkCompletedMs: 31_100,
			benchmarkInvokedMs: 1_100,
			domReadyMs: 100,
			pageScriptStartMs: 10,
			timeOriginEpochMs: 1_700_000_000_000
		},
		// Tracks the production workload so parity fixtures can never lag a WORKLOAD_VERSION bump.
		workloadVersion: RUNTIME_LAB_WORKLOAD_VERSION,
		...overrides
	};
}
