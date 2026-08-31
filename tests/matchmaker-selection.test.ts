import assert from 'node:assert/strict';
import test from 'node:test';
import { collectMatchmakerCandidates, MATCHMAKER_MAX_RESPONSE_GAMES, parseMatchmakerGame, rankMatchmakerCandidates, selectMatchmakerGame, selectRevalidatedMatchmakerGame } from '../src/matchmaker-selection.ts';
const gameModes = ['Free for All', 'Team Deathmatch'] as const;
const criteria: IMatchmakerCriteria = {
	gameModes: ['Free for All'],
	mapScope: 'all',
	maps: [],
	maxPlayers: 6,
	minPlayers: 1,
	minRemainingTime: 120,
	regions: ['FRA']
};
function game(id: string, players = 2, limit = 8, mode = 0, remaining = 180, map = 'Burg', detailOverrides: Record<string, unknown> = {}): unknown[] {
	return [id, 0, players, limit, { c: 0, cm: 0, g: mode, i: map, ...detailOverrides }, remaining];
}
const emptyContext = { currentMatch: '', currentUrl: '' };
function collect(games: unknown[], overrides: Partial<IMatchmakerCriteria> = {}) {
	return collectMatchmakerCandidates(
		{ games },
		{
			...criteria,
			...overrides
		},
		emptyContext,
		gameModes
	);
}
function candidate(id: string, players = 2, remaining = 180): IMatchmakerGame {
	const parsed = parseMatchmakerGame(game(id, players, 8, 0, remaining), gameModes);
	assert.ok(parsed);
	return parsed;
}
test('parseMatchmakerGame validates tuple shape and numeric bounds', () => {
	assert.deepEqual(parseMatchmakerGame(game('FRA:abc'), gameModes), {
		gameID: 'FRA:abc',
		gamemode: 'Free for All',
		map: 'Burg',
		playerCount: 2,
		playerLimit: 8,
		region: 'FRA',
		remainingTime: 180
	});
	assert.equal(parseMatchmakerGame(['broken'], gameModes), undefined);
	assert.equal(parseMatchmakerGame(game('FRA:full', 9, 8), gameModes), undefined);
	assert.equal(parseMatchmakerGame(['FRA:bad', 0, 1, 8, { g: 0 }, 180], gameModes), undefined);
});
test('collectMatchmakerCandidates treats empty region and mode filters as unrestricted', () => {
	const candidates = collect([game('SYD:unknown-mode', 2, 8, 99), game('MOON:unknown-region'), game('FRA:joinable-seven', 7, 8), game('FRA:full', 8, 8), game('FRA:over-capacity', 9, 8)], {
		gameModes: [],
		maxPlayers: 7,
		regions: []
	});
	assert.deepEqual(
		candidates.map((candidate) => candidate.gameID),
		['SYD:unknown-mode', 'MOON:unknown-region', 'FRA:joinable-seven']
	);
});
test('unknown endpoint values require the corresponding filter to be unrestricted', () => {
	assert.deepEqual(
		collect([game('MOON:unknown-region')], {
			gameModes: [],
			regions: ['MOON']
		}),
		[]
	);
	assert.deepEqual(
		collect([game('FRA:unknown-mode', 2, 8, 99)], {
			gameModes: ['Unknown Gamemode'],
			regions: []
		}),
		[]
	);
});
test('collectMatchmakerCandidates rejects a full lobby at its reported limit', () => {
	const candidates = collect([game('FRA:joinable', 7, 8), game('FRA:full', 8, 8)], {
		maxPlayers: 8
	});
	assert.deepEqual(
		candidates.map((candidate) => candidate.gameID),
		['FRA:joinable']
	);
});
test('empty region and mode filters remain independent', () => {
	const games = [game('SYD:free-for-all'), game('FRA:team-deathmatch', 2, 8, 1)];
	assert.deepEqual(
		collect(games, {
			regions: []
		}).map((candidate) => candidate.gameID),
		['SYD:free-for-all']
	);
	assert.deepEqual(
		collect(games, {
			gameModes: []
		}).map((candidate) => candidate.gameID),
		['FRA:team-deathmatch']
	);
});
test('collectMatchmakerCandidates preserves endpoint order before final selection', () => {
	const candidates = collect([game('FRA:first'), game('FRA:second'), game('FRA:third')]);
	assert.deepEqual(
		candidates.map((candidate) => candidate.gameID),
		['FRA:first', 'FRA:second', 'FRA:third']
	);
});
test('official map scope accepts normalized official maps and rejects other maps', () => {
	const candidates = collect([game('FRA:burg', 2, 8, 0, 180, 'Burg'), game('FRA:sky-temple', 2, 8, 0, 180, 'sky_temple'), game('FRA:custom', 2, 8, 0, 180, 'AIM Room')], {
		mapScope: 'official'
	});
	assert.deepEqual(
		candidates.map((candidate) => candidate.gameID),
		['FRA:burg', 'FRA:sky-temple']
	);
});
test('official map scope combines selected maps with the official whitelist across all regions', () => {
	const candidates = collect(
		[game('FRA:selected-official', 2, 8, 0, 180, 'Burg'), game('NY:selected-official', 2, 8, 0, 180, 'burg'), game('DAL:unselected-official', 2, 8, 0, 180, 'Site'), game('SYD:selected-custom', 2, 8, 0, 180, 'AIM Room')],
		{
			gameModes: [],
			mapScope: 'official',
			maps: ['  burg  ', 'AIM_Room'],
			regions: []
		}
	);
	assert.deepEqual(
		candidates.map((candidate) => candidate.gameID),
		['FRA:selected-official', 'NY:selected-official']
	);
});
test('official map scope rejects custom lobbies that reuse an official map name', () => {
	const missingMarkers = game('FRA:missing-markers');
	missingMarkers[4] = { g: 0, i: 'Burg' };
	const candidates = collect(
		[
			game('FRA:official'),
			game('FRA:custom-game', 2, 8, 0, 180, 'Burg', { c: 1 }),
			game('FRA:custom-map', 2, 8, 0, 180, 'Burg', { cm: 42 }),
			game('FRA:malformed-markers', 2, 8, 0, 180, 'Burg', { c: '0', cm: '0' }),
			missingMarkers
		],
		{
			mapScope: 'official'
		}
	);
	assert.deepEqual(
		candidates.map((candidate) => candidate.gameID),
		['FRA:official']
	);
});
test('selected map scope uses normalized selected identifiers, including custom lobbies', () => {
	const candidates = collect([game('FRA:selected', 2, 8, 0, 180, 'Krunk_Plaza', { c: 1, cm: 42 }), game('FRA:not-selected', 2, 8, 0, 180, 'Burg')], {
		mapScope: 'selected',
		maps: ['  krunk plaza  ']
	});
	assert.deepEqual(
		candidates.map((candidate) => candidate.gameID),
		['FRA:selected']
	);
});
test('selected map scope with no maps rejects every lobby', () => {
	assert.deepEqual(
		collect([game('FRA:burg')], {
			mapScope: 'selected',
			maps: []
		}),
		[]
	);
});
test('all map scope accepts official and community maps', () => {
	const candidates = collect([game('FRA:official', 2, 8, 0, 180, 'Burg'), game('FRA:community', 2, 8, 0, 180, 'AIM_Room', { c: 1, cm: 42 })], {
		mapScope: 'all'
	});
	assert.deepEqual(
		candidates.map((candidate) => candidate.gameID),
		['FRA:official', 'FRA:community']
	);
});
test('selectMatchmakerGame skips malformed, full, current, and disallowed games', () => {
	const selected = selectMatchmakerGame(
		{
			games: [['broken'], game('NY:wrong-region'), game('FRA:wrong-mode', 2, 8, 1), game('FRA:full', 8, 8), game('FRA:current'), game('FRA:eligible')]
		},
		criteria,
		{
			currentMatch: '',
			currentUrl: 'https://krunker.io/?game=FRA:current'
		},
		gameModes,
		() => 0
	);
	assert.equal(selected?.gameID, 'FRA:eligible');
});
test('selectMatchmakerGame validates the response envelope and processing budget', () => {
	assert.throws(() => selectMatchmakerGame(null, criteria, emptyContext, gameModes), TypeError);
	assert.throws(() => selectMatchmakerGame({}, criteria, emptyContext, gameModes), TypeError);
	assert.throws(
		() =>
			selectMatchmakerGame(
				{
					games: new Array(MATCHMAKER_MAX_RESPONSE_GAMES + 1)
				},
				criteria,
				emptyContext,
				gameModes
			),
		RangeError
	);
});
test('selectMatchmakerGame keeps reservoir selection deterministic with injected randomness', () => {
	const values = [0, 0.75, 0.2];
	const selected = selectMatchmakerGame(
		{
			games: [game('FRA:first'), game('FRA:second'), game('FRA:third')]
		},
		criteria,
		emptyContext,
		gameModes,
		() => values.shift() ?? 1
	);
	assert.equal(selected?.gameID, 'FRA:third');
});
test('candidate ranking prioritizes measured latency before occupancy', () => {
	const ranked = rankMatchmakerCandidates(
		[candidate('NY:busy', 7, 600), candidate('FRA:fast', 2, 180)],
		{
			FRA: 20,
			NY: 60
		},
		() => 0
	);
	assert.deepEqual(
		ranked.map((value) => value.gameID),
		['FRA:fast', 'NY:busy']
	);
});
test('occupancy and then remaining time break equal-latency ties', () => {
	const ranked = rankMatchmakerCandidates(
		[candidate('FRA:low-occupancy', 3, 600), candidate('FRA:shorter', 6, 180), candidate('FRA:longer', 6, 300)],
		{
			FRA: 25
		},
		() => 0
	);
	assert.deepEqual(
		ranked.map((value) => value.gameID),
		['FRA:longer', 'FRA:shorter', 'FRA:low-occupancy']
	);
});
test('unknown and invalid latency regions remain ordered fallbacks', () => {
	const ranked = rankMatchmakerCandidates(
		[candidate('NY:unknown-busy', 7, 600), candidate('SYD:invalid', 6, 500), candidate('FRA:measured', 1, 120), candidate('DAL:unknown-longer', 5, 400), candidate('TOK:unknown-shorter', 5, 300)],
		{
			FRA: 40,
			NY: Number.NaN,
			SYD: -1
		},
		() => 0
	);
	assert.deepEqual(
		ranked.map((value) => value.gameID),
		['FRA:measured', 'NY:unknown-busy', 'SYD:invalid', 'DAL:unknown-longer', 'TOK:unknown-shorter']
	);
});
test('candidate ranking preserves endpoint order for exact ties', () => {
	const ranked = rankMatchmakerCandidates(
		[candidate('FRA:first'), candidate('FRA:second'), candidate('FRA:third')],
		{
			FRA: 30
		},
		() => 0
	);
	assert.deepEqual(
		ranked.map((value) => value.gameID),
		['FRA:first', 'FRA:second', 'FRA:third']
	);
});
test('candidate ranking randomizes the first choice only within the comparable top pool', () => {
	const ranked = rankMatchmakerCandidates(
		[candidate('FRA:best', 7, 500), candidate('NY:comparable', 6, 460), candidate('DAL:too-empty', 4, 500), candidate('SYD:too-slow', 7, 500), candidate('TOK:too-short', 7, 300)],
		{
			DAL: 35,
			FRA: 20,
			NY: 30,
			SYD: 41,
			TOK: 35
		},
		() => 0.99
	);
	assert.deepEqual(
		ranked.map((value) => value.gameID),
		['NY:comparable', 'FRA:best', 'TOK:too-short', 'DAL:too-empty', 'SYD:too-slow']
	);
});
test('revalidation falls back to the next ranked lobby and returns fresh data', () => {
	const ranked = [candidate('FRA:filled', 7, 400), candidate('NY:fallback', 5, 300), candidate('DAL:last', 4, 200)];
	const freshFallback = candidate('NY:fallback', 6, 250);
	const selected = selectRevalidatedMatchmakerGame(ranked, [freshFallback, candidate('DAL:last', 5, 150)]);
	assert.equal(selected, freshFallback);
	assert.equal(selected?.playerCount, 6);
	assert.equal(selected?.remainingTime, 250);
});
test('revalidation returns no lobby when every ranked candidate disappeared', () => {
	const selected = selectRevalidatedMatchmakerGame([candidate('FRA:first'), candidate('NY:second')], [candidate('SYD:unranked')]);
	assert.equal(selected, undefined);
});
