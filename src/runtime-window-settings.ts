export interface RuntimeWindowBounds {
	height: number;
	width: number;
	x: number;
	y: number;
}

export interface RuntimeWindowTarget {
	isFullScreen(): boolean;
	isMaximized(): boolean;
	maximize(): void;
	setBounds(bounds: RuntimeWindowBounds): void;
	setFullScreen(fullscreen: boolean): void;
	setResizable(resizable: boolean): void;
	unmaximize(): void;
}

/**
 * Apply decorated window modes without replacing the BrowserWindow or its game renderer.
 * Borderless is intentionally excluded because Electron fixes `frame` at construction.
 */
export function applyRuntimeWindowSettings(
	window: RuntimeWindowTarget,
	mode: string,
	bounds: RuntimeWindowBounds
): boolean {
	if (mode === 'borderless') return false;

	// Bounds cannot reliably move a fullscreen or maximized native window to another display.
	if (window.isFullScreen()) window.setFullScreen(false);
	if (window.isMaximized()) window.unmaximize();

	window.setResizable(true);
	window.setBounds(bounds);

	if (mode === 'fullscreen') window.setFullScreen(true);
	else if (mode === 'maximized') window.maximize();
	return true;
}
