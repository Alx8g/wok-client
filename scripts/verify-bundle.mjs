// Verifies a bundle/ build (scripts/bundle.mjs) against src/ without launching the app:
//
// 1. Entry outputs exist and every deliberate lazy boundary (dynamic import() site) stayed
//    outside the eager entry bundles, so bundling cannot flatten the startup path.
// 2. The serialized-module mechanism survived bundling: the calibration trial page built by
//    the real shipped calibration-window chunk embeds calibration-workload/-benchmark
//    functions via Function.prototype.toString, and this script evaluates that embedded
//    script as plain JavaScript and proves it emits the identical WebGL command stream as
//    the raw src/ modules (the same digest check as tests/calibration-workload.test.ts).
//
// Exits non-zero with a message on the first violated invariant.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkload, createWorkloadSpec, createWorkloadSpin, mulberry32, WORKLOAD_SEED } from '../src/calibration-workload.ts';

const rootDirectory = join(import.meta.dirname, '..');
const metafile = JSON.parse(readFileSync(join(rootDirectory, 'bundle', 'metafile.json'), 'utf-8'));

// --- 1. entries + preserved lazy boundaries -------------------------------------------------

const lazyBoundaries = [
	'src/settingsui.ts',
	'src/matchmaker.ts',
	'src/discord-rpc.ts',
	'src/competitive-mode.ts',
	'src/calibration-window.ts'
];

/** Transitive input set of an output file: its own inputs plus every statically imported chunk's. */
function eagerInputsOf(outputPath, seen = new Set()) {
	if (seen.has(outputPath)) return new Set();
	seen.add(outputPath);
	const output = metafile.outputs[outputPath];
	assert.ok(output, `metafile is missing the output ${outputPath}`);
	const inputs = new Set(Object.keys(output.inputs).map(inputPath => inputPath.replaceAll('\\', '/')));
	for (const imported of output.imports ?? []) {
		if (imported.external || imported.kind !== 'import-statement') continue;
		for (const transitiveInput of eagerInputsOf(imported.path.replaceAll('\\', '/'), seen)) inputs.add(transitiveInput);
	}
	return inputs;
}

const entryOutputs = new Map();
for (const [outputPath, output] of Object.entries(metafile.outputs)) {
	if (output.entryPoint) entryOutputs.set(output.entryPoint.replaceAll('\\', '/'), outputPath.replaceAll('\\', '/'));
}
assert.equal(entryOutputs.get('src/main.ts'), 'bundle/main.mjs', 'src/main.ts must produce bundle/main.mjs');
assert.equal(entryOutputs.get('src/preload.ts'), 'bundle/preload.mjs', 'src/preload.ts must produce bundle/preload.mjs');

function outputsContainingInput(inputPath) {
	return Object.entries(metafile.outputs)
		.filter(([, output]) => Object.keys(output.inputs).some(candidate => candidate.replaceAll('\\', '/') === inputPath))
		.map(([outputPath]) => outputPath.replaceAll('\\', '/'));
}

function reachableThroughDynamicImport(entryPath, targetPath) {
	const pending = [{ outputPath: entryPath, crossedDynamicBoundary: false }];
	const seen = new Set();
	while (pending.length > 0) {
		const current = pending.shift();
		const seenKey = `${current.outputPath}:${current.crossedDynamicBoundary}`;
		if (seen.has(seenKey)) continue;
		seen.add(seenKey);
		if (current.outputPath === targetPath && current.crossedDynamicBoundary) return true;
		const output = metafile.outputs[current.outputPath];
		if (!output) continue;
		for (const imported of output.imports ?? []) {
			if (imported.external) continue;
			pending.push({
				outputPath: imported.path.replaceAll('\\', '/'),
				crossedDynamicBoundary: current.crossedDynamicBoundary || imported.kind === 'dynamic-import'
			});
		}
	}
	return false;
}

const entryBundles = ['bundle/main.mjs', 'bundle/preload.mjs'];
for (const boundary of lazyBoundaries) {
	const containingOutputs = outputsContainingInput(boundary);
	assert.ok(containingOutputs.length > 0, `${boundary} is declared lazy but absent from the bundle graph`);
	for (const entry of entryBundles) {
		assert.ok(!eagerInputsOf(entry).has(boundary), `${boundary} was flattened into the eager ${entry} bundle`);
	}
	assert.ok(
		containingOutputs.some(output => entryBundles.some(entry => reachableThroughDynamicImport(entry, output))),
		`${boundary} is not reachable from an entry through a dynamic import`
	);
}

// main.mjs must point Electron at the bundled preload, never the raw TypeScript one.
const mainSource = readFileSync(join(rootDirectory, 'bundle', 'main.mjs'), 'utf-8');
assert.ok(mainSource.includes('preload.mjs'), 'bundle/main.mjs does not reference preload.mjs');

// --- 2. serialized-module equivalence against the shipped chunk -----------------------------

const calibrationWindowOutput = Object.keys(metafile.outputs).find(outputPath =>
	Object.keys(metafile.outputs[outputPath].inputs).some(inputPath => inputPath.replaceAll('\\', '/') === 'src/calibration-window.ts'));
assert.ok(calibrationWindowOutput, 'no bundle output contains src/calibration-window.ts');

const bundledCalibrationWindow = await import(pathToFileURL(join(rootDirectory, calibrationWindowOutput)));
assert.equal(typeof bundledCalibrationWindow.buildCalibrationTrialPage, 'function',
	`${calibrationWindowOutput} does not export buildCalibrationTrialPage`);

const page = bundledCalibrationWindow.buildCalibrationTrialPage(
	{ backend: 'default', framePolicy: 'uncapped', id: 'default:uncapped' }, 1, 1, '<svg></svg>'
);
const scriptStart = page.indexOf("'use strict';");
const scriptEnd = page.indexOf('window.wokRunBenchmark');
assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, 'trial page lost its embedded module script');
const embedded = new Function(`${page.slice(scriptStart, scriptEnd)}
	return { WORKLOAD_SPEC, createWorkload, createWorkloadSpin, mulberry32, runBenchmarkTrial };`)();

assert.deepEqual(embedded.WORKLOAD_SPEC, createWorkloadSpec(), 'embedded workload spec drifted from src');
assert.equal(embedded.mulberry32(123)(), mulberry32(123)(), 'embedded mulberry32 diverged from src');
assert.equal(embedded.createWorkloadSpin(WORKLOAD_SEED, 500)(), createWorkloadSpin(WORKLOAD_SEED, 500)(),
	'embedded createWorkloadSpin diverged from src');

// Recording GL + digest, mirroring tests/calibration-workload.test.ts.
function createRecordingGl() {
	const calls = [];
	let objectCounter = 0;
	let constantCounter = 1;
	const constants = new Map();
	const attribLocations = new Map();
	const serializeArg = value => {
		if (value instanceof Float32Array || value instanceof Uint16Array || value instanceof Uint8Array) {
			let hash = 0;
			for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ Math.round(value[index] * 1_000), 0x01000193) >>> 0;
			return `${value.constructor.name}(${value.length}):${hash}`;
		}
		if (typeof value === 'object' && value !== null) return value.id ?? String(value);
		return value;
	};
	const gl = new Proxy({}, {
		get(_ignored, property) {
			if (typeof property !== 'string') return undefined;
			if (/^[A-Z0-9_]+$/u.test(property)) {
				if (!constants.has(property)) constants.set(property, constantCounter++);
				return constants.get(property);
			}
			return (...args) => {
				calls.push({ args: args.map(serializeArg), method: property });
				if (property === 'createShader' || property === 'createProgram' || property === 'createBuffer' || property === 'createTexture') {
					return { id: `${property}#${objectCounter++}` };
				}
				if (property === 'getShaderParameter' || property === 'getProgramParameter') return true;
				if (property === 'getUniformLocation') return { id: `uniform:${serializeArg(args[0])}:${String(args[1])}` };
				if (property === 'getAttribLocation') {
					const key = String(args[1]);
					if (!attribLocations.has(key)) attribLocations.set(key, attribLocations.size);
					return attribLocations.get(key);
				}
				return undefined;
			};
		}
	});
	return { calls, gl };
}

function commandStreamDigest(calls) {
	let hash = 0;
	for (const call of calls) {
		const serialized = `${call.method}(${JSON.stringify(call.args)})`;
		for (let index = 0; index < serialized.length; index++) hash = Math.imul(hash ^ serialized.charCodeAt(index), 0x01000193) >>> 0;
	}
	return hash.toString(16);
}

function renderDigest(createWorkloadImplementation) {
	const recording = createRecordingGl();
	const workload = createWorkloadImplementation(recording.gl, createWorkloadSpec(WORKLOAD_SEED), 1_920, 1_080);
	for (let frameIndex = 0; frameIndex < 2; frameIndex++) workload.renderFrame(frameIndex);
	return commandStreamDigest(recording.calls);
}

assert.equal(renderDigest(embedded.createWorkload), renderDigest(createWorkload),
	'the bundled trial page workload no longer emits the identical command stream as src');

// A null-GL trial exercises runBenchmarkTrial end-to-end, proving its BENCHMARK_* free
// variables all resolve inside the embedded script scope.
const trial = await embedded.runBenchmarkTrial({
	environment: { devicePixelRatio: 1, drawingBufferHeight: 0, drawingBufferWidth: 0 },
	getTimerQueryExt: () => null,
	gl: null,
	now: () => 0,
	renderFrame: () => {},
	requestFrame: () => {},
	spin: () => 0,
	startSampler: () => () => {},
	subscribeContamination: () => () => {},
	webglRenderer: ''
}, { benchmarkMs: 100, minSamples: 5, warmupMaxMs: 50, warmupMinMs: 10, warmupSettleFrames: 2, warmupSettleRatio: 3 });
assert.equal(trial.success, false);
assert.equal(trial.gpuTimingStatus, 'unsupported');

console.log(`verify-bundle: ok (${Object.keys(metafile.outputs).length} outputs; calibration chunk ${calibrationWindowOutput})`);
