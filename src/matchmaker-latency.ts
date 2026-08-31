import { MATCHMAKER_REGIONS } from './matchmaker-data.ts';

export const MATCHMAKER_LATENCY_CACHE_TTL_MS = 60_000;
export const MATCHMAKER_LATENCY_FETCH_TIMEOUT_MS = 3_000;
export const MATCHMAKER_LATENCY_PROBE_TIMEOUT_MS = 1_500;
export const MATCHMAKER_LATENCY_MAX_CONCURRENCY = 4;

export const MATCHMAKER_LATENCY_FALLBACK_PORT = 443;

export const MATCHMAKER_LATENCY_PROBE_ATTEMPTS = 2;
export const MATCHMAKER_LATENCY_TARGET_STALE_TTL_MS = 5 * 60_000;

export const MATCHMAKER_LATENCY_DEAD_PORT_TTL_MS = 10 * 60_000;
export const MATCHMAKER_PING_LIST_MAX_RESPONSE_BYTES = 64 * 1024;
export const MATCHMAKER_PING_LIST_MAX_TARGETS = 32;
export const MATCHMAKER_PING_LIST_URL = 'https://matchmaker.krunker.io/ping-list?hostname=krunker.io';

const KNOWN_MATCHMAKER_REGIONS = new Set<string>(MATCHMAKER_REGIONS);
const PING_SERVER_REGIONS: Readonly<Record<string, string>> = {
	'as-mb': 'MBI',
	'au-syd': 'SYD',
	'brz': 'BRZ',
	'de-fra': 'FRA',
	'jb-hnd': 'TOK',
	'me-bhn': 'BHN',
	'sgp': 'SIN',
	'us-ca-sv': 'SV',
	'us-nj': 'NY',
	'us-tx': 'DAL'
};

export interface MatchmakerPingTarget {
	host: string;
	port: number;
}

export type MatchmakerRegionLatencies = Record<string, number>;

export interface MatchmakerLatencyDependencies {
	loadTargets(signal: AbortSignal): Promise<unknown>;
	now?: () => number;
	probeTarget(target: MatchmakerPingTarget, signal: AbortSignal): Promise<number | undefined>;
}

export interface MatchmakerLatencyOptions {
	cacheTtlMs?: number;
	deadPortTtlMs?: number;
	fetchTimeoutMs?: number;
	maxConcurrency?: number;
	probeTimeoutMs?: number;
	targetStaleTtlMs?: number;
}

interface LatencyCacheEntry {
	expiresAt: number;
	latencyMs?: number;
}

interface TargetCacheEntry {
	expiresAt: number;
	staleExpiresAt: number;
	targets: ReadonlyMap<string, MatchmakerPingTarget>;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${name} must be a positive safe integer`);
	return resolved;
}

function parsePingTarget(value: unknown): MatchmakerPingTarget | undefined {
	if (typeof value !== 'string' || value.length === 0 || value.length > 300) return undefined;
	const separator = value.lastIndexOf(':');
	if (separator <= 0 || separator === value.length - 1) return undefined;
	const host = value.slice(0, separator).toLowerCase();
	const port = Number(value.slice(separator + 1));
	if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
	if (host.length > 253 || !host.endsWith('.krunker.io') || host.includes('..')) return undefined;
	const labels = host.split('.');
	if (labels.some(label => (
		label.length === 0
		|| label.length > 63
		|| !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
	))) return undefined;
	return { host, port };
}

export function parseMatchmakerPingTargets(value: unknown): ReadonlyMap<string, MatchmakerPingTarget> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Matchmaker ping target response was not an object.');
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > MATCHMAKER_PING_LIST_MAX_TARGETS) {
		throw new RangeError(`Matchmaker ping target response exceeded ${MATCHMAKER_PING_LIST_MAX_TARGETS} entries.`);
	}

	const targets = new Map<string, MatchmakerPingTarget>();
	for (const [server, rawTarget] of entries) {
		const region = PING_SERVER_REGIONS[server];
		if (!region || !KNOWN_MATCHMAKER_REGIONS.has(region) || targets.has(region)) continue;
		const target = parsePingTarget(rawTarget);
		if (target) targets.set(region, target);
	}
	return targets;
}

async function runWithTimeout<T>(
	timeoutMs: number,
	operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
	const controller = new AbortController();
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutHandle = setTimeout(() => {
			controller.abort();
			reject(new Error('Matchmaker latency operation timed out.'));
		}, timeoutMs);
	});
	try {
		return await Promise.race([
			Promise.resolve().then(() => operation(controller.signal)),
			timeout
		]);
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
	}
}

export class MatchmakerRegionLatencyService {
	private readonly cacheTtlMs: number;
	private readonly deadPortTtlMs: number;
	private readonly deadPorts = new Map<string, number>();
	private readonly dependencies: MatchmakerLatencyDependencies;
	private readonly fetchTimeoutMs: number;
	private readonly latencyCache = new Map<string, LatencyCacheEntry>();
	private measurementInFlight: Promise<void> | undefined;
	private readonly maxConcurrency: number;
	private readonly now: () => number;
	private readonly probeTimeoutMs: number;
	private targetCache: TargetCacheEntry | undefined;
	private readonly targetStaleTtlMs: number;

	public constructor(
		dependencies: MatchmakerLatencyDependencies,
		options: MatchmakerLatencyOptions = {}
	) {
		this.dependencies = dependencies;
		this.cacheTtlMs = positiveInteger(options.cacheTtlMs, MATCHMAKER_LATENCY_CACHE_TTL_MS, 'cacheTtlMs');
		this.deadPortTtlMs = positiveInteger(options.deadPortTtlMs, MATCHMAKER_LATENCY_DEAD_PORT_TTL_MS, 'deadPortTtlMs');
		this.fetchTimeoutMs = positiveInteger(options.fetchTimeoutMs, MATCHMAKER_LATENCY_FETCH_TIMEOUT_MS, 'fetchTimeoutMs');
		this.maxConcurrency = positiveInteger(options.maxConcurrency, MATCHMAKER_LATENCY_MAX_CONCURRENCY, 'maxConcurrency');
		this.probeTimeoutMs = positiveInteger(options.probeTimeoutMs, MATCHMAKER_LATENCY_PROBE_TIMEOUT_MS, 'probeTimeoutMs');
		this.targetStaleTtlMs = positiveInteger(
			options.targetStaleTtlMs,
			MATCHMAKER_LATENCY_TARGET_STALE_TTL_MS,
			'targetStaleTtlMs'
		);
		this.now = dependencies.now ?? Date.now;
	}

	public async measure(values: readonly unknown[]): Promise<MatchmakerRegionLatencies> {
		const regions = [...new Set(values
			.filter((value): value is string => typeof value === 'string' && KNOWN_MATCHMAKER_REGIONS.has(value))
		)];
		if (regions.length === 0) return {};

		while (true) {
			const now = this.now();
			const missing = regions.filter(region => {
				const cached = this.latencyCache.get(region);
				return !cached || cached.expiresAt <= now;
			});
			if (missing.length === 0) return this.collect(regions, now);

			if (this.measurementInFlight) {
				await this.measurementInFlight;
				continue;
			}

			const measurement = this.measureMissing(missing);
			this.measurementInFlight = measurement;
			try {
				await measurement;
			} finally {
				if (this.measurementInFlight === measurement) this.measurementInFlight = undefined;
			}
		}
	}

	private collect(regions: readonly string[], now: number): MatchmakerRegionLatencies {
		const result: MatchmakerRegionLatencies = {};
		for (const region of regions) {
			const cached = this.latencyCache.get(region);
			if (cached && cached.expiresAt > now && cached.latencyMs !== undefined) {
				result[region] = cached.latencyMs;
			}
		}
		return result;
	}

	private async loadTargets(): Promise<ReadonlyMap<string, MatchmakerPingTarget>> {
		const now = this.now();
		if (this.targetCache && this.targetCache.expiresAt > now) return this.targetCache.targets;
		try {
			const rawTargets = await runWithTimeout(this.fetchTimeoutMs, signal => this.dependencies.loadTargets(signal));
			const targets = parseMatchmakerPingTargets(rawTargets);
			this.targetCache = {
				expiresAt: now + this.cacheTtlMs,
				staleExpiresAt: now + this.targetStaleTtlMs,
				targets
			};
			return targets;
		} catch (error) {
			if (this.targetCache && this.targetCache.staleExpiresAt > now) {
				return this.targetCache.targets;
			}
			this.targetCache = undefined;
			throw error;
		}
	}

	private async measureMissing(regions: readonly string[]): Promise<void> {
		let targets: ReadonlyMap<string, MatchmakerPingTarget>;
		try {
			targets = await this.loadTargets();
		} catch (_error) {
			this.cacheFailures(regions);
			return;
		}

		const pending = regions.map(region => ({ region, target: targets.get(region) }));
		let nextIndex = 0;
		const worker = async () => {
			while (nextIndex < pending.length) {
				const item = pending[nextIndex++];
				let latencyMs: number | undefined;
				if (item.target) {

					const nowMs = this.now();
					this.pruneDeadPorts(nowMs);
					const candidatePorts = item.target.port === MATCHMAKER_LATENCY_FALLBACK_PORT
						? [item.target.port]
						: [item.target.port, MATCHMAKER_LATENCY_FALLBACK_PORT];
					for (const port of candidatePorts) {
						const target = { host: item.target.host, port };

						const deadPortKey = port === MATCHMAKER_LATENCY_FALLBACK_PORT
							? undefined
							: `${target.host}:${port}`;
						if (deadPortKey && (this.deadPorts.get(deadPortKey) ?? 0) > nowMs) continue;
						let portAnswered = false;
						for (let attempt = 0; attempt < MATCHMAKER_LATENCY_PROBE_ATTEMPTS; attempt++) {
							try {
								const measured = await runWithTimeout(
									this.probeTimeoutMs,
									signal => this.dependencies.probeTarget(target, signal)
								);
								if (typeof measured === 'number' && Number.isFinite(measured) && measured >= 0 && measured <= 60_000) {
									const rounded = Math.round(measured);
									if (latencyMs === undefined || rounded < latencyMs) latencyMs = rounded;
									portAnswered = true;
								} else break; // This port is not answering; move on rather than retrying it.
							} catch (_error) {
								break; // An unavailable port or region is omitted while other probes continue.
							}
						}
						if (!portAnswered && deadPortKey) this.deadPorts.set(deadPortKey, this.now() + this.deadPortTtlMs);
						if (latencyMs !== undefined) break;
					}
				}
				this.latencyCache.set(item.region, {
					expiresAt: this.now() + this.cacheTtlMs,
					...(latencyMs !== undefined ? { latencyMs } : {})
				});
			}
		};

		await Promise.all(Array.from(
			{ length: Math.min(this.maxConcurrency, pending.length) },
			() => worker()
		));
	}

	private pruneDeadPorts(nowMs: number): void {
		for (const [key, retryAt] of this.deadPorts) {
			if (retryAt <= nowMs) this.deadPorts.delete(key);
		}
	}

	private cacheFailures(regions: readonly string[]): void {
		const expiresAt = this.now() + this.cacheTtlMs;
		for (const region of regions) this.latencyCache.set(region, { expiresAt });
	}
}
