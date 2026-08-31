export const MATCHMAKER_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export class MatchmakerResponseTooLargeError extends Error {
	public constructor(maxBytes: number) {
		super(`Matchmaker response exceeds ${maxBytes} bytes`);
		this.name = 'MatchmakerResponseTooLargeError';
	}
}
export async function readBoundedMatchmakerJson(response: Response, maxBytes = MATCHMAKER_MAX_RESPONSE_BYTES): Promise<unknown> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('maxBytes must be a positive safe integer');
	const declaredLength = response.headers.get('Content-Length');
	if (declaredLength !== null) {
		const parsedLength = Number(declaredLength);
		if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
			await response.body?.cancel();
			throw new MatchmakerResponseTooLargeError(maxBytes);
		}
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error('Matchmaker response body is unavailable');
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				throw new MatchmakerResponseTooLargeError(maxBytes);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
