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

export function applyRuntimeWindowSettings(
	window: RuntimeWindowTarget,
	mode: string,
	bounds: RuntimeWindowBounds
): boolean {
	if (mode === 'borderless') return false;

	if (window.isFullScreen()) window.setFullScreen(false);
	if (window.isMaximized()) window.unmaximize();

	window.setResizable(true);
	window.setBounds(bounds);

	if (mode === 'fullscreen') window.setFullScreen(true);
	else if (mode === 'maximized') window.maximize();
	return true;
}
