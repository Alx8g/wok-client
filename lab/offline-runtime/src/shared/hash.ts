import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256Hex(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

export async function sha256FileHex(filePath: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest('hex');
}

function normalizeCanonicalValue(value: unknown, seen: Set<object>): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not support non-finite numbers.');
		return value;
	}
	if (Array.isArray(value)) return value.map(item => normalizeCanonicalValue(item, seen));
	if (typeof value !== 'object') throw new TypeError(`Canonical JSON does not support ${typeof value} values.`);
	if (seen.has(value)) throw new TypeError('Canonical JSON does not support circular references.');

	seen.add(value);
	const normalized: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const item = (value as Record<string, unknown>)[key];
		if (item === undefined) continue;
		normalized[key] = normalizeCanonicalValue(item, seen);
	}
	seen.delete(value);
	return normalized;
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(normalizeCanonicalValue(value, new Set()));
}
