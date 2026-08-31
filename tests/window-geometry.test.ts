import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveGameplayWindowGeometry, type GameplayDisplay } from '../src/window-geometry.ts';
const WINDOW_SCALE = 0.8;
const display: GameplayDisplay = {
	bounds: { height: 1440, width: 2560, x: 0, y: 0 },
	size: { height: 1440, width: 2560 }
};
test('windowed mode centres a scaled window and never starts fullscreen', () => {
	assert.deepEqual(resolveGameplayWindowGeometry('windowed', display, WINDOW_SCALE), {
		center: true,
		fullscreen: false,
		height: 1152,
		width: 2048
	});
});
test('maximized mode starts from the windowed rectangle; the maximize itself is window wiring', () => {
	assert.deepEqual(resolveGameplayWindowGeometry('maximized', display, WINDOW_SCALE), resolveGameplayWindowGeometry('windowed', display, WINDOW_SCALE));
});
test('fullscreen mode keeps the windowed rectangle as the restore size', () => {
	assert.deepEqual(resolveGameplayWindowGeometry('fullscreen', display, WINDOW_SCALE), {
		center: true,
		fullscreen: true,
		height: 1152,
		width: 2048
	});
});
test('borderless is a plain frameless window covering the display bounds, with no kiosk state', () => {
	const geometry = resolveGameplayWindowGeometry('borderless', display, WINDOW_SCALE);
	assert.deepEqual(geometry, {
		frame: false,
		fullscreen: false,
		fullscreenable: false,
		height: 1440,
		resizable: false,
		roundedCorners: false,
		width: 2560,
		x: 0,
		y: 0
	});
	assert.equal('kiosk' in geometry, false);
	assert.equal('center' in geometry, false);
});
test('borderless opts out of the Linux rounded-corner default so the screen corners stay square', () => {
	assert.equal(resolveGameplayWindowGeometry('borderless', display, WINDOW_SCALE).roundedCorners, false);
	for (const mode of ['windowed', 'maximized', 'fullscreen']) {
		assert.equal('roundedCorners' in resolveGameplayWindowGeometry(mode, display, WINDOW_SCALE), false);
	}
});
test('borderless follows the display origin, not an assumed 0,0', () => {
	const offsetDisplay: GameplayDisplay = {
		bounds: { height: 1080, width: 1920, x: -1920, y: 240 },
		size: { height: 1080, width: 1920 }
	};
	const geometry = resolveGameplayWindowGeometry('borderless', offsetDisplay, WINDOW_SCALE);
	assert.equal(geometry.x, -1920);
	assert.equal(geometry.y, 240);
	assert.equal(geometry.width, 1920);
	assert.equal(geometry.height, 1080);
});
test('unrecognised persisted values fall through to windowed instead of throwing', () => {
	assert.deepEqual(resolveGameplayWindowGeometry('hand-edited-nonsense', display, WINDOW_SCALE), resolveGameplayWindowGeometry('windowed', display, WINDOW_SCALE));
});
const secondDisplay: GameplayDisplay = {
	bounds: { height: 1080, width: 1920, x: 2560, y: 240 },
	size: { height: 1080, width: 1920 }
};
test('a chosen display gets explicit coordinates, because center centres on the primary one', () => {
	const geometry = resolveGameplayWindowGeometry('windowed', secondDisplay, WINDOW_SCALE, true);
	assert.deepEqual(geometry, {
		fullscreen: false,
		height: 864,
		width: 1536,
		x: 2560 + 192,
		y: 240 + 108
	});
	assert.equal('center' in geometry, false);
});
test('fullscreen on a chosen display is anchored there, not left to land on the primary', () => {
	const geometry = resolveGameplayWindowGeometry('fullscreen', secondDisplay, WINDOW_SCALE, true);
	assert.equal(geometry.fullscreen, true);
	assert.equal(geometry.x, 2560 + 192);
	assert.equal(geometry.y, 240 + 108);
});
test('maximized on a chosen display starts from that display, so the native maximize expands onto it', () => {
	assert.deepEqual(resolveGameplayWindowGeometry('maximized', secondDisplay, WINDOW_SCALE, true), resolveGameplayWindowGeometry('windowed', secondDisplay, WINDOW_SCALE, true));
});
test('borderless already carries display coordinates, so explicit placement changes nothing', () => {
	assert.deepEqual(resolveGameplayWindowGeometry('borderless', secondDisplay, WINDOW_SCALE, true), resolveGameplayWindowGeometry('borderless', secondDisplay, WINDOW_SCALE));
});
test('the default path is untouched: no explicit placement means the historical centred geometry', () => {
	assert.deepEqual(resolveGameplayWindowGeometry('windowed', secondDisplay, WINDOW_SCALE), {
		center: true,
		fullscreen: false,
		height: 864,
		width: 1536
	});
});
