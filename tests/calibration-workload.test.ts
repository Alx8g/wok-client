import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createEntitySimulation,
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
	BENCHMARK_GPU_SAMPLE_FRAME_INTERVAL,
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
				hash = Math.imul(hash ^ Math.round(value[index] * 1000), 0x01000193) >>> 0;
			}
			return `${value.constructor.name}(${value.length}):${hash}`;
		}
		if (typeof value === 'object' && value !== null)
			return (
				(
					value as {
						id?: string;
					}
				).id ?? String(value)
			);
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
function renderFrames(
	seed: number,
	frameCount: number
): {
	digest: string;
	drawCalls: number;
	perFrame: RecordedCall[][];
} {
	const recording = createRecordingGl();
	const workload = createWorkload(recording.gl, createWorkloadSpec(seed), 1920, 1080);
	const perFrame: RecordedCall[][] = [];
	for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
		const before = recording.calls.length;
		workload.renderFrame(frameIndex);
		perFrame.push(recording.calls.slice(before));
	}
	return { digest: commandStreamDigest(recording.calls), drawCalls: workload.drawCallsPerFrame, perFrame };
}
test('workload v4 constants match the frozen design table', () => {
	assert.equal(WORKLOAD_VERSION, 4);
	assert.equal(WORKLOAD_DRAWS_PER_FRAME, 23);
	assert.equal(WORKLOAD_CONSTANTS.opaqueDraws, 12);
	assert.equal(WORKLOAD_CONSTANTS.opaqueProgramSwitches, 7);
	assert.equal(WORKLOAD_CONSTANTS.opaqueTextureBinds, 10);
	assert.equal(WORKLOAD_CONSTANTS.transparentDraws, 6);
	assert.equal(WORKLOAD_CONSTANTS.transparentProgramSwitches, 2);
	assert.equal(WORKLOAD_CONSTANTS.transparentTextureBinds, 3);
	assert.equal(WORKLOAD_CONSTANTS.uiDraws, 2);
	assert.equal(WORKLOAD_CONSTANTS.sceneTextureCount, 8);
	assert.equal(WORKLOAD_CONSTANTS.sceneTextureSize, 256);
	assert.equal(WORKLOAD_CONSTANTS.atlasTextureSize, 1024);
	assert.equal(WORKLOAD_CONSTANTS.heightfieldSize, 64);
	assert.equal(WORKLOAD_CONSTANTS.warmupMinMs, 3000);
	assert.equal(WORKLOAD_CONSTANTS.warmupMaxMs, 5000);
	assert.equal(WORKLOAD_CONSTANTS.warmupSettleFrames, 30);
	assert.equal(WORKLOAD_CONSTANTS.warmupSettleRatio, 3);
	assert.equal(WORKLOAD_CONSTANTS.entityCount, 12288);
	assert.equal(WORKLOAD_CONSTANTS.entitySubsteps, 4);
	assert.equal(WORKLOAD_CONSTANTS.entityNeighborChecks, 24576);
	assert.equal(WORKLOAD_CONSTANTS.jsSpinIterations, 160000);
	assert.equal(WORKLOAD_CONSTANTS.submissionDraws, 3);
	assert.equal(WORKLOAD_CONSTANTS.submissionProgramSwitches, 3);
	assert.equal(WORKLOAD_CONSTANTS.submissionTextureBinds, 3);
	assert.equal(WORKLOAD_CONSTANTS.streamChunkBytes, 4096);
	assert.equal(WORKLOAD_CONSTANTS.streamChunksPerFrame, 3);
	assert.equal(WORKLOAD_SHADER_SOURCES.length, 10);
	assert.deepEqual(
		WORKLOAD_SHADER_SOURCES.map((shader) => shader.name),
		['lit-textured', 'unlit-textured', 'vertex-color', 'skybox', 'transparent-soft', 'transparent-additive', 'ui-quad', 'post-tint', 'sprite', 'sprite-additive']
	);
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
	const recordingA = createRecordingGl();
	const workloadA = createWorkload(recordingA.gl, createWorkloadSpec(WORKLOAD_SEED), 1920, 1080);
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
test('per-frame command stream reproduces the measured Krunker census exactly', () => {
	const { drawCalls, perFrame } = renderFrames(WORKLOAD_SEED, 2);
	assert.equal(drawCalls, WORKLOAD_DRAWS_PER_FRAME);
	const MEASURED_DRAWS = 23;
	const MEASURED_PROGRAM_SWITCHES = 17;
	const MEASURED_TEXTURE_BINDS = 20;
	const expectedSwitches = 5 + WORKLOAD_CONSTANTS.opaqueProgramSwitches + WORKLOAD_CONSTANTS.transparentProgramSwitches + WORKLOAD_CONSTANTS.submissionProgramSwitches;
	const expectedBinds = 4 + WORKLOAD_CONSTANTS.opaqueTextureBinds + WORKLOAD_CONSTANTS.transparentTextureBinds + WORKLOAD_CONSTANTS.submissionTextureBinds;
	assert.equal(expectedSwitches, MEASURED_PROGRAM_SWITCHES);
	assert.equal(expectedBinds, MEASURED_TEXTURE_BINDS);
	assert.equal(WORKLOAD_DRAWS_PER_FRAME, MEASURED_DRAWS);
	for (const frame of perFrame) {
		const count = (method: string) => frame.filter((call) => call.method === method).length;
		assert.equal(count('drawElements') + count('drawArrays'), MEASURED_DRAWS);
		assert.equal(count('useProgram'), MEASURED_PROGRAM_SWITCHES);
		assert.equal(count('bindTexture'), MEASURED_TEXTURE_BINDS);
		const programsUsed = new Set(frame.filter((call) => call.method === 'useProgram').map((call) => String(call.args[0])));
		assert.equal(programsUsed.size, WORKLOAD_SHADER_SOURCES.length, `expected every program to be used, got ${programsUsed.size}`);
		assert.ok(count('depthMask') >= 2);
		assert.ok(count('enable') + count('disable') >= 4);
		assert.ok(count('blendFunc') >= 4, `expected blend-func churn, got ${count('blendFunc')}`);
		assert.ok(count('uniformMatrix4fv') >= WORKLOAD_DRAWS_PER_FRAME);
		assert.ok(count('uniform4f') >= WORKLOAD_DRAWS_PER_FRAME);
	}
});
test('the sprite lane streams vertex data and switches state per draw', () => {
	const { perFrame } = renderFrames(WORKLOAD_SEED, 2);
	for (const frame of perFrame) {
		const count = (method: string) => frame.filter((call) => call.method === method).length;
		assert.equal(count('bufferSubData'), WORKLOAD_CONSTANTS.streamChunksPerFrame);
		assert.equal(count('drawArrays'), 3 + WORKLOAD_CONSTANTS.uiDraws + WORKLOAD_CONSTANTS.submissionDraws);
	}
	const uploads = (frame: RecordedCall[]) => frame.filter((call) => call.method === 'bufferSubData').map((call) => call.args);
	assert.notDeepEqual(uploads(perFrame[0]), uploads(perFrame[1]));
});
test('static resources are game-shaped: programs, meshes, and seeded textures', () => {
	const recording = createRecordingGl();
	createWorkload(recording.gl, createWorkloadSpec(WORKLOAD_SEED), 1920, 1080);
	const creations = recording.calls.filter((call) => call.method === 'createProgram').length;
	assert.equal(creations, 10);
	const textures = recording.calls.filter((call) => call.method === 'createTexture').length;
	assert.equal(textures, WORKLOAD_CONSTANTS.sceneTextureCount + 1);
	const mipmaps = recording.calls.filter((call) => call.method === 'generateMipmap').length;
	assert.equal(mipmaps, WORKLOAD_CONSTANTS.sceneTextureCount);
	const buffers = recording.calls.filter((call) => call.method === 'createBuffer').length;
	assert.ok(buffers >= WORKLOAD_CONSTANTS.meshVariants, 'expected static VBOs per mesh variant');
});
test('serialized modules evaluate as plain JavaScript exactly as the trial page embeds them', async () => {
	const constants: Record<string, unknown> = {
		BENCHMARK_EVENT_LOOP_SAMPLE_MS,
		BENCHMARK_FENCE_QUEUE_DEPTH,
		BENCHMARK_FENCE_RING_SIZE,
		BENCHMARK_GPU_DISJOINT_DEMOTION_RATIO,
		BENCHMARK_GPU_IMPLAUSIBLE_DEMOTION_RATIO,
		BENCHMARK_GPU_QUERY_POOL_SIZE,
		BENCHMARK_GPU_QUEUE_CONTAMINATION_FLAG,
		BENCHMARK_GPU_QUEUE_FLAG_RATIO,
		BENCHMARK_GPU_SAMPLE_FRAME_INTERVAL,
		BENCHMARK_GPU_SAMPLE_MAX_FRAME_RATIO,
		BENCHMARK_GPU_SAMPLE_MIN_MS,
		BENCHMARK_LONG_FRAME_MS,
		BENCHMARK_SEVERE_EVENT_LOOP_DELAY_MS
	};
	const script = `'use strict';
		${Object.entries(constants)
			.map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`)
			.join('\n')}
		const mulberry32 = ${mulberry32.toString()};
		const createWorkload = ${createWorkload.toString()};
		const createEntitySimulation = ${createEntitySimulation.toString()};
		const createWorkloadSpin = ${createWorkloadSpin.toString()};
		const runBenchmarkTrial = ${runBenchmarkTrial.toString()};
		return { createEntitySimulation, createWorkload, createWorkloadSpin, mulberry32, runBenchmarkTrial };`;
	const evaluated = new Function(script)() as {
		createEntitySimulation: typeof createEntitySimulation;
		createWorkload: typeof createWorkload;
		createWorkloadSpin: typeof createWorkloadSpin;
		mulberry32: typeof mulberry32;
		runBenchmarkTrial: typeof runBenchmarkTrial;
	};
	assert.equal(evaluated.mulberry32(123)(), mulberry32(123)());
	assert.equal(evaluated.createWorkloadSpin(WORKLOAD_SEED, 500)(), createWorkloadSpin(WORKLOAD_SEED, 500)());
	const serializedSimulation = evaluated.createEntitySimulation(WORKLOAD_SEED, 64, 2, 128);
	const moduleSimulation = createEntitySimulation(WORKLOAD_SEED, 64, 2, 128);
	for (let frame = 0; frame < 3; frame++) assert.equal(serializedSimulation(), moduleSimulation());
	const moduleRender = renderFrames(WORKLOAD_SEED, 2);
	const recording = createRecordingGl();
	const serializedWorkload = evaluated.createWorkload(recording.gl, createWorkloadSpec(WORKLOAD_SEED), 1920, 1080);
	const perFrame: RecordedCall[][] = [];
	for (let frameIndex = 0; frameIndex < 2; frameIndex++) {
		const before = recording.calls.length;
		serializedWorkload.renderFrame(frameIndex);
		perFrame.push(recording.calls.slice(before));
	}
	assert.equal(serializedWorkload.drawCallsPerFrame, WORKLOAD_DRAWS_PER_FRAME);
	assert.equal(commandStreamDigest(recording.calls), moduleRender.digest, 'serialized workload must emit the identical command stream');
	assert.equal(perFrame.length, 2);
	const trial = await evaluated.runBenchmarkTrial(
		{
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
		},
		{ benchmarkMs: 100, minSamples: 5, warmupMaxMs: 50, warmupMinMs: 10, warmupSettleFrames: 2, warmupSettleRatio: 3 }
	);
	assert.equal(trial.success, false);
	assert.equal(trial.gpuTimingStatus, 'unsupported');
});
test('the fixed-iteration spin is deterministic and stable across instances', () => {
	const first = createWorkloadSpin(WORKLOAD_SEED, 1000);
	const second = createWorkloadSpin(WORKLOAD_SEED, 1000);
	assert.equal(first(), second());
	assert.equal(first(), second());
	assert.notEqual(createWorkloadSpin(WORKLOAD_SEED, 1000)(), createWorkloadSpin(WORKLOAD_SEED + 1, 1000)());
});
test('the main-thread entity lane is deterministic, seeded, and fixed in iteration count', () => {
	const first = createEntitySimulation(WORKLOAD_SEED, 256, 2, 512);
	const second = createEntitySimulation(WORKLOAD_SEED, 256, 2, 512);
	for (let frame = 0; frame < 8; frame++) assert.equal(first(), second());
	assert.notEqual(createEntitySimulation(WORKLOAD_SEED, 256, 2, 512)(), createEntitySimulation(WORKLOAD_SEED + 1, 256, 2, 512)());
	const source = String(createEntitySimulation);
	assert.doesNotMatch(source, /performance\s*\.\s*now/u);
	assert.doesNotMatch(source, /Date\s*\.\s*now/u);
	assert.doesNotMatch(source, /new\s+Date/u);
	assert.doesNotMatch(source, /while\s*\(/u);
	const perFrameBody = source.slice(source.indexOf('return () => {'));
	assert.doesNotMatch(perFrameBody, /new\s+[A-Z]/u);
	assert.doesNotMatch(perFrameBody, /\.push\(/u);
});
test('the entity lane stays in normal float range over a long trial', () => {
	const simulate = createEntitySimulation(WORKLOAD_SEED, 512, 3, 1024);
	let accumulator = 0;
	for (let frame = 0; frame < 800; frame++) accumulator += simulate();
	assert.ok(Number.isFinite(accumulator), 'entity lane accumulator must stay finite');
	assert.ok(accumulator !== 0, 'entity lane must produce work the caller can sink');
});
