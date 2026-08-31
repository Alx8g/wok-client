import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join as pathJoin } from 'node:path';

import type { WebRequestFilter } from 'electron';
import { runBeforeDeadline } from './absolute-deadline.ts';

const TARGET_GAME_DOMAIN = 'krunker.io';
const RESOURCE_SWAPPER_PROTOCOL = 'krunker-resource-swapper:';
const RESOURCE_SWAPPER_HOST = 'resource';
const DIRECTORY_READ_CONCURRENCY = 8;
const MAX_SWAPPER_FILES = 10_000;
const MAX_SWAPPER_DIRECTORIES = 2_000;
const MAX_SWAPPER_DEPTH = 16;
const MAX_REQUEST_HANDLER_START_MS = 5_000;
const MAX_CUSTOM_FILTER_BYTES = 1024 * 1024;
const MAX_CUSTOM_FILTER_LINES = 20_000;
const MAX_CUSTOM_FILTER_RULES = 4_096;
const MAX_CUSTOM_FILTER_LINE_LENGTH = 4_096;
const STANDARD_NATIVE_URL_SCHEMES = new Set(['chrome', 'chrome-extension', 'file', 'filesystem', 'ftp', 'http', 'https', 'ws', 'wss']);
const NATIVE_URL_SCHEME_DEFAULT_PORTS: Readonly<Record<string, string>> = {
	ftp: '21',
	http: '80',
	https: '443',
	ws: '80',
	wss: '443'
};

const MAX_EXACT_SWAP_PATTERNS = 1_024;
const DIRECT_RESOURCE_DIRECTORIES = ['models', 'textures', 'sound', 'scares', 'videos'] as const;
const DIRECT_RESOURCE_DIRECTORY_SET = new Set<string>(DIRECT_RESOURCE_DIRECTORIES);
const LARGE_SWAPPER_FILTERS: readonly string[] = [
	`*://assets.${TARGET_GAME_DOMAIN}/*`,
	`*://comp.${TARGET_GAME_DOMAIN}/*`,
	`*://${TARGET_GAME_DOMAIN}/*`,
	`*://*.${TARGET_GAME_DOMAIN}/assets/*`,
	...DIRECT_RESOURCE_DIRECTORIES.map(directory => `*://*.${TARGET_GAME_DOMAIN}/${directory}/*`)
];
const BROWSER_FPS_CORS_FILTER: WebRequestFilter = {
	urls: [
		'*://browserfps.com/*',
		'*://*.browserfps.com/*'
	]
};

type UrlMatcher = (url: URL) => boolean;

type NativeUrlPattern = {
	host: string;
	path: string;
	port: string;
	scheme: string;
};

type NativeHostPattern = {
	host: string;
	port: string;
};

type BlockingPatterns = {
	matchers: UrlMatcher[];
	urls: string[];
};

type IndexedSwapResources = {
	requestResources: Map<string, string>;
	protocolFiles: Map<string, string>;
	resourcePaths: string[];
};

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeNativeHostPattern(scheme: string, hostAndPortPattern: string): NativeHostPattern | undefined {
	if (hostAndPortPattern.length === 0) {
		return scheme === 'file' ? { host: '', port: '*' } : undefined;
	}

	let hostPattern = hostAndPortPattern;
	let portPattern: string | undefined;
	if (hostAndPortPattern.startsWith('[')) {
		const hostEnd = hostAndPortPattern.indexOf(']');
		if (hostEnd < 2) return undefined;
		const suffix = hostAndPortPattern.slice(hostEnd + 1);
		if (suffix && !suffix.startsWith(':')) return undefined;
		hostPattern = hostAndPortPattern.slice(0, hostEnd + 1);
		if (suffix) portPattern = suffix.slice(1);
	} else {
		const portSeparator = hostAndPortPattern.indexOf(':');
		if (portSeparator >= 0) {
			hostPattern = hostAndPortPattern.slice(0, portSeparator);
			portPattern = hostAndPortPattern.slice(portSeparator + 1);
		}
	}

	let port = '*';
	if (portPattern !== undefined) {
		if (portPattern.length === 0) return undefined;
		if (portPattern !== '*') {
			if (!/^\d+$/u.test(portPattern)) return undefined;
			const portNumber = Number(portPattern);
			if (!Number.isSafeInteger(portNumber) || portNumber > 65_535) return undefined;
			port = String(portNumber);
		}
	}

	if (hostPattern === '*') return { host: hostPattern, port };
	const matchesSubdomains = hostPattern.startsWith('*.');
	const candidateHost = matchesSubdomains ? hostPattern.slice(2) : hostPattern;
	if (candidateHost.length === 0 || candidateHost.includes('*')) return undefined;

	try {
		const url = new URL(`http://${candidateHost}/`);
		if (url.username || url.password || url.port || !url.hostname || url.pathname !== '/' || url.search || url.hash) return undefined;
		const normalizedHost = url.hostname.toLowerCase();
		return { host: matchesSubdomains ? `*.${normalizedHost}` : normalizedHost, port };
	} catch (_error) {
		return undefined;
	}
}

function parseNativeUrlPattern(pattern: string): NativeUrlPattern | undefined {
	if (pattern === '<all_urls>') return { host: '*', path: '/*', port: '*', scheme: '*' };
	for (const character of pattern) {
		const characterCode = character.charCodeAt(0);
		if (characterCode <= 0x20 || characterCode === 0x7f) return undefined;
	}

	const match = /^([a-z][a-z\d+.-]*|\*):\/\/([^/]*)(\/.*)$/iu.exec(pattern);
	if (!match) return undefined;

	const [, rawScheme, hostAndPortPattern, path] = match;
	const scheme = rawScheme.toLowerCase();
	if (scheme !== '*' && !STANDARD_NATIVE_URL_SCHEMES.has(scheme)) return undefined;
	const hostPattern = normalizeNativeHostPattern(scheme, hostAndPortPattern);
	if (!hostPattern) return undefined;
	return { ...hostPattern, path, scheme };
}

function compileBlockingPattern(pattern: string): UrlMatcher | undefined {
	if (pattern === '<all_urls>') return () => true;

	const parsedPattern = parseNativeUrlPattern(pattern);
	if (!parsedPattern) return undefined;

	const pathExpression = parsedPattern.path
		.split('*')
		.map(escapeRegularExpression)
		.join('.*');
	let pathMatcher: RegExp;
	try {
		pathMatcher = new RegExp(`^${pathExpression}$`, 'u');
	} catch (_error) {
		return undefined;
	}
	const hasExplicitSearch = parsedPattern.path.includes('?');

	return url => {
		if (parsedPattern.scheme === '*') {
			if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
		} else if (url.protocol !== `${parsedPattern.scheme}:`) {
			return false;
		}

		if (parsedPattern.host === '*') {
			// Any host is accepted.
		} else if (parsedPattern.host.startsWith('*.')) {
			const suffix = parsedPattern.host.slice(2);
			if (url.hostname !== suffix && !url.hostname.endsWith(`.${suffix}`)) return false;
		} else if (url.hostname !== parsedPattern.host) {
			return false;
		}

		if (parsedPattern.port !== '*') {
			const requestScheme = url.protocol.slice(0, -1);
			const effectivePort = url.port || NATIVE_URL_SCHEME_DEFAULT_PORTS[requestScheme];
			if (effectivePort !== parsedPattern.port) return false;
		}

		if (pathMatcher.test(`${url.pathname}${url.search}`)) return true;
		return !hasExplicitSearch && pathMatcher.test(url.pathname);
	};
}

function validNativeUrlPatterns(patterns: readonly string[]): string[] {
	const urls: string[] = [];
	const seen = new Set<string>();
	for (const pattern of patterns) {
		if (seen.has(pattern)) continue;
		seen.add(pattern);
		if (parseNativeUrlPattern(pattern)) urls.push(pattern);
	}
	return urls;
}

function compileBlockingPatterns(patterns: readonly string[]): BlockingPatterns {
	const matchers: UrlMatcher[] = [];
	const urls: string[] = [];
	const seen = new Set<string>();
	for (const pattern of patterns) {
		if (seen.has(pattern)) continue;
		seen.add(pattern);

		const matcher = compileBlockingPattern(pattern);
		if (!matcher) continue;
		urls.push(pattern);
		matchers.push(matcher);
	}
	return { matchers, urls };
}

function parseCustomFilterContents(contents: string): string[] | undefined {
	const lines = contents.split(/\r?\n/u);
	if (lines.length > MAX_CUSTOM_FILTER_LINES) return undefined;

	const patterns: string[] = [];
	for (const line of lines) {
		if (line.length > MAX_CUSTOM_FILTER_LINE_LENGTH) return undefined;
		const pattern = line.trim();
		if (!pattern || pattern.startsWith('#')) continue;
		patterns.push(pattern);
		if (patterns.length > MAX_CUSTOM_FILTER_RULES) return undefined;
	}
	return patterns;
}

function encodeResourcePath(resourcePath: string): string {
	return resourcePath
		.split('/')
		.map(segment => encodeURIComponent(segment))
		.join('/');
}

function resourceSwapperToken(resourcePath: string): string {
	return Buffer.from(resourcePath, 'utf-8').toString('base64url');
}

function resourceSwapperUrl(resourcePath: string): string {
	return `${RESOURCE_SWAPPER_PROTOCOL}//${RESOURCE_SWAPPER_HOST}/${resourceSwapperToken(resourcePath)}`;
}

function exactSwapPatterns(resourcePath: string): string[] {
	const encodedPath = encodeResourcePath(resourcePath);
	const patterns = [
		`*://*.${TARGET_GAME_DOMAIN}${encodedPath}`,
		`*://*.${TARGET_GAME_DOMAIN}${encodedPath}?*`,
		`*://*.${TARGET_GAME_DOMAIN}/assets${encodedPath}`,
		`*://*.${TARGET_GAME_DOMAIN}/assets${encodedPath}?*`
	];
	const topLevelDirectory = resourcePath.split('/', 3)[1];

	if (DIRECT_RESOURCE_DIRECTORY_SET.has(topLevelDirectory)) return patterns;
	return [
		...patterns,
		`*://comp.${TARGET_GAME_DOMAIN}${encodedPath}?*`,
		`*://comp.${TARGET_GAME_DOMAIN}/assets${encodedPath}?*`
	];
}

export interface RequestHandlerPreferences {
	blockerEnabled: boolean;
	customFiltersEnabled: boolean;
	defaultFilters: string;
	swapperEnabled: boolean;
}

export default class RequestHandler {

	private browserWindow: Electron.BrowserWindow;

	private swapperEnabled: boolean;

	private swapperActive = false;

	private customFiltersEnabled: boolean;

	private swapRequestResources = new Map<string, string>();

	private swapProtocolFiles = new Map<string, string>();

	private blockingMatchers: UrlMatcher[] = [];

	private started = false;

	private swapDir: string;

	private defaultFilters: string[];

	private customFiltersPath: string;

	public constructor(browserWindow: Electron.BrowserWindow, swapDir: string, swapperEnabled: boolean, blockerEnabled: boolean, customFiltersEnabled: boolean, defaultFiltersStr: string, customFiltersPath: string) {
		this.browserWindow = browserWindow;
		this.swapDir = swapDir;
		this.customFiltersPath = customFiltersPath;
		this.swapperEnabled = false;
		this.customFiltersEnabled = false;
		this.defaultFilters = [];
		this.setPreferences({
			blockerEnabled,
			customFiltersEnabled,
			defaultFilters: defaultFiltersStr,
			swapperEnabled
		});
	}

	private setPreferences(preferences: RequestHandlerPreferences): void {
		this.swapperEnabled = preferences.swapperEnabled;
		this.customFiltersEnabled = preferences.customFiltersEnabled;
		this.defaultFilters = preferences.blockerEnabled
			? preferences.defaultFilters.split(/\r?\n/u).map(filter => filter.trim()).filter(Boolean)
			: [];
	}

	public async reconfigure(preferences: RequestHandlerPreferences): Promise<boolean> {
		try {
			this.browserWindow.webContents.session.webRequest.onBeforeRequest(null);
			this.browserWindow.webContents.session.webRequest.onHeadersReceived(null);
		} catch (error) {
			console.error('Failed to remove the previous WOK Client request filters', error);
			return false;
		}

		this.started = false;
		this.swapperActive = false;
		this.swapRequestResources.clear();
		this.swapProtocolFiles.clear();
		this.blockingMatchers = [];
		this.setPreferences(preferences);
		return this.start();
	}

	public async start(): Promise<boolean> {
		if (this.started) return true;
		const deadlineAt = Date.now() + MAX_REQUEST_HANDLER_START_MS;

		const swapUrls: string[] = [];
		this.swapperActive = false;
		if (this.swapperEnabled) {
			try {
				if (!existsSync(this.swapDir)) {
					await runBeforeDeadline(
						() => mkdir(this.swapDir, { recursive: true }),
						deadlineAt,
						'Resource swapper directory creation'
					);
				}
				const indexedResources = await this.indexSwapDirectory(deadlineAt);
				this.swapRequestResources = indexedResources.requestResources;
				this.swapProtocolFiles = indexedResources.protocolFiles;
				this.swapperActive = indexedResources.resourcePaths.length > 0;
				swapUrls.push(...this.createSwapFilters(indexedResources.resourcePaths));
			} catch (error) {
				this.swapRequestResources.clear();
				this.swapProtocolFiles.clear();
				console.error(`Resource swapping is unavailable for this launch (${this.swapDir})`, error);
			}
		}

		const blockingPatterns = [...this.defaultFilters];
		if (this.customFiltersEnabled) {
			try {
				const fileInfo = await runBeforeDeadline(
					() => stat(this.customFiltersPath),
					deadlineAt,
					'Custom request filter metadata'
				);
				if (fileInfo.size > MAX_CUSTOM_FILTER_BYTES) {
					throw new Error(`filter file exceeds ${MAX_CUSTOM_FILTER_BYTES} bytes`);
				}
				const contents = await runBeforeDeadline(
					() => readFile(this.customFiltersPath, { encoding: 'utf-8' }),
					deadlineAt,
					'Custom request filter read'
				);
				if (Buffer.byteLength(contents, 'utf-8') > MAX_CUSTOM_FILTER_BYTES) {
					throw new Error(`filter file exceeds ${MAX_CUSTOM_FILTER_BYTES} bytes`);
				}
				const customPatterns = parseCustomFilterContents(contents);
				if (!customPatterns) {
					throw new Error(
						`filter file exceeds a limit (${MAX_CUSTOM_FILTER_LINES} lines, ${MAX_CUSTOM_FILTER_RULES} rules, or ${MAX_CUSTOM_FILTER_LINE_LENGTH} characters per line)`
					);
				}
				blockingPatterns.push(...customPatterns);
			} catch (error) {
				console.error(`Custom request filters are unavailable for this launch (${this.customFiltersPath})`, error);
			}
		}
		const compiledBlockingPatterns = compileBlockingPatterns(blockingPatterns);
		this.blockingMatchers = compiledBlockingPatterns.matchers;

		const filter: WebRequestFilter = {
			urls: [...new Set([...validNativeUrlPatterns(swapUrls), ...compiledBlockingPatterns.urls])]
		};
		if (filter.urls.length > 0) {
			try {
				if (!this.swapperActive) {

					this.browserWindow.webContents.session.webRequest.onBeforeRequest(filter, (_details, callback) => {
						callback({ cancel: true });
					});
				} else {
					this.browserWindow.webContents.session.webRequest.onBeforeRequest(filter, (details, callback) => {
						let url: URL;
						try {
							url = new URL(details.url);
						} catch (_error) {
							return callback({});
						}

						if (this.isGameHost(url.hostname)) {
							const resourcePath = this.findSwapResourcePath(url.pathname);
							if (resourcePath) return callback({ redirectURL: resourceSwapperUrl(resourcePath) });
						}

						if (this.blockingMatchers.some(matcher => matcher(url))) return callback({ cancel: true });
						return callback({});
					});
				}

			this.browserWindow.webContents.session.webRequest.onHeadersReceived(BROWSER_FPS_CORS_FILTER, ({ responseHeaders }, callback) => {
				if (!responseHeaders) return callback({});

				let allowOriginKey: string | undefined;
				for (const [key, values] of Object.entries(responseHeaders)) {
					const lowercase = key.toLowerCase();

					if (lowercase === 'access-control-allow-credentials' && values?.[0] === 'true') {
						return callback({ responseHeaders });
					}

					if (lowercase === 'access-control-allow-origin') allowOriginKey = key;
				}

				if (allowOriginKey && responseHeaders[allowOriginKey]?.[0] === '*') {
					return callback({ responseHeaders });
				}

				const updatedHeaders = { ...responseHeaders };
				if (allowOriginKey) delete updatedHeaders[allowOriginKey];
				updatedHeaders['access-control-allow-origin'] = ['*'];
				return callback({ responseHeaders: updatedHeaders });
			});
			} catch (error) {

				try {
					this.browserWindow.webContents.session.webRequest.onBeforeRequest(null);
				} catch (rollbackError) {
					console.error('Failed to roll back partially registered WOK Client request filters', rollbackError);
				}
				console.error('Failed to register WOK Client request filters', error);
				return false;
			}
		}

		this.started = true;
		return true;
	}

	public resolveSwapProtocolRequest(rawUrl: string): string | undefined {
		try {
			const url = new URL(rawUrl);
			if (url.protocol !== RESOURCE_SWAPPER_PROTOCOL || url.hostname !== RESOURCE_SWAPPER_HOST) return undefined;
			const token = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
			if (!token || url.search || url.hash) return undefined;
			return this.swapProtocolFiles.get(token);
		} catch (_error) {
			return undefined;
		}
	}

	private createSwapFilters(resourcePaths: string[]): string[] {
		let exactPatternCount = 0;
		for (const resourcePath of resourcePaths) {
			const topLevelDirectory = resourcePath.split('/', 3)[1];
			exactPatternCount += DIRECT_RESOURCE_DIRECTORY_SET.has(topLevelDirectory) ? 4 : 6;
			if (exactPatternCount > MAX_EXACT_SWAP_PATTERNS) return [...LARGE_SWAPPER_FILTERS];
		}

		return resourcePaths.flatMap(exactSwapPatterns);
	}

	private findSwapResourcePath(rawPath: string): string | undefined {
		const exactMatch = this.swapRequestResources.get(rawPath);
		if (exactMatch || !rawPath.includes('%')) return exactMatch;

		try {
			return this.swapRequestResources.get(decodeURIComponent(rawPath));
		} catch (_error) {
			return undefined;
		}
	}

	private isGameHost(hostname: string): boolean {
		return hostname === TARGET_GAME_DOMAIN || hostname.endsWith(`.${TARGET_GAME_DOMAIN}`);
	}

	private async indexSwapDirectory(deadlineAt: number): Promise<IndexedSwapResources> {
		const resourcePaths: string[] = [];
		const requestResources = new Map<string, string>();
		const protocolFiles = new Map<string, string>();
		const pendingDirectories = [''];
		let directoryCount = 1;

		while (pendingDirectories.length > 0) {
			const batch = pendingDirectories.splice(0, DIRECTORY_READ_CONCURRENCY);
			const results = await runBeforeDeadline(
				() => Promise.all(batch.map(async prefix => ({
					entries: await readdir(pathJoin(this.swapDir, prefix), { withFileTypes: true }),
					prefix
				}))),
				deadlineAt,
				'Resource swapper index'
			);

			for (const { entries, prefix } of results) {
				entries.sort((left, right) => left.name.localeCompare(right.name));
				for (const dirent of entries) {
					const relativePath = prefix.length > 0 ? `${prefix}/${dirent.name}` : dirent.name;
					if (dirent.isDirectory()) {
						const depth = relativePath.split('/').length;
						if (depth > MAX_SWAPPER_DEPTH) throw new Error(`resource directory depth exceeds ${MAX_SWAPPER_DEPTH}`);
						directoryCount += 1;
						if (directoryCount > MAX_SWAPPER_DIRECTORIES) {
							throw new Error(`resource directory count exceeds ${MAX_SWAPPER_DIRECTORIES}`);
						}
						pendingDirectories.push(relativePath);
						continue;
					}
					if (!dirent.isFile()) continue;

					if (resourcePaths.length >= MAX_SWAPPER_FILES) {
						throw new Error(`resource file count exceeds ${MAX_SWAPPER_FILES}`);
					}
					const resourcePath = `/${relativePath}`;
					const localPath = pathJoin(this.swapDir, relativePath);
					resourcePaths.push(resourcePath);
					requestResources.set(resourcePath, resourcePath);
					requestResources.set(`/assets${resourcePath}`, resourcePath);
					protocolFiles.set(resourceSwapperToken(resourcePath), localPath);
				}
			}
		}

		return { protocolFiles, requestResources, resourcePaths };
	}

}
