import assert from 'node:assert/strict';
import test from 'node:test';
import { HUD_CONTAINMENT_CSS } from '../src/hud-containment.ts';
test('isolates only the fixed telemetry holder without size containment or visual overrides', () => {
	assert.match(HUD_CONTAINMENT_CSS, /#topLeftHolder\s*\{/u);
	assert.match(HUD_CONTAINMENT_CSS, /contain:\s*layout style paint/u);
	assert.doesNotMatch(HUD_CONTAINMENT_CSS, /\bsize\b/u);
	assert.doesNotMatch(HUD_CONTAINMENT_CSS, /display|position|width|height|transform|opacity/u);
});
