import assert from 'node:assert/strict';
import test from 'node:test';
import {
	classifyPublicServerRegion,
	formatPublicServerPingLabel,
	resolvePublicServerRegionCode,
	sortPublicServerRegions,
	type PublicServerRegionPingEntry
} from '../src/public-server-region-ping.ts';

function entry(region: string, pingMs?: number | null): PublicServerRegionPingEntry {
	return { region, pingMs };
}

test('classifies fixed categories before geographic aliases and rejects unknown labels', () => {
	assert.equal(classifyPublicServerRegion('Featured Servers'), 'fixed');
	assert.equal(classifyPublicServerRegion('OFFICIAL'), 'fixed');
	assert.equal(classifyPublicServerRegion('Official Customs'), 'fixed');
	assert.equal(classifyPublicServerRegion('Custom Games'), 'fixed');
	assert.equal(classifyPublicServerRegion('Super Secret Servers'), 'fixed');
	assert.equal(classifyPublicServerRegion('FRA'), 'geographic');
	assert.equal(classifyPublicServerRegion('Frankfurt'), 'geographic');
	assert.equal(classifyPublicServerRegion('de-fra'), 'geographic');
	assert.equal(classifyPublicServerRegion('Moon Base'), 'unknown');
	assert.equal(classifyPublicServerRegion(undefined), 'unknown');
});

test('accepts screen-specific fixed and geographic labels without changing defaults', () => {
	assert.equal(classifyPublicServerRegion('Tournament', { fixedCategories: ['Tournament'] }), 'fixed');
	assert.equal(classifyPublicServerRegion('OCE', { geographicRegions: ['OCE'] }), 'geographic');
	assert.equal(classifyPublicServerRegion('Featured Servers'), 'fixed');
});

test('resolves displayed geographic names and endpoint aliases to matchmaker region codes', () => {
	assert.equal(resolvePublicServerRegionCode('Frankfurt'), 'FRA');
	assert.equal(resolvePublicServerRegionCode('de-fra'), 'FRA');
	assert.equal(resolvePublicServerRegionCode('New York'), 'NY');
	assert.equal(resolvePublicServerRegionCode('Featured Servers'), undefined);
	assert.equal(resolvePublicServerRegionCode('Moon Base'), undefined);
});

test('pins fixed rows, sorts measured geographic rows, and keeps unresolved rows stable at the bottom', () => {
	const rows = [
		entry('Moon Base'),
		entry('FRA', 92),
		entry('Featured Servers', 1),
		entry('SYD', undefined),
		entry('NY', 38),
		entry('Official'),
		entry('Unknown Region', 2),
		entry('SIN', 38),
		entry('TOK', null),
		entry('Community Servers')
	];

	const sorted = sortPublicServerRegions(rows);
	assert.deepEqual(sorted.map(row => row.region), [
		'Featured Servers',
		'Official',
		'Community Servers',
		'NY',
		'SIN',
		'FRA',
		'Moon Base',
		'SYD',
		'Unknown Region',
		'TOK'
	]);
	assert.notEqual(sorted, rows);
	assert.deepEqual(rows.map(row => row.region), [
		'Moon Base',
		'FRA',
		'Featured Servers',
		'SYD',
		'NY',
		'Official',
		'Unknown Region',
		'SIN',
		'TOK',
		'Community Servers'
	]);
});

test('keeps equal pings and all unresolved rows in source order', () => {
	const rows = [
		entry('TOK', 50),
		entry('FRA', 50),
		entry('SYD'),
		entry('Unknown A'),
		entry('SIN', Number.NaN),
		entry('Unknown B')
	];

	assert.deepEqual(
		sortPublicServerRegions(rows).map(row => row.region),
		['TOK', 'FRA', 'SYD', 'Unknown A', 'SIN', 'Unknown B']
	);
});

test('formats finite non-negative ping values as rounded millisecond labels', () => {
	assert.equal(formatPublicServerPingLabel(0), '0 ms');
	assert.equal(formatPublicServerPingLabel(42.4), '42 ms');
	assert.equal(formatPublicServerPingLabel(42.5), '43 ms');
	assert.equal(formatPublicServerPingLabel('17.2'), '17 ms');
	assert.equal(formatPublicServerPingLabel('17.2 ms'), '17 ms');
	assert.equal(formatPublicServerPingLabel(undefined), '—');
	assert.equal(formatPublicServerPingLabel(null), '—');
	assert.equal(formatPublicServerPingLabel(-1), '—');
	assert.equal(formatPublicServerPingLabel(Number.NaN), '—');
	assert.equal(formatPublicServerPingLabel('42 milliseconds'), '—');
	assert.equal(formatPublicServerPingLabel(undefined, 'Timed out'), 'Timed out');
});
