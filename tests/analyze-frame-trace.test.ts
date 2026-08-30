import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyzeFrameTrace } from '../scripts/analyze-frame-trace.mjs';

function event(value: Record<string, unknown>): string {
	return `${JSON.stringify(value)},`;
}

test('separates callback, present-call, and presentation-feedback rates', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'wok-frame-trace-'));
	const tracePath = join(directory, 'trace.json');
	const lines = [
		'{"traceEvents":[',
		event({ ph: 'M', name: 'process_name', pid: 10, tid: 1, args: { name: 'Renderer' } }),
		event({ ph: 'M', name: 'thread_name', pid: 10, tid: 1, args: { name: 'CrRendererMain' } }),
		...([1_000, 2_000, 3_000].flatMap((timestamp, index) => [
			event({ ph: 'X', name: 'FrameRequestCallbackCollection::ExecuteFrameCallbacks', pid: 10, tid: 1, ts: timestamp, dur: 400 + index * 100, args: {} }),
			event({ ph: 'X', name: 'Commit', pid: 10, tid: 1, ts: timestamp + 400, dur: 100, args: { frameSeqId: 100 + index } }),
			event({ ph: 'X', name: 'Commit', pid: 10, tid: 2, ts: timestamp + 450, dur: 500, args: {} }),
			event({ ph: 'X', name: 'Surface::CommitFrame', pid: 20, tid: 3, ts: timestamp + 500, dur: 20, args: {} }),
			event({ ph: 'X', name: 'Display::DrawAndSwap', pid: 20, tid: 3, ts: timestamp + 550, dur: 80, args: {} }),
			event({ ph: 'X', name: 'DXGISwapChainImageBacking::Present', pid: 20, tid: 4, ts: timestamp + 650, dur: 120 + index * 10, args: {} }),
			event({ ph: 'b', name: 'SubmitCompositorFrameToPresentationCompositorFrame', pid: 10, tid: 2, ts: timestamp + 100, id2: { local: `main-${index}` }, args: {} }),
			event({ ph: 'b', name: 'SubmitCompositorFrameToPresentationCompositorFrame', pid: 10, tid: 2, ts: timestamp + 120, id2: { local: `impl-${index}` }, args: {} }),
			event({ ph: 'e', name: 'SubmitCompositorFrameToPresentationCompositorFrame', pid: 10, tid: 2, ts: timestamp + 500, id2: { local: `main-${index}` }, args: {} }),
			event({ ph: 'e', name: 'SubmitCompositorFrameToPresentationCompositorFrame', pid: 10, tid: 2, ts: timestamp + 500, id2: { local: `impl-${index}` }, args: {} }),
			event({ ph: 'I', name: 'WokFrameSubmitted', pid: 10, tid: 2, ts: timestamp + 510, args: { frame_token: index + 1 } }),
			event({ ph: 'I', name: 'WokFrameTerminal', pid: 10, tid: 2, ts: timestamp + 500, args: { frame_token: index + 1, status: index === 1 ? 'not_presented' : 'presented' } })
		])),
		event({ ph: 'I', name: 'Swap throttled', pid: 20, tid: 3, ts: 3_600, args: { pending_swaps: 1 } }),
		event({ ph: 'X', name: 'DCompPresenter::CheckPendingFrames', pid: 20, tid: 4, ts: 3_610, dur: 5, args: { num_pending_frames: 2 } }),
		'{}]}'
	];
	await writeFile(tracePath, `${lines.join('\n')}\n`, 'utf8');

	try {
		const report = await analyzeFrameTrace(tracePath);
		assert.equal(report.measurement_span_ms, 2.5);
		assert.equal(report.counts.callbacks, 3);
		assert.equal(report.counts.commit_events, 3, 'unrelated Commit slices are excluded');
		assert.equal(report.counts.unique_commit_frame_sequence_ids, 3);
		assert.equal(report.counts.viz_draw_and_swaps, 3);
		assert.equal(report.counts.dxgi_present_calls, 3);
		assert.equal(report.counts.presentation_reporter_spans, 6);
		assert.equal(report.counts.presentation_feedbacks, 3, 'main and impl reporters deduplicate by feedback timestamp');
		assert.equal(report.counts.ledger_submitted_frames, 3);
		assert.deepEqual(report.counts.ledger_outcomes, { not_presented: 1, presented: 2, unknown: 0 });
		assert.equal(report.rates.callback_fps, 1_200);
		assert.equal(report.rates.presentation_feedback_fps, 1_200);
		assert.equal(report.rates.ledger_presented_fps, 800);
		assert.equal(report.queue.swap_throttled_count, 1);
		assert.equal(report.queue.maximum_pending_swaps, 1);
		assert.equal(report.queue.maximum_dcomp_pending_frames, 2);
		assert.equal(report.stages.callback.p95_us, 600);
		assert.equal(report.stages.dxgi_present.p99_us, 140);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
