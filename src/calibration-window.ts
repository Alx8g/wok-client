import type { CalibrationCandidate, CalibrationLowConfidenceReason, CalibrationResult, EffectiveBackendVerification } from './calibration.ts';

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function sharedStyles(): string {
	return `
			:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
			* { box-sizing: border-box; }
			html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #0A0A0A; color: #FFFFFF; }
			body { display: grid; place-items: center; }
			.shell { position: relative; width: min(880px, calc(100vw - 48px)); border: 1px solid #343434; background: #111111; }
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
			canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; opacity: .13; image-rendering: auto; pointer-events: none; }
		`;
}

function brandMarkup(markSvg: string): string {
	return `<div class="brand">${markSvg}<div class="brand-copy"><div class="brand-name">WOK CLIENT</div><div class="brand-subtitle">Competitive calibration</div></div></div>`;
}

export function buildCalibrationTrialPage(
	candidate: CalibrationCandidate,
	step: number,
	total: number,
	markSvg: string
): string {
	const candidateJson = JSON.stringify(candidate).replaceAll('<', '\\u003c');

	return `<!doctype html>
	<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>WOK Client Calibration</title>
		<style>${sharedStyles()}</style>
	</head>
	<body>
		<canvas id="benchmark" width="480" height="270"></canvas>
		<main class="shell">
			<div class="accent"></div>
			<section class="content">
				${brandMarkup(markSvg)}
				<h1>Comparing renderer profiles</h1>
				<p>WOK Client is measuring frame throughput, 1% lows, frame pacing, and event-loop disturbance. Avoid moving, hiding, or covering this window. If that happens, the trial continues but is reported as lower confidence.</p>
				<div class="meta">
					<span class="pill">TEST ${step} / ${total}</span>
					<span class="pill">${escapeHtml(candidate.backend.toUpperCase())}</span>
					<span class="pill">${escapeHtml(candidate.framePolicy.toUpperCase())}</span>
				</div>
				<div class="progress-track"><div class="progress-fill" id="progress"></div></div>
				<div class="status"><span id="phase">Preparing renderer</span><span id="live">Collecting samples</span></div>
				<div class="warning" id="warning">This trial has lower-confidence evidence. Measurement will continue and the reason will be shown with the result.</div>
				<div class="privacy">This calibration is local. The private test build does not transmit benchmark results.</div>
			</section>
		</main>
		<script>
			'use strict';
			const candidate = ${candidateJson};
			const UI_UPDATE_INTERVAL_MS = 200;
			const SEVERE_EVENT_LOOP_DELAY_MS = 100;
			const percentile = (sorted, ratio) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] : 0;
			const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
			const round = value => Math.round(value * 100) / 100;

			window.wokRunBenchmark = async ({ warmupMs, benchmarkMs }) => {
				const canvas = document.getElementById('benchmark');
				const progress = document.getElementById('progress');
				const phase = document.getElementById('phase');
				const live = document.getElementById('live');
				const warning = document.getElementById('warning');
				const lowConfidenceReasons = new Set();
				const markLowConfidence = reason => {
					lowConfidenceReasons.add(reason);
					warning.classList.add('visible');
				};
				const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, desynchronized: true, failIfMajorPerformanceCaveat: false, powerPreference: 'high-performance', preserveDrawingBuffer: false })
					|| canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, desynchronized: true, failIfMajorPerformanceCaveat: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
				if (!gl) return { success: false, sampleCount: 0, averageFps: 0, onePercentLowFps: 0, p95FrameTimeMs: 0, worstFrameTimeMs: 0, eventLoopP95Ms: 0, eventLoopWorstMs: 0, longFrameRatio: 1, lowConfidenceReasons: [], webglRenderer: '' };

				let contextLost = false;
				const onBlur = () => markLowConfidence('window-blurred');
				const onVisibilityChange = () => markLowConfidence('document-visibility-changed');
				const onResize = () => markLowConfidence('window-resized');
				const onContextLost = event => {
					event.preventDefault();
					contextLost = true;
					markLowConfidence('webgl-context-lost');
				};
				const onContextRestored = () => { contextLost = false; };
				window.addEventListener('blur', onBlur);
				document.addEventListener('visibilitychange', onVisibilityChange);
				window.addEventListener('resize', onResize);
				canvas.addEventListener('webglcontextlost', onContextLost);
				canvas.addEventListener('webglcontextrestored', onContextRestored);

				const compile = (type, source) => {
					const shader = gl.createShader(type);
					gl.shaderSource(shader, source);
					gl.compileShader(shader);
					if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Shader compilation failed');
					return shader;
				};
				const vertexShader = compile(gl.VERTEX_SHADER, 'attribute vec2 position; varying vec2 uv; void main(){ uv=position*0.5+0.5; gl_Position=vec4(position,0.0,1.0); }');
				const fragmentShader = compile(gl.FRAGMENT_SHADER, 'precision mediump float; varying vec2 uv; uniform float tick; void main(){ vec2 p=uv*2.0-1.0; float wave=sin((p.x+tick)*13.0)*cos((p.y-tick)*11.0); float ring=sin(length(p)*24.0-tick*7.0); float value=0.5+0.25*wave+0.25*ring; gl_FragColor=vec4(value*0.98,value*0.74,value*0.12,1.0); }');
				const program = gl.createProgram();
				gl.attachShader(program, vertexShader);
				gl.attachShader(program, fragmentShader);
				gl.linkProgram(program);
				if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Program linking failed');
				gl.useProgram(program);
				const buffer = gl.createBuffer();
				gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
				gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
				const position = gl.getAttribLocation(program, 'position');
				gl.enableVertexAttribArray(position);
				gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
				const tick = gl.getUniformLocation(program, 'tick');
				gl.viewport(0, 0, canvas.width, canvas.height);

				let renderer = '';
				const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
				if (debugInfo) renderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '');

				const frameTimes = [];
				const eventLoopDelays = [];
				const start = performance.now();
				const warmupEnd = start + warmupMs;
				const end = warmupEnd + benchmarkMs;
				let lastFrame = 0;
				let frameTimeSum = 0;
				let longFrameCount = 0;
				let eventLoopWorstMs = 0;
				let lastUiUpdate = Number.NEGATIVE_INFINITY;
				let expectedTimer = performance.now() + 16;
				const timer = setInterval(() => {
					const now = performance.now();
					if (now >= warmupEnd) {
						const delay = Math.max(0, now - expectedTimer);
						eventLoopDelays.push(delay);
						eventLoopWorstMs = Math.max(eventLoopWorstMs, delay);
						if (delay >= SEVERE_EVENT_LOOP_DELAY_MS) markLowConfidence('severe-event-loop-disturbance');
					}
					expectedTimer = now + 16;
				}, 16);

				const updateUi = (now, force = false) => {
					if (!force && now - lastUiUpdate < UI_UPDATE_INTERVAL_MS) return;
					lastUiUpdate = now;
					const elapsed = Math.min(end - start, Math.max(0, now - start));
					progress.style.width = Math.round(elapsed / (end - start) * 100) + '%';
					phase.textContent = now < warmupEnd ? 'Warming up renderer' : 'Measuring frame delivery';
					live.textContent = now < warmupEnd ? 'Preparing samples' : 'Collecting samples';
				};

				try {
					await new Promise((resolve, reject) => {
						const frame = now => {
							try {
								if (now >= warmupEnd && lastFrame > 0) {
									const frameTime = now - lastFrame;
									if (frameTime > 0 && frameTime < 1_000) {
										frameTimes.push(frameTime);
										frameTimeSum += frameTime;
										if (frameTime > 33.34) longFrameCount++;
									}
								}
								lastFrame = now;
								updateUi(now);
								if (!contextLost) {
									for (let draw = 0; draw < 12; draw++) {
										gl.uniform1f(tick, now * 0.001 + draw * 0.071);
										gl.drawArrays(gl.TRIANGLES, 0, 3);
									}
									gl.flush();
								}
								if (now < end) requestAnimationFrame(frame);
								else resolve();
							} catch (error) {
								reject(error);
							}
						};
						requestAnimationFrame(frame);
					});
				} finally {
					clearInterval(timer);
					window.removeEventListener('blur', onBlur);
					document.removeEventListener('visibilitychange', onVisibilityChange);
					window.removeEventListener('resize', onResize);
					canvas.removeEventListener('webglcontextlost', onContextLost);
					canvas.removeEventListener('webglcontextrestored', onContextRestored);
				}
				updateUi(end, true);

				const sortedFrames = [...frameTimes].sort((left, right) => left - right);
				const sortedDelays = [...eventLoopDelays].sort((left, right) => left - right);
				const slowFrameCount = Math.max(1, Math.ceil(sortedFrames.length * 0.01));
				const slowFrames = sortedFrames.slice(-slowFrameCount);
				const meanFrameTime = frameTimes.length ? frameTimeSum / frameTimes.length : 0;
				const meanSlowFrameTime = average(slowFrames);
				return {
					averageFps: round(meanFrameTime > 0 ? 1000 / meanFrameTime : 0),
					eventLoopP95Ms: round(percentile(sortedDelays, 0.95)),
					eventLoopWorstMs: round(eventLoopWorstMs),
					longFrameRatio: round(frameTimes.length ? longFrameCount / frameTimes.length : 1),
					lowConfidenceReasons: [...lowConfidenceReasons],
					onePercentLowFps: round(meanSlowFrameTime > 0 ? 1000 / meanSlowFrameTime : 0),
					p95FrameTimeMs: round(percentile(sortedFrames, 0.95)),
					sampleCount: frameTimes.length,
					success: frameTimes.length > 0,
					webglRenderer: renderer,
					worstFrameTimeMs: round(sortedFrames.at(-1) || 0)
				};
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

function resultMarkup(result: CalibrationResult, recommendedId?: string): string {
	const { candidate, metrics } = result;
	const recommended = candidate.id === recommendedId;
	const lowConfidenceReasons = metrics.lowConfidenceReasons ?? [];
	const lowConfidenceMarkup = lowConfidenceReasons.length > 0
		? `<div class="result-note low-confidence">Lower confidence: ${escapeHtml(lowConfidenceReasons.map(reason => lowConfidenceLabels[reason]).join(', '))}. The trial was retained as warn-and-continue evidence.</div>`
		: '';
	const failureMarkup = result.failureReason
		? `<div class="result-note failure">${escapeHtml(result.failureReason)}</div>`
		: '';
	return `<div class="result${recommended ? ' recommended' : ''}">
			<div class="name">${escapeHtml(candidate.backend)} · ${escapeHtml(candidate.framePolicy)}${recommended ? '<span class="label">Recommended</span>' : ''}</div>
			<div class="metric"><span class="label">Average</span>${metrics.success ? `${metrics.averageFps.toFixed(1)} FPS` : 'Failed'}</div>
			<div class="metric"><span class="label">1% low</span>${metrics.success ? `${metrics.onePercentLowFps.toFixed(1)} FPS` : 'N/A'}</div>
			<div class="metric"><span class="label">p95 frame</span>${metrics.success ? `${metrics.p95FrameTimeMs.toFixed(2)} ms` : 'N/A'}</div>
			<div class="metric"><span class="label">Relative score</span>${metrics.success ? result.score.toFixed(2) : 'N/A'}</div>
			<div class="result-note">${escapeHtml(backendVerificationText(result.backendVerification))}</div>
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
	const displayedResults = recommended && !results.some(result => result.candidate.id === recommended.candidate.id)
		? [recommended, ...results]
		: results;
	const resultsHtml = displayedResults.map(result => resultMarkup(result, recommended?.candidate.id)).join('');
	const applyLabel = wasCompetitiveModeEnabled ? 'Apply new profile' : 'Enable Competitive mode';
	const keepLabel = wasCompetitiveModeEnabled ? 'Keep previous profile' : 'Keep current settings';
	const retainedKnownGood = Boolean(recommended && !results.some(result => result.candidate.id === recommended.candidate.id));
	const summary = recommended
		? retainedKnownGood
			? `The new evidence did not meaningfully beat the existing known-good <strong>${escapeHtml(recommended.candidate.backend)}</strong> profile, so it remains recommended.`
			: `The strongest measured profile was <strong>${escapeHtml(recommended.candidate.backend)}</strong> with <strong>${escapeHtml(recommended.candidate.framePolicy)}</strong> frame delivery.`
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
