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

test('workload v3 constants match the frozen design table', () => {
	assert.equal(WORKLOAD_VERSION, 3);
	// Batched-engine draw budget, not a draw-call stress test: v2's 1,000 draws/frame cost 3x the
	// real frame budget in GPU time on the reference machine and ranked the backends backwards.
	assert.equal(WORKLOAD_DRAWS_PER_FRAME, 100);
	assert.equal(WORKLOAD_CONSTANTS.opaqueDraws, 50);
	assert.equal(WORKLOAD_CONSTANTS.transparentDraws, 14);
	assert.equal(WORKLOAD_CONSTANTS.uiDraws, 10);
	assert.equal(WORKLOAD_CONSTANTS.programSwitchInterval, 12);
	// GPU-lane resources: the WORKLOAD_VERSION 1 freeze, carried unchanged.
	assert.equal(WORKLOAD_CONSTANTS.sceneTextureCount, 8);
	assert.equal(WORKLOAD_CONSTANTS.sceneTextureSize, 256);
	assert.equal(WORKLOAD_CONSTANTS.atlasTextureSize, 1_024);
	assert.equal(WORKLOAD_CONSTANTS.heightfieldSize, 64);
	// Warmup reaches steady state: below this, a backend's one-time pipeline-state creation and
	// the GPU's clock ramp land inside the measured window (v3-iterations.md, sweep D).
	assert.equal(WORKLOAD_CONSTANTS.warmupMinMs, 3_000);
	assert.equal(WORKLOAD_CONSTANTS.warmupMaxMs, 5_000);
	assert.equal(WORKLOAD_CONSTANTS.warmupSettleFrames, 30);
	assert.equal(WORKLOAD_CONSTANTS.warmupSettleRatio, 3);
	// Main-thread lane: the v3 addition. Fixed iteration counts, never a time budget.
	assert.equal(WORKLOAD_CONSTANTS.entityCount, 12_288);
	assert.equal(WORKLOAD_CONSTANTS.entitySubsteps, 4);
	assert.equal(WORKLOAD_CONSTANTS.entityNeighborChecks, 24_576);
	assert.equal(WORKLOAD_CONSTANTS.jsSpinIterations, 160_000);
	// Sprite/state-churn lane: material-batch churn intervals, not v2's every-2/every-4 torture test.
	assert.equal(WORKLOAD_CONSTANTS.submissionDraws, 26);
	assert.equal(WORKLOAD_CONSTANTS.submissionProgramSwitchInterval, 6);
	assert.equal(WORKLOAD_CONSTANTS.submissionTextureBindInterval, 4);
	assert.equal(WORKLOAD_CONSTANTS.submissionBlendToggleInterval, 8);
	assert.equal(WORKLOAD_CONSTANTS.streamChunkBytes, 4_096);
	assert.equal(WORKLOAD_CONSTANTS.streamChunksPerFrame, 8);
	assert.equal(WORKLOAD_SHADER_SOURCES.length, 10);
	assert.deepEqual(WORKLOAD_SHADER_SOURCES.map(shader => shader.name), [
		'lit-textured',
		'unlit-textured',
		'vertex-color',
		'skybox',
		'transparent-soft',
		'transparent-additive',
		'ui-quad',
		'post-tint',
		'sprite',
		'sprite-additive'
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

	const laneProgramSwitches = Math.ceil(WORKLOAD_CONSTANTS.submissionDraws / WORKLOAD_CONSTANTS.submissionProgramSwitchInterval);
	const laneTextureBinds = Math.ceil(WORKLOAD_CONSTANTS.submissionDraws / WORKLOAD_CONSTANTS.submissionTextureBindInterval);
	for (const frame of perFrame) {
		const count = (method: string) => frame.filter(call => call.method === method).length;
		assert.equal(count('drawElements') + count('drawArrays'), WORKLOAD_DRAWS_PER_FRAME);
		// Every one of the ten programs is exercised each frame, and the switching happens at
		// material-batch granularity: the scene lane switches once per programSwitchInterval
		// opaque draws plus once per pass boundary, and the sprite lane adds its churn on top.
		const programsUsed = new Set(frame.filter(call => call.method === 'useProgram').map(call => String(call.args[0])));
		assert.equal(programsUsed.size, WORKLOAD_SHADER_SOURCES.length, `expected every program to be used, got ${programsUsed.size}`);
		// Scene-lane switches: one per programSwitchInterval opaque draws, plus at most a handful
		// of pass boundaries (skybox, heightfield, transparent, fullscreen, post, UI).
		const sceneProgramSwitches = Math.ceil((WORKLOAD_CONSTANTS.opaqueDraws - 2) / WORKLOAD_CONSTANTS.programSwitchInterval);
		const programSwitches = count('useProgram');
		assert.ok(programSwitches >= sceneProgramSwitches + laneProgramSwitches, `expected lane program churn, got ${programSwitches}`);
		assert.ok(programSwitches <= sceneProgramSwitches + laneProgramSwitches + 12, `program switches out of band: ${programSwitches}`);
		// Scene-lane texture binds: one per textureBindInterval opaque draws plus the pass
		// boundaries; the sprite lane adds one per submissionTextureBindInterval draws.
		const sceneTextureBinds = Math.ceil((WORKLOAD_CONSTANTS.opaqueDraws - 2) / WORKLOAD_CONSTANTS.textureBindInterval);
		const textureBinds = frame.filter(call => call.method === 'bindTexture').length;
		assert.ok(
			textureBinds >= sceneTextureBinds + laneTextureBinds && textureBinds <= sceneTextureBinds + laneTextureBinds + 12,
			`texture binds out of band: ${textureBinds}`
		);
		// Blend and depth-mask state toggles happen (blend on/off + UI, depth-mask off/on, plus
		// the submission lane's blend toggling).
		assert.ok(count('depthMask') >= 2);
		assert.ok(count('enable') + count('disable') >= 4);
		// Per-draw uniform uploads: a mat4 model matrix and a vec4 tint for every draw.
		assert.ok(count('uniformMatrix4fv') >= WORKLOAD_DRAWS_PER_FRAME);
		assert.ok(count('uniform4f') >= WORKLOAD_DRAWS_PER_FRAME);
	}
});

test('the v3 sprite lane streams vertex data and churns state at the tuned intervals', () => {
	const { perFrame } = renderFrames(WORKLOAD_SEED, 2);

	for (const frame of perFrame) {
		const count = (method: string) => frame.filter(call => call.method === method).length;
		// Per-frame bufferSubData streaming: exactly one upload per chunk, covering the buffer.
		assert.equal(count('bufferSubData'), WORKLOAD_CONSTANTS.streamChunksPerFrame);
		// drawArrays covers the fullscreen layers (3), the UI quads, and every sprite draw.
		assert.equal(count('drawArrays'), 3 + WORKLOAD_CONSTANTS.uiDraws + WORKLOAD_CONSTANTS.submissionDraws);
		// Blend enable/disable alternates between lane blocks: real blend-state churn, not a
		// single set-and-forget (about one toggle per two blocks, both directions exercised).
		const laneBlocks = Math.ceil(WORKLOAD_CONSTANTS.submissionDraws / WORKLOAD_CONSTANTS.submissionBlendToggleInterval);
		assert.ok(count('enable') + count('disable') >= laneBlocks - 2, `expected lane blend toggling, got ${count('enable')}e/${count('disable')}d`);
		assert.ok(count('blendFunc') >= laneBlocks / 2, `expected lane blend-func flips, got ${count('blendFunc')}`);
	}

	// The stream is live: the uploaded chunk contents must differ frame-to-frame, so a backend
	// cannot satisfy the lane by caching the first upload.
	const uploads = (frame: RecordedCall[]) => frame.filter(call => call.method === 'bufferSubData').map(call => call.args);
	assert.notDeepEqual(uploads(perFrame[0]), uploads(perFrame[1]));
});

test('static resources are game-shaped: programs, meshes, and seeded textures', () => {
	const recording = createRecordingGl();
	createWorkload(recording.gl, createWorkloadSpec(WORKLOAD_SEED), 1_920, 1_080);
	const creations = recording.calls.filter(call => call.method === 'createProgram').length;
	assert.equal(creations, 10);
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
		BENCHMARK_GPU_SAMPLE_FRAME_INTERVAL,
		BENCHMARK_GPU_SAMPLE_MAX_FRAME_RATIO,
		BENCHMARK_GPU_SAMPLE_MIN_MS,
		BENCHMARK_LONG_FRAME_MS,
		BENCHMARK_SEVERE_EVENT_LOOP_DELAY_MS
	};
	const script = `'use strict';
		${Object.entries(constants).map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`).join('\n')}
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

test('the main-thread entity lane is deterministic, seeded, and fixed in iteration count', () => {
	const first = createEntitySimulation(WORKLOAD_SEED, 256, 2, 512);
	const second = createEntitySimulation(WORKLOAD_SEED, 256, 2, 512);
	for (let frame = 0; frame < 8; frame++) assert.equal(first(), second());
	assert.notEqual(
		createEntitySimulation(WORKLOAD_SEED, 256, 2, 512)(),
		createEntitySimulation(WORKLOAD_SEED + 1, 256, 2, 512)()
	);

	// Machine-independent work: the lane is sized by constants, never by a wall-clock budget, so
	// a faster machine finishes the same iterations sooner instead of running more of them.
	const source = String(createEntitySimulation);
	assert.doesNotMatch(source, /performance\s*\.\s*now/u);
	assert.doesNotMatch(source, /Date\s*\.\s*now/u);
	assert.doesNotMatch(source, /new\s+Date/u);
	assert.doesNotMatch(source, /while\s*\(/u);

	// Allocation-free after construction: the per-frame body must not build objects, or the lane
	// would measure garbage collection instead of entity math.
	const perFrameBody = source.slice(source.indexOf('return () => {'));
	assert.doesNotMatch(perFrameBody, /new\s+[A-Z]/u);
	assert.doesNotMatch(perFrameBody, /\.push\(/u);
});

test('the entity lane stays in normal float range over a long trial', () => {
	const simulate = createEntitySimulation(WORKLOAD_SEED, 512, 3, 1_024);
	// A 2.8 s trial at 250 fps is ~700 frames; drift into denormals or infinities would make the
	// lane's cost machine-dependent and its results incomparable.
	let accumulator = 0;
	for (let frame = 0; frame < 800; frame++) accumulator += simulate();
	assert.ok(Number.isFinite(accumulator), 'entity lane accumulator must stay finite');
	assert.ok(accumulator !== 0, 'entity lane must produce work the caller can sink');
});
