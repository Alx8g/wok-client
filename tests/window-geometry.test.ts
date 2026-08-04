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
	assert.deepEqual(
		resolveGameplayWindowGeometry('maximized', display, WINDOW_SCALE),
		resolveGameplayWindowGeometry('windowed', display, WINDOW_SCALE)
	);
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
	// kiosk was the likely breakage source of the old Windows implementation (audit A4); the
	// reimplementation must never reintroduce it, silently or otherwise.
	assert.equal('kiosk' in geometry, false);
	assert.equal('center' in geometry, false);
});

test('borderless opts out of the Linux rounded-corner default so the screen corners stay square', () => {
	// Electron 43 turned roundedCorners on by default for frameless windows on Linux. A window the
	// size of the display would then have the compositor round off the corners of the game itself.
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
	assert.deepEqual(
		resolveGameplayWindowGeometry('hand-edited-nonsense', display, WINDOW_SCALE),
		resolveGameplayWindowGeometry('windowed', display, WINDOW_SCALE)
	);
});
