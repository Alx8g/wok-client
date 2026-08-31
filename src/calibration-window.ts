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
	BENCHMARK_PROGRESS_WARMUP_SHARE,
	BENCHMARK_SEVERE_EVENT_LOOP_DELAY_MS,
	runBenchmarkTrial
} from './calibration-benchmark.ts';

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

function embedJson(value: unknown): string {
	return JSON.stringify(value).replaceAll('<', '\\u003c');
}

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
		BENCHMARK_PROGRESS_WARMUP_SHARE,
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
			.progress-fill { width: 100%; height: 100%; background: #FBC02D; transform: scaleX(0); transform-origin: left center; transition: transform 240ms cubic-bezier(.4,0,.2,1); will-change: transform; }
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

	attempt?: number;
	onBattery?: boolean;

	previousEventLoopWorstMs?: number;
	previousRejectionReasons?: CalibrationLowConfidenceReason[];
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
	const previousRejectionReasons = extras.previousRejectionReasons ?? [];
	const previousReasonText = previousRejectionReasons
		.map(reason => {
			const label = lowConfidenceLabels[reason];
			return reason === 'severe-event-loop-disturbance'
				&& typeof extras.previousEventLoopWorstMs === 'number'
				&& Number.isFinite(extras.previousEventLoopWorstMs)
				? `${label} (${extras.previousEventLoopWorstMs.toFixed(1)} ms timer delay)`
				: label;
		})
		.join(', ');
	const retryWarning = previousReasonText
		? `Interrupted: ${previousReasonText}. Running again.`
		: 'Interrupted &mdash; running this test again.';
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
				<h1>Measuring graphics profiles</h1>
				<p>Leave this window alone until it finishes.</p>
				<div class="meta">
					<span class="pill">TEST ${step} / ${total}</span>
					${isRetry ? '<span class="pill retry">RETRY</span>' : ''}
					<span class="pill">${escapeHtml(candidate.backend.toUpperCase())}</span>
					<span class="pill">${escapeHtml(framePolicyLabel(candidate.framePolicy).toUpperCase())}</span>
				</div>
				<div class="progress-track"><div class="progress-fill" id="progress"></div></div>
				<div class="status"><span id="phase">Preparing renderer</span><span id="live">Collecting samples</span></div>
				<div class="warning${isRetry ? ' visible' : ''}" id="warning">${isRetry
					? escapeHtml(retryWarning)
					: 'This test was disturbed; the result will be marked lower confidence.'}</div>
				<div class="privacy">Runs locally. Nothing is sent anywhere.</div>
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
						progress.style.transform = 'scaleX(' + update.ratio + ')';
						phase.textContent = 'Warming up';
						live.textContent = 'Waiting for steady state';
					} else {
						progress.style.transform = 'scaleX(' + update.ratio + ')';
						phase.textContent = 'Measuring';
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
	markSvg: string
): string {
	const hasRecommendation = Boolean(recommended);
	const groups = groupResultsByCandidate(results);
	const retainedKnownGood = Boolean(recommended && !results.some(result => result.candidate.id === recommended.candidate.id));
	if (recommended && retainedKnownGood) groups.unshift({ candidate: recommended.candidate, representative: recommended, trials: [recommended] });
	const resultsHtml = groups.map(group => resultMarkup(group, recommended?.candidate.id)).join('');
	const applyLabel = 'Apply new profile';
	const keepLabel = 'Keep current profile';
	const artifactAffected = results.some(result => (result.metrics.contaminationFlags ?? []).includes(BENCHMARK_FENCE_PACING_CONTAMINATION_FLAG));
	const summary = recommended
		? retainedKnownGood
			? `Nothing beat your current <strong>${escapeHtml(recommended.candidate.backend)}</strong> profile, so it stays.`
			: artifactAffected
				? `The test could not compare these fairly, so your current <strong>${escapeHtml(recommended.candidate.backend)}</strong> profile is kept.`
				: `Fastest profile: <strong>${escapeHtml(recommended.candidate.backend)}</strong>.`
		: 'Not enough clean measurements. Keeping your current settings.';

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
				<p>${summary}</p>
				<div class="results">${resultsHtml}</div>
				<div class="actions">
					<button class="primary" id="apply" ${hasRecommendation ? '' : 'disabled'}>${applyLabel}</button>
					<button id="keep">${keepLabel}</button>
				</div>
				<div class="result-note">Your next few matches check this profile. If it runs badly, WOK switches back on its own.</div>
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
