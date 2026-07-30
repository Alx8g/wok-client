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

function createFakeBrowserWindow(): { browserWindow: Electron.BrowserWindow, state: FakeWebRequestState } {
	const state: FakeWebRequestState = {
		beforeRequestRegistrations: 0,
		headersReceivedRegistrations: 0
	};
	const browserWindow = {
		webContents: {
			session: {
				webRequest: {
					onBeforeRequest(filter: WebRequestFilter, listener: BeforeRequestListener) {
						state.beforeRequest = { filter, listener };
						state.beforeRequestRegistrations += 1;
					},
					onHeadersReceived(filter: WebRequestFilter, listener: HeadersReceivedListener) {
						state.headersReceived = { filter, listener };
						state.headersReceivedRegistrations += 1;
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

test('empty swap trees avoid global request interception and keep BrowserFPS CORS scoped', async t => {
	const { browserWindow, state } = createFakeBrowserWindow();
	const { filtersPath, swapDir } = createTestPaths(t);
	const handler = new RequestHandler(browserWindow, swapDir, true, false, false, '', filtersPath);

	await handler.start();
	await handler.start();

	assert.equal(existsSync(swapDir), true);
	assert.equal(state.beforeRequest, undefined);
	assert.equal(state.beforeRequestRegistrations, 0);
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
