import {
	MATCHMAKER_OFFICIAL_MAPS,
	MATCHMAKER_REGIONS,
	normalizeMatchmakerMapIdentifier
} from './matchmaker-data.ts';

export const MATCHMAKER_MAX_RESPONSE_GAMES = 10_000;

const KNOWN_MATCHMAKER_REGIONS = new Set(MATCHMAKER_REGIONS);
const OFFICIAL_MATCHMAKER_MAP_IDENTIFIERS = new Set(MATCHMAKER_OFFICIAL_MAPS.map(normalizeMatchmakerMapIdentifier));

export interface MatchmakerSelectionContext {
	currentMatch: string;
	currentUrl: string;
}

function finiteInteger(value: unknown, minimum = 0): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= minimum ? value : undefined;
}

export function parseMatchmakerGame(value: unknown, gameModes: readonly string[]): IMatchmakerGame | undefined {
	if (!Array.isArray(value) || value.length < 6) return undefined;
	const gameID = value[0];
	const playerCount = finiteInteger(value[2]);
	const playerLimit = finiteInteger(value[3], 1);
	const details = value[4];
	const remainingTime = finiteInteger(value[5]);
	if (
		typeof gameID !== 'string'
		|| gameID.length === 0
		|| gameID.length > 256
		|| !gameID.includes(':')
		|| playerCount === undefined
		|| playerLimit === undefined
		|| playerCount > playerLimit
		|| remainingTime === undefined
		|| !details
		|| typeof details !== 'object'
		|| Array.isArray(details)
	) return undefined;

	const rawDetails = details as Record<string, unknown>;
	const map = rawDetails.i;
	const gameModeIndex = finiteInteger(rawDetails.g);
	if (typeof map !== 'string' || map.length === 0 || map.length > 128 || gameModeIndex === undefined) return undefined;

	return {
		gameID,
		region: gameID.split(':', 1)[0],
		playerCount,
		playerLimit,
		map,
		gamemode: gameModes[gameModeIndex] ?? 'Unknown Gamemode',
		remainingTime
	};
}

function matchmakerResponseGames(value: unknown): unknown[] {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Matchmaker response was not an object.');
	const games = (value as Record<string, unknown>).games;
	if (!Array.isArray(games)) throw new TypeError('Matchmaker response did not contain a games array.');
	if (games.length > MATCHMAKER_MAX_RESPONSE_GAMES) throw new RangeError(`Matchmaker response exceeded ${MATCHMAKER_MAX_RESPONSE_GAMES} games.`);
	return games;
}

/** Official rotation lobbies report both the custom-game and custom-map markers as zero. */
function isOfficialMatchmakerLobby(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	const details = value[4];
	if (!details || typeof details !== 'object' || Array.isArray(details)) return false;
	const rawDetails = details as Record<string, unknown>;
	return rawDetails.c === 0 && rawDetails.cm === 0;
}

function allowedMatchmakerMapIdentifiers(criteria: IMatchmakerCriteria): ReadonlySet<string> | undefined {
	if (criteria.mapScope === 'all') return undefined;
	const selectedIdentifiers = new Set(criteria.maps
		.map(normalizeMatchmakerMapIdentifier)
		.filter(identifier => identifier.length > 0));
	if (criteria.mapScope === 'official') {
		if (selectedIdentifiers.size === 0) return OFFICIAL_MATCHMAKER_MAP_IDENTIFIERS;
		return new Set([...selectedIdentifiers]
			.filter(identifier => OFFICIAL_MATCHMAKER_MAP_IDENTIFIERS.has(identifier)));
	}
	if (criteria.mapScope === 'selected') return selectedIdentifiers;
	return new Set();
}

const MATCHMAKER_COMPARABLE_LATENCY_MS = 20;
const MATCHMAKER_COMPARABLE_PLAYER_DEFICIT = 2;
const MATCHMAKER_COMPARABLE_REMAINING_TIME_DEFICIT = 60;
const MATCHMAKER_COMPARABLE_POOL_LIMIT = 8;
const MATCHMAKER_MAX_VALID_LATENCY_MS = 60_000;

interface RankedMatchmakerCandidate {
	game: IMatchmakerGame;
	index: number;
	latencyMs?: number;
}

/** The only place a raw latency payload is trusted, shared by ranking and by the popup's ping. */
export function matchmakerRegionLatency(
	latencies: Readonly<Record<string, unknown>>,
	region: string
): number | undefined {
	if (!Object.prototype.hasOwnProperty.call(latencies, region)) return undefined;
	const value = latencies[region];
	return typeof value === 'number'
		&& Number.isFinite(value)
		&& value >= 0
		&& value <= MATCHMAKER_MAX_VALID_LATENCY_MS
		? value
		: undefined;
}

function compareRankedMatchmakerCandidates(
	left: RankedMatchmakerCandidate,
	right: RankedMatchmakerCandidate
): number {
	if (left.latencyMs === undefined) {
		if (right.latencyMs !== undefined) return 1;
	} else if (right.latencyMs === undefined) {
		return -1;
	} else if (left.latencyMs !== right.latencyMs) {
		return left.latencyMs - right.latencyMs;
	}

	return right.game.playerCount - left.game.playerCount
		|| right.game.remainingTime - left.game.remainingTime
		|| left.index - right.index;
}

function isComparableMatchmakerCandidate(
	candidate: RankedMatchmakerCandidate,
	best: RankedMatchmakerCandidate
): boolean {
	const comparableLatency = best.latencyMs === undefined
		? candidate.latencyMs === undefined
		: candidate.latencyMs !== undefined
			&& candidate.latencyMs - best.latencyMs <= MATCHMAKER_COMPARABLE_LATENCY_MS;

	return comparableLatency
		&& candidate.game.playerCount >= best.game.playerCount - MATCHMAKER_COMPARABLE_PLAYER_DEFICIT
		&& candidate.game.remainingTime >= best.game.remainingTime - MATCHMAKER_COMPARABLE_REMAINING_TIME_DEFICIT;
}

export function rankMatchmakerCandidates(
	candidates: readonly IMatchmakerGame[],
	latencies: Readonly<Record<string, unknown>>,
	random: () => number = Math.random
): IMatchmakerGame[] {
	const ranked = candidates.map((game, index): RankedMatchmakerCandidate => ({
		game,
		index,
		latencyMs: matchmakerRegionLatency(latencies, game.region)
	}));
	ranked.sort(compareRankedMatchmakerCandidates);
	if (ranked.length < 2) return ranked.map(candidate => candidate.game);

	const best = ranked[0];
	const comparable = ranked
		.filter(candidate => isComparableMatchmakerCandidate(candidate, best))
		.slice(0, MATCHMAKER_COMPARABLE_POOL_LIMIT);
	if (comparable.length < 2) return ranked.map(candidate => candidate.game);

	const sample = random();
	const normalizedSample = Number.isFinite(sample)
		? Math.min(Math.max(sample, 0), 1 - Number.EPSILON)
		: 0;
	const selected = comparable[Math.floor(normalizedSample * comparable.length)];
	if (selected === best) return ranked.map(candidate => candidate.game);

	return [
		selected.game,
		...ranked
			.filter(candidate => candidate !== selected)
			.map(candidate => candidate.game)
	];
}

export function selectRevalidatedMatchmakerGame(
	rankedCandidates: readonly IMatchmakerGame[],
	freshCandidates: readonly IMatchmakerGame[]
): IMatchmakerGame | undefined {
	const freshByGameId = new Map<string, IMatchmakerGame>();
	for (const game of freshCandidates) {
		if (!freshByGameId.has(game.gameID)) freshByGameId.set(game.gameID, game);
	}
	for (const ranked of rankedCandidates) {
		const fresh = freshByGameId.get(ranked.gameID);
		if (fresh) return fresh;
	}
	return undefined;
}

export function collectMatchmakerCandidates(
	value: unknown,
	criteria: IMatchmakerCriteria,
	context: MatchmakerSelectionContext,
	gameModes: readonly string[]
): IMatchmakerGame[] {
	const games = matchmakerResponseGames(value);
	const knownGameModes = new Set(gameModes);
	const allowedRegions = new Set(criteria.regions.filter(region => KNOWN_MATCHMAKER_REGIONS.has(region)));
	const allowedGameModes = new Set(criteria.gameModes.filter(gameMode => knownGameModes.has(gameMode)));
	const allowedMapIdentifiers = allowedMatchmakerMapIdentifiers(criteria);
	const restrictRegions = criteria.regions.length > 0;
	const restrictGameModes = criteria.gameModes.length > 0;
	const candidates: IMatchmakerGame[] = [];

	for (const value of games) {
		const game = parseMatchmakerGame(value, gameModes);
		if (!game) continue;
		if (
			(restrictRegions && !allowedRegions.has(game.region))
			|| (restrictGameModes && !allowedGameModes.has(game.gamemode))
			|| (criteria.mapScope === 'official' && !isOfficialMatchmakerLobby(value))
			|| (allowedMapIdentifiers && !allowedMapIdentifiers.has(normalizeMatchmakerMapIdentifier(game.map)))
			|| game.playerCount < criteria.minPlayers
			|| game.playerCount > criteria.maxPlayers
			|| game.remainingTime < criteria.minRemainingTime
			|| game.playerCount >= game.playerLimit
			|| context.currentUrl.includes(game.gameID)
			|| context.currentMatch === game.gameID
		) continue;
		candidates.push(game);
	}

	return candidates;
}

export function selectMatchmakerGame(
	value: unknown,
	criteria: IMatchmakerCriteria,
	context: MatchmakerSelectionContext,
	gameModes: readonly string[],
	random: () => number = Math.random
): IMatchmakerGame | undefined {
	const candidates = collectMatchmakerCandidates(value, criteria, context, gameModes);
	let selectedGame: IMatchmakerGame | undefined;

	for (let index = 0; index < candidates.length; index++) {
		if (random() < 1 / (index + 1)) selectedGame = candidates[index];
	}

	return selectedGame;
}
