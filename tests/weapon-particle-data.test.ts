import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { WEAPON_COUNT, WEAPON_PALETTE_SIZE, WEAPON_PARTICLE_DATA, WEAPON_POINT_COUNT } from '../src/weapon-particle-data.ts';
const POINT_STRIDE = 3;
test('optimized weapon particle payload retains its attested identity', () => {
	const payload = inflateSync(Buffer.from(WEAPON_PARTICLE_DATA, 'base64'));
	assert.equal(createHash('sha256').update(payload).digest('hex'), '1267856777bb4ed77a7ad81cf96f420da6d26edbc572aa27e47d0ac96cba7996');
});
test('optimized weapon particle payload has the complete expected layout', () => {
	assert.equal(WEAPON_COUNT, 13);
	assert.equal(WEAPON_PALETTE_SIZE, 16);
	assert.equal(WEAPON_POINT_COUNT, 2200);
	const payload = inflateSync(Buffer.from(WEAPON_PARTICLE_DATA, 'base64'));
	const paletteBytes = WEAPON_COUNT * WEAPON_PALETTE_SIZE * 3;
	const pointBytes = WEAPON_COUNT * WEAPON_POINT_COUNT * POINT_STRIDE;
	assert.equal(payload.length, paletteBytes + pointBytes);
});
