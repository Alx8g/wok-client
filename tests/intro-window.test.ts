import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join as pathJoin } from 'node:path';
import test from 'node:test';
import type {
	BrowserWindow,
	BrowserWindowConstructorOptions,
	Display
} from 'electron';
import {
	createIntroGameWindowHandoff,
	getIntroWindowBounds,
	selectIntroSource,
	startIntroSequence,
	type IntroSequenceScheduler
} from '../src/intro-window.ts';

class FakeScheduler implements IntroSequenceScheduler {
	private nextId = 1;
	private readonly scheduled = new Map<
		number,
		{ callback: () => void; delayMs: number }
	>();

	public clear(timer: unknown): void {
		this.scheduled.delete(timer as number);
	}

	public schedule(
		callback: () => void,
		delayMs: number
	): unknown {
		const id = this.nextId;
		this.nextId += 1;
		this.scheduled.set(id, { callback, delayMs });
		return id;
	}

	public runDelay(delayMs: number): void {
		const match = [...this.scheduled.entries()].find(
			([, entry]) => entry.delayMs === delayMs
		);
		assert.ok(match, `No active timer is scheduled for ${delayMs} ms.`);
		this.scheduled.delete(match[0]);
		match[1].callback();
	}

	public get size(): number {
		return this.scheduled.size;
	}
}

class FakeWebContents extends EventEmitter {
	public muted = false;

	public setAudioMuted(muted: boolean): void {
		this.muted = muted;
	}
}

class FakeIntroWindow extends EventEmitter {
	/** Reachable after destruction so a test can prove late events are inert. */
	public readonly contents = new FakeWebContents();
	public alwaysOnTop?: [boolean, string];
	public destroyed = false;
	public hiddenCount = 0;
	/** Electron throws when a hidden window is hidden again after an internal teardown race. */
	public hideThrows = false;

	/** Electron throws from the members of a destroyed window, including this getter. */
	public get webContents(): FakeWebContents {
		if (this.destroyed) throw new Error('Object has been destroyed');
		return this.contents;
	}
	public load?: {
		options: { query: Record<string, string> };
		path: string;
	};
	public showInactiveCount = 0;
	public visible = false;

	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.visible = false;
		this.emit('closed');
	}

	public closeExternally(): void {
		this.destroy();
	}

	public hide(): void {
		if (this.hideThrows) throw new Error('Object has been destroyed');
		this.hiddenCount += 1;
		this.visible = false;
	}

	public isDestroyed(): boolean {
		return this.destroyed;
	}

	public isVisible(): boolean {
		return this.visible;
	}

	public loadFile(
		path: string,
		options: { query: Record<string, string> }
	): Promise<void> {
		this.load = { options, path };
		return Promise.resolve();
	}

	public setAlwaysOnTop(
		flag: boolean,
		level: string
	): void {
		this.alwaysOnTop = [flag, level];
	}

	public showInactive(): void {
		this.showInactiveCount += 1;
		this.visible = true;
	}
}

function createSequenceHarness(audio = true) {
	const callbackOrder: string[] = [];
	const introWindow = new FakeIntroWindow();
	const scheduler = new FakeScheduler();
	let constructorOptions:
		| BrowserWindowConstructorOptions
		| undefined;
	const sequence = startIntroSequence({
		assetsPath: 'C:\\client\\assets',
		audio,
		bounds: {
			height: 720,
			width: 1280,
			x: 12,
			y: 34
		},
		createWindow: options => {
			constructorOptions = options;
			return introWindow as unknown as BrowserWindow;
		},
		onFinished: () => {
			callbackOrder.push('finished');
		},
		onReveal: () => {
			callbackOrder.push('reveal');
		},
		onVisualEnd: () => {
			callbackOrder.push('visual-end');
		},
		scheduler,
		source: '1080',
		timing: {
			asset: 'intro-test',
			audioMs: 4_000,
			opaqueMs: 1_000,
			visualMs: 3_000
		}
	});
	return {
		callbackOrder,
		get constructorOptions() {
			return constructorOptions;
		},
		introWindow,
		scheduler,
		sequence
	};
}

function fakeDisplay(): Display {
	return {
		bounds: {
			height: 1440,
			width: 2560,
			x: -2560,
			y: 0
		},
		id: 1,
		internal: false,
		label: 'test',
		maximumCursorSize: { height: 64, width: 64 },
		monochrome: false,
		nativeOrigin: { x: -2560, y: 0 },
		rotation: 0,
		scaleFactor: 1,
		size: { height: 1440, width: 2560 },
		touchSupport: 'unknown',
		workArea: {
			height: 1400,
			width: 2560,
			x: -2560,
			y: 0
		},
		workAreaSize: { height: 1400, width: 2560 }
	} as unknown as Display;
}

test('intro bounds and source selection follow the game geometry and physical pixels', () => {
	const display = fakeDisplay();
	assert.deepEqual(
		getIntroWindowBounds(display, 'fullscreen', 0.75),
		display.bounds
	);
	assert.deepEqual(
		getIntroWindowBounds(display, 'maximized', 0.75),
		display.workArea
	);
	const windowed = getIntroWindowBounds(
		display,
		'windowed',
		0.75
	);
	assert.deepEqual(windowed, {
		height: 1080,
		width: 1920,
		x: -2240,
		y: 180
	});
	assert.equal(selectIntroSource(display, windowed), '1080');
	assert.equal(
		selectIntroSource(
			{ ...display, scaleFactor: 1.25 },
			windowed
		),
		'1440'
	);
});

test('intro startup, playback, visual handoff and audio-tail completion run once in order', () => {
	const harness = createSequenceHarness(false);
	assert.deepEqual(
		{
			height: harness.constructorOptions?.height,
			sandbox:
				harness.constructorOptions?.webPreferences
					?.sandbox,
			show: harness.constructorOptions?.show,
			transparent: harness.constructorOptions?.transparent,
			width: harness.constructorOptions?.width,
			x: harness.constructorOptions?.x,
			y: harness.constructorOptions?.y
		},
		{
			height: 720,
			sandbox: true,
			show: false,
			transparent: true,
			width: 1280,
			x: 12,
			y: 34
		}
	);
	assert.deepEqual(
		harness.introWindow.alwaysOnTop,
		[true, 'screen-saver']
	);
	assert.equal(harness.introWindow.webContents.muted, true);
	assert.deepEqual(harness.introWindow.load, {
		options: {
			query: {
				asset: 'intro-test',
				source: '1080',
				visualMs: '3000'
			}
		},
		path: pathJoin('C:\\client\\assets', 'intro.html')
	});

	harness.introWindow.emit('ready-to-show');
	assert.equal(harness.introWindow.visible, true);
	assert.equal(harness.introWindow.showInactiveCount, 1);

	harness.introWindow.webContents.emit(
		'media-started-playing'
	);
	harness.scheduler.runDelay(1_450);
	assert.deepEqual(harness.callbackOrder, ['reveal']);
	assert.equal(harness.introWindow.visible, true);

	harness.scheduler.runDelay(3_000);
	assert.deepEqual(harness.callbackOrder, [
		'reveal',
		'visual-end'
	]);
	assert.equal(harness.introWindow.visible, false);
	assert.equal(harness.introWindow.destroyed, false);

	harness.scheduler.runDelay(4_250);
	assert.deepEqual(harness.callbackOrder, [
		'reveal',
		'visual-end',
		'finished'
	]);
	assert.equal(harness.introWindow.destroyed, true);
	assert.equal(harness.scheduler.size, 0);

	harness.sequence.cancel();
	harness.introWindow.contents.emit('media-paused');
	assert.deepEqual(harness.callbackOrder, [
		'reveal',
		'visual-end',
		'finished'
	]);
});

test('intro media-start timeout fails forward and clears every remaining timer', () => {
	const harness = createSequenceHarness();
	harness.introWindow.emit('ready-to-show');
	harness.scheduler.runDelay(2_000);

	assert.deepEqual(harness.callbackOrder, [
		'reveal',
		'visual-end',
		'finished'
	]);
	assert.equal(harness.introWindow.destroyed, true);
	assert.equal(harness.scheduler.size, 0);
});

test('closing or cancelling the intro completes all callbacks exactly once', () => {
	const closed = createSequenceHarness();
	closed.introWindow.emit('ready-to-show');
	closed.introWindow.closeExternally();
	closed.sequence.cancel();
	assert.deepEqual(closed.callbackOrder, [
		'reveal',
		'visual-end',
		'finished'
	]);
	assert.equal(closed.scheduler.size, 0);

	const cancelled = createSequenceHarness();
	cancelled.sequence.cancel();
	cancelled.introWindow.emit('closed');
	assert.deepEqual(cancelled.callbackOrder, [
		'reveal',
		'visual-end',
		'finished'
	]);
	assert.equal(cancelled.introWindow.destroyed, true);
});

test('a window operation that throws mid-sequence cannot strand the handoff', () => {
	// Nothing about the intro window is worth trapping the user behind: an always-on-top window
	// that never hands over is the same dead client as a splash that never comes down.
	const hideFailure = createSequenceHarness();
	hideFailure.introWindow.emit('ready-to-show');
	hideFailure.introWindow.webContents.emit('media-started-playing');
	hideFailure.introWindow.hideThrows = true;
	hideFailure.scheduler.runDelay(1_450);
	hideFailure.scheduler.runDelay(3_000);
	assert.deepEqual(hideFailure.callbackOrder, ['reveal', 'visual-end']);
	hideFailure.scheduler.runDelay(4_250);
	assert.deepEqual(hideFailure.callbackOrder, [
		'reveal',
		'visual-end',
		'finished'
	]);
	assert.equal(hideFailure.introWindow.destroyed, true);

	// A window destroyed under the sequence (crashed renderer, closed window) makes every member
	// throw, including the webContents getter the cleanup path reads.
	const destroyedEarly = createSequenceHarness();
	destroyedEarly.introWindow.emit('ready-to-show');
	destroyedEarly.introWindow.destroy();
	assert.deepEqual(destroyedEarly.callbackOrder, [
		'reveal',
		'visual-end',
		'finished'
	]);
	assert.equal(destroyedEarly.scheduler.size, 0);
});

test('game readiness stays behind the intro then receives focus at the visual handoff', () => {
	const calls: string[] = [];
	let destroyed = false;
	let maximized = false;
	let visible = false;
	const handoff = createIntroGameWindowHandoff(
		{
			focus: () => {
				calls.push('focus');
			},
			isDestroyed: () => destroyed,
			isMaximized: () => maximized,
			isVisible: () => visible,
			maximize: () => {
				maximized = true;
				calls.push('maximize');
			},
			show: () => {
				visible = true;
				calls.push('show');
			},
			showInactive: () => {
				visible = true;
				calls.push('show-inactive');
			}
		},
		'maximized'
	);

	handoff.beginIntro();
	handoff.handleReadyToShow();
	assert.deepEqual(calls, []);

	handoff.revealBehindIntro();
	assert.deepEqual(calls, ['maximize', 'show-inactive']);
	handoff.handleReadyToShow();
	assert.deepEqual(calls, ['maximize', 'show-inactive']);

	handoff.revealForUse();
	assert.deepEqual(calls, [
		'maximize',
		'show-inactive',
		'focus'
	]);
	handoff.handleReadyToShow();
	assert.deepEqual(calls, [
		'maximize',
		'show-inactive',
		'focus',
		'focus'
	]);

	destroyed = true;
	handoff.revealForUse();
	assert.equal(calls.length, 4);
});
