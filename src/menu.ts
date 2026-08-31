import { shell, type MenuItemConstructorOptions, type MenuItem, app, BrowserWindow } from 'electron';
import type { OpenDevToolsOptions } from 'electron/main';
import { APP_NAME, NOTICES_URL, WEBSITE_URL } from './branding.ts';

export const aboutSubmenu: MenuItemConstructorOptions[] = [
	{ label: APP_NAME, enabled: false },
	{ label: 'Website', registerAccelerator: false, click: () => shell.openExternal(WEBSITE_URL) },
	{ label: 'Open-source notices', registerAccelerator: false, click: () => shell.openExternal(NOTICES_URL) }
];

export const macAppMenuArr: (MenuItemConstructorOptions | MenuItem)[] = process.platform === 'darwin'
	? [ {
		label: app.name,
		submenu: [
			...aboutSubmenu,
			{ type: 'separator' },
			{ role: 'hide' },
			{ role: 'hideOthers' },
			{ role: 'unhide' },
			{ type: 'separator' },
			{ role: 'services' },
			{ role: 'quit', registerAccelerator: false }
		]
	} ]
	: [];

export function constructDevtoolsSubmenu(
	providedWindow: BrowserWindow,
	skipFallbackPreference: null | boolean | (() => null | boolean) = null,
	options?: OpenDevToolsOptions
) {
	const maxLag = 500;
	let detectedSkipFallback = typeof skipFallbackPreference === 'function' ? null : skipFallbackPreference;

	function fallbackDevtools() {
		providedWindow.webContents.closeDevTools();

		const devtoolsWindow = new BrowserWindow();
		devtoolsWindow.setMenuBarVisibility(false);

		providedWindow.webContents.setDevToolsWebContents(devtoolsWindow.webContents);
		providedWindow.webContents.openDevTools({ mode: 'detach' });
		providedWindow.once('closed', () => devtoolsWindow.destroy());
	}

	function openDevToolsWithFallback() {
		const configuredPreference = typeof skipFallbackPreference === 'function'
			? skipFallbackPreference()
			: skipFallbackPreference;
		const skipFallback = configuredPreference ?? detectedSkipFallback;
		if (skipFallback === true) {
			providedWindow.webContents.openDevTools(options);
		} else if (skipFallback === false) {
			fallbackDevtools();
		} else {
			providedWindow.webContents.openDevTools(options);
			const popupDevtoolTimeout = setTimeout(() => { detectedSkipFallback = false; fallbackDevtools(); }, maxLag);
			providedWindow.webContents.once('devtools-opened', () => { detectedSkipFallback = true; clearTimeout(popupDevtoolTimeout); }); // if opens devtools first, never run fallback
		}
	}

	return [
		{ label: 'Toggle Developer Tools', accelerator: 'CommandOrControl+Shift+I', click: () => { openDevToolsWithFallback(); } },
		{ label: 'Toggle Developer Tools (F12)', accelerator: 'F12', click: () => { openDevToolsWithFallback(); } }
	];
}

export const csMenuTemplate: (MenuItemConstructorOptions | MenuItem)[] = [
	{
		label: 'Edit',
		submenu: [
			{ role: 'undo' },
			{ role: 'redo' },
			{ type: 'separator' },
			{ role: 'cut' },
			{ role: 'copy' },
			{ role: 'paste' },
			{ role: 'delete' },
			{ type: 'separator' },
			{ role: 'selectAll' }
		]
	},
	{
		label: 'Page',
		submenu: [
			{ role: 'reload' },
			{ role: 'forceReload' },
			{ type: 'separator' },
			{ type: 'separator' },
			{ role: 'zoomIn' },
			{ role: 'zoomOut' },
			{ role: 'resetZoom' },
			{ type: 'separator' },
			{ role: 'togglefullscreen' }
		]
	}
];
