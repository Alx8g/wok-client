import assert from 'node:assert/strict';
import test from 'node:test';
import {
	applyRuntimeWindowSettings,
	type RuntimeWindowBounds,
	type RuntimeWindowTarget
} from '../src/runtime-window-settings.ts';

const bounds: RuntimeWindowBounds = { height: 864, width: 1536, x: 2752, y: 348 };

function createWindow(fullscreen = false, maximized = false): {
	calls: string[];
	target: RuntimeWindowTarget;
} {
	const calls: string[] = [];
	return {
		calls,
		target: {
			isFullScreen: () => fullscreen,
			isMaximized: () => maximized,
			maximize: () => { calls.push('maximize'); },
			setBounds: value => { calls.push(`bounds:${JSON.stringify(value)}`); },
			setFullScreen: value => { calls.push(`fullscreen:${value}`); },
			setResizable: value => { calls.push(`resizable:${value}`); },
			unmaximize: () => { calls.push('unmaximize'); }
		}
	};
}

test('moves a windowed game without replacing its renderer', () => {
	const window = createWindow();
	assert.equal(applyRuntimeWindowSettings(window.target, 'windowed', bounds), true);
	assert.deepEqual(window.calls, [
		'resizable:true',
		`bounds:${JSON.stringify(bounds)}`
	]);
});

test('leaves native state before moving and then enters the requested mode', () => {
	const fullscreen = createWindow(true, false);
	assert.equal(applyRuntimeWindowSettings(fullscreen.target, 'fullscreen', bounds), true);
	assert.deepEqual(fullscreen.calls, [
		'fullscreen:false',
		'resizable:true',
		`bounds:${JSON.stringify(bounds)}`,
		'fullscreen:true'
	]);

	const maximized = createWindow(false, true);
	assert.equal(applyRuntimeWindowSettings(maximized.target, 'maximized', bounds), true);
	assert.deepEqual(maximized.calls, [
		'unmaximize',
		'resizable:true',
		`bounds:${JSON.stringify(bounds)}`,
		'maximize'
	]);
});

test('refuses borderless because frame is fixed at BrowserWindow construction', () => {
	const window = createWindow();
	assert.equal(applyRuntimeWindowSettings(window.target, 'borderless', bounds), false);
	assert.deepEqual(window.calls, []);
});
