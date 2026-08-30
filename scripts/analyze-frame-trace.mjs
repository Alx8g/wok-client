import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const EVENT_METRICS = new Map([
	['FrameRequestCallbackCollection::ExecuteFrameCallbacks', 'callback'],
	['Commit', 'commit'],
	['Surface::CommitFrame', 'surface_commit'],
	['Surface::ActivateFrame', 'surface_activate'],
	['Display::DrawAndSwap', 'viz_draw_and_swap'],
	['DirectRenderer::DrawFrame', 'viz_draw_frame'],
	['SkiaRenderer::SwapBuffers', 'viz_swap'],
	['SkiaOutputSurfaceImplOnGpu::SwapBuffers', 'gpu_swap'],
	['DXGISwapChainImageBacking::Present', 'dxgi_present'],
	['DCompPresenter::Present', 'dcomp_present'],
	['CommandBufferHelper::Flush', 'renderer_command_flush'],
	['CommandBuffer::Flush', 'gpu_command_flush']
]);
const PRESENTATION_SPAN = 'SubmitCompositorFrameToPresentationCompositorFrame';
const WOK_SUBMIT_EVENT = 'WokFrameSubmitted';
const WOK_TERMINAL_EVENT = 'WokFrameTerminal';

function parseTraceEvent(line) {
	let value = line.trim();
	if (value.endsWith(',')) value = value.slice(0, -1);
	if (!value.startsWith('{') || value.startsWith('{"traceEvents"')) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function numeric(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function percentile(sorted, fraction) {
	if (sorted.length === 0) return 0;
	const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1));
	return sorted[index];
}

function summarizeDurations(values) {
	if (values.length === 0) return { count: 0, max_us: 0, mean_us: 0, p50_us: 0, p95_us: 0, p99_us: 0 };
	const sorted = [...values].sort((left, right) => left - right);
	return {
		count: values.length,
		max_us: sorted.at(-1) ?? 0,
		mean_us: values.reduce((sum, value) => sum + value, 0) / values.length,
		p50_us: percentile(sorted, 0.50),
		p95_us: percentile(sorted, 0.95),
		p99_us: percentile(sorted, 0.99)
	};
}

function asyncId(event) {
	const processPrefix = `pid:${event.pid}:`;
	const local = event.id2?.local;
	if (typeof local === 'string' || typeof local === 'number') return `${processPrefix}local:${local}`;
	const global = event.id2?.global;
	if (typeof global === 'string' || typeof global === 'number') return `${processPrefix}global:${global}`;
	if (typeof event.id === 'string' || typeof event.id === 'number') return `${processPrefix}id:${event.id}`;
	return undefined;
}

function eventArgs(event) {
	return event.args && typeof event.args === 'object' && !Array.isArray(event.args) ? event.args : {};
}

function terminalStatus(args) {
	const status = args.status ?? args.termination_status;
	if (typeof status === 'string') return status.toLowerCase();
	if (args.presented === true) return 'presented';
	if (args.presented === false || args.failed === true) return 'not_presented';
	return 'unknown';
}

export async function analyzeFrameTrace(tracePath) {
	const processNames = new Map();
	const threadNames = new Map();
	const durations = new Map();
	const counts = new Map();
	const firstTimestamp = new Map();
	const lastTimestamp = new Map();
	const presentationStarts = new Map();
	const presentationDurations = [];
	const presentationEndTimestamps = new Set();
	const commitFrameSequenceIds = new Set();
	const submittedFrameTokens = new Set();
	const terminalFrameTokens = new Set();
	const outcomeCounts = { not_presented: 0, presented: 0, unknown: 0 };
	let maximumPendingSwaps = 0;
	let swapThrottledCount = 0;
	let maximumDcompPendingFrames = 0;
	let traceEventCount = 0;

	const lines = createInterface({ input: createReadStream(tracePath), crlfDelay: Infinity });
	for await (const line of lines) {
		const event = parseTraceEvent(line);
		if (!event) continue;
		traceEventCount++;
		const pid = numeric(event.pid);
		const tid = numeric(event.tid);
		const name = typeof event.name === 'string' ? event.name : '';
		if (event.ph === 'M' && name === 'process_name' && pid !== undefined) {
			processNames.set(pid, String(eventArgs(event).name ?? ''));
			continue;
		}
		if (event.ph === 'M' && name === 'thread_name' && pid !== undefined && tid !== undefined) {
			threadNames.set(`${pid}:${tid}`, String(eventArgs(event).name ?? ''));
			continue;
		}

		const metric = EVENT_METRICS.get(name);
		const timestamp = numeric(event.ts);
		const args = eventArgs(event);
		const isFrameCommit = metric !== 'commit'
			|| typeof args.frameSeqId === 'string'
			|| typeof args.frameSeqId === 'number';
		if (metric && event.ph === 'X' && isFrameCommit) {
			counts.set(metric, (counts.get(metric) ?? 0) + 1);
			const duration = numeric(event.dur);
			if (duration !== undefined && duration >= 0) {
				const values = durations.get(metric) ?? [];
				values.push(duration);
				durations.set(metric, values);
			}
			if (timestamp !== undefined) {
				firstTimestamp.set(metric, Math.min(firstTimestamp.get(metric) ?? timestamp, timestamp));
				lastTimestamp.set(metric, Math.max(lastTimestamp.get(metric) ?? timestamp, timestamp));
			}
			if (metric === 'commit') {
				const frameSequenceId = args.frameSeqId;
				if (typeof frameSequenceId === 'string' || typeof frameSequenceId === 'number') {
					commitFrameSequenceIds.add(String(frameSequenceId));
				}
			}
		}

		if (name === PRESENTATION_SPAN && timestamp !== undefined) {
			const id = asyncId(event);
			if (id && event.ph === 'b') {
				const starts = presentationStarts.get(id) ?? [];
				starts.push(timestamp);
				presentationStarts.set(id, starts);
			} else if (id && event.ph === 'e') {
				const starts = presentationStarts.get(id);
				const start = starts?.shift();
				if (start !== undefined && timestamp >= start) presentationDurations.push(timestamp - start);
				if (starts?.length === 0) presentationStarts.delete(id);
				presentationEndTimestamps.add(timestamp);
			}
		}

		if (name === 'Swap throttled') {
			swapThrottledCount++;
			maximumPendingSwaps = Math.max(maximumPendingSwaps, numeric(args.pending_swaps) ?? 0);
		}
		if (name === 'DCompPresenter::CheckPendingFrames') {
			maximumDcompPendingFrames = Math.max(maximumDcompPendingFrames, numeric(args.num_pending_frames) ?? 0);
		}
		if (name === WOK_SUBMIT_EVENT) {
			const token = args.frame_token;
			if (typeof token === 'string' || typeof token === 'number') submittedFrameTokens.add(String(token));
		}
		if (name === WOK_TERMINAL_EVENT) {
			const token = args.frame_token;
			if (typeof token === 'string' || typeof token === 'number') terminalFrameTokens.add(String(token));
			outcomeCounts[terminalStatus(args)]++;
		}
	}

	const measurementStart = firstTimestamp.get('callback')
		?? firstTimestamp.get('commit')
		?? firstTimestamp.get('viz_draw_and_swap');
	const feedbackEnds = [...presentationEndTimestamps];
	const measurementEnd = feedbackEnds.length > 0
		? Math.max(...feedbackEnds)
		: lastTimestamp.get('dxgi_present') ?? lastTimestamp.get('viz_draw_and_swap');
	const measurementSpanUs = measurementStart !== undefined && measurementEnd !== undefined && measurementEnd > measurementStart
		? measurementEnd - measurementStart
		: 0;
	const rate = count => measurementSpanUs > 0 ? count * 1_000_000 / measurementSpanUs : 0;

	const stageMetrics = {};
	for (const [metric, values] of durations) stageMetrics[metric] = summarizeDurations(values);
	stageMetrics.submit_to_presentation_feedback = summarizeDurations(presentationDurations);

	return {
		trace_path: tracePath,
		trace_event_count: traceEventCount,
		measurement_span_ms: measurementSpanUs / 1000,
		processes: Object.fromEntries(processNames),
		threads: Object.fromEntries(threadNames),
		rates: {
			callback_fps: rate(counts.get('callback') ?? 0),
			commit_fps: rate(commitFrameSequenceIds.size || counts.get('commit') || 0),
			surface_commit_fps: rate(counts.get('surface_commit') ?? 0),
			viz_draw_and_swap_fps: rate(counts.get('viz_draw_and_swap') ?? 0),
			dxgi_present_call_fps: rate(counts.get('dxgi_present') ?? 0),
			presentation_feedback_fps: rate(presentationEndTimestamps.size),
			ledger_submitted_fps: rate(submittedFrameTokens.size),
			ledger_presented_fps: rate(outcomeCounts.presented)
		},
		counts: {
			callbacks: counts.get('callback') ?? 0,
			commit_events: counts.get('commit') ?? 0,
			unique_commit_frame_sequence_ids: commitFrameSequenceIds.size,
			surface_commits: counts.get('surface_commit') ?? 0,
			viz_draw_and_swaps: counts.get('viz_draw_and_swap') ?? 0,
			dxgi_present_calls: counts.get('dxgi_present') ?? 0,
			presentation_reporter_spans: presentationDurations.length,
			presentation_feedbacks: presentationEndTimestamps.size,
			ledger_submitted_frames: submittedFrameTokens.size,
			ledger_terminal_frames: terminalFrameTokens.size,
			ledger_outcomes: outcomeCounts
		},
		queue: {
			swap_throttled_count: swapThrottledCount,
			maximum_pending_swaps: maximumPendingSwaps,
			maximum_dcomp_pending_frames: maximumDcompPendingFrames
		},
		stages: stageMetrics,
		limitations: [
			'Callback, present-call, and presentation-feedback rates remain separate metrics.',
			'Presentation feedback is not classified as successful unless WokFrameTerminal events are present.',
			'GPU service time is unknown unless frame-ledger GPU completion timestamps are present.',
			'Trace instrumentation can reduce throughput; use this report for attribution, then qualify with tracing disabled.'
		]
	};
}

async function main() {
	const [tracePath, outputPath] = process.argv.slice(2);
	if (!tracePath) throw new Error('Usage: node scripts/analyze-frame-trace.mjs <trace.json> [output.json]');
	const report = await analyzeFrameTrace(tracePath);
	const text = `${JSON.stringify(report, null, 2)}\n`;
	if (outputPath) await writeFile(outputPath, text, 'utf8');
	else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
