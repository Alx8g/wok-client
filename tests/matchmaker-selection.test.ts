import assert from 'node:assert/strict';
import test from 'node:test';
import {
	MATCHMAKER_MAX_RESPONSE_GAMES,
	parseMatchmakerGame,
	selectMatchmakerGame
} from '../src/matchmaker-selection.ts';
const gameModes = ['Free for All', 'Team Deathmatch'] as const;

const criteria: IMatchmakerCriteria = {
	gameModes: ['Free for All'],
	maxPlayers: 6,
	minPlayers: 1,
	minRemainingTime: 120,
	regions: ['FRA']
};

function game(id: string, players = 2, limit = 8, mode = 0, remaining = 180) {
	return [id, 0, players, limit, { g: mode, i: 'Burg' }, remaining];
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

test('selectMatchmakerGame skips malformed, full, current, and disallowed games', () => {
	const selected = selectMatchmakerGame({
		games: [
			['broken'],
			game('NY:wrong-region'),
			game('FRA:wrong-mode', 2, 8, 1),
			game('FRA:full', 8, 8),
			game('FRA:current'),
			game('FRA:eligible')
		]
	}, criteria, {
		currentMatch: '',
		currentUrl: 'https://krunker.io/?game=FRA:current'
	}, gameModes, () => 0);

	assert.equal(selected?.gameID, 'FRA:eligible');
});

test('selectMatchmakerGame validates the response envelope and processing budget', () => {
	assert.throws(() => selectMatchmakerGame(null, criteria, { currentMatch: '', currentUrl: '' }, gameModes), TypeError);
	assert.throws(() => selectMatchmakerGame({}, criteria, { currentMatch: '', currentUrl: '' }, gameModes), TypeError);
	assert.throws(() => selectMatchmakerGame({
		games: new Array(MATCHMAKER_MAX_RESPONSE_GAMES + 1)
	}, criteria, { currentMatch: '', currentUrl: '' }, gameModes), RangeError);
});

test('selectMatchmakerGame keeps reservoir selection deterministic with injected randomness', () => {
	const values = [0, 0.75, 0.2];
	const selected = selectMatchmakerGame({
		games: [game('FRA:first'), game('FRA:second'), game('FRA:third')]
	}, criteria, { currentMatch: '', currentUrl: '' }, gameModes, () => values.shift() ?? 1);
	assert.equal(selected?.gameID, 'FRA:third');
});
