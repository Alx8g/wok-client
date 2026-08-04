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
 */
export function resolveGameplayWindowGeometry(
	mode: string,
	display: GameplayDisplay,
	windowScale: number
): BrowserWindowConstructorOptions {
	if (mode === 'borderless') {
		return {
			frame: false,
			fullscreen: false,
			fullscreenable: false,
			height: display.bounds.height,
			resizable: false,
			width: display.bounds.width,
			x: display.bounds.x,
			y: display.bounds.y
		};
	}

	const geometry: BrowserWindowConstructorOptions = {
		center: true,
		fullscreen: false,
		height: Math.round(display.size.height * windowScale),
		width: Math.round(display.size.width * windowScale)
	};
	if (mode === 'fullscreen') return { ...geometry, fullscreen: true };
	// 'maximized' starts from the windowed rectangle; the actual maximize is applied by the
	// window wiring once the window exists (ready-to-show / calibration grace period).
	return geometry;
}
