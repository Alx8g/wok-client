import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
	fetchChromiumRuntimeIdentity,
	parseDevToolsActivePort
} from '../src/adapter/chromium-devtools.ts';

test('DevToolsActivePort parser constructs a loopback-only browser endpoint', () => {
	assert.deepEqual(parseDevToolsActivePort('45123\n/devtools/browser/abc-123\n'), {
		browserWebSocketUrl: 'ws://127.0.0.1:45123/devtools/browser/abc-123',
		port: 45_123
	});
	assert.throws(() => parseDevToolsActivePort('0\n/devtools/browser/abc\n'), /invalid port/u);
	assert.throws(() => parseDevToolsActivePort('45123\n/devtools/page/abc\n'), /invalid browser WebSocket path/u);
});

test('runtime identity is collected from the loopback DevTools endpoint', async () => {
	const server = createServer((request, response) => {
		assert.equal(request.url, '/json/version');
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('Expected TCP server address.');
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(
			JSON.stringify({
				Browser: 'Chrome/150.0.0.0',
				'Protocol-Version': '1.3',
				Revision: '@abc123',
				'User-Agent': 'Runtime Lab Chrome',
				'V8-Version': '15.0',
				'WebKit-Version': '537.36',
				webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/abc-123`
			})
		);
	});
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', resolveListen);
	});
	try {
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('Expected TCP server address.');
		const identity = await fetchChromiumRuntimeIdentity({
			browserWebSocketUrl: `ws://127.0.0.1:${address.port}/devtools/browser/abc-123`,
			port: address.port
		});
		assert.equal(identity.browser, 'Chrome/150.0.0.0');
		assert.equal(identity.protocolVersion, '1.3');
		assert.equal(identity.revision, '@abc123');
	} finally {
		await new Promise<void>((resolveClose, rejectClose) =>
			server.close(error => (error ? rejectClose(error) : resolveClose()))
		);
	}
});
