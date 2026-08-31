import assert from 'node:assert/strict';
import test from 'node:test';
import { DRAW_METHOD_NAMES, installDrawCallCensus, summarizeDrawCallCensus, type DrawCallCensusReport, type DrawCallCensusTarget } from '../src/draw-call-stats.ts';
function createFakeGlPrototype(): DrawCallCensusTarget & {
	calls: string[];
} {
	const target = { calls: [] as string[] } as DrawCallCensusTarget & {
		calls: string[];
	};
	for (const name of DRAW_METHOD_NAMES)
		target[name] = function () {
			(this as typeof target).calls.push(name);
			return name;
		};
	target.bindTexture = function () {
		(this as typeof target).calls.push('bindTexture');
	};
	target.useProgram = function () {
		(this as typeof target).calls.push('useProgram');
	};
	return target;
}
test('summarizes per-frame counts as medians and p95s', () => {
	const samples = [
		{ draws: 10, programSwitches: 2, textureBinds: 4 },
		{ draws: 20, programSwitches: 3, textureBinds: 6 },
		{ draws: 30, programSwitches: 4, textureBinds: 8 },
		{ draws: 200, programSwitches: 9, textureBinds: 40 }
	];
	assert.deepEqual(summarizeDrawCallCensus(samples), {
		frames: 4,
		maxDraws: 200,
		medianDraws: 20,
		medianProgramSwitches: 3,
		medianTextureBinds: 6,
		p95Draws: 30,
		p95ProgramSwitches: 4,
		p95TextureBinds: 8
	});
	assert.equal(summarizeDrawCallCensus([]).frames, 0);
});
test('counts real calls per frame, skips warmup and idle frames, then restores the prototype', () => {
	const target = createFakeGlPrototype();
	const untouched = Object.fromEntries(DRAW_METHOD_NAMES.map((name) => [name, target[name]]));
	const frames: (() => void)[] = [];
	let report: DrawCallCensusReport | undefined;
	installDrawCallCensus({
		report: (value) => {
			report = value;
		},
		requestFrame: (callback) => {
			frames.push(callback);
		},
		sampleFrames: 2,
		target,
		warmupFrames: 1
	});
	const drive = (draws: number, binds: number, programs: number) => {
		for (let index = 0; index < draws; index++) (target.drawElements as () => void).call(target);
		for (let index = 0; index < binds; index++) (target.bindTexture as () => void).call(target);
		for (let index = 0; index < programs; index++) (target.useProgram as () => void).call(target);
		const next = frames.shift();
		assert.ok(next, 'expected a scheduled frame');
		next();
	};
	drive(999, 999, 999);
	drive(0, 5, 5);
	drive(40, 8, 3);
	drive(60, 12, 5);
	assert.ok(report);
	assert.equal(report.frames, 2);
	assert.equal(report.medianDraws, 40);
	assert.equal(report.maxDraws, 60);
	assert.equal(report.medianTextureBinds, 8);
	assert.equal(report.medianProgramSwitches, 3);
	for (const name of DRAW_METHOD_NAMES) assert.equal(target[name], untouched[name], `${name} was not restored`);
});
test('only gameplay frames are censused, so a menu cannot fill the window', () => {
	const target = createFakeGlPrototype();
	const frames: (() => void)[] = [];
	let active = false;
	let report: DrawCallCensusReport | undefined;
	installDrawCallCensus({
		isActive: () => active,
		report: (value) => {
			report = value;
		},
		requestFrame: (callback) => {
			frames.push(callback);
		},
		sampleFrames: 2,
		target,
		warmupFrames: 1
	});
	const drive = (draws: number) => {
		for (let index = 0; index < draws; index++) (target.drawElements as () => void).call(target);
		const next = frames.shift();
		assert.ok(next, 'expected a scheduled frame');
		next();
	};
	for (let index = 0; index < 50; index++) drive(60);
	assert.equal(report, undefined, 'menu frames must not fill the census window');
	active = true;
	drive(300);
	drive(280);
	drive(320);
	assert.ok(report);
	assert.equal(report.frames, 2);
	assert.equal(report.medianDraws, 280);
});
test('the returned uninstall restores the prototype without reporting', () => {
	const target = createFakeGlPrototype();
	const original = target.drawArrays;
	const frames: (() => void)[] = [];
	let reported = false;
	const uninstall = installDrawCallCensus({
		report: () => {
			reported = true;
		},
		requestFrame: (callback) => {
			frames.push(callback);
		},
		target
	});
	assert.notEqual(target.drawArrays, original, 'expected the census to wrap draw calls');
	uninstall();
	assert.equal(target.drawArrays, original);
	frames.shift()?.();
	assert.equal(reported, false, 'a cancelled census must not report');
});
