export interface PerfMarkSummary {
	count: number;
	medianMs: number;
	minMs: number;
	maxMs: number;
}

export interface PerfMarksReport {
	marks: Record<string, PerfMarkSummary>;
}

export declare function parsePerfMarks(text: string): PerfMarksReport;
