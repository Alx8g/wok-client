import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeReleaseSmokeBitmap } from '../src/release-smoke.ts';

function solidBitmap(red: number, green: number, blue: number, pixels = 256): Uint8Array {
	const bitmap = new Uint8Array(pixels * 4);
	for (let index = 0; index < pixels; index++) bitmap.set([blue, green, red, 255], index * 4);
	return bitmap;
}

test('rejects an empty or uniform gray capture', () => {
	assert.equal(analyzeReleaseSmokeBitmap(new Uint8Array()).nonUniform, false);
	const gray = analyzeReleaseSmokeBitmap(solidBitmap(32, 32, 32));
	assert.equal(gray.nonUniform, false);
	assert.equal(gray.luminanceRange, 0);
});

test('accepts a capture with meaningful visual variation', () => {
	const bitmap = solidBitmap(8, 8, 8);
	for (let pixel = 0; pixel < 128; pixel++) bitmap.set([220, 160, 80, 255], pixel * 4);
	const result = analyzeReleaseSmokeBitmap(bitmap);
	assert.equal(result.nonUniform, true);
	assert.ok(result.luminanceRange >= 12);
	assert.ok(result.luminanceVariance >= 20);
});

test('bounds analysis work on large captures', () => {
	const bitmap = solidBitmap(0, 0, 0, 1_000_000);
	const result = analyzeReleaseSmokeBitmap(bitmap);
	assert.ok(result.sampleCount <= 16_500);
});
