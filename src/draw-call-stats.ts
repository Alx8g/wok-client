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
export type DrawCallCensusTarget = Record<string, unknown>;
export const DRAW_METHOD_NAMES = ['drawArrays', 'drawArraysInstanced', 'drawElements', 'drawElementsInstanced', 'drawRangeElements'] as const;
export const DRAW_CENSUS_WARMUP_FRAMES = 60;
export const DRAW_CENSUS_SAMPLE_FRAMES = 240;
function percentile(sorted: number[], ratio: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}
export function summarizeDrawCallCensus(samples: readonly DrawCallCensusCounts[]): DrawCallCensusReport {
	const sortedBy = (key: keyof DrawCallCensusCounts) => samples.map((sample) => sample[key]).sort((left, right) => left - right);
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
	isActive?(): boolean;
	report(report: DrawCallCensusReport): void;
	requestFrame(callback: () => void): void;
	target: DrawCallCensusTarget;
	warmupFrames?: number;
	sampleFrames?: number;
}
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
	for (const name of DRAW_METHOD_NAMES)
		wrap(name, () => {
			counts.draws++;
		});
	wrap('bindTexture', () => {
		counts.textureBinds++;
	});
	wrap('useProgram', () => {
		counts.programSwitches++;
	});
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
		const active = hooks.isActive ? hooks.isActive() : true;
		if (active) frameIndex++;
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
