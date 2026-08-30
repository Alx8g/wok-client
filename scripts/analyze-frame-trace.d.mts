export interface FrameTraceDurationSummary {
	count: number;
	max_us: number;
	mean_us: number;
	p50_us: number;
	p95_us: number;
	p99_us: number;
}

export interface FrameTraceReport {
	trace_path: string;
	trace_event_count: number;
	measurement_span_ms: number;
	processes: Record<string, string>;
	threads: Record<string, string>;
	rates: Record<string, number>;
	counts: {
		callbacks: number;
		commit_events: number;
		unique_commit_frame_sequence_ids: number;
		surface_commits: number;
		viz_draw_and_swaps: number;
		dxgi_present_calls: number;
		presentation_reporter_spans: number;
		presentation_feedbacks: number;
		display_frame_feedbacks: number;
		ledger_submitted_frames: number;
		ledger_gpu_complete_frames: number;
		ledger_presentation_feedback_frames: number;
		ledger_terminal_frames: number;
		ledger_feedback_flags: Record<'failure' | 'hw_clock' | 'hw_completion' | 'vsync' | 'zero_copy', number>;
		ledger_outcomes: Record<'not_presented' | 'presented' | 'unknown', number>;
	};
	queue: {
		swap_throttled_count: number;
		maximum_pending_swaps: number;
		maximum_dcomp_pending_frames: number;
	};
	stages: Record<string, FrameTraceDurationSummary>;
	limitations: string[];
}

export function analyzeFrameTrace(tracePath: string): Promise<FrameTraceReport>;
