import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, sha256Hex } from '../src/shared/hash.ts';

test('sha256Hex produces the known SHA-256 digest', () => {
	assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('canonicalJson sorts object keys recursively without reordering arrays', () => {
	const first = canonicalJson({ z: 1, a: { y: 2, b: 3 }, list: [{ d: 4, c: 5 }, 6] });
	const second = canonicalJson({ list: [{ c: 5, d: 4 }, 6], a: { b: 3, y: 2 }, z: 1 });
	assert.equal(first, second);
	assert.equal(first, '{"a":{"b":3,"y":2},"list":[{"c":5,"d":4},6],"z":1}');
});

test('canonicalJson rejects non-finite numbers and circular references', () => {
	assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite/u);
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	assert.throws(() => canonicalJson(circular), /circular/u);
});
