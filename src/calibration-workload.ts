/**
 * Calibration workload v1 (design §1): a deterministic, self-contained scene shaped like the
 * measured Krunker menu frame (draw-call count, state changes, texture binds, overdraw, JS spin,
 * DOM overlay handled by the page). The command stream is a pure function of (seed, frameIndex):
 * no wall-clock reads happen anywhere in the command path, so every trial replays the identical
 * stream frame-for-frame.
 *
 * The page generator embeds `mulberry32`, `createWorkload`, and `createWorkloadSpin` by function
 * serialization, so those functions must stay self-contained: they may reference each other by
 * name but must not capture any other module-level binding.
 */

export const WORKLOAD_VERSION = 1;
export const WORKLOAD_SEED = 0x574f4b31;

export interface CalibrationWorkloadConstants {
	atlasTextureSize: number;
	heightfieldSize: number;
	jsSpinIterations: number;
	meshVariants: number;
	opaqueDraws: number;
	prismMaxSides: number;
	prismMinSides: number;
	programSwitchInterval: number;
	sceneTextureCount: number;
	sceneTextureSize: number;
	textureBindInterval: number;
	transparentDraws: number;
	uiDraws: number;
	warmupMaxMs: number;
	warmupMinMs: number;
	warmupSettleFrames: number;
	warmupSettleRatio: number;
}

// Frozen as WORKLOAD_VERSION 1 after reference-machine lane tuning (design §1.4), measured on the
// Iris Xe reference machine with the WOK_CALIBRATION_TUNING=1 + WOK_TRACE_MS harness. Final lanes
// per workload frame across 3 consecutive runs: renderer-main busy 4.17/4.21/4.34 ms (gate 4-6),
// script 2.81/2.84/2.93 ms (menu lane 2.68 ms), GPU-main busy 3.66/3.72/3.81 ms (gate 3-5).
// Session record: .working/perf-round2/quiet-session.md. Any re-tune bumps WORKLOAD_VERSION.
export const WORKLOAD_CONSTANTS: CalibrationWorkloadConstants = {
	atlasTextureSize: 1_024,
	heightfieldSize: 64,
	jsSpinIterations: 2_560_000,
	meshVariants: 30,
	opaqueDraws: 240,
	prismMaxSides: 17,
	prismMinSides: 4,
	programSwitchInterval: 40,
	sceneTextureCount: 8,
	sceneTextureSize: 256,
	textureBindInterval: 4,
	transparentDraws: 44,
	uiDraws: 16,
	warmupMaxMs: 2_000,
	warmupMinMs: 900,
	warmupSettleFrames: 30,
	warmupSettleRatio: 3
};

export const WORKLOAD_DRAWS_PER_FRAME = WORKLOAD_CONSTANTS.opaqueDraws + WORKLOAD_CONSTANTS.transparentDraws + WORKLOAD_CONSTANTS.uiDraws;

// Frozen with WORKLOAD_VERSION 1. Matches game-like defaults; `desynchronized` is
// deliberately absent-equivalent (false) because Krunker does not use it and it changes the
// present path under comparison (audit C1).
export const WORKLOAD_CONTEXT_ATTRIBUTES = {
	alpha: false,
	antialias: false,
	depth: true,
	desynchronized: false,
	failIfMajorPerformanceCaveat: false,
	powerPreference: 'high-performance',
	preserveDrawingBuffer: false,
	stencil: false
} as const;

export interface WorkloadShaderSource {
	fragment: string;
	name: string;
	vertex: string;
}

const SHARED_VERTEX_SHADER = `attribute vec3 position; attribute vec3 normal; attribute vec2 uv;
uniform mat4 modelMatrix; uniform mat4 viewProjectionMatrix;
varying vec3 vNormal; varying vec2 vUv; varying vec3 vPosition;
void main() {
	vec4 world = modelMatrix * vec4(position, 1.0);
	vNormal = mat3(modelMatrix[0].xyz, modelMatrix[1].xyz, modelMatrix[2].xyz) * normal;
	vUv = uv;
	vPosition = world.xyz;
	gl_Position = viewProjectionMatrix * world;
}`;

const SCREEN_VERTEX_SHADER = `attribute vec3 position; attribute vec3 normal; attribute vec2 uv;
uniform mat4 modelMatrix;
varying vec3 vNormal; varying vec2 vUv;
void main() {
	vNormal = normal;
	vUv = uv;
	gl_Position = modelMatrix * vec4(position, 1.0);
}`;

// Eight programs (design §1.2): state-change translation (input layouts, sampler/blend state,
// root signatures on D3D11on12) is the largest backend differentiator ANGLE exercises.
export const WORKLOAD_SHADER_SOURCES: readonly WorkloadShaderSource[] = [
	{
		fragment: `precision mediump float; varying vec3 vNormal; varying vec2 vUv; varying vec3 vPosition;
uniform sampler2D map; uniform vec4 tint;
void main() {
	float light = 0.35 + 0.65 * max(0.0, dot(normalize(vNormal), normalize(vec3(0.4, 0.8, 0.45))));
	vec4 texel = texture2D(map, vUv);
	gl_FragColor = vec4(texel.rgb * tint.rgb * light, 1.0);
}`,
		name: 'lit-textured',
		vertex: SHARED_VERTEX_SHADER
	},
	{
		fragment: `precision mediump float; varying vec2 vUv;
uniform sampler2D map; uniform vec4 tint;
void main() { gl_FragColor = vec4(texture2D(map, vUv).rgb * tint.rgb, 1.0); }`,
		name: 'unlit-textured',
		vertex: SHARED_VERTEX_SHADER
	},
	{
		fragment: `precision mediump float; varying vec3 vNormal; varying vec2 vUv;
uniform vec4 tint;
void main() {
	vec3 pseudo = normalize(vNormal) * 0.5 + 0.5;
	gl_FragColor = vec4(pseudo * tint.rgb + vec3(vUv * 0.05, 0.0), 1.0);
}`,
		name: 'vertex-color',
		vertex: SHARED_VERTEX_SHADER
	},
	{
		fragment: `precision mediump float; varying vec3 vPosition;
uniform vec4 tint;
void main() {
	float height = clamp(vPosition.y * 0.002 + 0.5, 0.0, 1.0);
	gl_FragColor = vec4(mix(vec3(0.10, 0.11, 0.16), vec3(0.55, 0.68, 0.90), height) * tint.rgb, 1.0);
}`,
		name: 'skybox',
		vertex: SHARED_VERTEX_SHADER
	},
	{
		fragment: `precision mediump float; varying vec2 vUv;
uniform sampler2D map; uniform vec4 tint;
void main() {
	vec4 texel = texture2D(map, vUv);
	gl_FragColor = vec4(texel.rgb * tint.rgb, texel.a * tint.a);
}`,
		name: 'transparent-soft',
		vertex: SHARED_VERTEX_SHADER
	},
	{
		fragment: `precision mediump float; varying vec2 vUv;
uniform sampler2D map; uniform vec4 tint;
void main() { gl_FragColor = vec4(texture2D(map, vUv).rgb * tint.rgb * tint.a, 1.0); }`,
		name: 'transparent-additive',
		vertex: SHARED_VERTEX_SHADER
	},
	{
		fragment: `precision mediump float; varying vec2 vUv;
uniform sampler2D map; uniform vec4 tint;
void main() {
	vec4 texel = texture2D(map, vUv);
	gl_FragColor = vec4(texel.rgb * tint.rgb, texel.a * tint.a);
}`,
		name: 'ui-quad',
		vertex: SCREEN_VERTEX_SHADER
	},
	{
		fragment: `precision mediump float; varying vec2 vUv;
uniform vec4 tint;
void main() {
	float vignette = smoothstep(1.15, 0.35, length(vUv * 2.0 - 1.0));
	gl_FragColor = vec4(tint.rgb, tint.a * (1.0 - vignette * 0.6));
}`,
		name: 'post-tint',
		vertex: SCREEN_VERTEX_SHADER
	}
];

export interface WorkloadSpec {
	constants: CalibrationWorkloadConstants;
	seed: number;
	shaders: readonly WorkloadShaderSource[];
	version: number;
}

export function createWorkloadSpec(seed: number = WORKLOAD_SEED): WorkloadSpec {
	return {
		constants: WORKLOAD_CONSTANTS,
		seed,
		shaders: WORKLOAD_SHADER_SOURCES,
		version: WORKLOAD_VERSION
	};
}

export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Fixed-iteration JS spin (design §1.2): stands in for game-script main-thread work. A fixed
 * iteration count (not fixed wall-time) keeps work identical across candidates while faster
 * CPUs finish sooner. Returns an accumulator so callers can sink it against dead-code elimination.
 */
export function createWorkloadSpin(seed: number, iterations: number): () => number {
	let state = seed >>> 0;
	return () => {
		let accumulator = 0;
		let s = state;
		for (let step = 0; step < iterations; step++) {
			s = (s + 0x6d2b79f5) | 0;
			let t = Math.imul(s ^ (s >>> 15), 1 | s);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			accumulator += ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		}
		state = s >>> 0;
		return accumulator;
	};
}

type GlObject = unknown;

/** The WebGL surface the workload touches. Tests inject a recording fake; the page passes a real context. */
export interface WorkloadGl {
	ARRAY_BUFFER: number;
	BACK: number;
	BLEND: number;
	COMPILE_STATUS: number;
	CULL_FACE: number;
	COLOR_BUFFER_BIT: number;
	DEPTH_BUFFER_BIT: number;
	DEPTH_TEST: number;
	ELEMENT_ARRAY_BUFFER: number;
	FLOAT: number;
	FRAGMENT_SHADER: number;
	LEQUAL: number;
	LINEAR: number;
	LINEAR_MIPMAP_LINEAR: number;
	LINK_STATUS: number;
	NEAREST: number;
	ONE: number;
	ONE_MINUS_SRC_ALPHA: number;
	REPEAT: number;
	RGBA: number;
	SRC_ALPHA: number;
	STATIC_DRAW: number;
	TEXTURE0: number;
	TEXTURE_2D: number;
	TEXTURE_MAG_FILTER: number;
	TEXTURE_MIN_FILTER: number;
	TEXTURE_WRAP_S: number;
	TEXTURE_WRAP_T: number;
	TRIANGLES: number;
	UNSIGNED_BYTE: number;
	UNSIGNED_SHORT: number;
	VERTEX_SHADER: number;
	activeTexture(unit: number): void;
	attachShader(program: GlObject, shader: GlObject): void;
	bindBuffer(target: number, buffer: GlObject): void;
	bindTexture(target: number, texture: GlObject): void;
	blendFunc(source: number, destination: number): void;
	bufferData(target: number, data: ArrayBufferView, usage: number): void;
	clear(mask: number): void;
	clearColor(red: number, green: number, blue: number, alpha: number): void;
	compileShader(shader: GlObject): void;
	createBuffer(): GlObject;
	createProgram(): GlObject;
	createShader(type: number): GlObject;
	createTexture(): GlObject;
	cullFace(mode: number): void;
	depthFunc(func: number): void;
	depthMask(enabled: boolean): void;
	disable(capability: number): void;
	drawArrays(mode: number, first: number, count: number): void;
	drawElements(mode: number, count: number, type: number, offset: number): void;
	enable(capability: number): void;
	enableVertexAttribArray(index: number): void;
	generateMipmap(target: number): void;
	getAttribLocation(program: GlObject, name: string): number;
	getProgramInfoLog(program: GlObject): string | null;
	getProgramParameter(program: GlObject, parameter: number): unknown;
	getShaderInfoLog(shader: GlObject): string | null;
	getShaderParameter(shader: GlObject, parameter: number): unknown;
	getUniformLocation(program: GlObject, name: string): GlObject;
	linkProgram(program: GlObject): void;
	shaderSource(shader: GlObject, source: string): void;
	texImage2D(
		target: number,
		level: number,
		internalFormat: number,
		width: number,
		height: number,
		border: number,
		format: number,
		type: number,
		pixels: ArrayBufferView
	): void;
	texParameteri(target: number, parameter: number, value: number): void;
	uniform1f(location: GlObject, value: number): void;
	uniform1i(location: GlObject, value: number): void;
	uniform4f(location: GlObject, x: number, y: number, z: number, w: number): void;
	uniformMatrix4fv(location: GlObject, transpose: boolean, value: Float32Array): void;
	useProgram(program: GlObject): void;
	vertexAttribPointer(index: number, size: number, type: number, normalized: boolean, stride: number, offset: number): void;
	viewport(x: number, y: number, width: number, height: number): void;
}

export interface CalibrationWorkload {
	drawCallsPerFrame: number;
	renderFrame(frameIndex: number): void;
}

/**
 * Builds all static resources (programs, VBOs, textures) and returns a per-frame command emitter.
 * Deterministic: every value derives from `spec.seed`; animation phase derives from `frameIndex`.
 * Self-contained apart from `mulberry32`, which the embedding page defines in the same scope.
 */
export function createWorkload(gl: WorkloadGl, spec: WorkloadSpec, viewportWidth: number, viewportHeight: number): CalibrationWorkload {
	const constants = spec.constants;
	const random = mulberry32(spec.seed);

	const compile = (type: number, source: string) => {
		const shader = gl.createShader(type);
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Workload shader compilation failed');
		return shader;
	};

	interface ProgramInfo {
		attributes: { normal: number; position: number; uv: number };
		program: GlObject;
		uniforms: { map: GlObject; modelMatrix: GlObject; tint: GlObject; viewProjectionMatrix: GlObject };
	}

	const programs: ProgramInfo[] = spec.shaders.map(shader => {
		const program = gl.createProgram();
		gl.attachShader(program, compile(gl.VERTEX_SHADER, shader.vertex));
		gl.attachShader(program, compile(gl.FRAGMENT_SHADER, shader.fragment));
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Workload program linking failed');
		return {
			attributes: {
				normal: gl.getAttribLocation(program, 'normal'),
				position: gl.getAttribLocation(program, 'position'),
				uv: gl.getAttribLocation(program, 'uv')
			},
			program,
			uniforms: {
				map: gl.getUniformLocation(program, 'map'),
				modelMatrix: gl.getUniformLocation(program, 'modelMatrix'),
				tint: gl.getUniformLocation(program, 'tint'),
				viewProjectionMatrix: gl.getUniformLocation(program, 'viewProjectionMatrix')
			}
		};
	});
	const programIndexByName: Record<string, number> = {};
	spec.shaders.forEach((shader, index) => { programIndexByName[shader.name] = index; });

	// Interleaved vertex layout: position(3) normal(3) uv(2).
	const FLOATS_PER_VERTEX = 8;
	interface Mesh { indexBuffer: GlObject; indexCount: number; vertexBuffer: GlObject }
	const uploadMesh = (vertices: number[], indices: number[]): Mesh => {
		const vertexBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
		const indexBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
		return { indexBuffer, indexCount: indices.length, vertexBuffer };
	};

	const pushVertex = (vertices: number[], x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number) => {
		vertices.push(x, y, z, nx, ny, nz, u, v);
	};

	// Low-poly n-gonal prism: 4n-4 triangles, so sides 4..17 span the design's 12-64 tris/mesh.
	const buildPrismMesh = (sides: number): Mesh => {
		const vertices: number[] = [];
		const indices: number[] = [];
		const ringOffsets: number[] = [];
		for (let ring = 0; ring < 2; ring++) {
			ringOffsets.push(vertices.length / FLOATS_PER_VERTEX);
			for (let side = 0; side < sides; side++) {
				const angle = (side / sides) * Math.PI * 2;
				const x = Math.cos(angle);
				const z = Math.sin(angle);
				pushVertex(vertices, x, ring === 0 ? -1 : 1, z, x, 0, z, side / sides, ring);
			}
		}
		for (let side = 0; side < sides; side++) {
			const next = (side + 1) % sides;
			indices.push(ringOffsets[0] + side, ringOffsets[0] + next, ringOffsets[1] + side);
			indices.push(ringOffsets[1] + side, ringOffsets[0] + next, ringOffsets[1] + next);
		}
		for (let ring = 0; ring < 2; ring++) {
			const capOffset = vertices.length / FLOATS_PER_VERTEX;
			const ny = ring === 0 ? -1 : 1;
			for (let side = 0; side < sides; side++) {
				const angle = (side / sides) * Math.PI * 2;
				pushVertex(vertices, Math.cos(angle), ny, Math.sin(angle), 0, ny, 0, (Math.cos(angle) + 1) / 2, (Math.sin(angle) + 1) / 2);
			}
			for (let side = 1; side < sides - 1; side++) {
				if (ring === 0) indices.push(capOffset, capOffset + side + 1, capOffset + side);
				else indices.push(capOffset, capOffset + side, capOffset + side + 1);
			}
		}
		return uploadMesh(vertices, indices);
	};

	const buildHeightfieldMesh = (size: number): Mesh => {
		const vertices: number[] = [];
		const indices: number[] = [];
		const heightRandom = mulberry32((spec.seed ^ 0x48454c44) >>> 0);
		const heights: number[] = [];
		for (let row = 0; row <= size; row++) {
			for (let column = 0; column <= size; column++) heights.push(heightRandom() * 4 - 2);
		}
		for (let row = 0; row <= size; row++) {
			for (let column = 0; column <= size; column++) {
				const x = (column / size - 0.5) * 120;
				const z = (row / size - 0.5) * 120;
				pushVertex(vertices, x, heights[row * (size + 1) + column], z, 0, 1, 0, column / size * 8, row / size * 8);
			}
		}
		for (let row = 0; row < size; row++) {
			for (let column = 0; column < size; column++) {
				const topLeft = row * (size + 1) + column;
				indices.push(topLeft, topLeft + 1, topLeft + size + 1);
				indices.push(topLeft + 1, topLeft + size + 2, topLeft + size + 1);
			}
		}
		return uploadMesh(vertices, indices);
	};

	const buildBoxMesh = (scale: number): Mesh => {
		const vertices: number[] = [];
		const indices: number[] = [];
		const faces = [
			{ normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
			{ normal: [0, 0, -1], uAxis: [-1, 0, 0], vAxis: [0, 1, 0] },
			{ normal: [1, 0, 0], uAxis: [0, 0, -1], vAxis: [0, 1, 0] },
			{ normal: [-1, 0, 0], uAxis: [0, 0, 1], vAxis: [0, 1, 0] },
			{ normal: [0, 1, 0], uAxis: [1, 0, 0], vAxis: [0, 0, -1] },
			{ normal: [0, -1, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1] }
		];
		for (const face of faces) {
			const base = vertices.length / FLOATS_PER_VERTEX;
			for (const [cornerU, cornerV] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
				const x = (face.normal[0] + face.uAxis[0] * cornerU + face.vAxis[0] * cornerV) * scale;
				const y = (face.normal[1] + face.uAxis[1] * cornerU + face.vAxis[1] * cornerV) * scale;
				const z = (face.normal[2] + face.uAxis[2] * cornerU + face.vAxis[2] * cornerV) * scale;
				pushVertex(vertices, x, y, z, face.normal[0], face.normal[1], face.normal[2], (cornerU + 1) / 2, (cornerV + 1) / 2);
			}
			indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
		}
		return uploadMesh(vertices, indices);
	};

	// Screen-space unit quad used by fullscreen layers and UI quads (drawn with drawArrays).
	const screenQuadBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, screenQuadBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
		-1, -1, 0, 0, 0, 1, 0, 0,
		1, -1, 0, 0, 0, 1, 1, 0,
		1, 1, 0, 0, 0, 1, 1, 1,
		-1, -1, 0, 0, 0, 1, 0, 0,
		1, 1, 0, 0, 0, 1, 1, 1,
		-1, 1, 0, 0, 0, 1, 0, 1
	]), gl.STATIC_DRAW);

	const meshes: Mesh[] = [];
	for (let variant = 0; variant < constants.meshVariants; variant++) {
		const sides = constants.prismMinSides + Math.floor(random() * (constants.prismMaxSides - constants.prismMinSides + 1));
		meshes.push(variant % 3 === 0 ? buildBoxMesh(0.75 + random() * 0.5) : buildPrismMesh(sides));
	}
	const heightfieldMesh = buildHeightfieldMesh(constants.heightfieldSize);
	const skyboxMesh = buildBoxMesh(1);

	// Procedural seeded textures: 8 mipmapped scene textures + one NEAREST-filtered UI atlas.
	const buildTexture = (size: number, textureSeed: number, nearest: boolean): GlObject => {
		const texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		const pixels = new Uint8Array(size * size * 4);
		const textureRandom = mulberry32(textureSeed >>> 0);
		const baseRed = 40 + Math.floor(textureRandom() * 180);
		const baseGreen = 40 + Math.floor(textureRandom() * 180);
		const baseBlue = 40 + Math.floor(textureRandom() * 180);
		const stripe = 4 + Math.floor(textureRandom() * 28);
		for (let index = 0; index < size * size; index++) {
			const x = index % size;
			const y = (index - x) / size;
			const wave = ((x / stripe) | 0) + ((y / stripe) | 0);
			const noise = textureRandom() * 60;
			const lit = wave % 2 === 0 ? 1 : 0.62;
			pixels[index * 4] = Math.min(255, baseRed * lit + noise) | 0;
			pixels[index * 4 + 1] = Math.min(255, baseGreen * lit + noise) | 0;
			pixels[index * 4 + 2] = Math.min(255, baseBlue * lit + noise) | 0;
			pixels[index * 4 + 3] = 200 + ((noise / 60) * 55) | 0;
		}
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
		if (nearest) {
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		} else {
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.generateMipmap(gl.TEXTURE_2D);
		}
		return texture;
	};
	const sceneTextures: GlObject[] = [];
	for (let index = 0; index < constants.sceneTextureCount; index++) {
		sceneTextures.push(buildTexture(constants.sceneTextureSize, spec.seed + 0x1000 + index, false));
	}
	const atlasTexture = buildTexture(constants.atlasTextureSize, spec.seed + 0x2000, true);

	// Static per-draw placement (position, scale, spin axis phase, texture, tint) fixed at creation.
	interface OpaqueDrawSpec {
		distance: number;
		meshIndex: number;
		phase: number;
		positionX: number;
		positionY: number;
		positionZ: number;
		scale: number;
		spinSpeed: number;
		textureIndex: number;
		tint: [number, number, number];
	}
	const boxDrawCount = constants.opaqueDraws - 2;
	const opaqueDraws: OpaqueDrawSpec[] = [];
	for (let index = 0; index < boxDrawCount; index++) {
		const positionX = (random() - 0.5) * 90;
		const positionY = random() * 14 - 2;
		const positionZ = (random() - 0.5) * 90;
		opaqueDraws.push({
			distance: Math.hypot(positionX, positionY, positionZ - 40),
			meshIndex: Math.floor(random() * constants.meshVariants),
			phase: random() * Math.PI * 2,
			positionX,
			positionY,
			positionZ,
			scale: 0.6 + random() * 2.4,
			spinSpeed: 0.002 + random() * 0.02,
			textureIndex: 0,
			tint: [0.55 + random() * 0.45, 0.55 + random() * 0.45, 0.55 + random() * 0.45]
		});
	}
	// Depth-staggered far-to-near fixed order gives the ~1.6x opaque overdraw of the design.
	opaqueDraws.sort((left, right) => right.distance - left.distance);
	// Texture changes every `textureBindInterval` draws in final draw order to hit the ~64 binds/frame lane.
	opaqueDraws.forEach((draw, index) => {
		draw.textureIndex = Math.floor(index / constants.textureBindInterval) % constants.sceneTextureCount;
	});

	interface TransparentDrawSpec {
		additive: boolean;
		fullscreen: boolean;
		phase: number;
		positionX: number;
		positionY: number;
		positionZ: number;
		scale: number;
		textureIndex: number;
		tint: [number, number, number, number];
	}
	const transparentDraws: TransparentDrawSpec[] = [];
	const fullscreenLayerCount = 3;
	for (let index = 0; index < constants.transparentDraws - fullscreenLayerCount; index++) {
		transparentDraws.push({
			// Blend modes and textures batch in blocks so the pass changes state like a scene graph, not per draw.
			additive: Math.floor(index / 11) % 2 === 1,
			fullscreen: false,
			phase: random() * Math.PI * 2,
			positionX: (random() - 0.5) * 70,
			positionY: random() * 12,
			positionZ: (random() - 0.5) * 70,
			scale: 1 + random() * 5,
			textureIndex: Math.floor(index / 8) % constants.sceneTextureCount,
			tint: [0.6 + random() * 0.4, 0.6 + random() * 0.4, 0.6 + random() * 0.4, 0.12 + random() * 0.3]
		});
	}

	interface UiDrawSpec {
		height: number;
		phase: number;
		width: number;
		x: number;
		y: number;
	}
	const uiDraws: UiDrawSpec[] = [];
	for (let index = 0; index < constants.uiDraws; index++) {
		uiDraws.push({
			height: 0.04 + random() * 0.18,
			phase: random() * Math.PI * 2,
			width: 0.05 + random() * 0.22,
			x: random() * 1.7 - 0.85,
			y: random() * 1.7 - 0.85
		});
	}

	const modelMatrix = new Float32Array(16);
	const viewProjectionMatrix = new Float32Array(16);
	const identityMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

	const writeModelMatrix = (x: number, y: number, z: number, scale: number, angle: number) => {
		const cos = Math.cos(angle) * scale;
		const sin = Math.sin(angle) * scale;
		modelMatrix[0] = cos; modelMatrix[1] = 0; modelMatrix[2] = -sin; modelMatrix[3] = 0;
		modelMatrix[4] = 0; modelMatrix[5] = scale; modelMatrix[6] = 0; modelMatrix[7] = 0;
		modelMatrix[8] = sin; modelMatrix[9] = 0; modelMatrix[10] = cos; modelMatrix[11] = 0;
		modelMatrix[12] = x; modelMatrix[13] = y; modelMatrix[14] = z; modelMatrix[15] = 1;
	};

	const writeScreenMatrix = (x: number, y: number, width: number, height: number) => {
		modelMatrix.set(identityMatrix);
		modelMatrix[0] = width;
		modelMatrix[5] = height;
		modelMatrix[12] = x;
		modelMatrix[13] = y;
	};

	const writeViewProjection = (frameIndex: number) => {
		// Fixed camera height, slow frame-index-driven orbit around the scene center.
		const angle = frameIndex * 0.004;
		const eyeX = Math.sin(angle) * 46;
		const eyeZ = Math.cos(angle) * 46;
		const eyeY = 12;
		// Look-at toward origin with Y up, then perspective; composed by hand to stay dependency-free.
		const forwardLength = Math.hypot(eyeX, eyeY, eyeZ);
		const fz = [eyeX / forwardLength, eyeY / forwardLength, eyeZ / forwardLength];
		const fx = [fz[2], 0, -fz[0]];
		const fxLength = Math.hypot(fx[0], fx[1], fx[2]) || 1;
		fx[0] /= fxLength; fx[2] /= fxLength;
		const fy = [fz[1] * fx[2] - fz[2] * fx[1], fz[2] * fx[0] - fz[0] * fx[2], fz[0] * fx[1] - fz[1] * fx[0]];
		const aspect = viewportWidth > 0 && viewportHeight > 0 ? viewportWidth / viewportHeight : 16 / 9;
		const fov = 1 / Math.tan(0.45);
		const near = 0.1;
		const far = 400;
		const view = [
			fx[0], fy[0], fz[0], 0,
			fx[1], fy[1], fz[1], 0,
			fx[2], fy[2], fz[2], 0,
			-(fx[0] * eyeX + fx[1] * eyeY + fx[2] * eyeZ),
			-(fy[0] * eyeX + fy[1] * eyeY + fy[2] * eyeZ),
			-(fz[0] * eyeX + fz[1] * eyeY + fz[2] * eyeZ),
			1
		];
		const projection = [
			fov / aspect, 0, 0, 0,
			0, fov, 0, 0,
			0, 0, (far + near) / (near - far), -1,
			0, 0, (2 * far * near) / (near - far), 0
		];
		for (let column = 0; column < 4; column++) {
			for (let row = 0; row < 4; row++) {
				let sum = 0;
				for (let k = 0; k < 4; k++) sum += projection[k * 4 + row] * view[column * 4 + k];
				viewProjectionMatrix[column * 4 + row] = sum;
			}
		}
	};

	let boundProgramIndex = -1;
	let boundTextureIndex = -2;
	let boundMesh: Mesh | 'screen-quad' | undefined;

	const bindProgram = (programIndex: number): ProgramInfo => {
		const info = programs[programIndex];
		if (boundProgramIndex !== programIndex) {
			gl.useProgram(info.program);
			gl.uniform1i(info.uniforms.map, 0);
			gl.uniformMatrix4fv(info.uniforms.viewProjectionMatrix, false, viewProjectionMatrix);
			boundProgramIndex = programIndex;
			// Attribute bindings follow the currently bound mesh; force a rebind after a program switch.
			boundMesh = undefined;
		}
		return info;
	};

	const bindSceneTexture = (textureIndex: number) => {
		if (boundTextureIndex === textureIndex) return;
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, textureIndex === -1 ? atlasTexture : sceneTextures[textureIndex]);
		boundTextureIndex = textureIndex;
	};

	const bindMeshAttributes = (info: ProgramInfo, mesh: Mesh | 'screen-quad') => {
		if (boundMesh === mesh) return;
		const stride = FLOATS_PER_VERTEX * 4;
		if (mesh === 'screen-quad') gl.bindBuffer(gl.ARRAY_BUFFER, screenQuadBuffer);
		else {
			gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vertexBuffer);
			gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
		}
		gl.enableVertexAttribArray(info.attributes.position);
		gl.vertexAttribPointer(info.attributes.position, 3, gl.FLOAT, false, stride, 0);
		gl.enableVertexAttribArray(info.attributes.normal);
		gl.vertexAttribPointer(info.attributes.normal, 3, gl.FLOAT, false, stride, 12);
		gl.enableVertexAttribArray(info.attributes.uv);
		gl.vertexAttribPointer(info.attributes.uv, 2, gl.FLOAT, false, stride, 24);
		boundMesh = mesh;
	};

	const renderFrame = (frameIndex: number) => {
		boundProgramIndex = -1;
		boundTextureIndex = -2;
		boundMesh = undefined;
		writeViewProjection(frameIndex);

		gl.viewport(0, 0, viewportWidth, viewportHeight);
		gl.clearColor(0.05, 0.06, 0.08, 1);
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
		gl.depthMask(true);
		gl.disable(gl.BLEND);
		gl.enable(gl.CULL_FACE);
		gl.cullFace(gl.BACK);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

		// Opaque pass: skybox, heightfield, then the depth-staggered mesh field. Program rotates
		// through the three opaque programs every `programSwitchInterval` draws.
		let info = bindProgram(programIndexByName.skybox);
		bindMeshAttributes(info, skyboxMesh);
		writeModelMatrix(0, 0, 0, 200, 0);
		gl.uniformMatrix4fv(info.uniforms.modelMatrix, false, modelMatrix);
		gl.uniform4f(info.uniforms.tint, 1, 1, 1, 1);
		gl.drawElements(gl.TRIANGLES, skyboxMesh.indexCount, gl.UNSIGNED_SHORT, 0);

		info = bindProgram(programIndexByName['lit-textured']);
		bindSceneTexture(0);
		bindMeshAttributes(info, heightfieldMesh);
		writeModelMatrix(0, -4, 0, 1, 0);
		gl.uniformMatrix4fv(info.uniforms.modelMatrix, false, modelMatrix);
		gl.uniform4f(info.uniforms.tint, 0.8, 0.85, 0.8, 1);
		gl.drawElements(gl.TRIANGLES, heightfieldMesh.indexCount, gl.UNSIGNED_SHORT, 0);

		const opaqueProgramCycle = [programIndexByName['lit-textured'], programIndexByName['unlit-textured'], programIndexByName['vertex-color']];
		for (let index = 0; index < opaqueDraws.length; index++) {
			const draw = opaqueDraws[index];
			info = bindProgram(opaqueProgramCycle[Math.floor(index / constants.programSwitchInterval) % opaqueProgramCycle.length]);
			bindSceneTexture(draw.textureIndex);
			const mesh = meshes[draw.meshIndex];
			bindMeshAttributes(info, mesh);
			writeModelMatrix(draw.positionX, draw.positionY, draw.positionZ, draw.scale, draw.phase + frameIndex * draw.spinSpeed);
			gl.uniformMatrix4fv(info.uniforms.modelMatrix, false, modelMatrix);
			gl.uniform4f(info.uniforms.tint, draw.tint[0], draw.tint[1], draw.tint[2], 1);
			gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0);
		}

		// Transparent pass: depth writes off, blending on (2 of the 4 blend toggles, 1 of 2 depth-mask toggles).
		gl.depthMask(false);
		gl.enable(gl.BLEND);
		let blendModeAdditive: boolean | undefined;
		for (let index = 0; index < transparentDraws.length; index++) {
			const draw = transparentDraws[index];
			if (blendModeAdditive !== draw.additive) {
				blendModeAdditive = draw.additive;
				if (draw.additive) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
				else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
			}
			info = bindProgram(draw.additive ? programIndexByName['transparent-additive'] : programIndexByName['transparent-soft']);
			bindSceneTexture(draw.textureIndex);
			const mesh = meshes[draw.textureIndex % meshes.length];
			bindMeshAttributes(info, mesh);
			const pulse = 0.85 + 0.3 * Math.sin(draw.phase + frameIndex * 0.05);
			writeModelMatrix(draw.positionX, draw.positionY, draw.positionZ, draw.scale * pulse, draw.phase + frameIndex * 0.01);
			gl.uniformMatrix4fv(info.uniforms.modelMatrix, false, modelMatrix);
			gl.uniform4f(info.uniforms.tint, draw.tint[0], draw.tint[1], draw.tint[2], draw.tint[3]);
			gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0);
		}

		// Three fullscreen blended layers (smoke, smoke, vignette tint): fill-rate and ROP load.
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		for (let layer = 0; layer < 2; layer++) {
			info = bindProgram(programIndexByName['transparent-soft']);
			bindSceneTexture(layer % constants.sceneTextureCount);
			bindMeshAttributes(info, 'screen-quad');
			writeScreenMatrix(0, 0, 1, 1);
			gl.uniformMatrix4fv(info.uniforms.modelMatrix, false, modelMatrix);
			gl.uniform4f(info.uniforms.tint, 0.5, 0.55, 0.6, 0.1 + layer * 0.04 + 0.02 * Math.sin(frameIndex * 0.03));
			gl.drawArrays(gl.TRIANGLES, 0, 6);
		}
		info = bindProgram(programIndexByName['post-tint']);
		bindMeshAttributes(info, 'screen-quad');
		writeScreenMatrix(0, 0, 1, 1);
		gl.uniformMatrix4fv(info.uniforms.modelMatrix, false, modelMatrix);
		gl.uniform4f(info.uniforms.tint, 0.03, 0.03, 0.05, 0.35);
		gl.drawArrays(gl.TRIANGLES, 0, 6);

		// UI pass: NEAREST atlas quads, depth test off (blend stays on: toggles 3/4 close the pass).
		gl.disable(gl.DEPTH_TEST);
		info = bindProgram(programIndexByName['ui-quad']);
		bindSceneTexture(-1);
		bindMeshAttributes(info, 'screen-quad');
		for (let index = 0; index < uiDraws.length; index++) {
			const draw = uiDraws[index];
			writeScreenMatrix(draw.x, draw.y, draw.width, draw.height);
			gl.uniformMatrix4fv(info.uniforms.modelMatrix, false, modelMatrix);
			gl.uniform4f(info.uniforms.tint, 1, 1, 1, 0.75 + 0.25 * Math.sin(draw.phase + frameIndex * 0.08));
			gl.drawArrays(gl.TRIANGLES, 0, 6);
		}
		gl.enable(gl.DEPTH_TEST);
		gl.disable(gl.BLEND);
		gl.depthMask(true);
	};

	return {
		drawCallsPerFrame: 2 + opaqueDraws.length + transparentDraws.length + fullscreenLayerCount + uiDraws.length,
		renderFrame
	};
}
