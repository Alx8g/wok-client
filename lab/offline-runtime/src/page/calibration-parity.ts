import { buildCalibrationTrialPage } from '../../../../src/calibration-window.ts';
import type { CalibrationCandidate } from '../../../../src/calibration.ts';
import { sha256Hex } from '../shared/hash.ts';
import {
	RUNTIME_LAB_DEFAULT_BENCHMARK_MS,
	RUNTIME_LAB_DEFAULT_MIN_SAMPLES,
	RUNTIME_LAB_FOREGROUND_POLL_MS,
	RUNTIME_LAB_FOREGROUND_SETTLE_MS,
	RUNTIME_LAB_FOREGROUND_TIMEOUT_MS,
	RUNTIME_LAB_PAGE_ID,
	RUNTIME_LAB_PROTOCOL_VERSION,
	RUNTIME_LAB_WORKLOAD_VERSION
} from '../shared/protocol.ts';

const LAB_CANDIDATE: CalibrationCandidate = {
	backend: 'default',
	framePolicy: 'uncapped',
	id: 'runtime-lab-tier1'
};

function autoRunScript(): string {
	return `<script>
		'use strict';
		(() => {
			const pageScriptStartMs = performance.now();
			const parameters = new URLSearchParams(location.search);
			const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
			const sha256Pattern = /^[a-f0-9]{64}$/;
			const requireIdentifier = (name) => {
				const value = parameters.get(name) || '';
				if (!identifierPattern.test(value)) throw new Error('Invalid ' + name + '.');
				return value;
			};
			const boundedInteger = (name, fallback, minimum, maximum) => {
				const raw = parameters.get(name);
				if (raw === null || raw === '') return fallback;
				const value = Number(raw);
				if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error('Invalid ' + name + '.');
				return value;
			};
			const runId = requireIdentifier('run');
			const candidateId = requireIdentifier('candidate');
			const token = requireIdentifier('token');
			const pageSha256 = parameters.get('page') || '';
			if (!sha256Pattern.test(pageSha256)) throw new Error('Invalid page digest.');
			const benchmarkMs = boundedInteger('benchmarkMs', ${RUNTIME_LAB_DEFAULT_BENCHMARK_MS}, 1_000, 300_000);
			const minSamples = boundedInteger('minSamples', ${RUNTIME_LAB_DEFAULT_MIN_SAMPLES}, 10, 100_000);
			const inputMode = parameters.get('input') || 'off';
			if (inputMode !== 'off' && inputMode !== 'synthetic') throw new Error('Invalid input mode.');
			const startMode = parameters.get('start') || 'immediate';
			if (startMode !== 'controller' && startMode !== 'immediate') throw new Error('Invalid start mode.');

			const foregroundEvents = [];
			const recordForegroundEvent = type => {
				if (foregroundEvents.length >= 64) return;
				foregroundEvents.push({
					hasFocus: typeof document.hasFocus === 'function' && document.hasFocus(),
					performanceNowMs: performance.now(),
					type,
					visibilityState: document.visibilityState
				});
			};
			window.addEventListener('blur', () => recordForegroundEvent('window-blur'), { passive: true });
			window.addEventListener('focus', () => recordForegroundEvent('window-focus'), { passive: true });
			document.addEventListener('visibilitychange', () => recordForegroundEvent('visibility-change'), { passive: true });
			recordForegroundEvent('initial-state');

			const failedBenchmark = (message, reason = 'page-error') => ({
				averageFps: 0,
				contaminationFlags: ['page-error'],
				cpuSubmitP50Ms: 0,
				cpuSubmitP95Ms: 0,
				environment: {
					devicePixelRatio: window.devicePixelRatio || 1,
					drawingBufferHeight: 0,
					drawingBufferWidth: 0
				},
				eventLoopP95Ms: 0,
				eventLoopWorstMs: 0,
				gpuDisjointDiscardCount: 0,
				gpuImplausibleCount: 0,
				gpuSampleCount: 0,
				gpuTimingStatus: 'unsupported',
				longFrameRatio: 1,
				lowConfidenceReasons: [reason, 'page-error:' + String(message).slice(0, 180)],
				onePercentLowFps: 0,
				p95FrameTimeMs: 0,
				rejected: true,
				rejectionReasons: [reason],
				sampleCount: 0,
				stallRatio: 1,
				stalledTicks: 0,
				success: false,
				totalTicks: 0,
				webglRenderer: '',
				worstFrameTimeMs: 0
			});

			const createSyntheticInputProbe = target => {
				const dispatchIntervalMs = 16;
				const keyCodes = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'];
				const lateness = [];
				let dispatchChecksum = 0;
				let dispatchedEvents = 0;
				let expectedAt = 0;
				let receivedChecksum = 0;
				let receivedEvents = 0;
				let sequence = 0;
				let timer;
				const mix = (hash, values) => {
					let next = hash >>> 0;
					for (const value of values) next = Math.imul(next ^ (value >>> 0), 0x01000193) >>> 0;
					return next;
				};
				const onMouseMove = event => {
					receivedEvents++;
					receivedChecksum = mix(receivedChecksum, [1, event.clientX, event.clientY, event.buttons]);
				};
				const onKeyDown = event => {
					receivedEvents++;
					receivedChecksum = mix(receivedChecksum, [2, Math.max(0, keyCodes.indexOf(event.code))]);
				};
				const schedule = () => {
					timer = setTimeout(tick, Math.max(0, expectedAt - performance.now()));
				};
				const tick = () => {
					const now = performance.now();
					lateness.push(Math.max(0, now - expectedAt));
					if (sequence % 8 === 7) {
						const keyIndex = Math.floor(sequence / 8) % keyCodes.length;
						dispatchChecksum = mix(dispatchChecksum, [2, keyIndex]);
						dispatchedEvents++;
						target.dispatchEvent(new KeyboardEvent('keydown', { code: keyCodes[keyIndex], key: keyCodes[keyIndex], bubbles: false }));
					} else {
						const clientX = (sequence * 37) % Math.max(1, window.innerWidth);
						const clientY = (sequence * 53) % Math.max(1, window.innerHeight);
						const buttons = sequence % 3 === 0 ? 1 : 0;
						dispatchChecksum = mix(dispatchChecksum, [1, clientX, clientY, buttons]);
						dispatchedEvents++;
						target.dispatchEvent(new MouseEvent('mousemove', { buttons, clientX, clientY, bubbles: false }));
					}
					sequence++;
					expectedAt += dispatchIntervalMs;
					schedule();
				};
				return {
					start() {
						target.addEventListener('mousemove', onMouseMove);
						target.addEventListener('keydown', onKeyDown);
						expectedAt = performance.now() + dispatchIntervalMs;
						schedule();
					},
					stop() {
						clearTimeout(timer);
						target.removeEventListener('mousemove', onMouseMove);
						target.removeEventListener('keydown', onKeyDown);
						const sorted = lateness.slice().sort((left, right) => left - right);
						const percentileIndex = sorted.length ? Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95)) : 0;
						return {
							dispatchChecksum,
							dispatchIntervalMs,
							dispatchedEvents,
							p95DispatchLatenessMs: sorted[percentileIndex] || 0,
							receivedChecksum,
							receivedEvents,
							mode: 'synthetic',
							worstDispatchLatenessMs: sorted.at(-1) || 0
						};
					}
				};
			};

			const waitForDom = () => document.readyState === 'loading'
				? new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
				: Promise.resolve();
			const waitForController = async () => {
				if (startMode === 'immediate') return;
				const response = await fetch('/v1/start/' + encodeURIComponent(token), {
					cache: 'no-store',
					credentials: 'omit',
					referrerPolicy: 'no-referrer'
				});
				if (!response.ok) throw new Error('Benchmark start barrier failed (' + response.status + ').');
			};
			const waitForStableForeground = () => new Promise((resolve, reject) => {
				const startedAt = performance.now();
				let settled = false;
				let stableSince;
				let timer;
				const focusedAndVisible = () => document.visibilityState === 'visible'
					&& typeof document.hasFocus === 'function'
					&& document.hasFocus();
				const cleanup = () => {
					clearTimeout(timer);
					window.removeEventListener('blur', reset);
					window.removeEventListener('focus', reset);
					document.removeEventListener('visibilitychange', reset);
				};
				const finish = error => {
					if (settled) return;
					settled = true;
					cleanup();
					if (error) reject(error);
					else resolve();
				};
				const check = () => {
					if (settled) return;
					const now = performance.now();
					const elapsed = now - startedAt;
					if (elapsed >= ${RUNTIME_LAB_FOREGROUND_TIMEOUT_MS}) {
						finish(new Error('foreground-not-stable-before-start'));
						return;
					}
					if (!focusedAndVisible()) stableSince = undefined;
					else stableSince ??= now;
					if (
						stableSince !== undefined
						&& now - stableSince >= ${RUNTIME_LAB_FOREGROUND_SETTLE_MS}
						&& focusedAndVisible()
					) {
						finish();
						return;
					}
					const settleRemaining = stableSince === undefined
						? ${RUNTIME_LAB_FOREGROUND_POLL_MS}
						: Math.max(1, ${RUNTIME_LAB_FOREGROUND_SETTLE_MS} - (now - stableSince));
					const timeoutRemaining = Math.max(1, ${RUNTIME_LAB_FOREGROUND_TIMEOUT_MS} - elapsed);
					timer = setTimeout(check, Math.min(${RUNTIME_LAB_FOREGROUND_POLL_MS}, settleRemaining, timeoutRemaining));
				};
				function reset() {
					stableSince = undefined;
					clearTimeout(timer);
					check();
				}
				window.addEventListener('blur', reset, { passive: true });
				window.addEventListener('focus', reset, { passive: true });
				document.addEventListener('visibilitychange', reset, { passive: true });
				check();
			});

			const run = async () => {
				await waitForDom();
				const domReadyMs = performance.now();
				await waitForController();
				const controllerReleasedMs = performance.now();
				let benchmark;
				let benchmarkInvokedMs;
				let foregroundStableMs;
				let inputProbe = null;
				try {
					await waitForStableForeground();
					foregroundStableMs = performance.now();
					benchmarkInvokedMs = performance.now();
					inputProbe = inputMode === 'synthetic' ? createSyntheticInputProbe(document.getElementById('benchmark')) : null;
					if (inputProbe) inputProbe.start();
					try {
						benchmark = await window.wokRunBenchmark({ benchmarkMs, minSamples });
					} catch (error) {
						benchmark = failedBenchmark(error instanceof Error ? error.message : String(error));
					}
				} catch (error) {
					benchmarkInvokedMs = performance.now();
					const message = error instanceof Error ? error.message : String(error);
					const reason = message === 'foreground-not-stable-before-start'
						? message
						: 'page-error';
					benchmark = failedBenchmark(message, reason);
				}
				const input = inputProbe ? inputProbe.stop() : {
					dispatchChecksum: 0,
					dispatchIntervalMs: 0,
					dispatchedEvents: 0,
					mode: inputMode,
					p95DispatchLatenessMs: 0,
					receivedChecksum: 0,
					receivedEvents: 0,
					worstDispatchLatenessMs: 0
				};
				const benchmarkCompletedMs = performance.now();
				const userAgentData = navigator.userAgentData;
				const envelope = {
					benchmark,
					candidateId,
					foregroundEvents,
					identity: {
						...(typeof navigator.deviceMemory === 'number' ? { deviceMemoryGiB: navigator.deviceMemory } : {}),
						hardwareConcurrency: navigator.hardwareConcurrency || 0,
						language: navigator.language || '',
						platform: navigator.platform || '',
						userAgent: navigator.userAgent || '',
						...(userAgentData && Array.isArray(userAgentData.brands) ? { userAgentBrands: userAgentData.brands } : {}),
						...(userAgentData && typeof userAgentData.mobile === 'boolean' ? { userAgentMobile: userAgentData.mobile } : {}),
						...(userAgentData && typeof userAgentData.platform === 'string' ? { userAgentPlatform: userAgentData.platform } : {})
					},
					input,
					pageId: ${JSON.stringify(RUNTIME_LAB_PAGE_ID)},
					pageSha256,
					protocolVersion: ${RUNTIME_LAB_PROTOCOL_VERSION},
					runId,
					timings: {
						benchmarkCompletedMs,
						benchmarkInvokedMs,
						controllerReleasedMs,
						domReadyMs,
						...(foregroundStableMs === undefined ? {} : { foregroundStableMs }),
						pageScriptStartMs,
						timeOriginEpochMs: performance.timeOrigin
					},
					workloadVersion: ${RUNTIME_LAB_WORKLOAD_VERSION}
				};
				const response = await fetch('/v1/results/' + encodeURIComponent(token), {
					body: JSON.stringify(envelope),
					cache: 'no-store',
					credentials: 'omit',
					headers: { 'content-type': 'application/json' },
					keepalive: true,
					method: 'POST',
					referrerPolicy: 'no-referrer'
				});
				if (!response.ok) throw new Error('Result collector rejected the result (' + response.status + ').');
				document.documentElement.dataset.runtimeLabState = 'reported';
				document.title = 'WOK Runtime Lab - Complete';
			};

			run().catch(error => {
				document.documentElement.dataset.runtimeLabState = 'failed';
				document.title = 'WOK Runtime Lab - Failed';
				const phase = document.getElementById('phase');
				if (phase) phase.textContent = error instanceof Error ? error.message : String(error);
			});
		})();
	</script>`;
}

export interface CalibrationParityPage {
	calibrationSourceHtml: string;
	calibrationSourceSha256: string;
	html: string;
	pageId: typeof RUNTIME_LAB_PAGE_ID;
	sha256: string;
	workloadVersion: number;
}

export function buildCalibrationParityPage(markSvg: string): CalibrationParityPage {
	const calibrationSourceHtml = buildCalibrationTrialPage(LAB_CANDIDATE, 1, 1, markSvg);
	const favicon = '<link rel="icon" href="data:,">';
	const html = calibrationSourceHtml
		.replace('</head>', `\t\t${favicon}\n\t</head>`)
		.replace('</body>', `${autoRunScript()}\n\t</body>`);
	return {
		calibrationSourceHtml,
		calibrationSourceSha256: sha256Hex(calibrationSourceHtml),
		html,
		pageId: RUNTIME_LAB_PAGE_ID,
		sha256: sha256Hex(html),
		workloadVersion: RUNTIME_LAB_WORKLOAD_VERSION
	};
}
