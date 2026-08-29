import { MATCHMAKER_REGION_NAMES, MATCHMAKER_REGIONS } from './matchmaker-data.ts';

export type PublicServerRegionKind = 'fixed' | 'geographic' | 'unknown';

export interface PublicServerRegionPingEntry {
	region: string;
	pingMs?: number | string | null;
}

export interface PublicServerRegionSortOptions {
	/** Additional labels used by the Public screen for non-geographic sections. */
	fixedCategories?: readonly string[];
	/** Additional region codes or labels recognised as geographic. */
	geographicRegions?: readonly string[];
}

const DEFAULT_FIXED_CATEGORY_LABELS = [
	'all',
	'all servers',
	'any',
	'community',
	'community servers',
	'custom',
	'custom games',
	'custom servers',
	'featured',
	'featured servers',
	'eu super secret servers',
	'favorites',
	'favourites',
	'official',
	'official customs',
	'official rotation',
	'official servers',
	'other',
	'others',
	'recommended',
	'recommended servers',
	'special',
	'super secret servers',
	'super secret',
	'sss'
] as const;

/** The labels that stay ahead of geographic rows when no screen-specific labels are supplied. */
export const PUBLIC_SERVER_FIXED_CATEGORIES: readonly string[] = DEFAULT_FIXED_CATEGORY_LABELS;

const ADDITIONAL_REGION_ALIASES: Readonly<Record<string, readonly string[]>> = {
	AFR: ['za-cpt', 'cape town', 'south africa'],
	BHN: ['me-bhn', 'middle east'],
	BRZ: ['brz', 'brazil'],
	CHI: ['cn-sh', 'shanghai', 'china'],
	DAL: ['us-tx', 'dallas'],
	FRA: ['de-fra', 'frankfurt'],
	LON: ['gb-lon', 'london'],
	MBI: ['as-mb', 'mumbai'],
	MIA: ['us-fl', 'miami'],
	MX: ['mx', 'mexico'],
	NY: ['us-nj', 'new york', 'new york city'],
	SIN: ['sgp', 'singapore'],
	STL: ['us-wa', 'seattle'],
	SV: ['us-ca-sv', 'silicon valley'],
	SYD: ['au-syd', 'sydney'],
	TOK: ['jb-hnd', 'tokyo']
};

function normalizeRegionLabel(value: string): string {
	return value.normalize('NFKC').trim().toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function buildGeographicRegionLookup(): ReadonlyMap<string, string> {
	const lookup = new Map<string, string>();
	for (const region of MATCHMAKER_REGIONS) {
		const aliases = [
			region,
			MATCHMAKER_REGION_NAMES[region as keyof typeof MATCHMAKER_REGION_NAMES],
			...(ADDITIONAL_REGION_ALIASES[region] ?? [])
		];
		for (const alias of aliases) {
			if (alias) lookup.set(normalizeRegionLabel(alias), region);
		}
	}
	return lookup;
}

function buildGeographicRegionSet(additionalRegions: readonly string[] = []): ReadonlySet<string> {
	const aliases = new Set(buildGeographicRegionLookup().keys());
	for (const region of additionalRegions) {
		if (typeof region === 'string' && region.trim().length > 0) aliases.add(normalizeRegionLabel(region));
	}
	return aliases;
}

function buildFixedCategorySet(additionalCategories: readonly string[] = []): ReadonlySet<string> {
	return new Set([
		...DEFAULT_FIXED_CATEGORY_LABELS.map(normalizeRegionLabel),
		...additionalCategories
			.filter(category => typeof category === 'string' && category.trim().length > 0)
			.map(normalizeRegionLabel)
	]);
}

/** Resolve a displayed code/name/endpoint alias to the canonical code used by the latency service. */
export function resolvePublicServerRegionCode(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.trim().length === 0) return undefined;
	return buildGeographicRegionLookup().get(normalizeRegionLabel(value));
}

/** Classify a Public-screen section without treating unknown labels as geographic. */
export function classifyPublicServerRegion(
	value: unknown,
	options: PublicServerRegionSortOptions = {}
): PublicServerRegionKind {
	if (typeof value !== 'string' || value.trim().length === 0) return 'unknown';
	const normalized = normalizeRegionLabel(value);
	if (buildFixedCategorySet(options.fixedCategories).has(normalized)) return 'fixed';
	if (buildGeographicRegionSet(options.geographicRegions).has(normalized)) return 'geographic';
	return 'unknown';
}

function numericPing(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return Number.isFinite(value) && value >= 0 ? value : undefined;
	}
	if (typeof value !== 'string') return undefined;
	const text = value.trim();
	const match = /^(\d+(?:\.\d+)?)\s*(?:ms)?$/iu.exec(text);
	if (!match) return undefined;
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Format a measured ping for the compact label used beside a Public-screen region. */
export function formatPublicServerPingLabel(value: unknown, unknownLabel = '—'): string {
	const ping = numericPing(value);
	return ping === undefined ? unknownLabel : `${Math.round(ping)} ms`;
}

/**
 * Return a new list with fixed sections first, measured geographic regions next, and unresolved
 * rows last. Every tie, including the unresolved section, keeps the source order.
 */
export function sortPublicServerRegions<T extends PublicServerRegionPingEntry>(
	entries: readonly T[],
	options: PublicServerRegionSortOptions = {}
): T[] {
	const fixedCategories = buildFixedCategorySet(options.fixedCategories);
	const geographicRegions = buildGeographicRegionSet(options.geographicRegions);
	const ranked = entries.map((entry, index) => {
		const normalized = typeof entry.region === 'string' ? normalizeRegionLabel(entry.region) : '';
		const kind: PublicServerRegionKind = fixedCategories.has(normalized)
			? 'fixed'
			: geographicRegions.has(normalized) ? 'geographic' : 'unknown';
		return { entry, index, kind, ping: kind === 'geographic' ? numericPing(entry.pingMs) : undefined };
	});

	ranked.sort((left, right) => {
		const leftRank = left.kind === 'fixed' ? 0 : left.kind === 'geographic' && left.ping !== undefined ? 1 : 2;
		const rightRank = right.kind === 'fixed' ? 0 : right.kind === 'geographic' && right.ping !== undefined ? 1 : 2;
		if (leftRank !== rightRank) return leftRank - rightRank;
		if (leftRank === 1 && rightRank === 1 && left.ping !== right.ping) {
			const leftPing = left.ping;
			const rightPing = right.ping;
			if (leftPing !== undefined && rightPing !== undefined) return leftPing - rightPing;
		}
		return left.index - right.index;
	});

	return ranked.map(item => item.entry);
}
