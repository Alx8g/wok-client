import assert from 'node:assert/strict';
import test from 'node:test';
import {
	CUSTOM_CLAN_MAX_LENGTH,
	CUSTOM_NAME_MAX_LENGTH,
	customIdentitiesAreEqual,
	EMPTY_CUSTOM_IDENTITY,
	extractClanTag,
	formatCustomIdentityLabel,
	hasCustomIdentity,
	isCustomIdentityPreferenceKey,
	isPlausibleRealName,
	mergeRealIdentityCandidates,
	parseCustomIdentityPreference,
	readGameActivityName,
	resolveConfiguredRealIdentity,
	resolveCustomIdentity,
	sanitizeCustomClan,
	sanitizeCustomName
} from '../src/custom-identity.ts';
import { parseUserPreferencePatch } from '../src/user-preferences.ts';
test('trims surrounding whitespace before anything else', () => {
	assert.equal(sanitizeCustomName('   Rocketeer   '), 'Rocketeer');
	assert.equal(sanitizeCustomClan('\t WOK \n'), 'WOK');
	assert.equal(sanitizeCustomName(`   ${'a'.repeat(CUSTOM_NAME_MAX_LENGTH)}   `), 'a'.repeat(CUSTOM_NAME_MAX_LENGTH));
});
test('enforces the length limits', () => {
	assert.equal(CUSTOM_NAME_MAX_LENGTH, 16);
	assert.equal(CUSTOM_CLAN_MAX_LENGTH, 5);
	assert.equal(sanitizeCustomName('a'.repeat(64)), 'a'.repeat(CUSTOM_NAME_MAX_LENGTH));
	assert.equal(sanitizeCustomClan('a'.repeat(64)), 'a'.repeat(CUSTOM_CLAN_MAX_LENGTH));
});
test('keeps only characters a Krunker-style handle can contain', () => {
	assert.equal(sanitizeCustomName('Rocket_Man-7'), 'Rocket_Man-7');
	assert.equal(sanitizeCustomClan('W_O-K'), 'W_O-K');
	assert.equal(sanitizeCustomName('Rocket Man'), 'RocketMan');
	assert.equal(sanitizeCustomName('a.b,c;d'), 'abcd');
	assert.equal(sanitizeCustomName('"><img src=x>'), 'imgsrcx');
	assert.equal(sanitizeCustomClan("'onerror'"), 'onerr');
	assert.equal(sanitizeCustomName('héllo→ü'), 'hllo');
});
test('sanitizing is idempotent, so a stored value round-trips unchanged', () => {
	for (const candidate of ['  Rocket Man  ', '"><img src=x>', 'a'.repeat(64), '', '   ', '💥flair💥']) {
		assert.equal(sanitizeCustomName(sanitizeCustomName(candidate)), sanitizeCustomName(candidate));
		assert.equal(sanitizeCustomClan(sanitizeCustomClan(candidate)), sanitizeCustomClan(candidate));
	}
});
test('empty means unset, and so does anything that sanitizes to nothing', () => {
	for (const candidate of ['', '   ', '!!!', '💥', null, undefined, 42, {}, ['Bob']]) {
		assert.equal(sanitizeCustomName(candidate), '');
		assert.equal(sanitizeCustomClan(candidate), '');
	}
	assert.deepEqual(resolveCustomIdentity({}), EMPTY_CUSTOM_IDENTITY);
	assert.deepEqual(resolveCustomIdentity(undefined), EMPTY_CUSTOM_IDENTITY);
	assert.deepEqual(resolveCustomIdentity({ customClan: '', customName: '' }), { clan: '', name: '' });
	assert.equal(hasCustomIdentity(EMPTY_CUSTOM_IDENTITY), false);
	assert.equal(hasCustomIdentity({ clan: 'WOK', name: '' }), true);
	assert.equal(hasCustomIdentity({ clan: '', name: 'Bob' }), true);
});
test('resolves an identity from a preferences object', () => {
	assert.deepEqual(resolveCustomIdentity({ customClan: 'WOK', customName: 'Rocketeer' }), { clan: 'WOK', name: 'Rocketeer' });
	assert.deepEqual(resolveCustomIdentity({ customClan: '<b>', customName: 'a'.repeat(64) }), { clan: 'b', name: 'a'.repeat(CUSTOM_NAME_MAX_LENGTH) });
	assert.equal(customIdentitiesAreEqual({ clan: 'WOK', name: 'Bob' }, { clan: 'WOK', name: 'Bob' }), true);
	assert.equal(customIdentitiesAreEqual({ clan: 'WOK', name: 'Bob' }, { clan: 'WOK', name: 'Rob' }), false);
});
test('formats the label the client surfaces render', () => {
	assert.equal(formatCustomIdentityLabel({ clan: 'WOK', name: 'Rocketeer' }), '[WOK] Rocketeer');
	assert.equal(formatCustomIdentityLabel({ clan: '', name: 'Rocketeer' }), 'Rocketeer');
	assert.equal(formatCustomIdentityLabel({ clan: 'WOK', name: '' }), '[WOK]');
	assert.equal(formatCustomIdentityLabel(EMPTY_CUSTOM_IDENTITY), '');
});
test('accepts only already-clean stored values', () => {
	assert.equal(parseCustomIdentityPreference('customName', 'Rocketeer'), 'Rocketeer');
	assert.equal(parseCustomIdentityPreference('customClan', 'WOK'), 'WOK');
	assert.equal(parseCustomIdentityPreference('customName', ''), '');
	assert.equal(parseCustomIdentityPreference('customClan', ''), '');
	assert.equal(parseCustomIdentityPreference('customName', ' Rocketeer '), undefined);
	assert.equal(parseCustomIdentityPreference('customName', 'a'.repeat(17)), undefined);
	assert.equal(parseCustomIdentityPreference('customClan', 'WOKKK!'), undefined);
	assert.equal(parseCustomIdentityPreference('customName', 42), undefined);
	assert.equal(parseCustomIdentityPreference('customName', undefined), undefined);
});
test('the manual real-identity keys follow the same rules as the custom ones', () => {
	for (const key of ['customName', 'customClan', 'realName', 'realClan']) {
		assert.equal(isCustomIdentityPreferenceKey(key), true, key);
	}
	assert.equal(isCustomIdentityPreferenceKey('menuTimer'), false);
	assert.equal(parseCustomIdentityPreference('realName', 'Rocketeer'), 'Rocketeer');
	assert.equal(parseCustomIdentityPreference('realClan', 'WOK'), 'WOK');
	assert.equal(parseCustomIdentityPreference('realClan', 'WOKKK!'), undefined);
	assert.equal(parseCustomIdentityPreference('realName', ' Rocketeer '), undefined);
	assert.deepEqual(resolveConfiguredRealIdentity({ realClan: 'OLD', realName: 'Rocketeer' }), { clan: 'OLD', name: 'Rocketeer' });
	assert.deepEqual(resolveConfiguredRealIdentity({}), EMPTY_CUSTOM_IDENTITY);
	assert.deepEqual(resolveConfiguredRealIdentity(undefined), EMPTY_CUSTOM_IDENTITY);
	assert.deepEqual(resolveCustomIdentity({ realClan: 'OLD', realName: 'Rocketeer' }), EMPTY_CUSTOM_IDENTITY);
});
test('the preference loader keeps the local identity keys', () => {
	assert.deepEqual(parseUserPreferencePatch({ customClan: 'WOK', customName: 'Rocketeer' }), {
		customClan: 'WOK',
		customName: 'Rocketeer'
	});
	assert.deepEqual(parseUserPreferencePatch({ customClan: '', customName: '' }), {
		customClan: '',
		customName: ''
	});
	assert.deepEqual(parseUserPreferencePatch({ realClan: 'OLD', realName: 'Rocketeer' }), {
		realClan: 'OLD',
		realName: 'Rocketeer'
	});
	assert.deepEqual(
		parseUserPreferencePatch({
			customClan: 'way too long',
			customName: '<script>alert(1)</script>',
			realName: 'a'.repeat(17)
		}),
		{}
	);
});
test('recognises something that could be the account name Krunker prints', () => {
	for (const candidate of ['Rocketeer', 'KraXen72', 'a', 'x'.repeat(32), 'ünïcode', 'no.dots?fine']) {
		assert.equal(isPlausibleRealName(candidate), true, JSON.stringify(candidate));
	}
	for (const candidate of ['', ' ', 'two words', 'x'.repeat(33), '<b>', 'a&b', 'quote"', 42, null, undefined, {}]) {
		assert.equal(isPlausibleRealName(candidate), false, JSON.stringify(candidate));
	}
});
test("reads the player's name out of Krunker's game activity, defensively", () => {
	assert.equal(
		readGameActivityName(() => ({ class: { name: 'Triggerman' }, user: 'KraXen72' })),
		'KraXen72'
	);
	assert.equal(
		readGameActivityName(() => ({ user: '' })),
		''
	);
	assert.equal(
		readGameActivityName(() => ({ user: 'not signed in' })),
		''
	);
	assert.equal(
		readGameActivityName(() => ({})),
		''
	);
	assert.equal(
		readGameActivityName((): unknown => null),
		''
	);
	assert.equal(
		readGameActivityName(() => 'KraXen72'),
		''
	);
	assert.equal(
		readGameActivityName((): unknown => {
			throw new Error('krunker exploded');
		}),
		''
	);
	assert.equal(readGameActivityName(undefined), '');
	assert.equal(readGameActivityName({ user: 'KraXen72' }), '');
});
test('recovers the clan tag from the game printing it beside the real name', () => {
	assert.equal(extractClanTag('[OLD] Rocketeer', 'Rocketeer'), 'OLD');
	assert.equal(extractClanTag('[OLD]Rocketeer: gg', 'Rocketeer'), 'OLD');
	assert.equal(extractClanTag('  [O_1] Rocketeer  ', 'Rocketeer'), 'O_1');
	assert.equal(extractClanTag('[OLD] Bandit', 'Rocketeer'), '');
	assert.equal(extractClanTag('[OLD] Rocketeer2', 'Rocketeer'), '');
	assert.equal(extractClanTag('gg Rocketeer', 'Rocketeer'), '');
	assert.equal(extractClanTag('[WAYTOOLONG] Rocketeer', 'Rocketeer'), '');
	assert.equal(extractClanTag('[OLD] Rocketeer', ''), '');
	assert.equal(extractClanTag(undefined, 'Rocketeer'), '');
	assert.equal(extractClanTag('[OLD] a.b', 'a.b'), 'OLD');
	assert.equal(extractClanTag('[OLD] axb', 'a.b'), '');
});
test('merges what the user configured with what the game reported', () => {
	assert.deepEqual(mergeRealIdentityCandidates({ clan: 'OLD', name: 'Rocketeer' }, { clan: 'NEW', name: 'KraXen72' }), { clans: ['OLD', 'NEW'], names: ['Rocketeer', 'KraXen72'] });
	assert.deepEqual(mergeRealIdentityCandidates({ clan: '', name: 'Rocketeer' }, { clan: '', name: 'Rocketeer' }), { clans: [], names: ['Rocketeer'] });
	assert.deepEqual(mergeRealIdentityCandidates(EMPTY_CUSTOM_IDENTITY, {}), { clans: [], names: [] });
});
test('placeholder names are never taken for the player, so discovery keeps looking', () => {
	assert.equal(isPlausibleRealName('Guest'), false);
	assert.equal(isPlausibleRealName('guest'), false);
	assert.equal(isPlausibleRealName('Player'), false);
	assert.equal(isPlausibleRealName('lamboiigoni'), true);
	assert.equal(isPlausibleRealName('Guest123'), true);
	assert.equal(
		readGameActivityName(() => ({ user: 'Guest' })),
		''
	);
	assert.equal(
		readGameActivityName(() => ({ user: 'lamboiigoni' })),
		'lamboiigoni'
	);
});
