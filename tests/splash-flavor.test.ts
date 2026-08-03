import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSplashFlavor } from '../src/splash-flavor.ts';

test('splash flavor selection covers both ends of the curated list', () => {
	assert.equal(
		selectSplashFlavor(() => 0),
		"He's Doing It Sideways!"
	);
	assert.equal(
		selectSplashFlavor(() => 0.999_999),
		'Did You See That?'
	);
});
