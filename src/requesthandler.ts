import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join as pathJoin } from 'node:path';

import type { WebRequestFilter } from 'electron';

const TARGET_GAME_DOMAIN = 'krunker.io';
const RESOURCE_SWAPPER_PROTOCOL = 'krunker-resource-swapper:';
const RESOURCE_SWAPPER_HOST = 'resource';
const DIRECTORY_READ_CONCURRENCY = 8;

// Electron 44 registered 1,024 synthetic exact patterns in 7.9-13.4 ms on the
// reference machine; 2,048 took 11.2-13.9 ms and 4,000 took 21.4-26.4 ms.
// Beyond this crossover, a small fixed set of scoped prefixes avoids linear matcher retention.
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

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function compileBlockingPattern(pattern: string): UrlMatcher | undefined {
	if (pattern === '<all_urls>') return () => true;

	const match = /^([^:]+):\/\/([^/]*)(\/.*)$/u.exec(pattern);
	if (!match) return undefined;

	const [, schemePattern, hostPattern, pathPattern] = match;
	const normalizedScheme = schemePattern.toLowerCase();
	const normalizedHost = hostPattern.toLowerCase();
	const pathExpression = pathPattern
		.split('*')
		.map(escapeRegularExpression)
		.join('.*');
	const pathMatcher = new RegExp(`^${pathExpression}$`, 'u');
	const hasExplicitSearch = pathPattern.includes('?');

	return url => {
		if (normalizedScheme === '*') {
			if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
		} else if (url.protocol !== `${normalizedScheme}:`) {
			return false;
		}

		if (normalizedHost === '*') {
			// Any host is accepted.
		} else if (normalizedHost.startsWith('*.')) {
			const suffix = normalizedHost.slice(2);
			if (url.hostname !== suffix && !url.hostname.endsWith(`.${suffix}`)) return false;
		} else if (url.host !== normalizedHost) {
			return false;
		}

		if (pathMatcher.test(`${url.pathname}${url.search}`)) return true;
		return !hasExplicitSearch && pathMatcher.test(url.pathname);
	};
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

export default class RequestHandler {

	private browserWindow: Electron.BrowserWindow;

	private swapperEnabled: boolean;

	private customFiltersEnabled: boolean;

	private swapRequestResources = new Map<string, string>();

	private swapProtocolFiles = new Map<string, string>();

	private blockingMatchers: UrlMatcher[] = [];

	private started = false;

	private swapDir: string;

	private defaultFilters: string[];

	private customFiltersPath: string;

	/**
	 * Set the target window.
	 * @param browserWindow - The target window.
	 */
	// FIXME: better way to enable/disable?
	public constructor(browserWindow: Electron.BrowserWindow, swapDir: string, swapperEnabled: boolean, blockerEnabled: boolean, customFiltersEnabled: boolean, defaultFiltersStr: string, customFiltersPath: string) {
		this.browserWindow = browserWindow;
		this.swapDir = swapDir;
		this.swapperEnabled = swapperEnabled;
		this.customFiltersEnabled = customFiltersEnabled;
		this.customFiltersPath = customFiltersPath;

		this.defaultFilters = blockerEnabled
			? defaultFiltersStr.split(/\r?\n/u).map(filter => filter.trim()).filter(Boolean)
			: [];
	}

	/** Initialize the request handler for the target window. */
	public async start(): Promise<void> {
		if (this.started) return;

		const swapUrls: string[] = [];
		if (this.swapperEnabled) {
			if (!existsSync(this.swapDir)) await mkdir(this.swapDir, { recursive: true });
			const resourcePaths = await this.indexSwapDirectory();
			swapUrls.push(...this.createSwapFilters(resourcePaths));
		}

		const blockingUrls = [...this.defaultFilters];
		if (this.customFiltersEnabled) {
			blockingUrls.push(...(await readFile(this.customFiltersPath, { encoding: 'utf-8' }))
				.split(/\r?\n/u)
				.map(filter => filter.trim())
				.filter(filter => filter.length > 0 && !filter.startsWith('#')));
		}
		this.blockingMatchers = blockingUrls
			.map(compileBlockingPattern)
			.filter((matcher): matcher is UrlMatcher => matcher !== undefined);

		const filter: WebRequestFilter = { urls: [...new Set([...swapUrls, ...blockingUrls])] };
		if (filter.urls.length > 0) {
			try {
				this.browserWindow.webContents.session.webRequest.onBeforeRequest(filter, (details, callback) => {
					let url: URL;
					try {
						url = new URL(details.url);
					} catch (_error) {
						return callback({});
					}

					if (this.swapperEnabled && this.isGameHost(url.hostname)) {
						const resourcePath = this.findSwapResourcePath(url.pathname);
						if (resourcePath) return callback({ redirectURL: resourceSwapperUrl(resourcePath) });
					}

					if (this.blockingMatchers.some(matcher => matcher(url))) return callback({ cancel: true });
					return callback({});
				});
			} catch (error) {
				console.error('Failed to register WOK Client request filters', error);
			}

			// Fix the CORS problem only for browserfps.com instead of processing every response.
			// Registering any webRequest listener makes Electron interpose every request in the
			// session, so the mirror-domain CORS fixer only registers when a request feature has
			// already forced that interposition. With every request feature disabled the session
			// keeps Chromium's direct loading path.
			this.browserWindow.webContents.session.webRequest.onHeadersReceived(BROWSER_FPS_CORS_FILTER, ({ responseHeaders }, callback) => {
				if (!responseHeaders) return callback({});

				let allowOriginKey: string | undefined;
				for (const [key, values] of Object.entries(responseHeaders)) {
					const lowercase = key.toLowerCase();

					// If the credentials mode is 'include', changing the origin to '*' would make the request fail CORS.
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
		}

		this.started = true;
	}

	/** Resolve only opaque tokens created for files indexed inside the swapper directory. */
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

	/** Index all resources to swap with bounded directory-read concurrency. */
	private async indexSwapDirectory(): Promise<string[]> {
		const resourcePaths: string[] = [];
		const pendingDirectories = [''];

		while (pendingDirectories.length > 0) {
			const batch = pendingDirectories.splice(0, DIRECTORY_READ_CONCURRENCY);
			const results = await Promise.all(batch.map(async prefix => {
				try {
					return { entries: await readdir(pathJoin(this.swapDir, prefix), { withFileTypes: true }), prefix };
				} catch (error) {
					console.error(`Failed to resource-swap with prefix: ${prefix}`, error);
					return { entries: [], prefix };
				}
			}));

			for (const { entries, prefix } of results) {
				for (const dirent of entries) {
					const relativePath = prefix.length > 0 ? `${prefix}/${dirent.name}` : dirent.name;
					if (dirent.isDirectory()) {
						pendingDirectories.push(relativePath);
						continue;
					}
					if (!dirent.isFile()) continue;

					const resourcePath = `/${relativePath}`;
					const localPath = pathJoin(this.swapDir, relativePath);
					resourcePaths.push(resourcePath);
					this.swapRequestResources.set(resourcePath, resourcePath);
					this.swapRequestResources.set(`/assets${resourcePath}`, resourcePath);
					this.swapProtocolFiles.set(resourceSwapperToken(resourcePath), localPath);
				}
			}
		}

		return resourcePaths;
	}

}
