import type { BrowserWindow, BrowserWindowConstructorOptions, Display } from 'electron';
import { join as pathJoin } from 'path';
import type { IntroVariantTiming } from './startup-profile.ts';
const INTRO_REVEAL_MARGIN_MS = 450;
const INTRO_MEDIA_START_TIMEOUT_MS = 2000;
const INTRO_CEILING_SLACK_MS = 2500;
export interface IntroWindowBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}
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
export function selectIntroSource(display: Display, bounds: IntroWindowBounds): '1080' | '1440' {
	const devicePixelWidth = bounds.width * display.scaleFactor;
	const devicePixelHeight = bounds.height * display.scaleFactor;
	return devicePixelWidth > 1920 || devicePixelHeight > 1080 ? '1440' : '1080';
}
export type IntroGameWindow = Pick<BrowserWindow, 'focus' | 'isDestroyed' | 'isMaximized' | 'isVisible' | 'maximize' | 'show' | 'showInactive'>;
export interface IntroGameWindowHandoff {
	beginIntro(): void;
	endIntro(): void;
	handleReadyToShow(): void;
	revealBehindIntro(): void;
	revealForUse(): void;
}
export function createIntroGameWindowHandoff(gameWindow: IntroGameWindow, fullscreenMode: string): IntroGameWindowHandoff {
	let introActive = false;
	const reveal = (takeFocus: boolean): void => {
		if (gameWindow.isDestroyed()) return;
		if (fullscreenMode === 'maximized' && !gameWindow.isMaximized()) {
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
	assetsPath: string;
	bounds: IntroWindowBounds;
	createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
	scheduler?: IntroSequenceScheduler;
	source: '1080' | '1440';
	timing: IntroVariantTiming;
	audio: boolean;
	onReveal: () => void;
	onVisualEnd: () => void;
	onFinished: () => void;
}
export interface IntroSequence {
	cancel: () => void;
}
export function startIntroSequence(options: IntroSequenceOptions): IntroSequence {
	const { assetsPath, audio, bounds, createWindow, onFinished, onReveal, onVisualEnd, source, timing } = options;
	const runCallback = (callback: () => void, label: string) => {
		try {
			callback();
		} catch (error) {
			console.error(`Launch intro ${label} callback failed`, error);
		}
	};
	const safely = (label: string, action: () => void) => {
		try {
			action();
		} catch (error) {
			console.error(`Launch intro ${label} failed`, error);
		}
	};
	let introWindow: BrowserWindow;
	try {
		introWindow = createWindow({
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
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
			focusable: false,
			show: false,
			paintWhenInitiallyHidden: true,
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
				backgroundThrottling: false,
				devTools: false
			}
		});
		introWindow.setAlwaysOnTop(true, 'screen-saver');
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
		schedule: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs)
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
		safely('hide', () => {
			if (!introWindow.isDestroyed() && introWindow.isVisible()) introWindow.hide();
		});
		runCallback(onVisualEnd, 'visual-end');
	};
	const onMediaPaused = () => {
		if (mediaStarted) finish();
	};
	const finish = () => {
		if (finished) return;
		finished = true;
		safely('timer cleanup', clearTimers);
		safely('listener cleanup', () => {
			introWindow.webContents.removeListener('media-paused', onMediaPaused);
		});
		runVisualEnd();
		safely('destroy', () => {
			if (!introWindow.isDestroyed()) introWindow.destroy();
		});
		runCallback(onFinished, 'finished');
	};
	later(finish, timing.audioMs + INTRO_CEILING_SLACK_MS);
	const mediaStartTimeout = later(finish, INTRO_MEDIA_START_TIMEOUT_MS);
	introWindow.webContents.once('media-started-playing', () => {
		mediaStarted = true;
		safely('media-start timer', () => {
			scheduler.clear(mediaStartTimeout);
		});
		timers.delete(mediaStartTimeout);
		later(runReveal, timing.opaqueMs + INTRO_REVEAL_MARGIN_MS);
		later(runVisualEnd, timing.visualMs);
		later(finish, timing.audioMs + 250);
	});
	introWindow.webContents.on('media-paused', onMediaPaused);
	introWindow.webContents.on('render-process-gone', finish);
	introWindow.webContents.on('did-fail-load', (_event, _errorCode, _errorDescription, _url, isMainFrame) => {
		if (isMainFrame) finish();
	});
	introWindow.on('closed', finish);
	introWindow.once('ready-to-show', () => {
		safely('show', () => {
			if (introWindow.isDestroyed()) return;
			introWindow.showInactive();
		});
	});
	try {
		introWindow
			.loadFile(pathJoin(assetsPath, 'intro.html'), {
				query: { source, asset: timing.asset, visualMs: String(timing.visualMs) }
			})
			.catch(finish);
	} catch (error) {
		console.error('Launch intro failed to load its asset', error);
		finish();
	}
	return { cancel: finish };
}
