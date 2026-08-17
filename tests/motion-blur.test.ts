import assert from 'node:assert/strict';
import test from 'node:test';
import {
	calculateFrameRetention,
	calculateMouseMotionFactor,
	motionBlurOptionsFromUserPrefs
} from '../src/motion-blur.ts';

test('maps strength and quality controls to bounded renderer options', () => {
	assert.deepEqual(motionBlurOptionsFromUserPrefs({
		motionBlurQuality: 'balanced',
		motionBlurStrength: 50
	}), {
		qualityScale: 0.75,
		strength: 0.24
	});

	assert.deepEqual(motionBlurOptionsFromUserPrefs({
		motionBlurQuality: 'unknown',
		motionBlurStrength: 150
	}), {
		qualityScale: 1,
		strength: 0.48
	});
	assert.deepEqual(motionBlurOptionsFromUserPrefs({
		motionBlurQuality: 'toString',
		motionBlurStrength: Number.NaN
	}), {
		qualityScale: 1,
		strength: 0.24
	});
});

test('defaults to native quality and the recommended 50 percent strength', () => {
	assert.deepEqual(motionBlurOptionsFromUserPrefs({}), {
		qualityScale: 1,
		strength: 0.24
	});
});

test('ignores fine aim corrections and normalizes turn speed across frame rates', () => {
	assert.equal(calculateMouseMotionFactor(2.9, 1_000 / 60), 0);
	assert.equal(calculateMouseMotionFactor(30, 1_000 / 60), 1);
	assert.equal(calculateMouseMotionFactor(15, 1_000 / 120), 1);
	assert.ok(calculateMouseMotionFactor(10, 1_000 / 60) < 0.2);
});

test('keeps temporal frame retention consistent across frame rates', () => {
	const sixtyFpsRetention = calculateFrameRetention(0.48, 1_000 / 60);
	const thirtyFpsRetention = calculateFrameRetention(0.48, 1_000 / 30);
	assert.ok(Math.abs(sixtyFpsRetention - 0.48) < 1e-12);
	assert.ok(Math.abs(thirtyFpsRetention - 0.48 ** 2) < 1e-12);
});
