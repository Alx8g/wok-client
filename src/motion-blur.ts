const OUTPUT_CANVAS_ID = 'wok-motion-blur-canvas';
const REFERENCE_FRAME_MS = 1_000 / 60;
const LAYOUT_SYNC_INTERVAL_FRAMES = 30;
const MIN_HISTORY_WEIGHT = 0.002;
const MAX_HISTORY_WEIGHT = 0.48;
const MOUSE_BLUR_START_SPEED_PX = 3;
const MOUSE_BLUR_FULL_SPEED_PX = 30;
const WEBGL_DRAW_METHODS = [
	'drawArrays',
	'drawElements',
	'drawArraysInstanced',
	'drawElementsInstanced'
] as const;

export const MOTION_BLUR_QUALITY_SCALES = {
	balanced: 0.75,
	native: 1,
	performance: 0.5
} as const;

export type MotionBlurQuality = keyof typeof MOTION_BLUR_QUALITY_SCALES;

export interface MotionBlurOptions {
	qualityScale: number;
	strength: number;
}

export interface MotionBlurState extends MotionBlurOptions {
	active: boolean;
	attached: boolean;
	averageCpuCostMs: number;
	historyWeight: number;
	outputResolution?: [number, number];
	sourceResolution?: [number, number];
}

export interface MotionBlurController {
	destroy: () => void;
	getState: () => MotionBlurState;
	update: (options: MotionBlurOptions) => void;
}

interface MotionBlurRuntimeOptions {
	onError?: (error: unknown) => void;
}

interface WebGLDrawHook {
	name: string;
	original: (...arguments_: unknown[]) => unknown;
	target: Record<string, unknown>;
	wrapped: (...arguments_: unknown[]) => unknown;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
	const amount = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
	return amount * amount * (3 - 2 * amount);
}

function normalizeOptions(options: MotionBlurOptions): MotionBlurOptions {
	const qualityScale = Number(options.qualityScale);
	const strength = Number(options.strength);
	return {
		qualityScale: Number.isFinite(qualityScale) ? clamp(qualityScale, 0.5, 1) : 1,
		strength: Number.isFinite(strength)
			? clamp(strength, 0, MAX_HISTORY_WEIGHT)
			: MAX_HISTORY_WEIGHT / 2
	};
}

export function motionBlurOptionsFromUserPrefs(preferences: UserPrefs): MotionBlurOptions {
	const qualityKey = preferences.motionBlurQuality;
	const quality = typeof qualityKey === 'string' && Object.hasOwn(MOTION_BLUR_QUALITY_SCALES, qualityKey)
		? MOTION_BLUR_QUALITY_SCALES[qualityKey as MotionBlurQuality]
		: undefined;
	const strength = typeof preferences.motionBlurStrength === 'number'
		? preferences.motionBlurStrength
		: 50;
	return normalizeOptions({
		qualityScale: quality ?? MOTION_BLUR_QUALITY_SCALES.native,
		strength: (clamp(strength, 0, 100) / 100) * MAX_HISTORY_WEIGHT
	});
}

/** Keeps temporal accumulation visually consistent when the game frame rate changes. */
export function calculateFrameRetention(historyWeight: number, deltaMs: number): number {
	return clamp(historyWeight, 0, 0.85) ** (
		clamp(deltaMs, 1, 100) / REFERENCE_FRAME_MS
	);
}

/** Ignores fine aim corrections and reaches full blur only during a deliberate fast turn. */
export function calculateMouseMotionFactor(mouseDistance: number, deltaMs: number): number {
	const frameAdjustedDistance = Math.max(0, mouseDistance)
		* (REFERENCE_FRAME_MS / Math.max(1, deltaMs));
	return smoothstep(
		MOUSE_BLUR_START_SPEED_PX,
		MOUSE_BLUR_FULL_SPEED_PX,
		frameAdjustedDistance
	);
}

/**
 * Lightweight camera-motion blur for Krunker.
 *
 * Chromium discards a WebGL canvas's drawing buffer after presenting it. A separate animation-frame
 * callback therefore sees black unless the game created its context with preserveDrawingBuffer,
 * which has a permanent rendering cost. Instead, the draw hooks below queue one microtask from the
 * game's own WebGL render task. That microtask runs after all scene draws but before presentation,
 * while the current frame is still available, and copies it into one inexpensive 2D history canvas.
 */
export function startMotionBlur(
	initialOptions: MotionBlurOptions,
	runtimeOptions: MotionBlurRuntimeOptions = {}
): MotionBlurController {
	let options = normalizeOptions(initialOptions);
	let gameCanvas: HTMLCanvasElement | undefined;
	let sourceCanvas: HTMLCanvasElement | undefined;
	let outputCanvas: HTMLCanvasElement | undefined;
	let outputContext: CanvasRenderingContext2D | undefined;
	let lastFrameAt = 0;
	let layoutCountdown = 0;
	let accumulatedMotionX = 0;
	let accumulatedMotionY = 0;
	let smoothedHistoryWeight = 0;
	let hasHistory = false;
	let destroyed = false;
	let outputActive = false;
	let captureScheduled = false;
	let scheduledCanvas: HTMLCanvasElement | undefined;
	let costTotal = 0;
	let costSamples = 0;
	let averageCpuCostMs = 0;
	const drawHooks: WebGLDrawHook[] = [];

	// A stale output from an interrupted live reload should never cover the newly started renderer.
	document.getElementById(OUTPUT_CANVAS_ID)?.remove();

	const clearMotionState = () => {
		accumulatedMotionX = 0;
		accumulatedMotionY = 0;
		smoothedHistoryWeight = 0;
		hasHistory = false;
		outputActive = false;
		if (outputCanvas) outputCanvas.style.display = 'none';
	};

	const detachCanvas = () => {
		outputCanvas?.remove();
		sourceCanvas = undefined;
		outputCanvas = undefined;
		outputContext = undefined;
		clearMotionState();
	};

	const isGameCanvas = (canvas: HTMLCanvasElement): boolean => {
		if (
			canvas.id === 'game-overlay'
			|| canvas.id === OUTPUT_CANVAS_ID
			|| canvas.closest('.wok-weapon-loader')
			|| canvas.width <= 1
			|| canvas.height <= 1
		) return false;
		const rect = canvas.getBoundingClientRect();
		return rect.width >= window.innerWidth * 0.7 && rect.height >= window.innerHeight * 0.7;
	};

	const syncCanvasLayout = (force = false) => {
		if (!sourceCanvas || !outputCanvas || !outputContext) return;
		const rect = sourceCanvas.getBoundingClientRect();
		const targetWidth = Math.max(1, Math.round(sourceCanvas.width * options.qualityScale));
		const targetHeight = Math.max(1, Math.round(sourceCanvas.height * options.qualityScale));

		if (force || outputCanvas.width !== targetWidth || outputCanvas.height !== targetHeight) {
			outputCanvas.width = targetWidth;
			outputCanvas.height = targetHeight;
			outputContext.imageSmoothingEnabled = true;
			outputContext.imageSmoothingQuality = 'low';
			hasHistory = false;
		}

		outputCanvas.style.left = `${rect.left}px`;
		outputCanvas.style.top = `${rect.top}px`;
		outputCanvas.style.width = `${rect.width}px`;
		outputCanvas.style.height = `${rect.height}px`;
		const sourceZIndex = getComputedStyle(sourceCanvas).zIndex;
		outputCanvas.style.zIndex = sourceZIndex === 'auto' ? '0' : sourceZIndex;
	};

	const attachToCanvas = (canvas: HTMLCanvasElement) => {
		if (canvas === sourceCanvas && outputCanvas?.isConnected) return;
		detachCanvas();
		sourceCanvas = canvas;

		const nextOutputCanvas = document.createElement('canvas');
		nextOutputCanvas.id = OUTPUT_CANVAS_ID;
		nextOutputCanvas.setAttribute('aria-hidden', 'true');
		nextOutputCanvas.style.cssText = [
			'contain:strict',
			'display:none',
			'pointer-events:none',
			'position:fixed'
		].join(';');
		canvas.insertAdjacentElement('afterend', nextOutputCanvas);

		const context = nextOutputCanvas.getContext('2d', { alpha: false });
		if (!context) {
			nextOutputCanvas.remove();
			sourceCanvas = undefined;
			return;
		}

		outputCanvas = nextOutputCanvas;
		outputContext = context;
		syncCanvasLayout(true);
	};

	const readGamepadTurn = (): number => {
		try {
			for (const gamepad of navigator.getGamepads?.() ?? []) {
				if (!gamepad?.connected) continue;
				const horizontal = Number(gamepad.axes?.[2] ?? 0);
				const vertical = Number(gamepad.axes?.[3] ?? 0);
				const magnitude = Math.hypot(horizontal, vertical);
				if (magnitude > 0.08) return clamp((magnitude - 0.08) / 0.72, 0, 1);
			}
		} catch (_error) {
			// Gamepad enumeration can be blocked by hardened browser privacy settings.
		}
		return 0;
	};

	const calculateMotionFactor = (deltaMs: number): number => {
		const mouseDistance = Math.hypot(accumulatedMotionX, accumulatedMotionY);
		accumulatedMotionX = 0;
		accumulatedMotionY = 0;
		const mouseFactor = calculateMouseMotionFactor(mouseDistance, deltaMs);
		return Math.max(mouseFactor, readGamepadTurn());
	};

	function destroy() {
		if (destroyed) return;
		destroyed = true;
		window.removeEventListener('mousemove', onMouseMove, true);
		document.removeEventListener('pointerlockchange', onPointerLockChange, true);
		for (const hook of drawHooks.reverse()) {
			if (hook.target[hook.name] === hook.wrapped) hook.target[hook.name] = hook.original;
		}
		drawHooks.length = 0;
		detachCanvas();
	}

	const fail = (error: unknown) => {
		runtimeOptions.onError?.(error);
		destroy();
	};

	const captureFrame = (canvas: HTMLCanvasElement, timestamp: number) => {
		if (destroyed || canvas !== gameCanvas || !canvas.isConnected) return;
		try {
			if (!lastFrameAt) lastFrameAt = timestamp;
			const deltaMs = clamp(timestamp - lastFrameAt, 1, 100);
			lastFrameAt = timestamp;

			if (document.hidden || document.pointerLockElement === null) {
				accumulatedMotionX = 0;
				accumulatedMotionY = 0;
			}
			const motionFactor = document.hidden || document.pointerLockElement === null
				? 0
				: calculateMotionFactor(deltaMs);
			const targetHistoryWeight = options.strength * motionFactor;
			const smoothingTimeMs = targetHistoryWeight > smoothedHistoryWeight ? 6 : 24;
			const smoothing = 1 - Math.exp(-deltaMs / smoothingTimeMs);
			smoothedHistoryWeight += (targetHistoryWeight - smoothedHistoryWeight) * smoothing;
			if (smoothedHistoryWeight < MIN_HISTORY_WEIGHT) smoothedHistoryWeight = 0;

			// At rest the original WebGL canvas is already the correct output. Hiding this layer avoids
			// a full-frame canvas copy unless the camera is actually moving or its trail is releasing.
			if (smoothedHistoryWeight === 0) {
				if (outputActive) clearMotionState();
				return;
			}

			attachToCanvas(canvas);
			if (!sourceCanvas || !outputCanvas || !outputContext) return;
			layoutCountdown--;
			if (layoutCountdown <= 0) {
				layoutCountdown = LAYOUT_SYNC_INTERVAL_FRAMES;
				syncCanvasLayout();
			}

			outputActive = true;
			outputCanvas.style.display = 'block';
			const drawStartedAt = performance.now();
			if (!hasHistory) {
				outputContext.globalCompositeOperation = 'copy';
				outputContext.globalAlpha = 1;
				outputContext.drawImage(sourceCanvas, 0, 0, outputCanvas.width, outputCanvas.height);
				hasHistory = true;
			} else {
				const frameRetention = calculateFrameRetention(smoothedHistoryWeight, deltaMs);
				outputContext.globalCompositeOperation = 'source-over';
				outputContext.globalAlpha = 1 - frameRetention;
				outputContext.drawImage(sourceCanvas, 0, 0, outputCanvas.width, outputCanvas.height);
			}

			costTotal += performance.now() - drawStartedAt;
			costSamples++;
			if (costSamples >= 120) {
				averageCpuCostMs = costTotal / costSamples;
				costTotal = 0;
				costSamples = 0;
			}
		} catch (error) {
			fail(error);
		}
	};

	const scheduleCapture = (canvas: HTMLCanvasElement) => {
		if (destroyed) return;
		if (canvas !== gameCanvas) {
			if (gameCanvas?.isConnected || !isGameCanvas(canvas)) return;
			gameCanvas = canvas;
		}
		if (captureScheduled) {
			scheduledCanvas = canvas;
			return;
		}
		if (
			document.pointerLockElement === null
			&& smoothedHistoryWeight === 0
			&& accumulatedMotionX === 0
			&& accumulatedMotionY === 0
		) return;
		scheduledCanvas = canvas;
		captureScheduled = true;
		queueMicrotask(() => {
			captureScheduled = false;
			const canvasToCapture = scheduledCanvas;
			scheduledCanvas = undefined;
			if (canvasToCapture) captureFrame(canvasToCapture, performance.now());
		});
	};

	const installDrawHooks = (contextType: { prototype: object } | undefined) => {
		if (!contextType) return;
		const target = contextType.prototype as Record<string, unknown>;
		for (const name of WEBGL_DRAW_METHODS) {
			const descriptor = Object.getOwnPropertyDescriptor(target, name);
			if (!descriptor?.writable || typeof descriptor.value !== 'function') continue;
			const original = descriptor.value as (...arguments_: unknown[]) => unknown;
			const wrapped = function (this: { canvas?: HTMLCanvasElement }, ...arguments_: unknown[]) {
				const result = Reflect.apply(original, this, arguments_);
				if (this.canvas) scheduleCapture(this.canvas);
				return result;
			};
			target[name] = wrapped;
			drawHooks.push({ name, original, target, wrapped });
		}
	};

	function onMouseMove(event: MouseEvent) {
		if (document.pointerLockElement === null) return;
		accumulatedMotionX += Number(event.movementX || 0);
		accumulatedMotionY += Number(event.movementY || 0);
	}

	function onPointerLockChange() {
		clearMotionState();
	}

	window.addEventListener('mousemove', onMouseMove, true);
	document.addEventListener('pointerlockchange', onPointerLockChange, true);
	installDrawHooks(typeof WebGLRenderingContext === 'function' ? WebGLRenderingContext : undefined);
	installDrawHooks(typeof WebGL2RenderingContext === 'function' ? WebGL2RenderingContext : undefined);

	return {
		destroy,
		getState: () => ({
			...options,
			active: outputActive,
			attached: Boolean(sourceCanvas?.isConnected && outputCanvas?.isConnected),
			averageCpuCostMs,
			historyWeight: smoothedHistoryWeight,
			...(outputCanvas ? { outputResolution: [outputCanvas.width, outputCanvas.height] } : {}),
			...(sourceCanvas ? { sourceResolution: [sourceCanvas.width, sourceCanvas.height] } : {})
		}),
		update(nextOptions) {
			const previousQuality = options.qualityScale;
			options = normalizeOptions(nextOptions);
			if (options.qualityScale !== previousQuality) syncCanvasLayout(true);
			if (options.strength === 0) clearMotionState();
		}
	};
}
