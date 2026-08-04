import type { CalibrationCandidate, CalibrationLowConfidenceReason, CalibrationResult, EffectiveBackendVerification } from './calibration.ts';
import { CALIBRATION_BENCHMARK_MS, CALIBRATION_MIN_SAMPLES } from './calibration.ts';
import {
	createEntitySimulation,
	createWorkload,
	createWorkloadSpec,
	createWorkloadSpin,
	mulberry32,
	WORKLOAD_CONSTANTS,
	WORKLOAD_CONTEXT_ATTRIBUTES
} from './calibration-workload.ts';
import {
	BENCHMARK_EVENT_LOOP_SAMPLE_MS,
	BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG,
	BENCHMARK_FENCE_QUEUE_DEPTH,
	BENCHMARK_FENCE_RING_SIZE,
	BENCHMARK_FENCE_STALL_ARTIFACT_RATIO,
	BENCHMARK_FENCE_STALL_GPU_HEADROOM_RATIO,
	BENCHMARK_GPU_DISJOINT_DEMOTION_RATIO,
	BENCHMARK_GPU_IMPLAUSIBLE_DEMOTION_RATIO,
	BENCHMARK_GPU_QUERY_POOL_SIZE,
	BENCHMARK_GPU_QUEUE_CONTAMINATION_FLAG,
	BENCHMARK_GPU_QUEUE_FLAG_RATIO,
	BENCHMARK_GPU_SAMPLE_FRAME_INTERVAL,
	BENCHMARK_GPU_SAMPLE_MAX_FRAME_RATIO,
	BENCHMARK_GPU_SAMPLE_MIN_MS,
	BENCHMARK_LONG_FRAME_MS,
	BENCHMARK_SEVERE_EVENT_LOOP_DELAY_MS,
	runBenchmarkTrial
} from './calibration-benchmark.ts';

/**
 * 'capped' is not a frame-rate cap: it is simply the uncap switches absent, i.e. compositor
 * vsync left on. Krunker has no in-browser frame-cap setting, so the honest user-facing label
 * is display synchronization, not a cap.
 */
function framePolicyLabel(framePolicy: CalibrationCandidate['framePolicy']): string {
	return framePolicy === 'capped' ? 'display-synced' : framePolicy;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function embedJson(value: unknown): string {
	return JSON.stringify(value).replaceAll('<', '\\u003c');
}

/**
 * The measurement logic lives in `calibration-workload.ts` / `calibration-benchmark.ts` (unit
 * tested with injected fakes); the page embeds those exact functions by serialization, together
 * with the constants they reference, so page and tests can never drift apart.
 */
function embeddedModulesScript(): string {
	const constants: Record<string, unknown> = {
		BENCHMARK_EVENT_LOOP_SAMPLE_MS,
		BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG,
		BENCHMARK_FENCE_QUEUE_DEPTH,
		BENCHMARK_FENCE_RING_SIZE,
		BENCHMARK_FENCE_STALL_ARTIFACT_RATIO,
		BENCHMARK_FENCE_STALL_GPU_HEADROOM_RATIO,
		BENCHMARK_GPU_DISJOINT_DEMOTION_RATIO,
		BENCHMARK_GPU_IMPLAUSIBLE_DEMOTION_RATIO,
		BENCHMARK_GPU_QUERY_POOL_SIZE,
		BENCHMARK_GPU_QUEUE_CONTAMINATION_FLAG,
		BENCHMARK_GPU_QUEUE_FLAG_RATIO,
		BENCHMARK_GPU_SAMPLE_FRAME_INTERVAL,
		BENCHMARK_GPU_SAMPLE_MAX_FRAME_RATIO,
		BENCHMARK_GPU_SAMPLE_MIN_MS,
		BENCHMARK_LONG_FRAME_MS,
		BENCHMARK_SEVERE_EVENT_LOOP_DELAY_MS
	};
	const constantLines = Object.entries(constants)
		.map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`)
		.join('\n\t\t\t');
	return `${constantLines}
			const mulberry32 = ${mulberry32.toString()};
			const createWorkload = ${createWorkload.toString()};
			const createEntitySimulation = ${createEntitySimulation.toString()};
			const createWorkloadSpin = ${createWorkloadSpin.toString()};
			const runBenchmarkTrial = ${runBenchmarkTrial.toString()};`;
}

function sharedStyles(): string {
	return `
			:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
			* { box-sizing: border-box; }
			html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #0A0A0A; color: #FFFFFF; }
			body { display: grid; place-items: center; }
			.shell { position: relative; z-index: 30; width: min(880px, calc(100vw - 48px)); border: 1px solid #343434; background: rgba(17, 17, 17, .92); }
			.accent { height: 4px; background: #FBC02D; }
			.content { position: relative; padding: 32px; }
			.brand { display: flex; align-items: center; gap: 14px; margin-bottom: 28px; }
			.brand svg { width: 48px; height: 48px; }
			.brand-copy { display: grid; gap: 2px; }
			.brand-name { color: #FFFFFF; font-size: 20px; font-weight: 800; letter-spacing: .06em; }
			.brand-subtitle { color: #929292; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; }
			h1 { margin: 0 0 10px; font-size: 30px; line-height: 1.15; }
			p { color: #B8B8B8; line-height: 1.6; }
			.meta { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0 18px; }
			.pill { padding: 7px 10px; border: 1px solid #383838; background: #181818; color: #D7D7D7; font: 600 12px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace; }
			.pill.retry { border-color: #725F1A; color: #E6D083; }
			.progress-track { height: 10px; border: 1px solid #3A3A3A; background: #080808; overflow: hidden; }
			.progress-fill { width: 0; height: 100%; background: #FBC02D; transition: width 80ms linear; }
			.status { display: flex; justify-content: space-between; gap: 20px; margin-top: 10px; color: #8F8F8F; font: 600 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
			.warning { display: none; margin-top: 16px; border: 1px solid #725F1A; background: #1D190B; color: #E6D083; padding: 10px 12px; font-size: 12px; line-height: 1.45; }
			.warning.visible { display: block; }
			.privacy { margin-top: 24px; padding-top: 18px; border-top: 1px solid #292929; color: #777777; font-size: 12px; }
			button { min-width: 180px; border: 1px solid #444444; background: #191919; color: #FFFFFF; padding: 12px 16px; font: 700 14px/1.2 inherit; cursor: pointer; }
			button:hover { border-color: #FBC02D; }
			button.primary { border-color: #FBC02D; background: #FBC02D; color: #0A0A0A; }
			button:disabled { cursor: not-allowed; opacity: .4; }
			.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 26px; }
			.results { display: grid; gap: 8px; margin-top: 22px; max-height: 330px; overflow: auto; }
			.result { display: grid; grid-template-columns: minmax(180px, 1fr) repeat(4, minmax(80px, .55fr)); gap: 10px; align-items: center; padding: 12px; border: 1px solid #303030; background: #151515; }
			.result.recommended { border-color: #FBC02D; }
			.result .name { font-weight: 700; }
			.result .metric { color: #BEBEBE; font: 600 12px/1.3 ui-monospace, SFMono-Regular, Consolas, monospace; }
			.result .label { display: block; color: #707070; font: 500 10px/1.2 inherit; text-transform: uppercase; }
			.result-note { grid-column: 1 / -1; color: #999999; font-size: 11px; line-height: 1.45; }
			.result-note.low-confidence { color: #E6D083; }
			.result-note.failure { color: #E08A8A; }
			.trial-list { grid-column: 1 / -1; margin: 2px 0 0; padding: 0 0 0 16px; color: #8F8F8F; font: 500 11px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; }
			canvas { position: fixed; inset: 0; z-index: 0; width: 100vw; height: 100vh; image-rendering: auto; pointer-events: none; }
		`;
}

/**
 * DOM/UI compositing overlay (design §1.2): the game composites a large HTML UI over its canvas,
 * so the workload does too. Panel and HUD animate through compositor-driven CSS keyframes only;
 * the feed text updates at most 5 Hz through the throttled updater. Zero per-frame JS DOM writes.
 *
 * The keyframes use stepped timing (~14 updates/s): lane tuning showed that smooth compositor-only
 * animations let the uncapped compositor free-run presents far past the workload frame rate
 * (461/s vs 135 canvas frames/s on the reference machine), untethering the present path from the
 * scene under test and inflating GPU-process busy ~35% beyond the design §1.4 lane gate. Stepped
 * timing keeps the persistent composited overlay layers and their per-present composite cost while
 * the canvas drives present cadence, matching the measured menu behavior. `will-change` pins the
 * layer promotion so it cannot vary across Chromium versions. Part of the WORKLOAD_VERSION 1
 * freeze: changing this overlay changes the measured lane shape.
 */
function overlayStyles(): string {
	return `
			.overlay-gradient { position: fixed; inset: -12vh -12vw; z-index: 10; pointer-events: none; opacity: .06; background: linear-gradient(115deg, #FBC02D 0%, #202840 45%, #7B3131 100%); animation: wok-pan 7s steps(96) infinite alternate; will-change: transform; }
			@keyframes wok-pan { from { transform: translate3d(-3%, -2%, 0) scale(1.05); } to { transform: translate3d(3%, 2%, 0) scale(1.12); } }
			.hud { position: fixed; left: 24px; right: 24px; bottom: 20px; z-index: 20; display: flex; gap: 6px; pointer-events: none; }
			.hud span { flex: 1; height: 14px; border: 1px solid #3A3A3A; background: #181818; animation: wok-pulse 1.8s steps(24) infinite; will-change: opacity; }
			.hud span:nth-child(3n) { animation-delay: .45s; }
			.hud span:nth-child(3n + 1) { animation-delay: .9s; }
			@keyframes wok-pulse { 0%, 100% { opacity: .25; } 50% { opacity: .8; } }
			.feed { position: fixed; top: 24px; right: 24px; z-index: 20; width: 230px; display: grid; gap: 4px; pointer-events: none; }
			.feed div { padding: 5px 8px; border: 1px solid #2C2C2C; background: rgba(20, 20, 20, .8); color: #9A9A9A; font: 600 10px/1.3 ui-monospace, SFMono-Regular, Consolas, monospace; }
		`;
}

function brandMarkup(markSvg: string): string {
	return `<div class="brand">${markSvg}<div class="brand-copy"><div class="brand-name">WOK CLIENT</div><div class="brand-subtitle">Competitive calibration</div></div></div>`;
}

function overlayMarkup(): string {
	const hudCells = Array.from({ length: 24 }, () => '<span></span>').join('');
	const feedRows = Array.from({ length: 6 }, (_unused, index) => `<div data-feed-row="${index}">standby</div>`).join('');
	return `<div class="overlay-gradient"></div><div class="hud">${hudCells}</div><div class="feed" id="feed">${feedRows}</div>`;
}

export interface CalibrationTrialPageExtras {
	/** 1-based attempt number; 2 renders the retry messaging (design §2.4). */
	attempt?: number;
	onBattery?: boolean;
	refreshRateHz?: number;
}

export function buildCalibrationTrialPage(
	candidate: CalibrationCandidate,
	step: number,
	total: number,
	markSvg: string,
	extras: CalibrationTrialPageExtras = {}
): string {
	const attempt = extras.attempt ?? 1;
	const isRetry = attempt > 1;
	const trialDefaults = {
		benchmarkMs: CALIBRATION_BENCHMARK_MS,
		minSamples: CALIBRATION_MIN_SAMPLES,
		warmupMaxMs: WORKLOAD_CONSTANTS.warmupMaxMs,
		warmupMinMs: WORKLOAD_CONSTANTS.warmupMinMs,
		warmupSettleFrames: WORKLOAD_CONSTANTS.warmupSettleFrames,
		warmupSettleRatio: WORKLOAD_CONSTANTS.warmupSettleRatio
	};
	const pageEnvironment = {
		onBattery: extras.onBattery ?? null,
		refreshRateHz: extras.refreshRateHz ?? null
	};

	return `<!doctype html>
	<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>WOK Client Calibration</title>
		<style>${sharedStyles()}${overlayStyles()}</style>
	</head>
	<body>
		<canvas id="benchmark"></canvas>
		${overlayMarkup()}
		<main class="shell">
			<div class="accent"></div>
			<section class="content">
				${brandMarkup(markSvg)}
				<h1>Comparing renderer profiles</h1>
				<p>WOK Client is rendering a representative scene to measure frame delivery, 1% lows, frame pacing, GPU completion, and event-loop disturbance. Avoid moving, hiding, or covering this window: an interfered trial is retried once, then reported as lower confidence.</p>
				<div class="meta">
					<span class="pill">TEST ${step} / ${total}</span>
					${isRetry ? '<span class="pill retry">RETRY</span>' : ''}
					<span class="pill">${escapeHtml(candidate.backend.toUpperCase())}</span>
					<span class="pill">${escapeHtml(framePolicyLabel(candidate.framePolicy).toUpperCase())}</span>
				</div>
				<div class="progress-track"><div class="progress-fill" id="progress"></div></div>
				<div class="status"><span id="phase">Preparing renderer</span><span id="live">Collecting samples</span></div>
				<div class="warning${isRetry ? ' visible' : ''}" id="warning">${isRetry
					? 'Interference was detected, so this trial is running again. If it is interfered with once more, the better attempt is kept as lower-confidence evidence.'
					: 'This trial has lower-confidence evidence. Measurement will continue and the reason will be shown with the result.'}</div>
				<div class="privacy">This calibration is local. The private test build does not transmit benchmark results.</div>
			</section>
		</main>
		<script>
			'use strict';
			const candidate = ${embedJson(candidate)};
			const TRIAL_DEFAULTS = ${embedJson(trialDefaults)};
			const WORKLOAD_SPEC = ${embedJson(createWorkloadSpec())};
			const CONTEXT_ATTRIBUTES = ${embedJson(WORKLOAD_CONTEXT_ATTRIBUTES)};
			const PAGE_ENVIRONMENT = ${embedJson(pageEnvironment)};
			const UI_UPDATE_INTERVAL_MS = 200;
			${embeddedModulesScript()}

			window.wokRunBenchmark = async config => {
				const settings = Object.assign({}, TRIAL_DEFAULTS, config || {});
				const canvas = document.getElementById('benchmark');
				const progress = document.getElementById('progress');
				const phase = document.getElementById('phase');
				const live = document.getElementById('live');
				const feedRows = Array.from(document.querySelectorAll('#feed div'));
				const round = value => Math.round(value * 100) / 100;

				// Full-window canvas at the real window dimensions x devicePixelRatio (design §1.2).
				const devicePixelRatioValue = window.devicePixelRatio || 1;
				canvas.width = Math.max(1, Math.round(window.innerWidth * devicePixelRatioValue));
				canvas.height = Math.max(1, Math.round(window.innerHeight * devicePixelRatioValue));

				const gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
				const failedTrial = () => ({
					averageFps: 0, contaminationFlags: [], cpuSubmitP50Ms: 0, cpuSubmitP95Ms: 0,
					environment: { devicePixelRatio: devicePixelRatioValue, drawingBufferHeight: 0, drawingBufferWidth: 0 },
					eventLoopP95Ms: 0, eventLoopWorstMs: 0, gpuDisjointDiscardCount: 0, gpuImplausibleCount: 0,
					gpuSampleCount: 0, gpuTimingStatus: 'unsupported', longFrameRatio: 1, lowConfidenceReasons: [],
					onePercentLowFps: 0, p95FrameTimeMs: 0, rejected: false, rejectionReasons: [], sampleCount: 0,
					stallRatio: 0, stalledTicks: 0, success: false, totalTicks: 0, webglRenderer: '', worstFrameTimeMs: 0
				});
				if (!gl) return failedTrial();

				let renderer = '';
				const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
				if (debugInfo) renderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '');

				let onBattery = PAGE_ENVIRONMENT.onBattery === null ? undefined : PAGE_ENVIRONMENT.onBattery;
				try {
					if (navigator.getBattery) {
						const battery = await navigator.getBattery();
						onBattery = !battery.charging;
					}
				} catch (_error) { /* battery status is diagnostic only */ }

				let workload;
				let simulateEntities;
				let spin;
				try {
					workload = createWorkload(gl, WORKLOAD_SPEC, canvas.width, canvas.height);
					simulateEntities = createEntitySimulation(
						WORKLOAD_SPEC.seed,
						WORKLOAD_SPEC.constants.entityCount,
						WORKLOAD_SPEC.constants.entitySubsteps,
						WORKLOAD_SPEC.constants.entityNeighborChecks
					);
					spin = createWorkloadSpin(WORKLOAD_SPEC.seed, WORKLOAD_SPEC.constants.jsSpinIterations);
				} catch (_error) {
					return failedTrial();
				}
				let spinSink = 0;

				let lastUiUpdate = Number.NEGATIVE_INFINITY;
				let feedTick = 0;
				const updateUi = (update, force) => {
					const now = performance.now();
					if (!force && now - lastUiUpdate < UI_UPDATE_INTERVAL_MS) return;
					lastUiUpdate = now;
					if (update.phase === 'warmup') {
						progress.style.width = Math.round(update.ratio * 12) + '%';
						phase.textContent = 'Warming up renderer (adaptive)';
						live.textContent = 'Waiting for steady state';
					} else {
						progress.style.width = Math.round(12 + update.ratio * 88) + '%';
						phase.textContent = 'Measuring frame delivery';
						live.textContent = 'Collecting samples';
					}
					// Feed text updates at most 5 Hz through this throttled updater (design §1.2).
					feedTick++;
					const row = feedRows[feedTick % feedRows.length];
					if (row) row.textContent = 'evt ' + feedTick + ' \\u00b7 ' + update.phase;
				};

				let contextLost = false;
				const trial = await runBenchmarkTrial({
					environment: {
						devicePixelRatio: devicePixelRatioValue,
						drawingBufferHeight: gl.drawingBufferHeight,
						drawingBufferWidth: gl.drawingBufferWidth,
						...(typeof onBattery === 'boolean' ? { onBattery } : {}),
						...(PAGE_ENVIRONMENT.refreshRateHz === null ? {} : { refreshRateHz: PAGE_ENVIRONMENT.refreshRateHz })
					},
					getTimerQueryExt: () => gl.getExtension('EXT_disjoint_timer_query_webgl2'),
					gl,
					now: () => performance.now(),
					onProgress: update => updateUi(update, false),
					renderFrame: frameIndex => { if (!contextLost) workload.renderFrame(frameIndex); },
					requestFrame: callback => requestAnimationFrame(callback),
					// The main-thread lane, run per frame before any GL call, exactly as a game runs
					// its simulation before submitting the frame it produced: the v3 entity update
					// plus the residual unstructured spin.
					spin: () => { spinSink += simulateEntities() + spin(); return spinSink; },
					startSampler: (callback, intervalMs) => {
						const timer = setInterval(callback, intervalMs);
						return () => clearInterval(timer);
					},
					subscribeContamination: notify => {
						const onBlur = () => notify('window-blurred');
						const onVisibilityChange = () => { if (document.visibilityState !== 'visible') notify('document-visibility-changed'); };
						const onResize = () => notify('window-resized');
						const onContextLost = event => {
							event.preventDefault();
							contextLost = true;
							notify('webgl-context-lost');
						};
						window.addEventListener('blur', onBlur);
						document.addEventListener('visibilitychange', onVisibilityChange);
						window.addEventListener('resize', onResize);
						canvas.addEventListener('webglcontextlost', onContextLost);
						return () => {
							window.removeEventListener('blur', onBlur);
							document.removeEventListener('visibilitychange', onVisibilityChange);
							window.removeEventListener('resize', onResize);
							canvas.removeEventListener('webglcontextlost', onContextLost);
						};
					},
					webglRenderer: renderer
				}, {
					benchmarkMs: settings.benchmarkMs,
					minSamples: settings.minSamples,
					warmupMaxMs: settings.warmupMaxMs,
					warmupMinMs: settings.warmupMinMs,
					warmupSettleFrames: settings.warmupSettleFrames,
					warmupSettleRatio: settings.warmupSettleRatio
				});
				updateUi({ phase: 'measure', ratio: 1 }, true);
				phase.textContent = 'Trial complete';
				live.textContent = 'Reporting (' + round(trial.stallRatio * 100) + '% stalled ticks)';

				// Round-1 compatible warn-and-continue field; the main process decides rejection/retry.
				const lowConfidenceReasons = trial.rejectionReasons.slice();
				if (trial.contaminationFlags.indexOf(BENCHMARK_GPU_QUEUE_CONTAMINATION_FLAG) >= 0) lowConfidenceReasons.push(BENCHMARK_GPU_QUEUE_CONTAMINATION_FLAG);
				return Object.assign({}, trial, { lowConfidenceReasons });
			};
		</script>
	</body>
	</html>`;
}

const lowConfidenceLabels: Record<CalibrationLowConfidenceReason, string> = {
	'document-visibility-changed': 'document visibility changed',
	'gpu-disjoint-excessive': 'excessive GPU timer disruption',
	'gpu-queue-exceeds-frame-budget': 'queued GPU work exceeded the frame budget',
	'insufficient-samples': 'too few frame samples',
	'power-state-changed': 'AC/battery power changed',
	'severe-event-loop-disturbance': 'severe event-loop disturbance',
	'webgl-context-lost': 'WebGL context loss',
	'window-blurred': 'window lost focus',
	'window-resized': 'window was resized'
};

function backendVerificationText(verification: EffectiveBackendVerification): string {
	if (verification.status === 'verified') return `Effective renderer verified as ${verification.candidateBackend}.`;
	if (verification.status === 'mismatch') return `Effective renderer mismatch: requested ${verification.candidateBackend}, reported ${verification.detectedBackend ?? 'an unknown backend'}.`;
	if (verification.candidateBackend === 'default') {
		return verification.detectedBackend
			? `Chromium default selected ${verification.detectedBackend}; no explicit backend was asserted.`
			: 'Chromium default was used; its effective backend could not be identified from the renderer string.';
	}
	return `The effective ${verification.candidateBackend} backend could not be verified from the renderer string.`;
}

function gpuTimingText(result: CalibrationResult): string {
	const status = result.metrics.gpuTimingStatus;
	if (status === 'measured' && typeof result.metrics.gpuTimeP95Ms === 'number') {
		return `GPU completion measured directly (p95 ${result.metrics.gpuTimeP95Ms.toFixed(2)} ms).`;
	}
	if (status === 'unreliable') return 'GPU timer queries were unreliable on this backend; completion inferred from bounded-queue frame delivery.';
	return 'GPU completion inferred from bounded-queue frame delivery.';
}

interface CandidateResultGroup {
	candidate: CalibrationCandidate;
	representative: CalibrationResult;
	trials: CalibrationResult[];
}

function groupResultsByCandidate(results: CalibrationResult[]): CandidateResultGroup[] {
	const groups: CandidateResultGroup[] = [];
	for (const result of results) {
		const existing = groups.find(group => group.candidate.id === result.candidate.id);
		if (existing) existing.trials.push(result);
		else groups.push({ candidate: result.candidate, representative: result, trials: [result] });
	}
	for (const group of groups) {
		const scores = [...group.trials].sort((left, right) => left.score - right.score);
		const median = scores[Math.floor((scores.length - 1) / 2)].score;
		group.representative = group.trials.reduce((closest, trial) => (
			Math.abs(trial.score - median) < Math.abs(closest.score - median) ? trial : closest
		), group.trials[0]);
	}
	return groups;
}

function trialListMarkup(group: CandidateResultGroup): string {
	if (group.trials.length < 2) return '';
	const rows = group.trials.map((trial, index) => {
		const label = trial.metrics.success
			? `${trial.metrics.averageFps.toFixed(1)} FPS avg · ${trial.metrics.onePercentLowFps.toFixed(1)} 1% low · score ${trial.score.toFixed(2)}`
			: 'failed';
		const flags = (trial.metrics.lowConfidenceReasons ?? []).length > 0 ? ' · lower confidence' : '';
		return `<li>Trial ${index + 1}: ${escapeHtml(label)}${flags}</li>`;
	}).join('');
	return `<ul class="trial-list">${rows}</ul>`;
}

function resultMarkup(group: CandidateResultGroup, recommendedId?: string): string {
	const { candidate, representative } = group;
	const metrics = representative.metrics;
	const recommended = candidate.id === recommendedId;
	const lowConfidenceReasons = metrics.lowConfidenceReasons ?? [];
	const lowConfidenceMarkup = lowConfidenceReasons.length > 0
		? `<div class="result-note low-confidence">Lower confidence: ${escapeHtml(lowConfidenceReasons.map(reason => lowConfidenceLabels[reason]).join(', '))}. The trial was retained as warn-and-continue evidence.</div>`
		: '';
	const failureMarkup = representative.failureReason
		? `<div class="result-note failure">${escapeHtml(representative.failureReason)}</div>`
		: '';
	const fencePacingAffected = (metrics.contaminationFlags ?? []).includes(BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG);
	const fencePacingMarkup = fencePacingAffected
		? '<div class="result-note low-confidence">Benchmark artifact: the test\'s own frame pacing, not this backend, set these numbers. They are not comparable evidence and did not count against this profile.</div>'
		: '';
	return `<div class="result${recommended ? ' recommended' : ''}">
			<div class="name">${escapeHtml(candidate.backend)} · ${escapeHtml(framePolicyLabel(candidate.framePolicy))}${recommended ? '<span class="label">Recommended</span>' : ''}${group.trials.length > 1 ? `<span class="label">${group.trials.length} trials, median shown</span>` : ''}</div>
			<div class="metric"><span class="label">Average</span>${metrics.success ? `${metrics.averageFps.toFixed(1)} FPS${fencePacingAffected ? ' *' : ''}` : 'Failed'}</div>
			<div class="metric"><span class="label">1% low</span>${metrics.success ? `${metrics.onePercentLowFps.toFixed(1)} FPS${fencePacingAffected ? ' *' : ''}` : 'N/A'}</div>
			<div class="metric"><span class="label">p95 frame</span>${metrics.success ? `${metrics.p95FrameTimeMs.toFixed(2)} ms${fencePacingAffected ? ' *' : ''}` : 'N/A'}</div>
			<div class="metric"><span class="label">Relative score</span>${fencePacingAffected ? 'not comparable' : metrics.success ? representative.score.toFixed(2) : 'N/A'}</div>
			<div class="result-note">${escapeHtml(backendVerificationText(representative.backendVerification))} ${escapeHtml(gpuTimingText(representative))}</div>
			${trialListMarkup(group)}
			${fencePacingMarkup}
			${lowConfidenceMarkup}
			${failureMarkup}
		</div>`;
}

export function buildCalibrationResultPage(
	results: CalibrationResult[],
	recommended: CalibrationResult | undefined,
	markSvg: string,
	wasCompetitiveModeEnabled: boolean
): string {
	const hasRecommendation = Boolean(recommended);
	const groups = groupResultsByCandidate(results);
	const retainedKnownGood = Boolean(recommended && !results.some(result => result.candidate.id === recommended.candidate.id));
	if (recommended && retainedKnownGood) groups.unshift({ candidate: recommended.candidate, representative: recommended, trials: [recommended] });
	const resultsHtml = groups.map(group => resultMarkup(group, recommended?.candidate.id)).join('');
	const applyLabel = wasCompetitiveModeEnabled ? 'Apply new profile' : 'Enable Competitive mode';
	const keepLabel = wasCompetitiveModeEnabled ? 'Keep previous profile' : 'Keep current settings';
	const artifactAffected = results.some(result => (result.metrics.contaminationFlags ?? []).includes(BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG));
	const summary = recommended
		? retainedKnownGood
			? `The new evidence did not meaningfully beat the existing known-good <strong>${escapeHtml(recommended.candidate.backend)}</strong> profile, so it remains recommended.`
			: artifactAffected
				? `The benchmark could not fairly compare these profiles (its own frame pacing dominated at least one trial), so the current <strong>${escapeHtml(recommended.candidate.backend)}</strong> profile is kept. Your next play sessions confirm it against real gameplay, which the benchmark cannot fake.`
				: `The strongest measured profile was <strong>${escapeHtml(recommended.candidate.backend)}</strong> with <strong>${escapeHtml(framePolicyLabel(recommended.candidate.framePolicy))}</strong> frame delivery.`
		: 'Calibration could not collect enough valid frame samples. WOK Client will keep the current safe settings.';

	return `<!doctype html>
	<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>WOK Client Calibration Result</title>
		<style>${sharedStyles()}</style>
	</head>
	<body>
		<main class="shell">
			<div class="accent"></div>
			<section class="content">
				${brandMarkup(markSvg)}
				<h1>Calibration complete</h1>
				<p>${summary} The relative score compares measured frame throughput and consistency. It is not an end-to-end input-latency measurement.</p>
				<div class="results">${resultsHtml}</div>
				<div class="actions">
					<button class="primary" id="apply" ${hasRecommendation ? '' : 'disabled'}>${applyLabel}</button>
					<button id="keep">${keepLabel}</button>
				</div>
				<div class="result-note">Applying uses the new profile provisionally: your next three clean play sessions confirm it, and WOK automatically reverts to the previous profile if it underperforms in real play.</div>
				<div class="privacy">Game settings changed by Competitive mode are backed up before modification and restored when the mode is disabled.</div>
			</section>
		</main>
		<script>
			'use strict';
			window.wokWaitForCalibrationDecision = () => new Promise(resolve => {
				document.getElementById('apply').addEventListener('click', () => resolve('apply'), { once: true });
				document.getElementById('keep').addEventListener('click', () => resolve('keep'), { once: true });
			});
		</script>
	</body>
	</html>`;
}
