import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ChromiumDevToolsEndpoint {
	browserWebSocketUrl: string;
	port: number;
}

export interface ChromiumRuntimeIdentity {
	browser: string;
	browserWebSocketUrl: string;
	protocolVersion: string;
	revision?: string;
	userAgent: string;
	v8Version: string;
	webKitVersion: string;
}

function expectString(value: unknown, field: string, maximumLength = 4_096): string {
	if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength) {
		throw new TypeError(`${field} must be a non-empty string.`);
	}
	return value;
}

export function parseDevToolsActivePort(value: string): ChromiumDevToolsEndpoint {
	const lines = value.trim().split(/\r?\n/u);
	if (lines.length !== 2) throw new TypeError('DevToolsActivePort must contain a port and browser WebSocket path.');
	const port = Number(lines[0]);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError('DevToolsActivePort contains an invalid port.');
	const webSocketPath = lines[1];
	if (!/^\/devtools\/browser\/[a-z0-9-]+$/iu.test(webSocketPath)) {
		throw new TypeError('DevToolsActivePort contains an invalid browser WebSocket path.');
	}
	return {
		browserWebSocketUrl: `ws://127.0.0.1:${port}${webSocketPath}`,
		port
	};
}

export async function waitForChromiumDevTools(
	profileDirectory: string,
	options: { pollIntervalMs?: number; signal?: AbortSignal; timeoutMs: number }
): Promise<ChromiumDevToolsEndpoint> {
	const activePortPath = join(profileDirectory, 'DevToolsActivePort');
	const pollIntervalMs = options.pollIntervalMs ?? 25;
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) throw new TypeError('timeoutMs must be positive.');
	if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) throw new TypeError('pollIntervalMs must be positive.');
	const deadline = performance.now() + options.timeoutMs;
	let lastError: unknown;

	while (performance.now() < deadline) {
		if (options.signal?.aborted) throw options.signal.reason ?? new Error('DevTools discovery was aborted.');
		try {
			return parseDevToolsActivePort(await readFile(activePortPath, 'utf8'));
		} catch (error) {
			lastError = error;
		}
		await new Promise<void>(resolveDelay => setTimeout(resolveDelay, pollIntervalMs));
	}
	throw new Error(`Timed out waiting for Chromium DevTools endpoint: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function fetchChromiumRuntimeIdentity(
	endpoint: ChromiumDevToolsEndpoint,
	options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<ChromiumRuntimeIdentity> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError('timeoutMs must be from 1 through 120,000.');
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/version`, {
		cache: 'no-store',
		signal
	});
	if (!response.ok) throw new Error(`Chromium DevTools version request failed with HTTP ${response.status}.`);
	const body = (await response.json()) as unknown;
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		throw new TypeError('Chromium DevTools version response must be an object.');
	}
	const record = body as Record<string, unknown>;
	const browserWebSocketUrl = expectString(record.webSocketDebuggerUrl, 'webSocketDebuggerUrl');
	const parsedWebSocketUrl = new URL(browserWebSocketUrl);
	if (
		parsedWebSocketUrl.protocol !== 'ws:' ||
		(parsedWebSocketUrl.hostname !== '127.0.0.1' && parsedWebSocketUrl.hostname !== 'localhost') ||
		Number(parsedWebSocketUrl.port) !== endpoint.port
	) {
		throw new TypeError('Chromium DevTools returned a non-loopback browser WebSocket URL.');
	}
	return {
		browser: expectString(record.Browser, 'Browser'),
		browserWebSocketUrl,
		protocolVersion: expectString(record['Protocol-Version'], 'Protocol-Version'),
		...(record.Revision === undefined ? {} : { revision: expectString(record.Revision, 'Revision') }),
		userAgent: expectString(record['User-Agent'], 'User-Agent'),
		v8Version: expectString(record['V8-Version'], 'V8-Version'),
		webKitVersion: expectString(record['WebKit-Version'], 'WebKit-Version')
	};
}
