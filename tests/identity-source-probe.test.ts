import assert from 'node:assert/strict';
import test from 'node:test';
import { findIdentityIn, formatIdentityProbe, probeIdentitySources } from '../src/identity-source-probe.ts';

test('distinguishes an exact identity value from one embedded in other text', () => {
	const hits = findIdentityIn({ user: 'lamboiigoni', status: 'lamboiigoni is playing' }, 'lamboiigoni', 'activity');
	assert.deepEqual(hits.map(hit => [hit.location, hit.match]), [['user', 'exact'], ['status', 'contains']]);
});

test('searches every source and survives a throwing getter', () => {
	const hits = probeIdentitySources({
		needle: 'lamboiigoni',
		readActivity: () => { throw new Error('activity unavailable'); },
		readGlobals: () => ({ account: { name: 'lamboiigoni' } }),
		readStorage: () => ({ 'krunker_user': '{"alias":"lamboiigoni"}' }),
		searchDom: () => [{ location: '#profileName', sample: 'lamboiigoni' }]
	});

	const sources = hits.map(hit => hit.source);
	assert.ok(sources.includes('global'), 'a throwing activity source must not end the probe');
	assert.ok(sources.includes('storage'));
	assert.ok(sources.includes('dom'));
	assert.match(formatIdentityProbe(hits), /hit\(s\)/u);
});

test('an empty needle probes nothing and no hits reports plainly', () => {
	const called: string[] = [];
	assert.deepEqual(probeIdentitySources({
		needle: '   ',
		readActivity: () => { called.push('activity'); return undefined; },
		readGlobals: () => ({}),
		readStorage: () => ({}),
		searchDom: () => []
	}), []);
	assert.deepEqual(called, [], 'an empty needle must not read anything');
	assert.match(formatIdentityProbe([]), /not found in any source/u);
});
