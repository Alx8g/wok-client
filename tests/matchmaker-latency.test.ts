import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
	assert.equal(probeCount, 1);

	now += MATCHMAKER_LATENCY_CACHE_TTL_MS + 1;
	assert.deepEqual(await service.measure(['FRA']), { FRA: 12 });
	assert.equal(loadCount, 2);
	assert.equal(probeCount, 2);
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
	assert.equal(probeCount, 2);
});
