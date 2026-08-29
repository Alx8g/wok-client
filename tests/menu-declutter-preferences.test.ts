import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUserPreferencePatch } from '../src/user-preferences.ts';

test('accepts only explicit boolean menu-declutter preferences', () => {
	assert.deepEqual(parseUserPreferencePatch({ wokMenuDeclutter: true }), {
		wokMenuDeclutter: true
	});
	assert.deepEqual(parseUserPreferencePatch({ wokMenuDeclutter: false }), {
		wokMenuDeclutter: false
	});
	assert.deepEqual(parseUserPreferencePatch({ wokMenuDeclutter: 'true' }), {});
});
