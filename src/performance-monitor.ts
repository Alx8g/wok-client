import {
	parseKrunkerRegionCode,
	parseKrunkerReportedPing,
	parseKrunkerReportedTps,
	RollingReportedPingStats
} from './network-diagnostics.ts';
import { MAX_VALID_FRAME_MS, RollingPerformanceStats } from './performance-stats.ts';
import { getCustomIdentityOverlayLines } from './custom-identity-display.ts';
import { NO_REWRITE_ATTRIBUTE } from './identity-rewrite.ts';

const OVERLAY_REFRESH_MS = 1_000;
const REPORTED_PING_STALE_MS = 15_000;

const performanceStats = new RollingPerformanceStats();
const reportedPingStats = new RollingReportedPingStats();

let lastFrameTime = 0;
let animationFrame: number | undefined;
let nextOverlayRefresh = 0;
let overlay: HTMLPreElement | undefined;
let overlayVisible = true;
let monitorStarted = false;
let runtimeInfo: GraphicsRuntimeInfo | undefined;
let observedPingElement: HTMLElement | undefined;
let pingObserver: MutationObserver | undefined;

function getElementById(id: string): HTMLElement | null {
	return typeof document.getElementById === 'function'
		? document.getElementById(id)
		: null;
}

function recordReportedPing(element: HTMLElement, now = performance.now()) {
	const reportedPingMs = parseKrunkerReportedPing(element.textContent);
	if (reportedPingMs !== undefined) reportedPingStats.record(now, reportedPingMs);
}

function stopNetworkObservation() {
	pingObserver?.disconnect();
	pingObserver = undefined;
	observedPingElement = undefined;
}

function ensureNetworkObservation(now = performance.now()) {
	const pingElement = getElementById('pingText');
	if (pingElement === observedPingElement) return;

	stopNetworkObservation();
	if (!pingElement) return;

	observedPingElement = pingElement;
	recordReportedPing(pingElement, now);
	if (typeof MutationObserver !== 'function') return;

	const observer = new MutationObserver(() => {
		if (
			observer !== pingObserver
			|| pingElement !== observedPingElement
			|| !monitorStarted
			|| !overlayVisible
			|| document.visibilityState !== 'visible'
		) return;
		recordReportedPing(pingElement);
	});
	observer.observe(pingElement, { characterData: true, childList: true, subtree: true });
	pingObserver = observer;
}

function currentRegionCode(): string {
	let gameId: unknown;
	try {
		if (typeof window.getGameActivity === 'function') {
			const activity: unknown = window.getGameActivity();
			if (activity && typeof activity === 'object' && !Array.isArray(activity)) {
				gameId = (activity as Record<string, unknown>).id;
			}
		}
	} catch (_error) {
		// Krunker's page API is optional and can be unavailable while navigating.
	}

	if (gameId === undefined) {
		try {
			gameId = new URLSearchParams(window.location?.search ?? '').get('game') ?? undefined;
		} catch (_error) {
			// A missing or transient location leaves the region unknown.
		}
	}

	return parseKrunkerRegionCode(gameId) ?? '';
}

function elementIsVisible(element: HTMLElement | null): boolean {
	if (!element || element.hidden) return false;
	if (typeof getComputedStyle !== 'function') return element.style.display !== 'none';
	const style = getComputedStyle(element);
	return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

export function getNetworkDiagnosticsSnapshot(now = performance.now()): NetworkDiagnosticsSnapshot {
	if (monitorStarted && overlayVisible && document.visibilityState === 'visible') ensureNetworkObservation(now);

	const reportedPing = reportedPingStats.snapshot(now);
	return {
		available: reportedPing.available,
		currentReportedPingMs: reportedPing.currentMs,
		minimumReportedPingMs: reportedPing.minimumMs,
		medianReportedPingMs: reportedPing.medianMs,
		p95ReportedPingMs: reportedPing.p95Ms,
		reportedPingVariationMs: reportedPing.variationMs,
		reportedPingSampleAgeMs: reportedPing.sampleAgeMs,
		reportedPingSampleCount: reportedPing.sampleCount,
		reportedPingWindowSeconds: reportedPing.windowSeconds,
		regionCode: currentRegionCode(),
		reportedTps: parseKrunkerReportedTps(getElementById('tickPacketCount')?.textContent) ?? 0,
		networkLagWarning: elementIsVisible(getElementById('networkLag'))
	};
}

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
	ensureNetworkObservation(now);
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
	reportedPingStats.reset();
	lastFrameTime = 0;
	if (observedPingElement) recordReportedPing(observedPingElement);
	if (overlayVisible) renderOverlay();
}

function renderOverlay(now = performance.now()) {
	if (!overlay || !overlayVisible || !runtimeInfo) return;

	const snapshot = getPerformanceSnapshot(now);
	const networkSnapshot = getNetworkDiagnosticsSnapshot(now);
	const onePercentLow = snapshot.onePercentLowFps > 0 ? snapshot.onePercentLowFps.toFixed(1) : 'collecting';
	const webglStatus = runtimeInfo.features.webgl ?? 'unknown';
	const rasterStatus = runtimeInfo.features.rasterization ?? 'unknown';
	const reportedPing = networkSnapshot.available
		? `${networkSnapshot.currentReportedPingMs.toFixed(0)} ms${networkSnapshot.reportedPingSampleAgeMs > REPORTED_PING_STALE_MS ? ' (stale)' : ''}`
		: 'collecting';
	const reportedPingRange = networkSnapshot.available
		? `${networkSnapshot.medianReportedPingMs.toFixed(0)} / ${networkSnapshot.p95ReportedPingMs.toFixed(0)} ms`
		: 'collecting';
	const reportedPingVariation = networkSnapshot.available
		? `${networkSnapshot.reportedPingVariationMs.toFixed(1)} ms`
		: 'collecting';
	const reportedTps = networkSnapshot.reportedTps > 0 ? networkSnapshot.reportedTps.toFixed(0) : 'unknown';
	// Local display identity, read from the client's own state. Absent unless the user set one,
	// and unrelated to the account name Krunker knows. Reports what it is searching for and how
	// many nodes it is currently rewriting, which is the only way to check the feature in-game.
	const customIdentityLines = getCustomIdentityOverlayLines();

	overlay.textContent = [
		'WOK RENDERER rAF DIAGNOSTICS',
		...customIdentityLines,
		`rAF FPS now   ${snapshot.currentFps.toFixed(1)}`,
		`rAF FPS 10s   ${snapshot.averageFps.toFixed(1)}`,
		`rAF 1% low    ${onePercentLow}`,
		`rAF p95       ${snapshot.p95FrameTimeMs.toFixed(2)} ms`,
		`rAF worst     ${snapshot.worstFrameTimeMs.toFixed(2)} ms`,
		`backend       ${runtimeInfo.activeBackend} (${runtimeInfo.source})`,
		...(runtimeInfo.gpuAdvisory
			? [`GPU WARNING   ${runtimeInfo.gpuAdvisoryKind === 'manual-backend-failure'
				? 'manual backend crashing, never quarantined'
				: 'integrated GPU active, discrete GPU idle'}`]
			: []),
		`WebGL         ${webglStatus}`,
		`raster        ${rasterStatus}`,
		`samples       ${snapshot.sampleCount}`,
		'',
		'KRUNKER-REPORTED NETWORK (not RTT)',
		`reported ping ${reportedPing}`,
		`ping p50/p95  ${reportedPingRange}`,
		`ping change   ${reportedPingVariation}`,
		`server        ${networkSnapshot.regionCode || 'not joined'} · TPS ${reportedTps}`,
		`lag warning   ${networkSnapshot.networkLagWarning ? 'ACTIVE' : 'no'} · ${networkSnapshot.reportedPingSampleCount} samples`,
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
		stopNetworkObservation();
	}
}

function createOverlay(): HTMLPreElement {
	const element = document.createElement('pre');
	element.id = 'crankshaftPerformanceOverlay';
	element.setAttribute('aria-label', 'WOK Client performance and network diagnostics');
	// This overlay prints the real name it is searching for, so the identity engine must leave it
	// alone; rewriting it would make the one diagnostic that proves the feature works agree with
	// itself no matter what.
	element.setAttribute(NO_REWRITE_ATTRIBUTE, '');
	/*
	 * Themeable through custom properties rather than a stylesheet: these are inline styles, so a
	 * theme's rules could only reach them with !important. Every var() carries the stock value as
	 * its fallback, which is what an unthemed client renders. fontFamily follows the font
	 * shorthand deliberately, so a missing --wok-font-mono cannot invalidate the whole shorthand.
	 */
	Object.assign(element.style, {
		background: 'var(--wok-overlay-bg, rgba(8, 10, 14, 0.82))',
		border: '1px solid rgba(251, 192, 45, 0.72)',
		borderColor: 'var(--wok-overlay-border, rgba(251, 192, 45, 0.72))',
		borderRadius: 'var(--wok-radius, 6px)',
		color: 'var(--wok-overlay-text, #FFFFFF)',
		contain: 'content',
		font: '600 12px/1.45 Consolas, monospace',
		fontFamily: 'var(--wok-font-mono, Consolas, monospace)',
		margin: '0',
		padding: '8px 10px',
		pointerEvents: 'none',
		position: 'fixed',
		right: '8px',
		textAlign: 'left',
		top: '8px',
		userSelect: 'none',
		width: '285px',
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
		stopNetworkObservation();
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
	networkSnapshot: getNetworkDiagnosticsSnapshot,
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
	reportedPingStats.reset();
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
	stopNetworkObservation();
	document.removeEventListener('visibilitychange', handleVisibilityChange);
	window.removeEventListener('keydown', handleOverlayHotkey, true);
	window.removeEventListener('beforeunload', handleBeforeUnload);
	overlay?.remove();
	overlay = undefined;
	performanceStats.reset();
	reportedPingStats.reset();
	if (window.wokPerformance === performanceApi) delete window.wokPerformance;
	if (window.crankshaftPerformance === performanceApi) delete window.crankshaftPerformance;
	runtimeInfo = undefined;
	monitorStarted = false;
	overlayVisible = true;
}
