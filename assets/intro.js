/*
 * Launch intro renderer.
 *
 * The obvious implementation - a full-window <video> element - does not survive this client's
 * own command-line switches. `--disable-frame-rate-limit` (applied whenever the FPS uncap or an
 * uncapped competitive frame policy is active, see src/switches.ts) starves Chromium's video
 * presentation path: the decoder still produces every frame (112/112, zero dropped) but the
 * compositor only ever presents about 31 of them, so the animation renders at roughly 8 fps.
 * Measured on Windows 11 / Intel iGPU:
 *
 *   no switches                    112/112 frames presented   29.6 fps
 *   --disable-gpu-vsync            112/112 frames presented   29.6 fps
 *   --disable-frame-rate-limit      30/112 frames presented    7.6 fps
 *
 * requestAnimationFrame is unaffected by that switch (it runs unthrottled, ~200 Hz), so the video
 * is decoded off-screen and blitted to a canvas from a rAF loop instead. The decode path and the
 * media lifecycle events the main process relies on are unchanged.
 *
 * Draws are gated on the source frame actually advancing, so the blit runs at the asset's 30 fps
 * rather than at the unthrottled rAF rate - the loop must not burn CPU while Krunker is loading.
 */

const SOURCE_FPS = 30;

/**
 * Where the picture stops changing. The audio track always runs on past it, so the loop must stop
 * here: leaving it running woke the renderer at the unthrottled rAF rate (~200 Hz) for a further
 * two seconds to redraw an identical frame, in exactly the window where Krunker compiles its
 * shaders. Audio playback is unaffected by stopping the loop.
 *
 * Supplied per variant by the main process, because each one is the same render trimmed from a
 * different start point and so stops at a different time.
 */
const requestedVisualMs = Number(new URLSearchParams(window.location.search).get('visualMs'));
const VISUAL_END_SECONDS = Number.isFinite(requestedVisualMs) && requestedVisualMs > 0
	? requestedVisualMs / 1000
	: 3.8;

/**
 * The main process picks the length variant and the resolution that matches the target display's
 * device pixels, and passes both as query parameters, so nothing here needs an IPC channel. Only
 * the shipped names are accepted: these values reach this page through a URL and are never trusted
 * as free-form paths.
 */
const ASSETS = { 'intro-short': 'intro-short', 'intro-long': 'intro-long' };
const SOURCES = { '1080': '1080', '1440': '1440' };

const params = new URLSearchParams(window.location.search);
const asset = ASSETS[params.get('asset')] ?? ASSETS['intro-short'];
const source = SOURCES[params.get('source')] ?? SOURCES['1080'];

const video = document.getElementById('intro-source');
video.src = `${asset}-${source}.webm`;
const canvas = document.getElementById('intro-canvas');
const context = canvas.getContext('2d', { alpha: true });

let backingWidth = 0;
let backingHeight = 0;
let lastDrawnFrame = -1;

/** Match the backing store to the window's device pixels, not the source resolution. */
function resizeCanvas() {
	const ratio = window.devicePixelRatio || 1;
	const width = Math.round(window.innerWidth * ratio);
	const height = Math.round(window.innerHeight * ratio);
	if (width === backingWidth && height === backingHeight) return;
	backingWidth = width;
	backingHeight = height;
	canvas.width = width;
	canvas.height = height;
	lastDrawnFrame = -1;
}

/** CSS object-fit: cover, done by hand so the canvas keeps its alpha. */
function drawCover() {
	const sourceWidth = video.videoWidth;
	const sourceHeight = video.videoHeight;
	if (sourceWidth === 0 || sourceHeight === 0) return;

	const scale = Math.max(backingWidth / sourceWidth, backingHeight / sourceHeight);
	const drawWidth = sourceWidth * scale;
	const drawHeight = sourceHeight * scale;

	// clearRect, never fillRect: painting a background would hide the desktop behind the window.
	context.clearRect(0, 0, backingWidth, backingHeight);
	context.drawImage(video, (backingWidth - drawWidth) / 2, (backingHeight - drawHeight) / 2, drawWidth, drawHeight);
}

function tick() {
	if (video.readyState >= 2) {
		resizeCanvas();
		const frame = Math.floor(video.currentTime * SOURCE_FPS);
		if (frame !== lastDrawnFrame) {
			lastDrawnFrame = frame;
			drawCover();
		}
		// Final frame drawn; stop scheduling. The audio tail keeps playing without us.
		if (video.currentTime >= VISUAL_END_SECONDS) return;
	}
	requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
void video.play().catch(error => {
	// The main process owns fail-forward timing. Avoid an unhandled rejection here and let its
	// media-start timeout reveal the game if playback cannot begin.
	console.error('Launch intro playback failed', error);
});
