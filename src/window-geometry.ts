import type { BrowserWindowConstructorOptions, Display } from 'electron';
export type GameplayDisplay = Pick<Display, 'bounds' | 'size'>;
export function resolveGameplayWindowGeometry(mode: string, display: GameplayDisplay, windowScale: number, placeExplicitly = false): BrowserWindowConstructorOptions {
	if (mode === 'borderless') {
		return {
			frame: false,
			fullscreen: false,
			fullscreenable: false,
			height: display.bounds.height,
			resizable: false,
			roundedCorners: false,
			width: display.bounds.width,
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
	return geometry;
}
