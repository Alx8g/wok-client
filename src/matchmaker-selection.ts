export const MATCHMAKER_MAX_RESPONSE_GAMES = 10_000;

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

export function selectMatchmakerGame(
	value: unknown,
	criteria: IMatchmakerCriteria,
	context: MatchmakerSelectionContext,
	gameModes: readonly string[],
	random: () => number = Math.random
): IMatchmakerGame | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Matchmaker response was not an object.');
	const games = (value as Record<string, unknown>).games;
	if (!Array.isArray(games)) throw new TypeError('Matchmaker response did not contain a games array.');
	if (games.length > MATCHMAKER_MAX_RESPONSE_GAMES) throw new RangeError(`Matchmaker response exceeded ${MATCHMAKER_MAX_RESPONSE_GAMES} games.`);

	const allowedRegions = new Set(criteria.regions);
	const allowedGameModes = new Set(criteria.gameModes);
	let selectedGame: IMatchmakerGame | undefined;
	let matchingGames = 0;

	for (const value of games) {
		const game = parseMatchmakerGame(value, gameModes);
		if (!game) continue;
		if (
			!allowedRegions.has(game.region)
			|| !allowedGameModes.has(game.gamemode)
			|| game.playerCount < criteria.minPlayers
			|| game.playerCount > criteria.maxPlayers
			|| game.remainingTime < criteria.minRemainingTime
			|| game.playerCount === game.playerLimit
			|| context.currentUrl.includes(game.gameID)
			|| context.currentMatch === game.gameID
		) continue;

		matchingGames++;
		if (random() < 1 / matchingGames) selectedGame = game;
	}

	return selectedGame;
}
