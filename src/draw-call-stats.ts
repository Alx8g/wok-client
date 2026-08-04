/**
 * Diagnostic-only WebGL call census.
 *
 * The calibration workload is tuned against assumptions about how many draw calls, texture binds
 * and program switches a real Krunker frame issues. Those assumptions decide the backend ranking
 * (the v3 tuning curve is monotonic in draw count), so they must be measured on the real game
 * rather than guessed. This module counts the calls the game actually makes, per frame, and
 * reports percentiles over a bounded window.
 *
 * Inert unless WOK_DRAW_STATS is set. It wraps prototype methods, so it is never installed in a
 * normal session: the wrapper cost itself would perturb the very frame budget being measured.
 */

export interface DrawCallCensusCounts {
	draws: number;
	programSwitches: number;
	textureBinds: number;
}

export interface DrawCallCensusReport extends Record<string, unknown> {
	frames: number;
	medianDraws: number;
	medianProgramSwitches: number;
	medianTextureBinds: number;
	p95Draws: number;
	p95ProgramSwitches: number;
	p95TextureBinds: number;
	maxDraws: number;
}

/** Prototype-shaped target; tests pass a fake, production passes WebGL2RenderingContext.prototype. */
export type DrawCallCensusTarget = Record<string, unknown>;

export const DRAW_METHOD_NAMES = [
	'drawArrays',
	'drawArraysInstanced',
	'drawElements',
	'drawElementsInstanced',
	'drawRangeElements'
] as const;

/** Frames skipped before sampling, so shader compilation and first-render spikes are excluded. */
export const DRAW_CENSUS_WARMUP_FRAMES = 60;
export const DRAW_CENSUS_SAMPLE_FRAMES = 240;

function percentile(sorted: number[], ratio: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

export function summarizeDrawCallCensus(samples: readonly DrawCallCensusCounts[]): DrawCallCensusReport {
	const sortedBy = (key: keyof DrawCallCensusCounts) => samples.map(sample => sample[key]).sort((left, right) => left - right);
	const draws = sortedBy('draws');
	const programSwitches = sortedBy('programSwitches');
	const textureBinds = sortedBy('textureBinds');
	return {
		frames: samples.length,
		maxDraws: draws.length > 0 ? draws[draws.length - 1] : 0,
		medianDraws: percentile(draws, 0.5),
		medianProgramSwitches: percentile(programSwitches, 0.5),
		medianTextureBinds: percentile(textureBinds, 0.5),
		p95Draws: percentile(draws, 0.95),
		p95ProgramSwitches: percentile(programSwitches, 0.95),
		p95TextureBinds: percentile(textureBinds, 0.95)
	};
}

export interface DrawCallCensusHooks {
	/**
	 * Whether the frame about to be counted is real gameplay. Menus render a fixed scene at very
	 * high frame rates, so an ungated census fills its whole window before the player ever joins a
	 * match and reports the menu's shape as the game's. Production passes pointer-lock state.
	 */
	isActive?(): boolean;
	report(report: DrawCallCensusReport): void;
	requestFrame(callback: () => void): void;
	target: DrawCallCensusTarget;
	warmupFrames?: number;
	sampleFrames?: number;
}

/** Installs the counters and resolves once one bounded census has been reported. Returns an uninstall function. */
export function installDrawCallCensus(hooks: DrawCallCensusHooks): () => void {
	const counts: DrawCallCensusCounts = { draws: 0, programSwitches: 0, textureBinds: 0 };
	const originals = new Map<string, unknown>();
	const target = hooks.target;

	const wrap = (name: string, bump: () => void) => {
		const original = target[name];
		if (typeof original !== 'function') return;
		originals.set(name, original);
		target[name] = function wrapped(this: unknown, ...args: unknown[]) {
			bump();
			return (original as (...callArgs: unknown[]) => unknown).apply(this, args);
		};
	};

	for (const name of DRAW_METHOD_NAMES) wrap(name, () => { counts.draws++; });
	wrap('bindTexture', () => { counts.textureBinds++; });
	wrap('useProgram', () => { counts.programSwitches++; });

	const uninstall = () => {
		for (const [name, original] of originals) target[name] = original;
		originals.clear();
	};

	const warmupFrames = hooks.warmupFrames ?? DRAW_CENSUS_WARMUP_FRAMES;
	const sampleFrames = hooks.sampleFrames ?? DRAW_CENSUS_SAMPLE_FRAMES;
	const samples: DrawCallCensusCounts[] = [];
	let frameIndex = 0;
	let done = false;

	const tick = () => {
		if (done) return;
		const frame: DrawCallCensusCounts = { ...counts };
		counts.draws = 0;
		counts.programSwitches = 0;
		counts.textureBinds = 0;
		// Warmup only advances while gameplay is live, so shader-compilation frames at the start of
		// the first match are excluded rather than being spent in the menu.
		const active = hooks.isActive ? hooks.isActive() : true;
		if (active) frameIndex++;
		// Only count frames that actually rendered; menus and idle tabs would dilute the census.
		if (active && frameIndex > warmupFrames && frame.draws > 0) samples.push(frame);
		if (samples.length >= sampleFrames) {
			done = true;
			uninstall();
			hooks.report(summarizeDrawCallCensus(samples));
			return;
		}
		hooks.requestFrame(tick);
	};
	hooks.requestFrame(tick);

	return () => {
		done = true;
		uninstall();
	};
}
