import { WEAPON_COUNT, WEAPON_PALETTE_SIZE, WEAPON_PARTICLE_DATA, WEAPON_POINT_COUNT } from './weapon-particle-data.ts';
const CYCLE_MS = 1360;
const MORPH_START = 0.44;
const MORPH_END = 0.92;
const SOURCE_SIZE = 170;
const POINT_STRIDE = 3;
const PALETTE_BYTES = WEAPON_COUNT * WEAPON_PALETTE_SIZE * 3;
export interface WeaponParticleLoader {
	destroy(): void;
}
function clamp(value: number): number {
	return Math.min(1, Math.max(0, value));
}
function hash(value: number): number {
	const result = Math.sin(value * 91.727 + 17.311) * 43758.5453;
	return result - Math.floor(result);
}
function smootherStep(value: number): number {
	const progress = clamp(value);
	return progress * progress * progress * (progress * (progress * 6 - 15) + 10);
}
function chooseParticleCount(): number {
	const cores = navigator.hardwareConcurrency || 4;
	const viewportArea = innerWidth * innerHeight;
	if (cores <= 4 || viewportArea < 520000) return 1150;
	if (cores <= 8 || viewportArea < 1100000) return 1650;
	return WEAPON_POINT_COUNT;
}
async function unpack(): Promise<Uint8Array> {
	const binary = atob(WEAPON_PARTICLE_DATA);
	const compressed = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function mountWeaponParticleLoader(host: HTMLElement): Promise<WeaponParticleLoader> {
	let data = await unpack();
	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d', { alpha: true });
	if (!context) throw new Error('Canvas 2D is unavailable');
	const renderingContext: CanvasRenderingContext2D = context;
	Object.assign(canvas.style, {
		inset: '0',
		pointerEvents: 'none',
		position: 'absolute',
		height: '100%',
		width: '100%'
	});
	host.append(canvas);
	const particleCount = chooseParticleCount();
	const pointIndexes = Uint16Array.from({ length: particleCount }, (_, index) => Math.min(WEAPON_POINT_COUNT - 1, Math.floor(((index + 0.5) / particleCount) * WEAPON_POINT_COUNT)));
	const size = Float32Array.from({ length: particleCount }, (_, index) => 0.68 + hash(index + 7.31) * 1.28);
	const timing = Float32Array.from({ length: particleCount }, (_, index) => (hash(index + 12.91) - 0.5) * 0.12);
	const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
	let width = 1;
	let height = 1;
	let scale = 1;
	let centerX = 0;
	let centerY = 0;
	let active = 0;
	let next = 1;
	let startedAt = performance.now();
	let frame = 0;
	let running = false;
	let destroyed = false;
	const pointOffset = (weapon: number, index: number) => PALETTE_BYTES + (weapon * WEAPON_POINT_COUNT + index) * POINT_STRIDE;
	const paletteOffset = (weapon: number, style: number) => (weapon * WEAPON_PALETTE_SIZE + (style >> 4)) * 3;
	const FRAME_INTERVAL_MS = 1000 / 60;
	let lastDrawnAt = -Infinity;
	const colourCache = new Map<number, string>();
	const fillStyleFor = (red: number, green: number, blue: number, alpha: number): string => {
		const quantisedAlpha = Math.round(alpha * 63);
		const key = ((red >> 3) << 17) | ((green >> 3) << 12) | ((blue >> 3) << 7) | quantisedAlpha;
		let style = colourCache.get(key);
		if (style === undefined) {
			style = `rgba(${red | 0},${green | 0},${blue | 0},${(quantisedAlpha / 63).toFixed(3)})`;
			colourCache.set(key, style);
		}
		return style;
	};
	function draw(now: number): void {
		if (destroyed) return;
		if (now - lastDrawnAt < FRAME_INTERVAL_MS) {
			if (running) frame = requestAnimationFrame(draw);
			return;
		}
		lastDrawnAt = now;
		while (now - startedAt >= CYCLE_MS) {
			startedAt += CYCLE_MS;
			active = next;
			next = (next + 1) % WEAPON_COUNT;
		}
		const phase = clamp((now - startedAt) / CYCLE_MS);
		const linear = clamp((phase - MORPH_START) / (MORPH_END - MORPH_START));
		renderingContext.clearRect(0, 0, width, height);
		const morphing = phase >= MORPH_START && phase < MORPH_END;
		const morphWave = morphing ? Math.sin(linear * Math.PI) : 0;
		const energy = morphing ? morphWave * 0.16 : 0.04;
		const sizeGain = 0.82 + energy * 0.42;
		const alphaGain = 0.82 + energy * 0.28;
		const settledProgress = phase < MORPH_START ? 0 : 1;
		for (let particle = 0; particle < particleCount; particle += 1) {
			const index = pointIndexes[particle];
			const from = pointOffset(active, index);
			const to = pointOffset(next, index);
			const individual = morphing ? clamp(linear + timing[particle] * morphWave) : settledProgress;
			const progress = smootherStep(individual);
			const fromStyle = data[from + 2];
			const toStyle = data[to + 2];
			const fromPalette = paletteOffset(active, fromStyle);
			const toPalette = paletteOffset(next, toStyle);
			const particleSize = size[particle];
			const alpha = ((fromStyle & 15) + ((toStyle & 15) - (fromStyle & 15)) * progress) / 15;
			const visibleAlpha = clamp(alpha * (0.76 + particleSize * 0.11) * alphaGain);
			const x = centerX + ((data[from] + (data[to] - data[from]) * progress - 84.5) / SOURCE_SIZE) * scale;
			const y = centerY + ((data[from + 1] + (data[to + 1] - data[from + 1]) * progress - 84.5) / SOURCE_SIZE) * scale;
			const red = data[fromPalette] + (data[toPalette] - data[fromPalette]) * progress;
			const green = data[fromPalette + 1] + (data[toPalette + 1] - data[fromPalette + 1]) * progress;
			const blue = data[fromPalette + 2] + (data[toPalette + 2] - data[fromPalette + 2]) * progress;
			renderingContext.beginPath();
			renderingContext.arc(x, y, particleSize * sizeGain, 0, Math.PI * 2);
			renderingContext.fillStyle = fillStyleFor(red, green, blue, visibleAlpha);
			renderingContext.fill();
		}
		if (running) frame = requestAnimationFrame(draw);
	}
	function resize(): void {
		const bounds = host.getBoundingClientRect();
		const ratio = Math.min(devicePixelRatio || 1, 2);
		width = Math.max(1, bounds.width);
		height = Math.max(1, bounds.height);
		canvas.width = Math.round(width * ratio);
		canvas.height = Math.round(height * ratio);
		renderingContext.setTransform(ratio, 0, 0, ratio, 0, 0);
		centerX = width * 0.5;
		centerY = height * 0.475;
		scale = Math.min(width * 0.83, height * 1.08);
		if (reducedMotion) {
			lastDrawnAt = -Infinity;
			draw(startedAt);
		}
	}
	function pause(): void {
		running = false;
		cancelAnimationFrame(frame);
	}
	function resume(): void {
		if (running || reducedMotion || destroyed) return;
		running = true;
		startedAt = performance.now();
		frame = requestAnimationFrame(draw);
	}
	function visibilityChanged(): void {
		if (document.hidden) pause();
		else resume();
	}
	const resizeObserver = new ResizeObserver(resize);
	resizeObserver.observe(host);
	document.addEventListener('visibilitychange', visibilityChanged);
	resize();
	resume();
	return {
		destroy() {
			if (destroyed) return;
			destroyed = true;
			pause();
			colourCache.clear();
			resizeObserver.disconnect();
			document.removeEventListener('visibilitychange', visibilityChanged);
			data = new Uint8Array();
			canvas.width = 1;
			canvas.height = 1;
			canvas.remove();
		}
	};
}
