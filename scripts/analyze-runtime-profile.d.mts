export interface CpuProfileAnalysisEntry {
	category: string;
	column: number;
	functionName: string;
	line: number;
	nodeId: number;
	samples: number;
	selfMs: number;
	selfPercent: number;
	url: string;
}

export interface CpuProfileCategory {
	category: string;
	selfMs: number;
	selfPercent: number;
}

export interface CpuProfileAnalysis {
	attributedMs: number;
	categories: CpuProfileCategory[];
	durationMs: number;
	sampleCount: number;
	top: CpuProfileAnalysisEntry[];
	unattributedSamples: number;
	usedRecordedTimeDeltas: boolean;
}

export function analyzeCpuProfile(profile: unknown, limit?: number): CpuProfileAnalysis;
export function formatCpuProfileAnalysis(analysis: CpuProfileAnalysis): string;
