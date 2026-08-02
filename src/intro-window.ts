import type {
	BrowserWindow,
	BrowserWindowConstructorOptions,
	Display
} from 'electron';
import { join as pathJoin } from 'path';
import type { IntroVariantTiming } from './startup-profile.ts';

/**
 * Launch identity animation.
 *
 * Several length variants ship (see startup-profile.ts); the client picks one to match how long
 * its own launches actually take. Every variant is a VP9 WebM whose video and audio tracks end at
 * different times on purpose, and every variant ends on a pixel-identical final frame - verified by
 * diffing the 3.733 s and 7.167 s renders - which is also the frame the loading screen carries, so
 * switching variants never changes the handoff.
 *
 * Taking the short variant as the example:
 *
 * - 0 ms .. ~1330 ms  the frame is genuinely transparent (mean alpha ramps 1 -> 255), so the
 *                     user's desktop shows through while the animation wipes in.
 * - ~1330 ms          alpha reaches 255 everywhere; from here the frame is fully opaque black.
 * - 3733 ms           the video track ends on a static WOK lockup over #000000.
 * - 5674 ms           the audio track finishes its fade-out tail.
 *
 * The long variant has the same shape stretched: opaque at 4933 ms, picture ends at 7167 ms, audio
 * at 9267 ms. Timings are per-variant, never assumed.
 *
 * Two properties of that timeline drive the whole sequence:
 *
 * 1. Because the frame is opaque well before the video ends, the game window can be revealed
 *    *behind* the intro mid-playback with no visible seam - the game window's backgroundColor is
 *    already #000000. Revealing early also stops Chromium treating the game renderer as a hidden
 *    window for the back half of Krunker's load.
 * 2. Because Chromium keeps a media element playing while its BrowserWindow is hidden, the intro
 *    window can be hidden at the visual end and destroyed only once the audio tail completes. The
 *    sting therefore decays over the loading screen instead of being cut off at the handoff.
 *
 * The intro window is sandboxed and context-isolated with no preload and no IPC surface: the
 * sequence is driven entirely from the main process using the webContents media lifecycle events,
 * and the only input the page receives is the selected resolution, passed as a loadFile query.
 *
 * The page does run one local script (assets/intro.js). It has to: this client's own
 * `--disable-frame-rate-limit` switch starves Chromium's video presentation path, so a plain
 * <video> element renders at roughly 8 fps. The asset is decoded off-screen and blitted to a
 * canvas from a requestAnimationFrame loop instead, which that switch does not affect.
 *
 * Every path is fail-forward: if the asset cannot decode, if the media events never arrive, or if
 * the renderer dies, the sequence completes early and the game is shown. A launch can never be
 * blocked by the intro.
 */

/**
 * Margin added to a variant's measured opaque point before the game window is revealed behind it,
 * covering frame-timing jitter so the reveal can never be visible.
 */
const INTRO_REVEAL_MARGIN_MS = 450;

/**
 * If media playback never starts, treat the intro as failed and hand over immediately rather
 * than holding a black window over the game.
 */
const INTRO_MEDIA_START_TIMEOUT_MS = 2_000;

/**
 * Absolute ceiling on the whole sequence, measured from window creation. Nothing - a stalled
 * decode, a wedged renderer, a missing media event - may keep the intro on screen past this.
 *
 * Derived from the selected variant rather than fixed: a constant tuned for the short asset
 * (9 s) would have cut the long asset's own audio tail, which ends at 9.267 s.
 */
const INTRO_CEILING_SLACK_MS = 2_500;

export interface IntroWindowBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Match the rectangle the game window is about to occupy, so hiding the intro does not snap the
 * user from a full-screen frame to a smaller window. Fullscreen and borderless cover the whole
 * display; maximized covers the work area (leaving the taskbar); windowed matches the same
 * centred, scaled rectangle the gameplay geometry resolver produces.
 *
 * `mode` is the raw persisted `fullscreen` preference, so any unrecognised value falls through to
 * the windowed rectangle rather than throwing on a hand-edited config.
 */
export function getIntroWindowBounds(display: Display, mode: string, windowScale: number): IntroWindowBounds {
	if (mode === 'fullscreen' || mode === 'borderless') {
		return { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height };
	}
	if (mode === 'maximized') {
		return { x: display.workArea.x, y: display.workArea.y, width: display.workArea.width, height: display.workArea.height };
	}
	const width = Math.round(display.size.width * windowScale);
	const height = Math.round(display.size.height * windowScale);
	return {
		x: display.bounds.x + Math.round((display.bounds.width - width) / 2),
		y: display.bounds.y + Math.round((display.bounds.height - height) / 2),
		width,
		height
	};
}

/**
 * Pick the asset that matches the pixels actually being drawn. The intro window is sized in DIP
 * but rendered at `bounds * scaleFactor`, so a 1080p panel at 100% scaling draws 1920x1080 and
 * gains nothing from the 1440p asset beyond ~1.8x the decode and downscale work every frame. That
 * cost lands while Krunker is loading, so it is worth avoiding on the machines least able to
 * absorb it.
 */
export function selectIntroSource(display: Display, bounds: IntroWindowBounds): '1080' | '1440' {
	const devicePixelWidth = bounds.width * display.scaleFactor;
	const devicePixelHeight = bounds.height * display.scaleFactor;
	return devicePixelWidth > 1920 || devicePixelHeight > 1080 ? '1440' : '1080';
}

export type IntroGameWindow = Pick<
	BrowserWindow,
	| 'focus'
	| 'isDestroyed'
	| 'isMaximized'
	| 'isVisible'
	| 'maximize'
	| 'show'
	| 'showInactive'
>;

export interface IntroGameWindowHandoff {
	/** Prevent ready-to-show from revealing the game in front of the intro. */
	beginIntro(): void;
	/** Release intro ownership without changing game-window visibility. */
	endIntro(): void;
	/** Handle game ready-to-show events, including later reloads. */
	handleReadyToShow(): void;
	/** Reveal the game without focus while the intro's opaque frame remains above it. */
	revealBehindIntro(): void;
	/** Complete or fail-forward the visual handoff and focus the game. */
	revealForUse(): void;
}

/**
 * Coordinates the intro's one-time ownership of the game window's first reveal. Keeping this state
 * outside Electron event wiring makes the handoff deterministic: readiness is held while the intro
 * owns the reveal, the opaque phase can show the game inactive, and completion always releases
 * ownership before giving the game focus.
 */
export function createIntroGameWindowHandoff(
	gameWindow: IntroGameWindow,
	fullscreenMode: string
): IntroGameWindowHandoff {
	let introActive = false;
	const reveal = (takeFocus: boolean): void => {
		if (gameWindow.isDestroyed()) return;
		if (
			fullscreenMode === 'maximized'
			&& !gameWindow.isMaximized()
		) {
			gameWindow.maximize();
		}
		if (!gameWindow.isVisible()) {
			if (takeFocus) gameWindow.show();
			else gameWindow.showInactive();
		} else if (takeFocus) {
			gameWindow.focus();
		}
	};
	return {
		beginIntro: () => {
			introActive = true;
		},
		endIntro: () => {
			introActive = false;
		},
		handleReadyToShow: () => {
			if (!introActive) reveal(true);
		},
		revealBehindIntro: () => {
			reveal(false);
		},
		revealForUse: () => {
			introActive = false;
			reveal(true);
		}
	};
}

export interface IntroSequenceScheduler {
	clear(timer: unknown): void;
	schedule(callback: () => void, delayMs: number): unknown;
}

export interface IntroSequenceOptions {
	/** Absolute path to the assets directory holding intro.html, intro.js, and the WebM assets. */
	assetsPath: string;
	bounds: IntroWindowBounds;
	/** Creates the sandboxed Electron window; supplied by the main process. */
	createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
	/** Optional deterministic scheduler used by lifecycle tests. */
	scheduler?: IntroSequenceScheduler;
	/** Which shipped resolution to play; see selectIntroSource. */
	source: '1080' | '1440';
	/** Asset name and measured timings for the selected variant; see startup-profile.ts. */
	timing: IntroVariantTiming;
	/** False when the user has turned the launch sound off. */
	audio: boolean;
	/** Fired once the animation is reliably opaque: safe to reveal the game window behind it. */
	onReveal: () => void;
	/** Fired when the animation ends: the intro is hidden and the game should take focus. */
	onVisualEnd: () => void;
	/** Fired exactly once when the sequence is over and the window has been destroyed. */
	onFinished: () => void;
}

export interface IntroSequence {
	/** Ends the sequence immediately, running any callbacks that have not fired yet. */
	cancel: () => void;
}

/**
 * Create the intro window and drive the launch sequence. Returns immediately; the callbacks fire
 * as the sequence progresses. `onReveal`, `onVisualEnd`, and `onFinished` each run at most once,
 * always in that order, and all three are guaranteed to run even on the failure paths.
 */
export function startIntroSequence(options: IntroSequenceOptions): IntroSequence {
	const {
		assetsPath,
		audio,
		bounds,
		createWindow,
		onFinished,
		onReveal,
		onVisualEnd,
		source,
		timing
	} = options;
	const runCallback = (callback: () => void, label: string) => {
		try {
			callback();
		} catch (error) {
			console.error(`Launch intro ${label} callback failed`, error);
		}
	};

	let introWindow: BrowserWindow;
	try {
		introWindow = createWindow({
		x: bounds.x,
		y: bounds.y,
		width: bounds.width,
		height: bounds.height,
		// A transparent window must be frameless, and must not be resizable or shadowed if it is
		// to composite cleanly over the desktop.
		frame: false,
		transparent: true,
		backgroundColor: '#00000000',
		hasShadow: false,
		roundedCorners: false,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		// Never take focus from the game window, which is loading Krunker behind this one.
		focusable: false,
		show: false,
		paintWhenInitiallyHidden: true,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			backgroundThrottling: false,
			// Nothing here is meant to be inspected at runtime; keep the surface minimal.
			devTools: false
		}
	});

		// Sit above the taskbar so a full-bleed intro is not clipped by it.
		introWindow.setAlwaysOnTop(true, 'screen-saver');

		// Mouse events are deliberately NOT forwarded through the window. Clicks during the intro land
		// on it and do nothing, rather than reaching desktop icons the user cannot see.

		if (!audio) introWindow.webContents.setAudioMuted(true);
	} catch (error) {
		console.error('Failed to create the launch intro window', error);
		runCallback(onReveal, 'reveal');
		runCallback(onVisualEnd, 'visual-end');
		runCallback(onFinished, 'finished');
		return { cancel: () => {} };
	}

	const scheduler = options.scheduler ?? {
		clear: (timer: unknown) => {
			clearTimeout(timer as ReturnType<typeof setTimeout>);
		},
		schedule: (callback: () => void, delayMs: number) =>
			setTimeout(callback, delayMs)
	};
	const timers = new Set<unknown>();
	const later = (callback: () => void, delayMs: number) => {
		let timer: unknown;
		timer = scheduler.schedule(() => {
			timers.delete(timer);
			callback();
		}, delayMs);
		timers.add(timer);
		return timer;
	};
	const clearTimers = () => {
		for (const timer of timers) scheduler.clear(timer);
		timers.clear();
	};

	let revealed = false;
	let visualEnded = false;
	let finished = false;
	let mediaStarted = false;

	const runReveal = () => {
		if (revealed) return;
		revealed = true;
		runCallback(onReveal, 'reveal');
	};

	const runVisualEnd = () => {
		if (visualEnded) return;
		runReveal();
		visualEnded = true;
		if (!introWindow.isDestroyed() && introWindow.isVisible()) introWindow.hide();
		runCallback(onVisualEnd, 'visual-end');
	};

	const onMediaPaused = () => {
		if (mediaStarted) finish();
	};
	const finish = () => {
		if (finished) return;
		finished = true;
		clearTimers();
		introWindow.webContents.removeListener('media-paused', onMediaPaused);
		runVisualEnd();
		if (!introWindow.isDestroyed()) introWindow.destroy();
		runCallback(onFinished, 'finished');
	};

	// Nothing may hold the intro on screen past the ceiling.
	later(finish, timing.audioMs + INTRO_CEILING_SLACK_MS);

	// If the asset never starts playing, hand over rather than sitting on a dead window.
	const mediaStartTimeout = later(finish, INTRO_MEDIA_START_TIMEOUT_MS);

	introWindow.webContents.once('media-started-playing', () => {
		mediaStarted = true;
		scheduler.clear(mediaStartTimeout);
		timers.delete(mediaStartTimeout);
		// Anchor the sequence to real playback rather than to page load, so a slow first-frame
		// decode shifts the whole timeline instead of truncating the animation.
		later(runReveal, timing.opaqueMs + INTRO_REVEAL_MARGIN_MS);
		later(runVisualEnd, timing.visualMs);
		// The audio tail outlives the visual; keep the (hidden) window alive until it finishes.
		later(finish, timing.audioMs + 250);
	});

	// Ignore initialization pauses, but any pause after playback starts means playback ended or was
	// interrupted and must hand over immediately rather than waiting for the outer ceiling.
	introWindow.webContents.on('media-paused', onMediaPaused);

	introWindow.webContents.on('render-process-gone', finish);
	introWindow.webContents.on('did-fail-load', (_event, _errorCode, _errorDescription, _url, isMainFrame) => {
		if (isMainFrame) finish();
	});
	introWindow.on('closed', finish);

	introWindow.once('ready-to-show', () => {
		if (introWindow.isDestroyed()) return;
		// showInactive, never show: the game window must keep the focus it will need.
		introWindow.showInactive();
	});

	introWindow.loadFile(pathJoin(assetsPath, 'intro.html'), {
		query: { source, asset: timing.asset, visualMs: String(timing.visualMs) }
	}).catch(finish);

	return { cancel: finish };
}
