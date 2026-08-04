import type { BrowserWindowConstructorOptions, Display } from 'electron';

/** The subset of Electron's Display this module reads, so geometry stays testable without Electron. */
export type GameplayDisplay = Pick<Display, 'bounds' | 'size'>;

/**
 * Pure resolver from the persisted `fullscreen` preference to the BrowserWindow geometry shared
 * by the game and calibration windows. `mode` is the raw persisted value, so an unrecognised
 * (hand-edited) value falls through to the windowed rectangle instead of throwing.
 *
 * Borderless is a plain frameless window covering the display bounds. The previous
 * implementation added `kiosk: true`, which is what broke the mode on Windows badly enough that
 * the preference was silently rewritten to windowed there (audit A4). A frameless screen-bounds
 * window needs no kiosk state, works on every platform, and is also the window shape DWM can
 * promote out of desktop composition on Windows.
 *
 * `placeExplicitly` is what makes the `display` preference (src/display-selection.ts) real for the
 * windowed, maximized, and fullscreen modes. Electron's `center: true` centres on the *primary*
 * display, and `fullscreen: true` goes fullscreen on whichever display the window landed on - so
 * without explicit coordinates a chosen secondary monitor is silently ignored. Placement stays
 * opt-in rather than unconditional so the default (primary) path keeps the exact centring Electron
 * has always done for it, work area and all.
 *
 * `roundedCorners: false` is load-bearing on Linux: Electron 43 made frameless windows default to
 * rounded corners wherever the desktop supports client-side decorations, which on a window sized to
 * the whole display means the compositor rounds off the four screen corners of the game.
 */
export function resolveGameplayWindowGeometry(
	mode: string,
	display: GameplayDisplay,
	windowScale: number,
	placeExplicitly = false
): BrowserWindowConstructorOptions {
	if (mode === 'borderless') {
		return {
			frame: false,
			fullscreen: false,
			fullscreenable: false,
			height: display.bounds.height,
			resizable: false,
			roundedCorners: false,
			width: display.bounds.width,
			// Wayland does not let clients place their own windows, so x/y are honoured on Windows,
			// macOS and X11 and ignored by the compositor on Wayland.
			x: display.bounds.x,
			y: display.bounds.y
		};
	}

	const width = Math.round(display.size.width * windowScale);
	const height = Math.round(display.size.height * windowScale);
	const geometry: BrowserWindowConstructorOptions = placeExplicitly
		? {
			fullscreen: false,
			height,
			width,
			x: display.bounds.x + Math.round((display.bounds.width - width) / 2),
			y: display.bounds.y + Math.round((display.bounds.height - height) / 2)
		}
		: { center: true, fullscreen: false, height, width };
	if (mode === 'fullscreen') return { ...geometry, fullscreen: true };
	// 'maximized' starts from the windowed rectangle; the actual maximize is applied by the
	// window wiring once the window exists (ready-to-show / calibration grace period). Because the
	// rectangle already sits on the chosen display, the native maximize expands onto it.
	return geometry;
}
