import assert from 'node:assert/strict';
import test from 'node:test';
import {
	CUSTOM_CLAN_MAX_LENGTH,
	CUSTOM_NAME_MAX_LENGTH,
	customIdentitiesAreEqual,
	EMPTY_CUSTOM_IDENTITY,
	formatCustomIdentityLabel,
	hasCustomIdentity,
	parseCustomIdentityPreference,
	resolveCustomIdentity,
	sanitizeCustomClan,
	sanitizeCustomName
} from '../src/custom-identity.ts';
import { parseUserPreferencePatch } from '../src/user-preferences.ts';

test('trims surrounding whitespace before anything else', () => {
	assert.equal(sanitizeCustomName('   Rocketeer   '), 'Rocketeer');
	assert.equal(sanitizeCustomClan('\t WOK \n'), 'WOK');
	// Trimming happens first so padding never consumes the length budget.
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
	// Inner whitespace and punctuation are dropped rather than kept or escaped.
	assert.equal(sanitizeCustomName('Rocket Man'), 'RocketMan');
	assert.equal(sanitizeCustomName('a.b,c;d'), 'abcd');
	// Nothing that could break out of the settings UI markup can survive.
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
	// A preferences object that somehow carries junk still yields a safe identity.
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
	// Values that would need sanitizing are dropped, so the empty default applies instead of a
	// silently mangled one.
	assert.equal(parseCustomIdentityPreference('customName', ' Rocketeer '), undefined);
	assert.equal(parseCustomIdentityPreference('customName', 'a'.repeat(17)), undefined);
	assert.equal(parseCustomIdentityPreference('customClan', 'WOKKK!'), undefined);
	assert.equal(parseCustomIdentityPreference('customName', 42), undefined);
	assert.equal(parseCustomIdentityPreference('customName', undefined), undefined);
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
	assert.deepEqual(parseUserPreferencePatch({
		customClan: 'way too long',
		customName: '<script>alert(1)</script>'
	}), {});
});
