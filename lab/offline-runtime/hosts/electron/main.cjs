'use strict';

const { app, BrowserWindow, session } = require('electron');

const EVENT_PREFIX = 'WOK_RUNTIME_HOST_EVENT ';
const startedAtNs = process.hrtime.bigint();

function emitEvent(type, details = {}) {
	const event = {
		details,
		epochMs: Date.now(),
		monotonicMs: Number(process.hrtime.bigint() - startedAtNs) / 1_000_000,
		pid: process.pid,
		type
	};
	process.stdout.write(`${EVENT_PREFIX}${JSON.stringify(event)}\n`);
}

function emitWindowState(type, labWindow) {
	emitEvent(type, {
		isFocused: labWindow.isFocused(),
		isMinimized: labWindow.isMinimized(),
		isVisible: labWindow.isVisible()
	});
}

function requiredEnvironment(name) {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required environment variable ${name}.`);
	return value;
}

function positiveIntegerEnvironment(name) {
	const value = Number(requiredEnvironment(name));
	if (!Number.isInteger(value) || value < 1 || value > 16_384) throw new Error(`${name} must be a positive integer.`);
	return value;
}

const candidateId = requiredEnvironment('WOK_RUNTIME_LAB_CANDIDATE_ID');
const pageUrl = new URL(requiredEnvironment('WOK_RUNTIME_LAB_PAGE_URL'));
if (pageUrl.protocol !== 'http:' || pageUrl.hostname !== '127.0.0.1' || !pageUrl.port || pageUrl.username || pageUrl.password) {
	throw new Error('WOK_RUNTIME_LAB_PAGE_URL must use unauthenticated HTTP on 127.0.0.1 with an explicit port.');
}
const allowedOrigin = pageUrl.origin;
const profileDirectory = requiredEnvironment('WOK_RUNTIME_LAB_PROFILE_DIR');
const sessionDirectory = requiredEnvironment('WOK_RUNTIME_LAB_SESSION_DIR');
const width = positiveIntegerEnvironment('WOK_RUNTIME_LAB_WIDTH');
const height = positiveIntegerEnvironment('WOK_RUNTIME_LAB_HEIGHT');

app.setName('WOK Runtime Lab');
app.setPath('userData', profileDirectory);
app.setPath('sessionData', sessionDirectory);

emitEvent('host-started', { candidateId, electronVersion: process.versions.electron, chromeVersion: process.versions.chrome });

function isAllowedRequest(rawUrl) {
	if (rawUrl.startsWith('data:')) return true;
	try {
		const parsed = new URL(rawUrl);
		return parsed.protocol === 'http:' && parsed.origin === allowedOrigin;
	} catch {
		return false;
	}
}

function installGlobalGuards() {
	app.on('web-contents-created', (_event, contents) => {
		contents.setWindowOpenHandler(details => {
			emitEvent('popup-denied', { url: details.url });
			return { action: 'deny' };
		});
		contents.on('will-attach-webview', event => {
			event.preventDefault();
			emitEvent('webview-denied');
		});
		contents.on('will-navigate', (event, navigationUrl) => {
			if (navigationUrl !== pageUrl.href) {
				event.preventDefault();
				emitEvent('navigation-denied', { url: navigationUrl });
			}
		});
	});

	app.on('certificate-error', (event, _webContents, requestUrl, error, _certificate, callback) => {
		event.preventDefault();
		emitEvent('certificate-denied', { error, url: requestUrl });
		callback(false);
	});
	app.on('login', (event, _webContents, details) => {
		event.preventDefault();
		emitEvent('authentication-denied', { url: details.url });
	});
	app.on('child-process-gone', (_event, details) => {
		emitEvent('child-process-gone', {
			exitCode: details.exitCode,
			name: details.name,
			reason: details.reason,
			serviceName: details.serviceName,
			type: details.type
		});
	});
}

async function configureSession() {
	const labSession = session.defaultSession;
	await labSession.setProxy({
		mode: 'fixed_servers',
		proxyBypassRules: '127.0.0.1,localhost',
		proxyRules: 'http=127.0.0.1:9;https=127.0.0.1:9'
	});
	labSession.setPermissionCheckHandler(() => false);
	labSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
	labSession.setDevicePermissionHandler(() => false);
	labSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
		const allowed = isAllowedRequest(details.url);
		if (!allowed) emitEvent('request-denied', { method: details.method, resourceType: details.resourceType, url: details.url });
		callback({ cancel: !allowed });
	});
}

async function createLabWindow() {
	installGlobalGuards();
	await configureSession();
	emitEvent('app-ready');

	const labWindow = new BrowserWindow({
		autoHideMenuBar: true,
		backgroundColor: '#000000',
		height,
		show: true,
		useContentSize: true,
		webPreferences: {
			backgroundThrottling: false,
			contextIsolation: true,
			devTools: false,
			nodeIntegration: false,
			sandbox: true,
			spellcheck: false,
			webSecurity: true
		},
		width
	});
	labWindow.removeMenu();
	emitEvent('window-created', {
		height,
		isFocused: labWindow.isFocused(),
		isMinimized: labWindow.isMinimized(),
		isVisible: labWindow.isVisible(),
		width
	});

	labWindow.on('blur', () => emitWindowState('window-blur', labWindow));
	labWindow.on('focus', () => emitWindowState('window-focus', labWindow));
	labWindow.on('hide', () => emitWindowState('window-hide', labWindow));
	labWindow.on('minimize', () => emitWindowState('window-minimize', labWindow));
	labWindow.on('restore', () => emitWindowState('window-restore', labWindow));
	labWindow.on('show', () => emitWindowState('window-show', labWindow));
	labWindow.on('closed', () => emitEvent('window-closed'));
	labWindow.on('ready-to-show', () => emitWindowState('ready-to-show', labWindow));
	labWindow.webContents.on('blur', () => emitWindowState('web-contents-blur', labWindow));
	labWindow.webContents.on('focus', () => emitWindowState('web-contents-focus', labWindow));
	labWindow.webContents.on('did-start-loading', () => emitEvent('did-start-loading'));
	labWindow.webContents.on('dom-ready', () => emitEvent('dom-ready'));
	labWindow.webContents.on('did-finish-load', () => emitEvent('did-finish-load'));
	labWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
		emitEvent('did-fail-load', { errorCode, errorDescription, isMainFrame, url: validatedUrl });
	});
	labWindow.webContents.on('render-process-gone', (_event, details) => {
		emitEvent('render-process-gone', { exitCode: details.exitCode, reason: details.reason });
	});
	labWindow.webContents.on('unresponsive', () => emitEvent('renderer-unresponsive'));
	labWindow.webContents.on('responsive', () => emitEvent('renderer-responsive'));

	await labWindow.loadURL(pageUrl.href);
}

app.whenReady().then(createLabWindow).catch(error => {
	emitEvent('host-error', { message: error instanceof Error ? error.message : String(error) });
	app.exit(1);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => emitEvent('before-quit'));
