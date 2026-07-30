import { MAX_VALID_FRAME_MS, RollingPerformanceStats } from './performance-stats.ts';

const OVERLAY_REFRESH_MS = 1_000;

const performanceStats = new RollingPerformanceStats();

let lastFrameTime = 0;
let animationFrame: number | undefined;
let nextOverlayRefresh = 0;
let overlay: HTMLPreElement | undefined;
let overlayVisible = true;
let monitorStarted = false;
let runtimeInfo: GraphicsRuntimeInfo | undefined;

function recordFrame(now: number) {
	animationFrame = undefined;
	if (!monitorStarted || !overlayVisible || document.visibilityState !== 'visible') {
		lastFrameTime = 0;
		return;
	}

	if (lastFrameTime > 0) {
		const frameTime = now - lastFrameTime;
		if (frameTime > 0 && frameTime <= MAX_VALID_FRAME_MS) performanceStats.recordFrame(now, frameTime);
	}
	lastFrameTime = now;

	// Rendering is throttled on the existing animation-frame loop. There is no
	// interval competing with a frame, and snapshot work is fixed-size.
	if (now >= nextOverlayRefresh) {
		renderOverlay(now);
		nextOverlayRefresh = now + OVERLAY_REFRESH_MS;
	}

	animationFrame = requestAnimationFrame(recordFrame);
}

function startSampling(now = performance.now()) {
	if (animationFrame !== undefined || !monitorStarted || !overlayVisible || document.visibilityState !== 'visible') return;
	lastFrameTime = 0;
	nextOverlayRefresh = now + OVERLAY_REFRESH_MS;
	animationFrame = requestAnimationFrame(recordFrame);
}

function stopSampling() {
	if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
	animationFrame = undefined;
	lastFrameTime = 0;
}

export function getPerformanceSnapshot(now = performance.now()): PerformanceSnapshot {
	return performanceStats.snapshot(now);
}

export function resetPerformanceMonitor() {
	performanceStats.reset();
	lastFrameTime = 0;
	if (overlayVisible) renderOverlay();
}

function renderOverlay(now = performance.now()) {
	if (!overlay || !overlayVisible || !runtimeInfo) return;

	const snapshot = getPerformanceSnapshot(now);
	const onePercentLow = snapshot.onePercentLowFps > 0 ? snapshot.onePercentLowFps.toFixed(1) : 'collecting';
	const webglStatus = runtimeInfo.features.webgl ?? 'unknown';
	const rasterStatus = runtimeInfo.features.rasterization ?? 'unknown';

	overlay.textContent = [
		'WOK CLIENT PERFORMANCE',
		`FPS now       ${snapshot.currentFps.toFixed(1)}`,
		`FPS 10s avg   ${snapshot.averageFps.toFixed(1)}`,
		`1% low        ${onePercentLow}`,
		`p95 frame     ${snapshot.p95FrameTimeMs.toFixed(2)} ms`,
		`worst frame   ${snapshot.worstFrameTimeMs.toFixed(2)} ms`,
		`backend       ${runtimeInfo.activeBackend} (${runtimeInfo.source})`,
		`WebGL         ${webglStatus}`,
		`raster        ${rasterStatus}`,
		`samples       ${snapshot.sampleCount}`,
		'Alt+F8: hide/show'
	].join('\n');
}

function setOverlayVisible(visible: boolean) {
	overlayVisible = visible;
	if (overlay) overlay.hidden = !visible;

	if (visible) {
		renderOverlay();
		startSampling();
	} else {
		stopSampling();
	}
}

function createOverlay(): HTMLPreElement {
	const element = document.createElement('pre');
	element.id = 'crankshaftPerformanceOverlay';
	element.setAttribute('aria-label', 'WOK Client performance diagnostics');
	Object.assign(element.style, {
		background: 'rgba(8, 10, 14, 0.82)',
		border: '1px solid rgba(251, 192, 45, 0.72)',
		borderRadius: '6px',
		color: '#FFFFFF',
		contain: 'content',
		font: '600 12px/1.45 Consolas, monospace',
		margin: '0',
		padding: '8px 10px',
		pointerEvents: 'none',
		position: 'fixed',
		right: '8px',
		textAlign: 'left',
		top: '8px',
		userSelect: 'none',
		width: '250px',
		zIndex: '2147483647'
	});
	document.body.append(element);
	return element;
}

function handleVisibilityChange() {
	if (document.visibilityState === 'visible') {
		if (overlayVisible) {
			renderOverlay();
			startSampling();
		}
	} else {
		stopSampling();
	}
}

function handleOverlayHotkey(event: KeyboardEvent) {
	if (!event.altKey || event.code !== 'F8') return;
	event.preventDefault();
	setOverlayVisible(!overlayVisible);
}

function handleBeforeUnload() {
	stopPerformanceMonitor();
}

const performanceApi = Object.freeze({
	reset: resetPerformanceMonitor,
	setVisible: setOverlayVisible,
	snapshot: getPerformanceSnapshot
});

export function startPerformanceMonitor(info: GraphicsRuntimeInfo) {
	runtimeInfo = info;
	if (monitorStarted) return;

	monitorStarted = true;
	overlayVisible = true;
	overlay = createOverlay();
	performanceStats.reset();
	document.addEventListener('visibilitychange', handleVisibilityChange, { passive: true });
	window.addEventListener('keydown', handleOverlayHotkey, true);
	window.addEventListener('beforeunload', handleBeforeUnload, { once: true });
	window.wokPerformance = performanceApi;
	window.crankshaftPerformance = performanceApi;
	renderOverlay();
	startSampling();
}

export function stopPerformanceMonitor() {
	if (!monitorStarted) return;

	stopSampling();
	document.removeEventListener('visibilitychange', handleVisibilityChange);
	window.removeEventListener('keydown', handleOverlayHotkey, true);
	window.removeEventListener('beforeunload', handleBeforeUnload);
	overlay?.remove();
	overlay = undefined;
	performanceStats.reset();
	if (window.wokPerformance === performanceApi) delete window.wokPerformance;
	if (window.crankshaftPerformance === performanceApi) delete window.crankshaftPerformance;
	runtimeInfo = undefined;
	monitorStarted = false;
	overlayVisible = true;
}
