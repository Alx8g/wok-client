import assert from 'node:assert/strict';
import test from 'node:test';
import {
	MATCHMAKER_LATENCY_FALLBACK_PORT,
	MATCHMAKER_LATENCY_PROBE_ATTEMPTS,
	MATCHMAKER_LATENCY_CACHE_TTL_MS,
	MatchmakerRegionLatencyService,
	parseMatchmakerPingTargets,
	type MatchmakerPingTarget
} from '../src/matchmaker-latency.ts';

const pingTargets = {
	'as-mb': 'lobby-mumbai.mumbai.krunker.io:3000',
	'de-fra': 'lobby-frankfurt.frankfurt.krunker.io:3000',
	'sgp': 'lobby-singapore.singapore.krunker.io:3000',
	'us-ca-sv': 'lobby-silicon.siliconvalley.krunker.io:3000',
	'us-nj': 'lobby-newyork.newyork.krunker.io:3000'
};

test('ping target parsing accepts only statically mapped Krunker hosts and valid ports', () => {
	const targets = parseMatchmakerPingTargets({
		...pingTargets,
		'brz': 'attacker.example:3000',
		'me-bhn': 'lobby-middleeast.middleeast.krunker.io:70000',
		'sss': 'lobby-secret.supersecretserver.krunker.io:3000',
		'us-tx': 'lobby-dallas.dallas.krunker.io:not-a-port',
		unknown: 'lobby-unknown.frankfurt.krunker.io:3000'
	});

	assert.deepEqual([...targets.entries()], [
		['MBI', { host: 'lobby-mumbai.mumbai.krunker.io', port: 3000 }],
		['FRA', { host: 'lobby-frankfurt.frankfurt.krunker.io', port: 3000 }],
		['SIN', { host: 'lobby-singapore.singapore.krunker.io', port: 3000 }],
		['SV', { host: 'lobby-silicon.siliconvalley.krunker.io', port: 3000 }],
		['NY', { host: 'lobby-newyork.newyork.krunker.io', port: 3000 }]
	]);
});

test('ping target parsing rejects malformed envelopes and excessive target counts', () => {
	assert.throws(() => parseMatchmakerPingTargets(null), TypeError);
	assert.throws(() => parseMatchmakerPingTargets([]), TypeError);
	assert.throws(
		() => parseMatchmakerPingTargets(Object.fromEntries(
			Array.from({ length: 33 }, (_unused, index) => [`unknown-${index}`, 'lobby.frankfurt.krunker.io:3000'])
		)),
		RangeError
	);
});

test('latency measurements deduplicate known regions and use the bounded cache', async () => {
	let now = 1_000;
	let loadCount = 0;
	let probeCount = 0;
	const service = new MatchmakerRegionLatencyService({
		loadTargets: async () => {
			loadCount++;
			return pingTargets;
		},
		now: () => now,
		probeTarget: async () => {
			probeCount++;
			return 12.4;
		}
	});

	assert.deepEqual(await service.measure(['FRA', 'FRA', 'MOON', 42]), { FRA: 12 });
	assert.deepEqual(await service.measure(['FRA']), { FRA: 12 });
	assert.equal(loadCount, 1);
	// Each reachable region is sampled MATCHMAKER_LATENCY_PROBE_ATTEMPTS times; the first connect
	// to a host also pays DNS, so the best sample is kept.
	assert.equal(probeCount, MATCHMAKER_LATENCY_PROBE_ATTEMPTS);

	now += MATCHMAKER_LATENCY_CACHE_TTL_MS + 1;
	assert.deepEqual(await service.measure(['FRA']), { FRA: 12 });
	assert.equal(loadCount, 2);
	assert.equal(probeCount, 2 * MATCHMAKER_LATENCY_PROBE_ATTEMPTS);
});

test('latency probes obey the configured concurrency bound', async () => {
	let active = 0;
	let maximumActive = 0;
	const service = new MatchmakerRegionLatencyService({
		loadTargets: async () => pingTargets,
		probeTarget: async (_target: MatchmakerPingTarget) => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			await new Promise(resolve => setTimeout(resolve, 5));
			active--;
			return 20;
		}
	}, {
		maxConcurrency: 2
	});

	const result = await service.measure(['MBI', 'FRA', 'SIN', 'SV', 'NY']);
	assert.deepEqual(Object.keys(result).sort(), ['FRA', 'MBI', 'NY', 'SIN', 'SV']);
	assert.equal(maximumActive, 2);
});

test('timed-out and failed probes are omitted without blocking successful regions', async () => {
	const service = new MatchmakerRegionLatencyService({
		loadTargets: async () => pingTargets,
		probeTarget: async (target, signal) => {
			if (target.host.includes('frankfurt')) {
				return new Promise(resolve => {
					signal.addEventListener('abort', () => resolve(undefined), { once: true });
				});
			}
			if (target.host.includes('mumbai')) throw new Error('probe failed');
			return 18.2;
		}
	}, {
		probeTimeoutMs: 10
	});

	assert.deepEqual(await service.measure(['FRA', 'MBI', 'SIN']), { SIN: 18 });
});

test('concurrent measurements coalesce and failed target loads are negatively cached', async () => {
	let loadCount = 0;
	let releaseLoad: (() => void) | undefined;
	const loadGate = new Promise<void>(resolve => { releaseLoad = resolve; });
	const service = new MatchmakerRegionLatencyService({
		loadTargets: async () => {
			loadCount++;
			await loadGate;
			throw new Error('offline');
		},
		probeTarget: async () => 1
	});

	const first = service.measure(['FRA']);
	const second = service.measure(['FRA']);
	releaseLoad?.();
	assert.deepEqual(await first, {});
	assert.deepEqual(await second, {});
	assert.equal(loadCount, 1);
	assert.deepEqual(await service.measure(['FRA']), {});
	assert.equal(loadCount, 1, 'a failed region stays negatively cached for the short cache window');
});

test('an expired target list is reused only within its bounded stale window', async () => {
	let now = 0;
	let loadCount = 0;
	let probeCount = 0;
	let targetRefreshFails = false;
	const service = new MatchmakerRegionLatencyService({
		loadTargets: async () => {
			loadCount++;
			if (targetRefreshFails) throw new Error('offline');
			return pingTargets;
		},
		now: () => now,
		probeTarget: async () => {
			probeCount++;
			return 12;
		}
	}, {
		cacheTtlMs: 10,
		targetStaleTtlMs: 30
	});

	assert.deepEqual(await service.measure(['FRA']), { FRA: 12 });
	targetRefreshFails = true;
	now = 11;
	assert.deepEqual(await service.measure(['FRA']), { FRA: 12 });
	now = 31;
	assert.deepEqual(await service.measure(['FRA']), {});
	assert.equal(loadCount, 3);
	assert.equal(probeCount, 2 * MATCHMAKER_LATENCY_PROBE_ATTEMPTS);
});


test('falls back to a reachable port when the advertised game port never answers', async () => {
	// Field evidence: Krunker advertises port 3000, which times out on ordinary networks for every
	// region, so no latency was ever recorded and the popup showed a dash. Port 443 answers.
	const attempted: number[] = [];
	const service = new MatchmakerRegionLatencyService({
		loadTargets: () => Promise.resolve({ 'au-syd': 'lobby-a.sydney.krunker.io:3000' }),
		probeTarget: target => {
			attempted.push(target.port);
			return Promise.resolve(target.port === MATCHMAKER_LATENCY_FALLBACK_PORT ? 48 : undefined);
		}
	});

	assert.deepEqual(await service.measure(['SYD']), { SYD: 48 });
	assert.equal(attempted[0], 3000, 'the advertised port is tried first');
	assert.ok(attempted.includes(MATCHMAKER_LATENCY_FALLBACK_PORT), 'the fallback port is tried');
	assert.equal(attempted.filter(port => port === 3000).length, 1, 'a silent port is not retried');
});

test('keeps the best sample so first-connect DNS cost is not reported as latency', async () => {
	// Measured on the reference machine: 153 ms on the first connect to a host, ~55 ms after.
	const samples = [153, 55];
	let index = 0;
	const service = new MatchmakerRegionLatencyService({
		loadTargets: () => Promise.resolve({ 'au-syd': `lobby-a.sydney.krunker.io:${MATCHMAKER_LATENCY_FALLBACK_PORT}` }),
		probeTarget: () => Promise.resolve(samples[Math.min(index++, samples.length - 1)])
	});

	assert.deepEqual(await service.measure(['SYD']), { SYD: 55 });
});

test('a dead port is negatively cached and skipped on later measurements', async () => {
	const attempted: number[] = [];
	let now = 1_000;
	const service = new MatchmakerRegionLatencyService({
		loadTargets: () => Promise.resolve({ 'au-syd': 'lobby-a.sydney.krunker.io:3000' }),
		now: () => now,
		probeTarget: target => {
			attempted.push(target.port);
			return Promise.resolve(target.port === MATCHMAKER_LATENCY_FALLBACK_PORT ? 30 : undefined);
		}
	}, { cacheTtlMs: 10, deadPortTtlMs: 100 });

	assert.deepEqual(await service.measure(['SYD']), { SYD: 30 });
	now = 1_011;
	// The ordinary latency cache expired, but the dead advertised port is skipped without a probe;
	// only the fallback
	// port pays for a fresh sample.
	assert.deepEqual(await service.measure(['SYD']), { SYD: 30 });
	assert.deepEqual(attempted, [
		3000,
		MATCHMAKER_LATENCY_FALLBACK_PORT,
		MATCHMAKER_LATENCY_FALLBACK_PORT,
		MATCHMAKER_LATENCY_FALLBACK_PORT,
		MATCHMAKER_LATENCY_FALLBACK_PORT
	]);

	// After the dead-port window the advertised port is retried, so a future fix upstream is picked up.
	now = 2_000;
	assert.deepEqual(await service.measure(['SYD']), { SYD: 30 });
	assert.deepEqual(attempted, [
		3000,
		MATCHMAKER_LATENCY_FALLBACK_PORT,
		MATCHMAKER_LATENCY_FALLBACK_PORT,
		MATCHMAKER_LATENCY_FALLBACK_PORT,
		MATCHMAKER_LATENCY_FALLBACK_PORT,
		3000,
		MATCHMAKER_LATENCY_FALLBACK_PORT,
		MATCHMAKER_LATENCY_FALLBACK_PORT
	]);
});

test('a transient fallback-port failure is retried after the ordinary latency cache expires', async () => {
	const attempted: number[] = [];
	let now = 1_000;
	const service = new MatchmakerRegionLatencyService({
		loadTargets: () => Promise.resolve({ 'au-syd': 'lobby-a.sydney.krunker.io:3000' }),
		now: () => now,
		probeTarget: target => {
			attempted.push(target.port);
			return Promise.resolve(undefined);
		}
	}, { cacheTtlMs: 10, deadPortTtlMs: 100 });

	assert.deepEqual(await service.measure(['SYD']), {});
	now = 1_011;
	assert.deepEqual(await service.measure(['SYD']), {});
	assert.deepEqual(attempted, [
		3000,
		MATCHMAKER_LATENCY_FALLBACK_PORT,
		MATCHMAKER_LATENCY_FALLBACK_PORT
	]);
});
