import assert from 'node:assert/strict';
import test from 'node:test';
import { MatchmakerResponseTooLargeError, readBoundedMatchmakerJson } from '../src/matchmaker-response.ts';
function chunkedResponse(chunks: readonly Uint8Array[], onCancel?: () => void): Response {
	let index = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			cancel() {
				onCancel?.();
			},
			pull(controller) {
				const chunk = chunks[index];
				index += 1;
				if (chunk) controller.enqueue(chunk);
				else controller.close();
			}
		})
	);
}
test('parses a chunked response at the exact byte limit', async () => {
	const encoder = new TextEncoder();
	const first = encoder.encode('{"games":');
	const second = encoder.encode('[]}');
	const response = chunkedResponse([first, second]);
	assert.deepEqual(await readBoundedMatchmakerJson(response, first.byteLength + second.byteLength), { games: [] });
});
test('cancels a chunked response as soon as it exceeds the byte limit', async () => {
	const encoder = new TextEncoder();
	let cancelled = false;
	const response = chunkedResponse([encoder.encode('{"games":['), encoder.encode('1234567890')], () => {
		cancelled = true;
	});
	await assert.rejects(readBoundedMatchmakerJson(response, 12), MatchmakerResponseTooLargeError);
	assert.equal(cancelled, true);
});
test('rejects an oversized declared content length before reading', async () => {
	let pulled = false;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled = true;
				controller.enqueue(new TextEncoder().encode('{"games":[]}'));
				controller.close();
			}
		}),
		{ headers: { 'Content-Length': '1024' } }
	);
	await assert.rejects(readBoundedMatchmakerJson(response, 64), MatchmakerResponseTooLargeError);
	assert.equal(pulled, false);
});
test('propagates malformed JSON without allocating beyond the bound', async () => {
	const body = '{"games":[';
	await assert.rejects(readBoundedMatchmakerJson(new Response(body), Buffer.byteLength(body)), SyntaxError);
});
test('rejects unavailable bodies and invalid limits', async () => {
	await assert.rejects(readBoundedMatchmakerJson(new Response(null), 64), /response body is unavailable/u);
	await assert.rejects(readBoundedMatchmakerJson(new Response('{}'), 0), RangeError);
});
