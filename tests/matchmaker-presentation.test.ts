import assert from 'node:assert/strict';
import test from 'node:test';
import {
	type MatchmakerHotkeyLabels,
	matchmakerCancelledView,
	matchmakerDurationLabel,
	matchmakerErrorView,
	matchmakerFilterChips,
	matchmakerLobbyChips,
	matchmakerLobbyView,
	matchmakerNoGamesView,
	matchmakerNoResultsHint,
	matchmakerPingChip,
	matchmakerRegionLabel,
	matchmakerSearchingView,
	matchmakerTimeLeftChip
} from '../src/matchmaker-presentation.ts';

const hotkeys: MatchmakerHotkeyLabels = { accept: 'ENTER', cancel: 'ESCAPE', search: 'F1' };

function criteria(overrides: Partial<IMatchmakerCriteria> = {}): IMatchmakerCriteria {
	return {
		gameModes: [],
		mapScope: 'official',
		maps: [],
		maxPlayers: 6,
		minPlayers: 1,
		minRemainingTime: 120,
		regions: [],
		...overrides
	};
}

function lobby(overrides: Partial<IMatchmakerGame> = {}): IMatchmakerGame {
	return {
		gameID: 'FRA:abc',
		gamemode: 'Team Deathmatch',
		map: 'Burg',
		playerCount: 4,
		playerLimit: 8,
		region: 'FRA',
		remainingTime: 150,
		...overrides
	};
}

test('durations read as seconds under a minute and minutes above it', () => {
	assert.equal(matchmakerDurationLabel(0), '0s');
	assert.equal(matchmakerDurationLabel(45), '45s');
	assert.equal(matchmakerDurationLabel(150), '2m 30s');
	assert.equal(matchmakerDurationLabel(-10), '0s');
	assert.equal(matchmakerDurationLabel(Number.NaN), '0s');
});

test('regions show their full name and unknown codes fall back to the code itself', () => {
	assert.equal(matchmakerRegionLabel('FRA'), 'Frankfurt');
	assert.equal(matchmakerRegionLabel('MOON'), 'MOON');
	assert.equal(matchmakerRegionLabel(''), '—');
});

test('a region code from an untrusted game ID cannot stretch the popup', () => {
	const label = matchmakerRegionLabel('X'.repeat(200));
	assert.equal(label.length, 16);
	assert.ok(label.endsWith('…'));
});

test('ping is toned by how playable it is, and unknown latency reads as unknown', () => {
	assert.deepEqual(matchmakerPingChip(28), { label: 'Ping', tone: 'good', value: '28 ms' });
	assert.deepEqual(matchmakerPingChip(95), { label: 'Ping', tone: 'warn', value: '95 ms' });
	assert.deepEqual(matchmakerPingChip(240), { label: 'Ping', tone: 'bad', value: '240 ms' });
	assert.deepEqual(matchmakerPingChip(undefined), { label: 'Ping', value: '—' });
	assert.deepEqual(matchmakerPingChip(Number.NaN), { label: 'Ping', value: '—' });
	assert.deepEqual(matchmakerPingChip(-1), { label: 'Ping', value: '—' });
});

test('time left warns as the match runs out and reports an ended match', () => {
	assert.deepEqual(matchmakerTimeLeftChip(150), { key: 'timeLeft', label: 'Time Left', value: '2m 30s' });
	assert.deepEqual(matchmakerTimeLeftChip(40), { key: 'timeLeft', label: 'Time Left', tone: 'warn', value: '40s' });
	assert.deepEqual(matchmakerTimeLeftChip(0), { key: 'timeLeft', label: 'Time Left', tone: 'bad', value: 'Ending' });
	assert.deepEqual(matchmakerTimeLeftChip(-5), { key: 'timeLeft', label: 'Time Left', tone: 'bad', value: 'Ending' });
});

test('a found lobby is described by every field the decision needs', () => {
	assert.deepEqual(matchmakerLobbyChips(lobby(), 34), [
		{ label: 'Region', value: 'Frankfurt' },
		{ label: 'Ping', tone: 'good', value: '34 ms' },
		{ label: 'Mode', value: 'Team Deathmatch' },
		{ label: 'Map', value: 'Burg' },
		{ label: 'Players', value: '4/8' },
		{ key: 'timeLeft', label: 'Time Left', value: '2m 30s' }
	]);
});

test('a hostile map name is truncated instead of being shown in full', () => {
	const chips = matchmakerLobbyChips(lobby({ map: 'A'.repeat(120) }), undefined);
	const map = chips.find(chip => chip.label === 'Map');
	assert.equal(map?.value.length, 18);
	assert.ok(map?.value.endsWith('…'));
});

test('empty filters read as "Any" and an unset time filter is left out', () => {
	assert.deepEqual(matchmakerFilterChips(criteria({ mapScope: 'all', minRemainingTime: 0 })), [
		{ label: 'Regions', value: 'Any' },
		{ label: 'Modes', value: 'Any' },
		{ label: 'Maps', value: 'Any' },
		{ label: 'Players', value: '1–6' }
	]);
});

test('long filter selections are summarised rather than truncated away', () => {
	const chips = matchmakerFilterChips(criteria({
		gameModes: ['Free for All', 'Team Deathmatch', 'Hardpoint'],
		regions: ['FRA', 'NY', 'DAL', 'SYD', 'TOK']
	}));

	assert.equal(chips[0].value, 'FRA, NY, DAL +2');
	assert.equal(chips[1].value, 'Free for All, Team Deathmatch +1');
	assert.equal(chips[2].value, 'Official');
	assert.deepEqual(chips[4], { label: 'Time Left', value: '2m 0s+' });
});

test('the map filter says which maps are actually in play', () => {
	assert.equal(matchmakerFilterChips(criteria({ mapScope: 'all' }))[2].value, 'Any');
	assert.equal(matchmakerFilterChips(criteria({ mapScope: 'official' }))[2].value, 'Official');
	assert.equal(matchmakerFilterChips(criteria({ mapScope: 'selected', maps: [] }))[2].value, 'None');
	assert.equal(matchmakerFilterChips(criteria({ mapScope: 'selected', maps: ['Burg'] }))[2].value, 'Burg');
	assert.equal(matchmakerFilterChips(criteria({ mapScope: 'selected', maps: ['Burg', 'Site'] }))[2].value, '2 picked');
});

test('an empty result names the filter most likely to be the cause', () => {
	assert.equal(
		matchmakerNoResultsHint(criteria({ mapScope: 'selected', maps: [] })),
		'No maps are selected.'
	);
	assert.equal(
		matchmakerNoResultsHint(criteria({ maxPlayers: 1, minPlayers: 5 })),
		'Minimum players is above maximum.'
	);
	assert.equal(
		matchmakerNoResultsHint(criteria({ mapScope: 'selected', maps: ['Burg', 'Site'] })),
		'Try selecting more maps.'
	);
	assert.equal(matchmakerNoResultsHint(criteria({ regions: ['FRA'] })), 'Try more regions.');
	assert.equal(matchmakerNoResultsHint(criteria({ gameModes: ['Hardpoint'] })), 'Try more gamemodes.');
	assert.equal(
		matchmakerNoResultsHint(criteria({ minRemainingTime: 300 })),
		'Try lowering minimum time left.'
	);
	assert.equal(
		matchmakerNoResultsHint(criteria({ maxPlayers: 4, minPlayers: 4 })),
		'Try a wider player range.'
	);
});

test('a plausible set of filters that simply found nothing is not blamed on the user', () => {
	assert.equal(matchmakerNoResultsHint(criteria()), 'Lobbies fill fast. Try again.');
});

test('searching shows the live filters and only offers a cancel', () => {
	const view = matchmakerSearchingView(criteria(), hotkeys);

	assert.equal(view.state, 'searching');
	assert.equal(view.title, 'Searching');
	assert.equal(view.confirm, undefined);
	assert.deepEqual(view.cancel, { hotkey: 'ESCAPE', label: 'Cancel' });
	assert.deepEqual(view.chips, matchmakerFilterChips(criteria()));
});

test('a found lobby offers both hotkeys', () => {
	const view = matchmakerLobbyView(lobby(), 34, hotkeys);

	assert.equal(view.state, 'game');
	assert.equal(view.title, 'Lobby Found');
	assert.deepEqual(view.confirm, { hotkey: 'ENTER', label: 'Join' });
	assert.deepEqual(view.cancel, { hotkey: 'ESCAPE', label: 'Skip' });
});

test('failure states explain themselves and say how to search again', () => {
	const empty = matchmakerNoGamesView(criteria({ regions: ['FRA'] }), hotkeys, false);
	assert.equal(empty.title, 'No Lobbies Match');
	assert.equal(empty.description, 'Try more regions.');
	assert.equal(empty.hint, 'Press F1 to search again');
	assert.equal(empty.confirm, undefined);

	const failed = matchmakerErrorView('The matchmaker timed out.', hotkeys, false);
	assert.equal(failed.title, 'Search Failed');
	assert.equal(failed.description, 'The matchmaker timed out.');
	assert.equal(failed.hint, 'Press F1 to try again');
	assert.deepEqual(failed.chips, []);

	const cancelled = matchmakerCancelledView(hotkeys);
	assert.equal(cancelled.state, 'cancelled');
	assert.equal(cancelled.title, 'Search Cancelled');
	assert.equal(cancelled.hint, 'Press F1 to search again');
	assert.equal(cancelled.confirm, undefined);
});

test('the cancel button names what it will actually do with the server browser setting on', () => {
	assert.equal(matchmakerNoGamesView(criteria(), hotkeys, true).cancel.label, 'Servers');
	assert.equal(matchmakerNoGamesView(criteria(), hotkeys, false).cancel.label, 'Close');
	assert.equal(matchmakerErrorView('offline', hotkeys, true).cancel.label, 'Servers');
	assert.equal(matchmakerErrorView('offline', hotkeys, false).cancel.label, 'Close');
});

test('an unbound search key drops the hint instead of naming an empty key', () => {
	const view = matchmakerNoGamesView(criteria(), { ...hotkeys, search: '' }, false);

	assert.equal(view.hint, '');
});
