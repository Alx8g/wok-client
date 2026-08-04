/**
 * Diagnostic-only search for where Krunker keeps the local player's name.
 *
 * Automatic detection reads `getGameActivity().user`, which did not resolve on a real account, so
 * the user had to type their name in by hand. Rather than guess another source, this searches the
 * places a name could live for a value the user has already told us, and reports every hit. The
 * winning source then becomes the detection path.
 *
 * Inert unless WOK_FIND_IDENTITY is set.
 */

export interface IdentitySourceHit {
	/** Dotted path or storage key where the value was found. */
	location: string;
	/** How the value sat in the container: exact match, or embedded in a larger string. */
	match: 'exact' | 'contains';
	source: 'global' | 'storage' | 'activity' | 'dom';
	/** Trimmed context so a maintainer can tell a display string from an account field. */
	sample: string;
}

export interface IdentityProbeHooks {
	/** The name the user typed in, i.e. the needle. */
	needle: string;
	readActivity(): unknown;
	readGlobals(): Record<string, unknown>;
	readStorage(): Record<string, string>;
	searchDom(needle: string): { location: string; sample: string }[];
}

const MAX_DEPTH = 4;
const MAX_HITS = 60;
const SAMPLE_LIMIT = 160;

function sampleOf(value: unknown): string {
	const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
	return text.length > SAMPLE_LIMIT ? `${text.slice(0, SAMPLE_LIMIT)}...` : text;
}

/** Walks a value looking for the needle, recording where each hit sits. */
export function findIdentityIn(
	value: unknown,
	needle: string,
	source: IdentitySourceHit['source'],
	path = '',
	depth = 0,
	hits: IdentitySourceHit[] = []
): IdentitySourceHit[] {
	if (hits.length >= MAX_HITS || depth > MAX_DEPTH || value === null || value === undefined) return hits;

	if (typeof value === 'string') {
		// Case-insensitive: a stored account name may not match the casing the user typed.
		const lowered = value.toLowerCase();
		const target = needle.toLowerCase();
		if (lowered === target) hits.push({ location: path, match: 'exact', sample: sampleOf(value), source });
		else if (lowered.includes(target)) hits.push({ location: path, match: 'contains', sample: sampleOf(value), source });
		return hits;
	}
	if (typeof value !== 'object') return hits;

	// Arrays and plain objects only; anything exotic is skipped rather than risking a getter.
	const entries = Array.isArray(value)
		? value.map((item, index) => [String(index), item] as const)
		: Object.entries(value as Record<string, unknown>);
	for (const [key, child] of entries) {
		findIdentityIn(child, needle, source, path ? `${path}.${key}` : key, depth + 1, hits);
		if (hits.length >= MAX_HITS) break;
	}
	return hits;
}

export function probeIdentitySources(hooks: IdentityProbeHooks): IdentitySourceHit[] {
	const needle = hooks.needle.trim();
	if (needle.length === 0) return [];
	const hits: IdentitySourceHit[] = [];

	const safely = (run: () => void) => {
		try { run(); } catch (_error) { /* a throwing getter must not end the probe */ }
	};

	safely(() => { hits.push(...findIdentityIn(hooks.readActivity(), needle, 'activity', 'getGameActivity()')); });
	safely(() => {
		for (const [key, value] of Object.entries(hooks.readStorage())) {
			hits.push(...findIdentityIn(value, needle, 'storage', `localStorage[${key}]`));
		}
	});
	safely(() => {
		for (const [key, value] of Object.entries(hooks.readGlobals())) {
			hits.push(...findIdentityIn(value, needle, 'global', `window.${key}`));
		}
	});
	safely(() => {
		for (const found of hooks.searchDom(needle)) {
			hits.push({ location: found.location, match: 'contains', sample: sampleOf(found.sample), source: 'dom' });
		}
	});

	return hits.slice(0, MAX_HITS);
}

/**
 * What the candidate sources actually hold, printed when the needle is not found. A probe that
 * only says "not here" cannot tell an absent value from a source that was never populated, or
 * from a search that looked in the wrong shape.
 */
export function formatIdentityContext(context: Readonly<Record<string, unknown>>): string {
	const lines = Object.entries(context).map(([label, value]) => {
		if (value === undefined) return `  ${label}: undefined`;
		if (value === null) return `  ${label}: null`;
		if (Array.isArray(value)) return `  ${label}: [${value.length}] ${sampleOf(value)}`;
		if (typeof value === 'object') return `  ${label}: {${Object.keys(value as object).join(', ')}} ${sampleOf(value)}`;
		return `  ${label}: ${sampleOf(value)}`;
	});
	return `[wok-identity] source contents:\n${lines.join('\n')}`;
}

export function formatIdentityProbe(hits: readonly IdentitySourceHit[]): string {
	if (hits.length === 0) return '[wok-identity] needle not found in any source';
	const exact = hits.filter(hit => hit.match === 'exact');
	const lines = hits.map(hit => `  ${hit.match === 'exact' ? 'EXACT  ' : 'contains'} ${hit.source.padEnd(8)} ${hit.location}  ${hit.sample}`);
	return `[wok-identity] ${hits.length} hit(s), ${exact.length} exact\n${lines.join('\n')}`;
}
