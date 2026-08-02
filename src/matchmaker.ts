import {
	MATCHMAKER_GAMEMODES,
	MATCHMAKER_MAP_ICON_INDICES,
	MATCHMAKER_REGION_NAMES
} from './matchmaker-data.ts';
import { MatchmakerPopupLifecycle, type MatchmakerPopupDismissal } from './matchmaker-popup-lifecycle.ts';
import { MatchmakerResponseTooLargeError, readBoundedMatchmakerJson } from './matchmaker-response.ts';
import { selectMatchmakerGame } from './matchmaker-selection.ts';
import { createElement, keyboardEventMatchesCustomSetting, secondsToTimestring } from './utils.ts';

export {
	MATCHMAKER_GAMEMODES,
	MATCHMAKER_MAP_ICON_INDICES,
	MATCHMAKER_REGION_NAMES,
	MATCHMAKER_REGIONS
} from './matchmaker-data.ts';

const MATCHMAKER_REQUEST_TIMEOUT_MS = 10_000;

// Hacky, but needed (?) until there's a better system to store state
let openServerWindow: boolean;
let matchmakerRequest: AbortController | undefined;
let matchmakerBindListener: AbortController | undefined;
const popupLifecycle = new MatchmakerPopupLifecycle();

// https://greasyfork.org/en/scripts/468482-kraxen-s-krunker-utils

function applyMatchmakerPopupDismissal(dismissal: MatchmakerPopupDismissal) {
	if (!dismissal.dismissed) return;

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

function showMatchmakerPopup(state: 'error' | 'game' | 'no-games'): boolean {
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
		minPlayers: _userPrefs.matchmaker_minPlayers,
		maxPlayers: _userPrefs.matchmaker_maxPlayers,
		minRemainingTime: _userPrefs.matchmaker_minRemainingTime
	} as IMatchmakerCriteria;

	matchmakerRequest?.abort();
	const request = new AbortController();
	matchmakerRequest = request;

	let timedOut = false;
	let retryAfter: string | null = null;
	const timeoutHandle = window.setTimeout(() => {
		timedOut = true;
		request.abort();
	}, MATCHMAKER_REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(`https://matchmaker.krunker.io/game-list?hostname=${window.location.hostname}`, {
			signal: request.signal
		});
		if (!response.ok) {
			retryAfter = response.status === 429 ? response.headers.get('Retry-After') : null;
			throw new Error(`Matchmaker request failed with HTTP ${response.status}`);
		}
		const result = await readBoundedMatchmakerJson(response);
		if (matchmakerRequest !== request) return;

		const selectedGame = selectMatchmakerGame(result, criteria, {
			currentMatch,
			currentUrl: window.location.href
		}, MATCHMAKER_GAMEMODES);
		createFetchedGamePopup(selectedGame ?? {
			gameID: "none",
			region: "none",
			playerCount: 0,
			playerLimit: 0,
			map: '',
			gamemode: MATCHMAKER_GAMEMODES[0],
			remainingTime: 0
		});
	} catch (error) {
		if (matchmakerRequest !== request) return;
		if (timedOut) {
			createMatchmakerErrorPopup('The server list took too long to respond. Try again or open the server browser.');
			return;
		}
		if ((error as Error).name === 'AbortError') return;
		console.error('Failed to fetch a matchmaker game', error);
		createMatchmakerErrorPopup(error instanceof MatchmakerResponseTooLargeError
			? 'The server list response was unexpectedly large. Try again or open the server browser.'
			: retryAfter
				? `The matchmaker is rate-limited. Try again after ${retryAfter}.`
				: 'The server list could not be loaded. Try again or open the server browser.');
	} finally {
		window.clearTimeout(timeoutHandle);
		if (matchmakerRequest === request) matchmakerRequest = undefined;
	}
}
