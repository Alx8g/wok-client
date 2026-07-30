import assert from 'node:assert/strict';
import test from 'node:test';
import { createChangedSettingsPatch } from '../src/competitive-settings.ts';

test('returns no writes when Competitive settings are already applied', () => {
	const current = {
		antiAlias: false,
		reflection: '0',
		shadows: false
	};

	assert.deepEqual(createChangedSettingsPatch(current, current), {});
});

test('returns only settings whose values need to change', () => {
	assert.deepEqual(createChangedSettingsPatch(
		{
			antiAlias: true,
			reflection: '1',
			shadows: false
		},
		{
			antiAlias: false,
			reflection: '0',
			shadows: false
		}
	), {
		antiAlias: false,
		reflection: '0'
	});
});

test('treats equivalent numeric and string setting values as unchanged', () => {
	assert.deepEqual(createChangedSettingsPatch(
		{ reflection: 0 },
		{ reflection: '0' }
	), {});
});

test('does not coerce booleans into strings', () => {
	assert.deepEqual(createChangedSettingsPatch(
		{ shadows: 'false' },
		{ shadows: false }
	), { shadows: false });
});
