import { ipcRenderer } from 'electron';
import {
	MATCHMAKER_GAMEMODES,
	MATCHMAKER_MAP_ICON_INDICES,
	MATCHMAKER_REGION_NAMES
} from './matchmaker-data.ts';
import {
	matchmakerCandidateRegions,
	waitForMatchmakerOperation
} from './matchmaker-flow.ts';
import { MatchmakerPopupLifecycle, type MatchmakerPopupDismissal } from './matchmaker-popup-lifecycle.ts';
import { MatchmakerResponseTooLargeError, readBoundedMatchmakerJson } from './matchmaker-response.ts';
import {
	collectMatchmakerCandidates,
	rankMatchmakerCandidates,
	selectRevalidatedMatchmakerGame
} from './matchmaker-selection.ts';
import { createElement, keyboardEventMatchesCustomSetting, secondsToTimestring } from './utils.ts';

export {
	MATCHMAKER_GAMEMODES,
	MATCHMAKER_MAP_ICON_INDICES,
	MATCHMAKER_REGION_NAMES,
	MATCHMAKER_REGIONS
} from './matchmaker-data.ts';

const MATCHMAKER_REQUEST_TIMEOUT_MS = 10_000;
const MATCHMAKER_GAME_LIST_URL = 'https://matchmaker.krunker.io/game-list';

class MatchmakerHttpError extends Error {
	public readonly retryAfter: string | null;

	public constructor(status: number, retryAfter: string | null) {
		super(`Matchmaker request failed with HTTP ${status}`);
		this.name = 'MatchmakerHttpError';
		this.retryAfter = retryAfter;
	}
}

class MatchmakerRequestSupersededError extends Error {
	public constructor() {
		super('Matchmaker request was superseded.');
		this.name = 'MatchmakerRequestSupersededError';
	}
}

// Hacky, but needed (?) until there's a better system to store state
let openServerWindow: boolean;
let matchmakerRequest: AbortController | undefined;
let matchmakerBindListener: AbortController | undefined;
const popupLifecycle = new MatchmakerPopupLifecycle();

// https://greasyfork.org/en/scripts/468482-kraxen-s-krunker-utils

function abortActiveMatchmakerSearch() {
	const request = matchmakerRequest;
	matchmakerRequest = undefined;
	request?.abort();
}

function applyMatchmakerPopupDismissal(dismissal: MatchmakerPopupDismissal) {
	if (!dismissal.dismissed) return;

	if (dismissal.abortSearch) abortActiveMatchmakerSearch();
	matchmakerBindListener?.abort();
	matchmakerBindListener = undefined;
	if (dismissal.playSelect) window.playSelect();
	if (dismissal.joinGame && currentMatch !== 'none') {
		window.location.href = `https://krunker.io/?game=${currentMatch}`;
	} else {
		popupElement.remove();
		if (dismissal.openServerWindow) window.openServerWindow(0);
	}
}

/**
 * Acts on the user's input for the matchmaker popup
 * @param accept whether or not the new game was accepted
 */
function decideMatchmakerDecision(accept: boolean) {
	applyMatchmakerPopupDismissal(popupLifecycle.decide(accept, openServerWindow));
}

function replaceMatchmakerPopup() {
	applyMatchmakerPopupDismissal(popupLifecycle.replace());
}

// ID of the container element, used to construct and to check if it's attached to the DOM.
const popupContainerID = "matchmakerPopupContainer";

// Create popup element
const popupElement = createElement('div', { id: popupContainerID });

const popupTitle = createElement('div', { id: "matchmakerPopupTitle" });
popupElement.appendChild(popupTitle);

const popupDescription = createElement('div', { id: "matchmakerPopupDescription" });
popupElement.appendChild(popupDescription);

const popupOptions = createElement('div', { id: "matchmakerPopupOptions" });

let confirmKey: KeybindUserPref = {
	shift: false,
	ctrl: false,
	alt: false,
	key: "Enter"
}
const popupConfirmOption = createElement('div', {
	class: ["matchmakerPopupButton", "bigShadowT"],
	id: "matchmakerConfirmButton",
	text: "Join",
	onmouseenter: "playTick()" // This is to play the little krunker 'tick' noise when hovering over the button.
})
popupConfirmOption.addEventListener('click', () => { decideMatchmakerDecision(true) });

let cancelKey: KeybindUserPref = {
	shift: false,
	ctrl: false,
	alt: false,
	key: "Escape"
}
const popupCancelOption = createElement('div', {
	class: ["matchmakerPopupButton", "bigShadowT"],
	id: "matchmakerCancelButton",
	text: "Cancel",
	onmouseenter: "playTick()" // This is to play the little krunker 'tick' noise when hovering over the button.
})
popupCancelOption.addEventListener('click', () => { decideMatchmakerDecision(false) });

popupOptions.appendChild(popupConfirmOption);
popupOptions.appendChild(popupCancelOption);
popupElement.appendChild(popupOptions);

/**
 * Handles keyboard input for the matchmaker
 * @param event The keyboard event that initiated the handler
 */
function handleMatchmakerBind(event: KeyboardEvent) {
	if (document.pointerLockElement) return; // Don't fire while in-game
	const matchesAcceptKey = keyboardEventMatchesCustomSetting(confirmKey, event);
	const matchesCancelKey = keyboardEventMatchesCustomSetting(cancelKey, event);
	if (matchesAcceptKey || matchesCancelKey) decideMatchmakerDecision(matchesAcceptKey);
}

/**
 * Sets the matchmaker element styles & content, shows the popup
 * @param game The game that was retrieved by the custom matchmaker
 */
function createFetchedGamePopup(game: IMatchmakerGame) {
	const mapIndex = MATCHMAKER_MAP_ICON_INDICES.indexOf(game.map);
	popupElement.style.backgroundImage = game.gameID !== 'none' && mapIndex >= 0
		? `url(https://assets.krunker.io/img/maps/map_${mapIndex}.png)`
		: '';

	currentMatch = game.gameID;
	let state: 'game' | 'no-games';
	if (game.gameID === "none") {
		popupTitle.innerText = "No Games Found...";
		popupDescription.innerHTML = "Check the server browser to see other lobbies.";
		popupConfirmOption.style.display = "none";
		state = 'no-games';
	} else {
		popupTitle.innerText = "Game Found!";
		popupDescription.innerHTML = `${game.gamemode} on ${game.map} (${MATCHMAKER_REGION_NAMES[game.region as keyof typeof MATCHMAKER_REGION_NAMES] ?? "Unknown Region"})<br/>${game.playerCount}/${game.playerLimit} Players, ${ secondsToTimestring(game.remainingTime) } Left`;
		popupConfirmOption.style.display = "block";
		state = 'game';
	}

	showMatchmakerPopup(state);
}

function showMatchmakerPopup(state: 'error' | 'game' | 'no-games' | 'searching'): boolean {
	const uiBase = document.getElementById("uiBase");
	if (!uiBase) {
		currentMatch = '';
		popupElement.remove();
		return false;
	}

	uiBase.appendChild(popupElement);
	popupLifecycle.show(state);
	matchmakerBindListener?.abort();
	matchmakerBindListener = new AbortController();
	document.addEventListener('keydown', handleMatchmakerBind, { capture: true, signal: matchmakerBindListener.signal });
	return true;
}

function createMatchmakerSearchingPopup(): boolean {
	popupElement.style.backgroundImage = '';
	popupTitle.innerText = 'Finding a Game...';
	popupDescription.innerText = 'Checking lobby availability and region latency.';
	popupConfirmOption.style.display = 'none';
	return showMatchmakerPopup('searching');
}

function createMatchmakerErrorPopup(message: string) {
	currentMatch = 'none';
	popupElement.style.backgroundImage = '';
	popupTitle.innerText = 'Matchmaker Unavailable';
	popupDescription.innerText = message;
	popupConfirmOption.style.display = 'none';
	showMatchmakerPopup('error');
}

/**
 * The last found match ID, used to filter matchmaker results and to handle acceptance or rejection of the new lobby
 * - When set to "none", popup interactions act like no lobby was found.
 */
let currentMatch = '';

function assertCurrentMatchmakerRequest(request: AbortController): void {
	if (matchmakerRequest !== request) throw new MatchmakerRequestSupersededError();
	if (request.signal.aborted) throw new DOMException('Matchmaker request was aborted.', 'AbortError');
}

async function loadMatchmakerGameList(request: AbortController): Promise<unknown> {
	const response = await fetch(`${MATCHMAKER_GAME_LIST_URL}?hostname=${window.location.hostname}`, {
		signal: request.signal
	});
	assertCurrentMatchmakerRequest(request);
	if (!response.ok) {
		throw new MatchmakerHttpError(
			response.status,
			response.status === 429 ? response.headers.get('Retry-After') : null
		);
	}

	const result = await readBoundedMatchmakerJson(response);
	assertCurrentMatchmakerRequest(request);
	return result;
}

function matchmakerRegionLatencies(value: unknown): Readonly<Record<string, unknown>> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>>
		: {};
}

const NO_MATCHMAKER_GAME: IMatchmakerGame = {
	gameID: 'none',
	region: 'none',
	playerCount: 0,
	playerLimit: 0,
	map: '',
	gamemode: MATCHMAKER_GAMEMODES[0],
	remainingTime: 0
};

/**
 * Retrieves a lobby using the custom matchmaker, presents the user with a popup
 * @param _userPrefs User Preferences Object
 */
export async function fetchGame(_userPrefs: UserPrefs) {
	openServerWindow = _userPrefs.matchmaker_openServerWindow as boolean;
	confirmKey = _userPrefs.matchmakerAcceptKey as KeybindUserPref;
	cancelKey = _userPrefs.matchmakerCancelKey as KeybindUserPref;

	// Replacing a popup for a retry is not a user cancellation.
	replaceMatchmakerPopup();
	const criteria = {
		regions: _userPrefs.matchmaker_regions,
		gameModes: _userPrefs.matchmaker_gamemodes,
		mapScope: _userPrefs.matchmaker_mapScope,
		maps: _userPrefs.matchmaker_maps,
		minPlayers: _userPrefs.matchmaker_minPlayers,
		maxPlayers: _userPrefs.matchmaker_maxPlayers,
		minRemainingTime: _userPrefs.matchmaker_minRemainingTime
	} as IMatchmakerCriteria;
	const selectionContext = {
		currentMatch,
		currentUrl: window.location.href
	};

	matchmakerRequest?.abort();
	const request = new AbortController();
	matchmakerRequest = request;
	if (!createMatchmakerSearchingPopup()) {
		abortActiveMatchmakerSearch();
		return;
	}

	let timedOut = false;
	const timeoutHandle = window.setTimeout(() => {
		timedOut = true;
		request.abort();
	}, MATCHMAKER_REQUEST_TIMEOUT_MS);

	try {
		const initialResult = await loadMatchmakerGameList(request);
		const candidates = collectMatchmakerCandidates(
			initialResult,
			criteria,
			selectionContext,
			MATCHMAKER_GAMEMODES
		);
		if (candidates.length === 0) {
			createFetchedGamePopup(NO_MATCHMAKER_GAME);
			return;
		}

		let latencyResult: unknown = {};
		try {
			latencyResult = await waitForMatchmakerOperation(
				request.signal,
				() => ipcRenderer.invoke(
					'matchmaker_measure_region_latency',
					matchmakerCandidateRegions(candidates)
				)
			);
			assertCurrentMatchmakerRequest(request);
		} catch (error) {
			assertCurrentMatchmakerRequest(request);
			console.warn('Failed to measure matchmaker region latency', error);
		}
		const rankedCandidates = rankMatchmakerCandidates(
			candidates,
			matchmakerRegionLatencies(latencyResult)
		);

		const freshResult = await loadMatchmakerGameList(request);
		const freshCandidates = collectMatchmakerCandidates(
			freshResult,
			criteria,
			selectionContext,
			MATCHMAKER_GAMEMODES
		);
		const selectedGame = selectRevalidatedMatchmakerGame(
			rankedCandidates,
			freshCandidates
		);
		createFetchedGamePopup(selectedGame ?? NO_MATCHMAKER_GAME);
	} catch (error) {
		if (matchmakerRequest !== request || error instanceof MatchmakerRequestSupersededError) return;
		if (timedOut) {
			createMatchmakerErrorPopup('The matchmaker took too long to respond. Try again or open the server browser.');
			return;
		}
		if ((error as Error).name === 'AbortError') return;
		console.error('Failed to fetch a matchmaker game', error);
		createMatchmakerErrorPopup(error instanceof MatchmakerResponseTooLargeError
			? 'The server list response was unexpectedly large. Try again or open the server browser.'
			: error instanceof MatchmakerHttpError && error.retryAfter
				? `The matchmaker is rate-limited. Try again after ${error.retryAfter}.`
				: 'The server list could not be loaded. Try again or open the server browser.');
	} finally {
		window.clearTimeout(timeoutHandle);
		if (matchmakerRequest === request) matchmakerRequest = undefined;
	}
}
