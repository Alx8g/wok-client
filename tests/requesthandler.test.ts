import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { WebRequestFilter } from 'electron';
import RequestHandler from '../src/requesthandler.ts';

type ResponseHeaders = Record<string, string[]>;
type RequestResponse = {
	cancel?: boolean;
	redirectURL?: string;
	responseHeaders?: ResponseHeaders;
};
type BeforeRequestListener = (details: { url: string }, callback: (response: RequestResponse) => void) => void;
type HeadersReceivedListener = (details: { responseHeaders?: ResponseHeaders }, callback: (response: RequestResponse) => void) => void;

type RegisteredRequest = {
	filter: WebRequestFilter;
	listener: BeforeRequestListener;
};

type RegisteredHeaders = {
	filter: WebRequestFilter;
	listener: HeadersReceivedListener;
};

type FakeWebRequestState = {
	beforeRequest?: RegisteredRequest;
	beforeRequestRegistrations: number;
	headersReceived?: RegisteredHeaders;
	headersReceivedRegistrations: number;
};

type FakeWebRequestOptions = {
	beforeRequestFailures?: number;
	headersReceivedFailures?: number;
	rejectedPatterns?: readonly string[];
};

function createFakeBrowserWindow(options: FakeWebRequestOptions = {}): { browserWindow: Electron.BrowserWindow, state: FakeWebRequestState } {
	const state: FakeWebRequestState = {
		beforeRequestRegistrations: 0,
		headersReceivedRegistrations: 0
	};
	const browserWindow = {
		webContents: {
			session: {
				webRequest: {
					onBeforeRequest(filter: WebRequestFilter | null, listener?: BeforeRequestListener) {
							if (filter === null) {
								state.beforeRequest = undefined;
								return;
							}
							state.beforeRequestRegistrations += 1;
							if (state.beforeRequestRegistrations <= (options.beforeRequestFailures ?? 0)) throw new Error('Synthetic registration failure');
							if (options.rejectedPatterns?.some(pattern => filter.urls.includes(pattern))) throw new Error('Rejected malformed URL pattern');
							assert.ok(listener);
							state.beforeRequest = { filter, listener };
						},
					onHeadersReceived(filter: WebRequestFilter | null, listener?: HeadersReceivedListener) {
							if (filter === null) {
								state.headersReceived = undefined;
								return;
							}
							state.headersReceivedRegistrations += 1;
							if (state.headersReceivedRegistrations <= (options.headersReceivedFailures ?? 0)) throw new Error('Synthetic headers registration failure');
							assert.ok(listener);
							state.headersReceived = { filter, listener };
						}
				}
			}
		}
	} as unknown as Electron.BrowserWindow;

	return { browserWindow, state };
}

function createTestPaths(t: TestContext): { filtersPath: string, root: string, swapDir: string } {
	const root = mkdtempSync(join(tmpdir(), 'wok-request-handler-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return {
		filtersPath: join(root, 'filters.txt'),
		root,
		swapDir: join(root, 'swapper')
	};
}

function writeTestFile(path: string, contents = 'test'): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}

function swapProtocolUrl(resourcePath: string): string {
	return `krunker-resource-swapper://resource/${Buffer.from(resourcePath, 'utf-8').toString('base64url')}`;
}

function dispatchBeforeRequest(state: FakeWebRequestState, url: string): RequestResponse {
	assert.ok(state.beforeRequest);
	let response: RequestResponse | undefined;
	state.beforeRequest.listener({ url }, value => {
		response = value;
	});
	assert.ok(response);
	return response;
}

function dispatchHeadersReceived(state: FakeWebRequestState, responseHeaders?: ResponseHeaders): RequestResponse {
	assert.ok(state.headersReceived);
	let response: RequestResponse | undefined;
	state.headersReceived.listener({ responseHeaders }, value => {
		response = value;
	});
	assert.ok(response);
	return response;
}

test('empty swap trees register no webRequest listeners at all', async t => {
	const { browserWindow, state } = createFakeBrowserWindow();
	const { filtersPath, swapDir } = createTestPaths(t);
	const handler = new RequestHandler(browserWindow, swapDir, true, false, false, '', filtersPath);

	assert.equal(await handler.start(), true);
	assert.equal(await handler.start(), true);

	assert.equal(existsSync(swapDir), true);
	assert.equal(state.beforeRequest, undefined);
	assert.equal(state.beforeRequestRegistrations, 0);
	assert.equal(state.headersReceived, undefined);
	assert.equal(state.headersReceivedRegistrations, 0);
});

test('reconfigures request features without restarting the browser process', async t => {
	const { browserWindow, state } = createFakeBrowserWindow();
	const { filtersPath, swapDir } = createTestPaths(t);
	const blocker = '*://ads.example.com/*';
	const handler = new RequestHandler(browserWindow, swapDir, false, true, false, blocker, filtersPath);

	assert.equal(await handler.start(), true);
	assert.deepEqual(dispatchBeforeRequest(state, 'https://ads.example.com/banner.js'), { cancel: true });

	assert.equal(await handler.reconfigure({
		blockerEnabled: false,
		customFiltersEnabled: false,
		defaultFilters: '',
		swapperEnabled: false
	}), true);
	assert.equal(state.beforeRequest, undefined);
	assert.equal(state.headersReceived, undefined);

	writeTestFile(join(swapDir, 'textures', 'weapon.png'));
	assert.equal(await handler.reconfigure({
		blockerEnabled: false,
		customFiltersEnabled: false,
		defaultFilters: '',
		swapperEnabled: true
	}), true);
	assert.equal(
		dispatchBeforeRequest(state, 'https://krunker.io/textures/weapon.png').redirectURL,
		swapProtocolUrl('/textures/weapon.png')
	);
});

test('resource swapping fails open when a tree exceeds its depth bound', async t => {
	const { browserWindow, state } = createFakeBrowserWindow();
	const { filtersPath, swapDir } = createTestPaths(t);
	const errorMock = t.mock.method(console, 'error', (): void => {});
	let nestedPath = swapDir;
	for (let depth = 0; depth < 17; depth += 1) nestedPath = join(nestedPath, `level-${depth}`);
	writeTestFile(join(nestedPath, 'asset.png'));

	const handler = new RequestHandler(browserWindow, swapDir, true, false, false, '', filtersPath);
	assert.equal(await handler.start(), true);

	assert.equal(state.beforeRequestRegistrations, 0);
	assert.equal(handler.resolveSwapProtocolRequest(swapProtocolUrl('/asset.png')), undefined);
	assert.equal(errorMock.mock.callCount(), 1);
	assert.match(String(errorMock.mock.calls[0].arguments[0]), /Resource swapping is unavailable/u);
});

test('oversized or unavailable custom filters fail open without disabling built-in blockers', async t => {
	const defaultPattern = '*://ads.example.com/*';
	const oversized = createTestPaths(t);
	writeTestFile(oversized.filtersPath, Array.from({ length: 4_097 }, (_, index) => `*://tracker-${index}.example.com/*`).join('\n'));
	const oversizedWindow = createFakeBrowserWindow();
	const oversizedError = t.mock.method(console, 'error', (): void => {});
	const oversizedHandler = new RequestHandler(
		oversizedWindow.browserWindow,
		oversized.swapDir,
		false,
		true,
		true,
		defaultPattern,
		oversized.filtersPath
	);

	assert.equal(await oversizedHandler.start(), true);
	assert.deepEqual(oversizedWindow.state.beforeRequest?.filter.urls, [defaultPattern]);
	assert.equal(oversizedError.mock.callCount(), 1);

	oversizedError.mock.restore();
	const missing = createTestPaths(t);
	const missingWindow = createFakeBrowserWindow();
	const missingError = t.mock.method(console, 'error', (): void => {});
	const missingHandler = new RequestHandler(
		missingWindow.browserWindow,
		missing.swapDir,
		false,
		true,
		true,
		defaultPattern,
		missing.filtersPath
	);

	assert.equal(await missingHandler.start(), true);
	assert.deepEqual(missingWindow.state.beforeRequest?.filter.urls, [defaultPattern]);
	assert.equal(missingError.mock.callCount(), 1);
});

test('active request features keep the BrowserFPS CORS fixer scoped to its domains', async t => {
	const { browserWindow, state } = createFakeBrowserWindow();
	const { filtersPath, swapDir } = createTestPaths(t);
	const handler = new RequestHandler(browserWindow, swapDir, false, true, false, '*://ads.example.com/*', filtersPath);

	assert.equal(await handler.start(), true);
	assert.equal(await handler.start(), true);

	assert.equal(state.beforeRequestRegistrations, 1);
	assert.equal(state.headersReceivedRegistrations, 1);
	assert.deepEqual(state.headersReceived?.filter.urls, [
		'*://browserfps.com/*',
		'*://*.browserfps.com/*'
	]);

	const originalHeaders = {
		'Access-Control-Allow-Origin': ['https://krunker.io'],
		'X-Test': ['kept']
	};
	assert.deepEqual(dispatchHeadersReceived(state, originalHeaders), {
		responseHeaders: {
			'X-Test': ['kept'],
			'access-control-allow-origin': ['*']
		}
	});
	assert.deepEqual(originalHeaders, {
		'Access-Control-Allow-Origin': ['https://krunker.io'],
		'X-Test': ['kept']
	});

	const credentialedHeaders = {
		'Access-Control-Allow-Credentials': ['true'],
		'Access-Control-Allow-Origin': ['https://krunker.io']
	};
	assert.deepEqual(dispatchHeadersReceived(state, credentialedHeaders), { responseHeaders: credentialedHeaders });
});

test('malformed mixed rules are ignored without disabling valid deduplicated blockers or swaps', async t => {
	const malformedPatterns = [
		'not-a-pattern',
		'https://example.com',
		'*://bad*host/*',
		'*://example.com:notaport/*',
		'https://example.com:70000/*',
		'https://user@example.com/*',
		'file://bad*host/blocked/*',
		'file://user@server/blocked/*',
		'file://server:notaport/blocked/*',
		'file://server:70000/blocked/*',
		'file://[broken/blocked/*',
		'custom://example.com/*'
	];
	const { browserWindow, state } = createFakeBrowserWindow({ rejectedPatterns: malformedPatterns });
	const { filtersPath, swapDir } = createTestPaths(t);
	const texturePath = join(swapDir, 'textures', 'replacement.png');
	writeTestFile(texturePath);
	writeTestFile(filtersPath, [
		'# comments are ignored',
		...malformedPatterns,
		'*://tracker.example.com/*',
		'  *://tracker.example.com/*  ',
		'*://ads.example.com/*'
	].join('\n'));

	const handler = new RequestHandler(
		browserWindow,
		swapDir,
		true,
		true,
		true,
		'*://ads.example.com/*\n*://ads.example.com/*',
		filtersPath
	);
	assert.equal(await handler.start(), true);

	assert.ok(state.beforeRequest);
	assert.equal(state.beforeRequestRegistrations, 1);
	assert.equal(new Set(state.beforeRequest.filter.urls).size, state.beforeRequest.filter.urls.length);
	for (const malformedPattern of malformedPatterns) assert.equal(state.beforeRequest.filter.urls.includes(malformedPattern), false);
	assert.equal(state.beforeRequest.filter.urls.filter(pattern => pattern === '*://ads.example.com/*').length, 1);
	assert.equal(state.beforeRequest.filter.urls.filter(pattern => pattern === '*://tracker.example.com/*').length, 1);
	assert.equal((handler as unknown as { blockingMatchers: unknown[] }).blockingMatchers.length, 2);

	assert.deepEqual(dispatchBeforeRequest(state, 'https://ads.example.com:8443/banner.js'), { cancel: true });
	assert.deepEqual(dispatchBeforeRequest(state, 'http://tracker.example.com/pixel'), { cancel: true });
	assert.deepEqual(dispatchBeforeRequest(state, 'https://example.com/'), {});
	const redirect = dispatchBeforeRequest(state, 'https://assets.krunker.io/textures/replacement.png?version=3');
	assert.deepEqual(redirect, { redirectURL: swapProtocolUrl('/textures/replacement.png') });
	assert.equal(handler.resolveSwapProtocolRequest(redirect.redirectURL ?? ''), texturePath);
});

test('failed core listener registration stays retryable and does not install dependent listeners', async t => {
	const { browserWindow, state } = createFakeBrowserWindow({ beforeRequestFailures: 1 });
	const { filtersPath, swapDir } = createTestPaths(t);
	const handler = new RequestHandler(browserWindow, swapDir, false, true, false, '*://ads.example.com/*', filtersPath);
	const errorMock = t.mock.method(console, 'error', (): void => {});

	assert.equal(await handler.start(), false);
	assert.equal(state.beforeRequestRegistrations, 1);
	assert.equal(state.beforeRequest, undefined);
	assert.equal(state.headersReceivedRegistrations, 0);
	assert.equal(errorMock.mock.callCount(), 1);

	assert.equal(await handler.start(), true);
	assert.equal(state.beforeRequestRegistrations, 2);
	assert.equal(state.headersReceivedRegistrations, 1);
	assert.deepEqual(dispatchBeforeRequest(state, 'https://ads.example.com/banner.js'), { cancel: true });

	assert.equal(await handler.start(), true);
	assert.equal(state.beforeRequestRegistrations, 2);
	assert.equal(state.headersReceivedRegistrations, 1);
});

test('dependent listener failure rolls back the core listener and remains retryable', async t => {
	const { browserWindow, state } = createFakeBrowserWindow({ headersReceivedFailures: 1 });
	const { filtersPath, swapDir } = createTestPaths(t);
	const handler = new RequestHandler(browserWindow, swapDir, false, true, false, '*://ads.example.com/*', filtersPath);
	const errorMock = t.mock.method(console, 'error', (): void => {});

	assert.equal(await handler.start(), false);
	assert.equal(state.beforeRequest, undefined, 'partial registration must be removed');
	assert.equal(state.beforeRequestRegistrations, 1);
	assert.equal(state.headersReceivedRegistrations, 1);
	assert.equal(errorMock.mock.callCount(), 1);

	assert.equal(await handler.start(), true);
	assert.equal(state.beforeRequestRegistrations, 2);
	assert.equal(state.headersReceivedRegistrations, 2);
	assert.deepEqual(dispatchBeforeRequest(state, 'https://ads.example.com/banner.js'), { cancel: true });
});

test('valid native blocker patterns retain scheme, host, subdomain, path, and all-URL behavior', async t => {
	const { browserWindow, state } = createFakeBrowserWindow();
	const { filtersPath, swapDir } = createTestPaths(t);
	const handler = new RequestHandler(browserWindow, swapDir, false, true, false, [
		'https://exact.example.com/private/*',
		'*://*.cdn.example.com/assets/*',
		'https://ports.example.com:8443/*',
		'*://wildcard-port.example.com:8443/*',
		'https://default-port.example.com:443/*',
		'https://leading-zero-port.example.com:0443/*',
		'file:///blocked/*',
		'file://server/shared/*',
		'file://server:1234/ported/*'
	].join('\n'), filtersPath);

	await handler.start();

	assert.ok(state.beforeRequest);
	assert.deepEqual(state.beforeRequest.filter.urls, [
		'https://exact.example.com/private/*',
		'*://*.cdn.example.com/assets/*',
		'https://ports.example.com:8443/*',
		'*://wildcard-port.example.com:8443/*',
		'https://default-port.example.com:443/*',
		'https://leading-zero-port.example.com:0443/*',
		'file:///blocked/*',
		'file://server/shared/*',
		'file://server:1234/ported/*'
	]);

	assert.deepEqual(dispatchBeforeRequest(state, 'https://exact.example.com/private/data.json'), { cancel: true });
	assert.deepEqual(dispatchBeforeRequest(state, 'https://child.cdn.example.com/assets/bundle.js'), { cancel: true });
	assert.deepEqual(dispatchBeforeRequest(state, 'https://ports.example.com:8443/socket'), { cancel: true });
	assert.deepEqual(dispatchBeforeRequest(state, 'http://wildcard-port.example.com:8443/socket'), { cancel: true });
	assert.deepEqual(dispatchBeforeRequest(state, 'https://wildcard-port.example.com:8443/socket'), { cancel: true });
	assert.deepEqual(dispatchBeforeRequest(state, 'https://default-port.example.com/implicit'), { cancel: true });
	assert.deepEqual(dispatchBeforeRequest(state, 'https://leading-zero-port.example.com/implicit'), { cancel: true });
	assert.deepEqual(dispatchBeforeRequest(state, 'file:///blocked/settings.json'), { cancel: true });
	assert.deepEqual(dispatchBeforeRequest(state, 'file://server/shared/settings.json'), { cancel: true });
	assert.ok(state.beforeRequest.filter.urls.includes('file://server:1234/ported/*'));

	const { browserWindow: allUrlsBrowserWindow, state: allUrlsState } = createFakeBrowserWindow();
	const allUrlsHandler = new RequestHandler(allUrlsBrowserWindow, swapDir, false, true, false, '<all_urls>', filtersPath);
	await allUrlsHandler.start();
	assert.deepEqual(allUrlsState.beforeRequest?.filter.urls, ['<all_urls>']);
	assert.deepEqual(dispatchBeforeRequest(allUrlsState, 'wss://socket.example.com/game'), { cancel: true });
});

test('small swap trees use exact encoded patterns and redirect direct and root asset paths', async t => {
	const { browserWindow, state } = createFakeBrowserWindow();
	const { filtersPath, swapDir } = createTestPaths(t);
	const texturePath = join(swapDir, 'textures', 'weapon #1.png');
	const rootAssetPath = join(swapDir, 'main bundle.js');
	writeTestFile(texturePath);
	writeTestFile(rootAssetPath);

	const handler = new RequestHandler(browserWindow, swapDir, true, false, false, '', filtersPath);
	await handler.start();

	assert.ok(state.beforeRequest);
	assert.equal(state.beforeRequest.filter.urls.length, 10);
	assert.ok(state.beforeRequest.filter.urls.includes('*://*.krunker.io/textures/weapon%20%231.png?*'));
	assert.ok(state.beforeRequest.filter.urls.includes('*://comp.krunker.io/main%20bundle.js?*'));
	assert.equal(state.beforeRequest.filter.urls.includes('<all_urls>'), false);

	const textureRedirect = dispatchBeforeRequest(state, 'https://assets.krunker.io/textures/weapon%20%231.png?version=7');
	assert.deepEqual(textureRedirect, {
		redirectURL: swapProtocolUrl('/textures/weapon #1.png')
	});
	assert.equal(handler.resolveSwapProtocolRequest(textureRedirect.redirectURL ?? ''), texturePath);
	const rootRedirect = dispatchBeforeRequest(state, 'http://comp.krunker.io/assets/main%20bundle.js?build=9');
	assert.deepEqual(rootRedirect, {
		redirectURL: swapProtocolUrl('/main bundle.js')
	});
	assert.equal(handler.resolveSwapProtocolRequest(rootRedirect.redirectURL ?? ''), rootAssetPath);
	assert.equal(handler.resolveSwapProtocolRequest('krunker-resource-swapper://resource/not-indexed'), undefined);
	assert.equal(handler.resolveSwapProtocolRequest(`${swapProtocolUrl('/main bundle.js')}?path=ignored`), undefined);
	assert.deepEqual(dispatchBeforeRequest(state, 'https://assets.krunker.io/textures/not-in-pack.png'), {});
	assert.deepEqual(dispatchBeforeRequest(state, 'https://example.com/textures/weapon%20%231.png'), {});
});

test('large swap trees use bounded Krunker prefixes while retaining O(1) redirects', async t => {
	const { browserWindow, state } = createFakeBrowserWindow();
	const { filtersPath, swapDir } = createTestPaths(t);
	for (let index = 0; index < 257; index += 1) {
		writeTestFile(join(swapDir, 'textures', `asset-${index}.png`));
	}
	const rootAssetPath = join(swapDir, 'bundle.js');
	writeTestFile(rootAssetPath);

	const handler = new RequestHandler(browserWindow, swapDir, true, false, false, '', filtersPath);
	await handler.start();

	assert.ok(state.beforeRequest);
	assert.equal(state.beforeRequest.filter.urls.length, 9);
	assert.equal(state.beforeRequest.filter.urls.includes('<all_urls>'), false);
	assert.equal(state.beforeRequest.filter.urls.includes('*://*.krunker.io/*'), false);
	assert.ok(state.beforeRequest.filter.urls.every(pattern => pattern.includes('krunker.io')));

	const finalTexturePath = join(swapDir, 'textures', 'asset-256.png');
	const finalTextureRedirect = dispatchBeforeRequest(state, 'https://assets.krunker.io/textures/asset-256.png?version=1');
	assert.deepEqual(finalTextureRedirect, {
		redirectURL: swapProtocolUrl('/textures/asset-256.png')
	});
	assert.equal(handler.resolveSwapProtocolRequest(finalTextureRedirect.redirectURL ?? ''), finalTexturePath);
	assert.deepEqual(dispatchBeforeRequest(state, 'https://cdn.krunker.io/assets/textures/asset-0.png'), {
		redirectURL: swapProtocolUrl('/textures/asset-0.png')
	});
	assert.deepEqual(dispatchBeforeRequest(state, 'https://comp.krunker.io/bundle.js?build=9'), {
		redirectURL: swapProtocolUrl('/bundle.js')
	});
	assert.deepEqual(dispatchBeforeRequest(state, 'https://krunker.io/bundle.js?build=9'), {
		redirectURL: swapProtocolUrl('/bundle.js')
	});
	assert.equal(handler.resolveSwapProtocolRequest(swapProtocolUrl('/bundle.js')), rootAssetPath);
	assert.deepEqual(dispatchBeforeRequest(state, 'https://assets.krunker.io/textures/missing.png'), {});
	assert.deepEqual(dispatchBeforeRequest(state, 'https://comp.krunker.io/game'), {});
});

test('blocker and custom matches cancel without cancelling broad-prefix misses', async t => {
	const { browserWindow, state } = createFakeBrowserWindow();
	const { filtersPath, swapDir } = createTestPaths(t);
	for (let index = 0; index < 257; index += 1) {
		writeTestFile(join(swapDir, 'textures', `asset-${index}.png`));
	}
	writeTestFile(filtersPath, [
		'# comments are ignored',
		'*://tracker.example.com/*',
		'*://assets.krunker.io/textures/blocked.png*'
	].join('\n'));

	const handler = new RequestHandler(
		browserWindow,
		swapDir,
		true,
		true,
		true,
		'*://ads.example.com/*',
		filtersPath
	);
	await handler.start();

	assert.ok(state.beforeRequest);
	assert.ok(state.beforeRequest.filter.urls.length <= 12);
	assert.deepEqual(dispatchBeforeRequest(state, 'https://assets.krunker.io/textures/not-in-pack.png'), {});
	assert.deepEqual(dispatchBeforeRequest(state, 'https://ads.example.com/banner.js'), { cancel: true });
	assert.deepEqual(dispatchBeforeRequest(state, 'https://tracker.example.com/pixel?id=1'), { cancel: true });
	assert.deepEqual(dispatchBeforeRequest(state, 'https://assets.krunker.io/textures/blocked.png?version=1'), { cancel: true });
	assert.deepEqual(dispatchBeforeRequest(state, 'https://assets.krunker.io/textures/asset-0.png'), {
		redirectURL: swapProtocolUrl('/textures/asset-0.png')
	});
});
