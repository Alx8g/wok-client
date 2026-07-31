import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createWorkload,
	createWorkloadSpec,
	createWorkloadSpin,
	mulberry32,
	WORKLOAD_CONSTANTS,
	WORKLOAD_CONTEXT_ATTRIBUTES,
	WORKLOAD_DRAWS_PER_FRAME,
	WORKLOAD_SEED,
	WORKLOAD_SHADER_SOURCES,
	WORKLOAD_VERSION,
	type WorkloadGl
} from '../src/calibration-workload.ts';
import {
	BENCHMARK_EVENT_LOOP_SAMPLE_MS,
	BENCHMARK_FENCE_QUEUE_DEPTH,
	BENCHMARK_FENCE_RING_SIZE,
	BENCHMARK_GPU_DISJOINT_DEMOTION_RATIO,
	BENCHMARK_GPU_IMPLAUSIBLE_DEMOTION_RATIO,
	BENCHMARK_GPU_QUERY_POOL_SIZE,
	BENCHMARK_GPU_QUEUE_CONTAMINATION_FLAG,
	BENCHMARK_GPU_QUEUE_FLAG_RATIO,
	BENCHMARK_GPU_SAMPLE_MAX_FRAME_RATIO,
	BENCHMARK_GPU_SAMPLE_MIN_MS,
	BENCHMARK_LONG_FRAME_MS,
	BENCHMARK_SEVERE_EVENT_LOOP_DELAY_MS,
	runBenchmarkTrial
} from '../src/calibration-benchmark.ts';

interface RecordedCall {
	args: unknown[];
	method: string;
}

interface RecordingGl {
	calls: RecordedCall[];
	gl: WorkloadGl;
}

function createRecordingGl(): RecordingGl {
	const calls: RecordedCall[] = [];
	let objectCounter = 0;
	let constantCounter = 1;
	const constants = new Map<string, number>();
	const attribLocations = new Map<string, number>();

	const serializeArg = (value: unknown): unknown => {
		if (value instanceof Float32Array || value instanceof Uint16Array || value instanceof Uint8Array) {
			let hash = 0;
			for (let index = 0; index < value.length; index++) {
				hash = Math.imul(hash ^ Math.round(value[index] * 1_000), 0x01000193) >>> 0;
			}
			return `${value.constructor.name}(${value.length}):${hash}`;
		}
		if (typeof value === 'object' && value !== null) return (value as { id?: string }).id ?? String(value);
		return value;
	};

	const record = (method: string, args: unknown[]) => {
		calls.push({ args: args.map(serializeArg), method });
	};

	const target: Record<string, unknown> = {};
	const gl = new Proxy(target, {
		get(_ignored, property: string) {
			if (typeof property !== 'string') return undefined;
			if (/^[A-Z0-9_]+$/u.test(property)) {
				if (!constants.has(property)) constants.set(property, constantCounter++);
				return constants.get(property);
			}
			return (...args: unknown[]) => {
				record(property, args);
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
	}) as unknown as WorkloadGl;
	return { calls, gl };
}

function commandStreamDigest(calls: RecordedCall[]): string {
	let hash = 0;
	for (const call of calls) {
		const serialized = `${call.method}(${JSON.stringify(call.args)})`;
		for (let index = 0; index < serialized.length; index++) {
			hash = Math.imul(hash ^ serialized.charCodeAt(index), 0x01000193) >>> 0;
		}
	}
	return hash.toString(16);
}

function renderFrames(seed: number, frameCount: number): { digest: string; drawCalls: number; perFrame: RecordedCall[][] } {
	const recording = createRecordingGl();
	const workload = createWorkload(recording.gl, createWorkloadSpec(seed), 1_920, 1_080);
	const perFrame: RecordedCall[][] = [];
	for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
		const before = recording.calls.length;
		workload.renderFrame(frameIndex);
		perFrame.push(recording.calls.slice(before));
	}
	return { digest: commandStreamDigest(recording.calls), drawCalls: workload.drawCallsPerFrame, perFrame };
}

test('workload v1 constants match the frozen design table', () => {
	assert.equal(WORKLOAD_VERSION, 1);
	assert.equal(WORKLOAD_DRAWS_PER_FRAME, 300);
	assert.equal(WORKLOAD_CONSTANTS.opaqueDraws, 240);
	assert.equal(WORKLOAD_CONSTANTS.transparentDraws, 44);
	assert.equal(WORKLOAD_CONSTANTS.uiDraws, 16);
	assert.equal(WORKLOAD_CONSTANTS.sceneTextureCount, 8);
	assert.equal(WORKLOAD_CONSTANTS.sceneTextureSize, 256);
	assert.equal(WORKLOAD_CONSTANTS.atlasTextureSize, 1_024);
	assert.equal(WORKLOAD_CONSTANTS.heightfieldSize, 64);
	assert.equal(WORKLOAD_CONSTANTS.jsSpinIterations, 2_560_000);
	assert.equal(WORKLOAD_CONSTANTS.warmupMinMs, 900);
	assert.equal(WORKLOAD_CONSTANTS.warmupMaxMs, 2_000);
	assert.equal(WORKLOAD_CONSTANTS.warmupSettleFrames, 30);
	assert.equal(WORKLOAD_CONSTANTS.warmupSettleRatio, 3);
	assert.equal(WORKLOAD_SHADER_SOURCES.length, 8);
	assert.deepEqual(WORKLOAD_SHADER_SOURCES.map(shader => shader.name), [
		'lit-textured',
		'unlit-textured',
		'vertex-color',
		'skybox',
		'transparent-soft',
		'transparent-additive',
		'ui-quad',
		'post-tint'
	]);
});

test('workload context attributes are game-like and avoid desynchronized present', () => {
	assert.equal(WORKLOAD_CONTEXT_ATTRIBUTES.desynchronized, false);
	assert.equal(WORKLOAD_CONTEXT_ATTRIBUTES.depth, true);
	assert.equal(WORKLOAD_CONTEXT_ATTRIBUTES.stencil, false);
	assert.equal(WORKLOAD_CONTEXT_ATTRIBUTES.alpha, false);
	assert.equal(WORKLOAD_CONTEXT_ATTRIBUTES.antialias, false);
	assert.equal(WORKLOAD_CONTEXT_ATTRIBUTES.powerPreference, 'high-performance');
	assert.equal(WORKLOAD_CONTEXT_ATTRIBUTES.preserveDrawingBuffer, false);
	assert.equal(WORKLOAD_CONTEXT_ATTRIBUTES.failIfMajorPerformanceCaveat, false);
});

test('same seed produces an identical command stream frame-for-frame', () => {
	const first = renderFrames(WORKLOAD_SEED, 4);
	const second = renderFrames(WORKLOAD_SEED, 4);
	assert.equal(first.digest, second.digest);
	assert.notEqual(first.digest, renderFrames(WORKLOAD_SEED ^ 0xff, 4).digest);
});

test('animation is frame-index-driven with no wall-clock reads in the command path', () => {
	const source = String(createWorkload) + String(mulberry32);
	assert.doesNotMatch(source, /performance\s*\.\s*now/u);
	assert.doesNotMatch(source, /Date\s*\.\s*now/u);
	assert.doesNotMatch(source, /new\s+Date/u);
	assert.doesNotMatch(source, /requestAnimationFrame/u);

	// The same frame index replays identically; different frame indexes animate deterministically.
	const recordingA = createRecordingGl();
	const workloadA = createWorkload(recordingA.gl, createWorkloadSpec(WORKLOAD_SEED), 1_920, 1_080);
	const startFirst = recordingA.calls.length;
	workloadA.renderFrame(7);
	const firstRender = commandStreamDigest(recordingA.calls.slice(startFirst));
	const startSecond = recordingA.calls.length;
	workloadA.renderFrame(7);
	const secondRender = commandStreamDigest(recordingA.calls.slice(startSecond));
	assert.equal(firstRender, secondRender);
	const startThird = recordingA.calls.length;
	workloadA.renderFrame(8);
	assert.notEqual(commandStreamDigest(recordingA.calls.slice(startThird)), firstRender);
});

test('per-frame command stream matches the design lane shape', () => {
	const { drawCalls, perFrame } = renderFrames(WORKLOAD_SEED, 2);
	assert.equal(drawCalls, WORKLOAD_DRAWS_PER_FRAME);

	for (const frame of perFrame) {
		const count = (method: string) => frame.filter(call => call.method === method).length;
		assert.equal(count('drawElements') + count('drawArrays'), WORKLOAD_DRAWS_PER_FRAME);
		// All eight programs are exercised; switches stay far below draw count.
		const programSwitches = count('useProgram');
		assert.ok(programSwitches >= 8, `expected at least 8 program switches, got ${programSwitches}`);
		assert.ok(programSwitches <= 60, `expected coarse program batching, got ${programSwitches} switches`);
		// Texture binds land in the measured ~64/frame band.
		const textureBinds = frame.filter(call => call.method === 'bindTexture').length;
		assert.ok(textureBinds >= 48 && textureBinds <= 90, `texture binds out of band: ${textureBinds}`);
		// Blend and depth-mask state toggles happen (blend on/off + UI, depth-mask off/on).
		assert.ok(count('depthMask') >= 2);
		assert.ok(count('enable') + count('disable') >= 4);
		// Per-draw uniform uploads: a mat4 model matrix and a vec4 tint for every draw.
		assert.ok(count('uniformMatrix4fv') >= WORKLOAD_DRAWS_PER_FRAME);
		assert.ok(count('uniform4f') >= WORKLOAD_DRAWS_PER_FRAME);
	}
});

test('static resources are game-shaped: programs, meshes, and seeded textures', () => {
	const recording = createRecordingGl();
	createWorkload(recording.gl, createWorkloadSpec(WORKLOAD_SEED), 1_920, 1_080);
	const creations = recording.calls.filter(call => call.method === 'createProgram').length;
	assert.equal(creations, 8);
	const textures = recording.calls.filter(call => call.method === 'createTexture').length;
	assert.equal(textures, WORKLOAD_CONSTANTS.sceneTextureCount + 1);
	const mipmaps = recording.calls.filter(call => call.method === 'generateMipmap').length;
	assert.equal(mipmaps, WORKLOAD_CONSTANTS.sceneTextureCount);
	const buffers = recording.calls.filter(call => call.method === 'createBuffer').length;
	assert.ok(buffers >= WORKLOAD_CONSTANTS.meshVariants, 'expected static VBOs per mesh variant');
});

test('serialized modules evaluate as plain JavaScript exactly as the trial page embeds them', async () => {
	// The page embeds these functions via .toString() after Node/Electron type stripping; this
	// proves the serialized sources are valid JS and behave identically to the imported modules.
	const constants: Record<string, unknown> = {
		BENCHMARK_EVENT_LOOP_SAMPLE_MS,
		BENCHMARK_FENCE_QUEUE_DEPTH,
		BENCHMARK_FENCE_RING_SIZE,
		BENCHMARK_GPU_DISJOINT_DEMOTION_RATIO,
		BENCHMARK_GPU_IMPLAUSIBLE_DEMOTION_RATIO,
		BENCHMARK_GPU_QUERY_POOL_SIZE,
		BENCHMARK_GPU_QUEUE_CONTAMINATION_FLAG,
		BENCHMARK_GPU_QUEUE_FLAG_RATIO,
		BENCHMARK_GPU_SAMPLE_MAX_FRAME_RATIO,
		BENCHMARK_GPU_SAMPLE_MIN_MS,
		BENCHMARK_LONG_FRAME_MS,
		BENCHMARK_SEVERE_EVENT_LOOP_DELAY_MS
	};
	const script = `'use strict';
		${Object.entries(constants).map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`).join('\n')}
		const mulberry32 = ${mulberry32.toString()};
		const createWorkload = ${createWorkload.toString()};
		const createWorkloadSpin = ${createWorkloadSpin.toString()};
		const runBenchmarkTrial = ${runBenchmarkTrial.toString()};
		return { createWorkload, createWorkloadSpin, mulberry32, runBenchmarkTrial };`;
	const evaluated = new Function(script)() as {
		createWorkload: typeof createWorkload;
		createWorkloadSpin: typeof createWorkloadSpin;
		mulberry32: typeof mulberry32;
		runBenchmarkTrial: typeof runBenchmarkTrial;
	};

	assert.equal(evaluated.mulberry32(123)(), mulberry32(123)());
	assert.equal(evaluated.createWorkloadSpin(WORKLOAD_SEED, 500)(), createWorkloadSpin(WORKLOAD_SEED, 500)());

	const moduleRender = renderFrames(WORKLOAD_SEED, 2);
	const recording = createRecordingGl();
	const serializedWorkload = evaluated.createWorkload(recording.gl, createWorkloadSpec(WORKLOAD_SEED), 1_920, 1_080);
	const perFrame: RecordedCall[][] = [];
	for (let frameIndex = 0; frameIndex < 2; frameIndex++) {
		const before = recording.calls.length;
		serializedWorkload.renderFrame(frameIndex);
		perFrame.push(recording.calls.slice(before));
	}
	assert.equal(serializedWorkload.drawCallsPerFrame, WORKLOAD_DRAWS_PER_FRAME);
	assert.equal(commandStreamDigest(recording.calls), moduleRender.digest, 'serialized workload must emit the identical command stream');
	assert.equal(perFrame.length, 2);

	const trial = await evaluated.runBenchmarkTrial({
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
});

test('the fixed-iteration spin is deterministic and stable across instances', () => {
	const first = createWorkloadSpin(WORKLOAD_SEED, 1_000);
	const second = createWorkloadSpin(WORKLOAD_SEED, 1_000);
	assert.equal(first(), second());
	assert.equal(first(), second());
	assert.notEqual(createWorkloadSpin(WORKLOAD_SEED, 1_000)(), createWorkloadSpin(WORKLOAD_SEED + 1, 1_000)());
});
