import { ipcRenderer } from 'electron';
import {
	MATCHMAKER_GAMEMODES,
	MATCHMAKER_MAP_ICON_INDICES
} from './matchmaker-data.ts';
import {
	matchmakerCandidateRegions,
	waitForMatchmakerOperation
} from './matchmaker-flow.ts';
import {
	matchmakerPointerDownIsOutside,
	MatchmakerPopupLifecycle,
	type MatchmakerPopupDismissal
} from './matchmaker-popup-lifecycle.ts';
import {
	type MatchmakerAction,
	type MatchmakerChip,
	type MatchmakerHotkeyLabels,
	type MatchmakerView,
	matchmakerCancelledView,
	matchmakerDurationLabel,
	matchmakerErrorView,
	matchmakerLobbyView,
	matchmakerNoGamesView,
	matchmakerSearchingView,
	matchmakerTimeLeftChip
} from './matchmaker-presentation.ts';
import { MatchmakerResponseTooLargeError, readBoundedMatchmakerJson } from './matchmaker-response.ts';
import {
	collectMatchmakerCandidates,
	matchmakerRegionLatency,
	rankMatchmakerCandidates,
	selectRevalidatedMatchmakerGame
} from './matchmaker-selection.ts';
import { createElement, keyboardEventMatchesCustomSetting, parseKeybindSettingDisplay } from './utils.ts';

export {
	MATCHMAKER_GAMEMODES,
	MATCHMAKER_MAP_ICON_INDICES,
	MATCHMAKER_REGION_NAMES,
	MATCHMAKER_REGIONS
} from './matchmaker-data.ts';

const MATCHMAKER_REQUEST_TIMEOUT_MS = 10_000;
/**
 * The searching state has to be visible long enough to read.
 *
 * A search with warm filters and a cached ping resolves in a few hundred milliseconds, so the
 * searching view was being replaced before the user could see it had appeared at all - the
 * feedback existed but nobody could perceive it. Holding the result briefly costs nothing a
 * player notices and is the difference between "it searched" and "something flashed".
 */
const MATCHMAKER_MINIMUM_SEARCH_VISIBLE_MS = 750;

const MATCHMAKER_GAME_LIST_URL = 'https://matchmaker.krunker.io/game-list';
/** How long the "Search Cancelled" confirmation stays up before it clears itself. */
const MATCHMAKER_CANCELLED_POPUP_MS = 1_400;

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
let matchmakerRequestGeneration = 0;
let matchmakerBindListener: AbortController | undefined;
let matchmakerConnectionObserver: MutationObserver | undefined;
const popupLifecycle = new MatchmakerPopupLifecycle();
let currentPopupSession = 0;

// https://greasyfork.org/en/scripts/468482-kraxen-s-krunker-utils

function abortActiveMatchmakerSearch() {
	matchmakerRequestGeneration++;
	const request = matchmakerRequest;
	matchmakerRequest = undefined;
	request?.abort();
}

function detachMatchmakerPopupListeners() {
	matchmakerBindListener?.abort();
	matchmakerBindListener = undefined;
}

function disconnectMatchmakerConnectionObserver() {
	matchmakerConnectionObserver?.disconnect();
	matchmakerConnectionObserver = undefined;
}

/**
 * Close every matchmaker-owned resource without making a sound or opening another window.
 * This is deliberately safe to call from several independent lifecycle events.
 */
export function teardownMatchmakerPopup() {
	const dismissal = popupLifecycle.teardown();
	stopMatchmakerTicker();
	clearMatchmakerAutoDismiss();
	if (dismissal.abortSearch || matchmakerRequest !== undefined) abortActiveMatchmakerSearch();
	detachMatchmakerPopupListeners();
	disconnectMatchmakerConnectionObserver();
	popupElement.remove();
}

function applyMatchmakerPopupDismissal(dismissal: MatchmakerPopupDismissal) {
	if (!dismissal.dismissed) return;

	stopMatchmakerTicker();
	clearMatchmakerAutoDismiss();
	if (dismissal.abortSearch) abortActiveMatchmakerSearch();
	detachMatchmakerPopupListeners();
	disconnectMatchmakerConnectionObserver();
	// Remove first. Joining navigates synchronously below, and the old popup must never survive
	// long enough to be painted over the destination page.
	popupElement.remove();
	if (dismissal.playSelect) window.playSelect();
	if (dismissal.joinGame && currentMatch !== 'none') {
		window.location.href = `https://krunker.io/?game=${currentMatch}`;
		return;
	}
	// A cancelled search is confirmed briefly instead of vanishing without explanation.
	if (dismissal.abortSearch) {
		showMatchmakerCancelledPopup();
		return;
	}
	if (dismissal.openServerWindow) window.openServerWindow(0);
}

/**
 * Acts on the user's input for the matchmaker popup
 * @param accept whether or not the new game was accepted
 */
function decideMatchmakerDecision(session: number, accept: boolean) {
	applyMatchmakerPopupDismissal(
		popupLifecycle.decide(session, accept, openServerWindow)
	);
}

/** Replace the popup and invalidate the old request as one synchronous transition. */
function replaceMatchmakerPopup() {
	popupLifecycle.replace();
	stopMatchmakerTicker();
	clearMatchmakerAutoDismiss();
	abortActiveMatchmakerSearch();
	detachMatchmakerPopupListeners();
	disconnectMatchmakerConnectionObserver();
	popupElement.remove();
}

// ID of the container element, used to construct and to check if it's attached to the DOM.
const popupContainerID = "matchmakerPopupContainer";

// Create popup element
const popupElement = createElement('div', { id: popupContainerID });

// One strip across the top: it sweeps while searching, then turns solid in the colour of the outcome.
const popupProgress = createElement('div', { id: "matchmakerSearchProgress" });
popupProgress.appendChild(createElement('div', { id: "matchmakerSearchProgressBar" }));
popupElement.appendChild(popupProgress);

const popupBody = createElement('div', { id: "matchmakerPopupBody" });
popupElement.appendChild(popupBody);

const popupHeader = createElement('div', { id: "matchmakerPopupHeader" });
const popupTitle = createElement('div', { id: "matchmakerPopupTitle" });
const popupPulse = createElement('span', { id: "matchmakerSearchPulse" });
popupPulse.appendChild(createElement('span', { class: "matchmakerPulseRing" }));
popupPulse.appendChild(createElement('span', { class: "matchmakerPulseRing" }));
const popupTimer = createElement('div', { id: "matchmakerPopupTimer" });
popupHeader.appendChild(popupPulse);
popupHeader.appendChild(popupTitle);
popupHeader.appendChild(popupTimer);
popupBody.appendChild(popupHeader);

const popupDescription = createElement('div', { id: "matchmakerPopupDescription" });
popupBody.appendChild(popupDescription);

const popupChips = createElement('div', { id: "matchmakerPopupChips" });
popupBody.appendChild(popupChips);

const popupOptions = createElement('div', { id: "matchmakerPopupOptions" });

interface MatchmakerPopupButton {
	button: HTMLElement;
	hotkey: HTMLElement;
	label: HTMLElement;
}

function createMatchmakerButton(id: string, accept: boolean): MatchmakerPopupButton {
	const button = createElement('div', {
		class: ["matchmakerPopupButton", "bigShadowT"],
		id,
		onmouseenter: "playTick()" // This is to play the little krunker 'tick' noise when hovering over the button.
	});
	const label = createElement('span', { class: "matchmakerButtonLabel" });
	const hotkey = createElement('kbd', { class: "matchmakerButtonHotkey" });
	button.appendChild(label);
	button.appendChild(hotkey);

	// Keep each pointer's originating session. A replacement view or another simultaneous pointer
	// cannot turn an old Cancel/Join interaction into an action on the current popup.
	const pointerSessions = new Map<number, number>();
	button.addEventListener('pointerdown', event => {
		if (
			event.button === 0
			&& popupLifecycle.isCurrent(currentPopupSession)
		) {
			pointerSessions.set(event.pointerId, currentPopupSession);
		}
	});
	const forgetPointer = (event: PointerEvent) => {
		pointerSessions.delete(event.pointerId);
	};
	button.addEventListener('pointercancel', forgetPointer);
	button.addEventListener('pointerleave', forgetPointer);
	button.addEventListener('pointerup', event => {
		const session = pointerSessions.get(event.pointerId);
		pointerSessions.delete(event.pointerId);
		if (event.button !== 0 || session === undefined) return;
		if (!popupElement.isConnected) {
			teardownMatchmakerPopup();
			return;
		}
		decideMatchmakerDecision(session, accept);
	});
	button.addEventListener('click', event => {
		// Physical pointer activation was handled above with a pointer-specific session. Keep the
		// zero-detail path for accessibility/programmatic activation, scoped to the visible view.
		if (event.detail !== 0) return;
		if (!popupElement.isConnected) {
			teardownMatchmakerPopup();
			return;
		}
		decideMatchmakerDecision(currentPopupSession, accept);
	});
	return { button, hotkey, label };
}

let confirmKey: KeybindUserPref = {
	shift: false,
	ctrl: false,
	alt: false,
	key: "Enter"
}
let cancelKey: KeybindUserPref = {
	shift: false,
	ctrl: false,
	alt: false,
	key: "Escape"
}

const popupConfirmOption = createMatchmakerButton("matchmakerConfirmButton", true);
const popupCancelOption = createMatchmakerButton("matchmakerCancelButton", false);
popupOptions.appendChild(popupConfirmOption.button);
popupOptions.appendChild(popupCancelOption.button);
popupBody.appendChild(popupOptions);

const popupHint = createElement('div', { id: "matchmakerPopupHint" });
popupBody.appendChild(popupHint);

let hotkeyLabels: MatchmakerHotkeyLabels = { accept: 'ENTER', cancel: 'ESCAPE', search: 'F1' };
/** The chip whose value keeps counting down while a lobby is offered. */
let countdownValue: HTMLElement | undefined;
let popupTicker: number | undefined;
let popupAutoDismiss: number | undefined;

function stopMatchmakerTicker() {
	if (popupTicker !== undefined) window.clearInterval(popupTicker);
	popupTicker = undefined;
}

function startMatchmakerTicker(tick: () => void) {
	stopMatchmakerTicker();
	tick();
	popupTicker = window.setInterval(tick, 1_000);
}

function clearMatchmakerAutoDismiss() {
	if (popupAutoDismiss !== undefined) window.clearTimeout(popupAutoDismiss);
	popupAutoDismiss = undefined;
}

function handleMatchmakerPointerLockChange() {
	if (document.pointerLockElement) teardownMatchmakerPopup();
}

function handleMatchmakerPageTeardown() {
	teardownMatchmakerPopup();
}

function observeMatchmakerPopupConnection(session: number) {
	disconnectMatchmakerConnectionObserver();
	const root = document.documentElement;
	if (!root) return;

	const observer = new MutationObserver(() => {
		if (
			popupLifecycle.isCurrent(session)
			&& !popupElement.isConnected
		) {
			teardownMatchmakerPopup();
		}
	});
	observer.observe(root, { childList: true, subtree: true });
	matchmakerConnectionObserver = observer;
}

document.addEventListener('pointerlockchange', handleMatchmakerPointerLockChange, { capture: true });
// pagehide only fires once navigation is actually proceeding; beforeunload can be cancelled.
window.addEventListener('pagehide', handleMatchmakerPageTeardown);
window.addEventListener('wok-matchmaker-disabled', handleMatchmakerPageTeardown);

function applyMatchmakerChipTone(value: HTMLElement, chip: MatchmakerChip) {
	if (chip.tone) value.dataset.tone = chip.tone;
	else delete value.dataset.tone;
}

function renderMatchmakerChips(chips: readonly MatchmakerChip[]) {
	countdownValue = undefined;
	popupChips.replaceChildren();
	for (const chip of chips) {
		const node = createElement('div', { class: "matchmakerChip" });
		node.appendChild(createElement('span', { class: "matchmakerChipLabel", text: chip.label }));
		const value = createElement('span', { class: "matchmakerChipValue", text: chip.value });
		applyMatchmakerChipTone(value, chip);
		node.appendChild(value);
		popupChips.appendChild(node);
		if (chip.key === 'timeLeft') countdownValue = value;
	}
}

function applyMatchmakerAction(target: MatchmakerPopupButton, action: MatchmakerAction | undefined) {
	if (!action) {
		target.button.style.display = 'none';
		return;
	}
	target.button.style.display = '';
	target.label.textContent = action.label;
	target.hotkey.textContent = action.hotkey;
	target.hotkey.style.display = action.hotkey ? '' : 'none';
}

function renderMatchmakerView(view: MatchmakerView) {
	popupElement.dataset.state = view.state;
	popupTitle.textContent = view.title;
	popupTimer.textContent = '';
	popupDescription.textContent = view.description;
	popupHint.textContent = view.hint;
	renderMatchmakerChips(view.chips);
	applyMatchmakerAction(popupConfirmOption, view.confirm);
	applyMatchmakerAction(popupCancelOption, view.cancel);
}

/**
 * Handles keyboard input for the matchmaker
 * @param event The keyboard event that initiated the handler
 */
function handleMatchmakerBind(event: KeyboardEvent, session: number) {
	if (!popupLifecycle.isCurrent(session)) return;
	if (!popupElement.isConnected || document.pointerLockElement) {
		teardownMatchmakerPopup();
		return; // Don't fire for a detached popup or while in-game
	}
	const matchesAcceptKey = keyboardEventMatchesCustomSetting(confirmKey, event);
	const matchesCancelKey = keyboardEventMatchesCustomSetting(cancelKey, event);
	if (!matchesAcceptKey && !matchesCancelKey) return;
	// The popup owns these keys. Do not let Krunker's menu/game handlers also act on the same press.
	event.preventDefault();
	event.stopImmediatePropagation();
	// A held cancel key must not immediately dismiss the short cancellation confirmation.
	if (event.repeat) return;
	decideMatchmakerDecision(session, matchesAcceptKey);
}

function handleMatchmakerPointerDown(event: PointerEvent, session: number) {
	if (!popupLifecycle.isCurrent(session)) return;
	if (!popupElement.isConnected) {
		teardownMatchmakerPopup();
		return;
	}
	const target = event.target instanceof Node ? event.target : null;
	if (!matchmakerPointerDownIsOutside(popupElement, target)) return;
	// An outside press means the player chose the game/menu rather than the popup. Tear down silently
	// and let that same press continue, so entering gameplay never requires a second click.
	teardownMatchmakerPopup();
}

function showMatchmakerPopup(view: MatchmakerView): number | undefined {
	stopMatchmakerTicker();
	clearMatchmakerAutoDismiss();
	// A result replaces the previous view synchronously. Taking the old state here prevents a late
	// input callback from applying the previous view's action to the newly rendered one.
	popupLifecycle.replace();
	detachMatchmakerPopupListeners();
	disconnectMatchmakerConnectionObserver();
	popupElement.remove();

	if (document.pointerLockElement) {
		teardownMatchmakerPopup();
		return undefined;
	}

	const uiBase = document.getElementById("uiBase");
	if (!uiBase) {
		currentMatch = '';
		teardownMatchmakerPopup();
		return undefined;
	}

	renderMatchmakerView(view);
	const session = popupLifecycle.show(view.state);
	currentPopupSession = session;
	const listener = new AbortController();
	matchmakerBindListener = listener;
	document.addEventListener(
		'keydown',
		event => handleMatchmakerBind(event, session),
		{ capture: true, signal: listener.signal }
	);
	document.addEventListener(
		'pointerdown',
		event => handleMatchmakerPointerDown(event, session),
		{ capture: true, signal: listener.signal }
	);
	uiBase.appendChild(popupElement);
	observeMatchmakerPopupConnection(session);
	return session;
}

/**
 * Sets the matchmaker element styles & content, shows the popup
 * @param game The game that was retrieved by the custom matchmaker
 * @param latencyMs The measured latency of the game's region, when one is known
 */
function showMatchmakerLobbyPopup(game: IMatchmakerGame, latencyMs: number | undefined) {
	const mapIndex = MATCHMAKER_MAP_ICON_INDICES.indexOf(game.map);
	popupElement.style.backgroundImage = mapIndex >= 0
		? `url(https://assets.krunker.io/img/maps/map_${mapIndex}.png)`
		: '';

	currentMatch = game.gameID;
	if (!showMatchmakerPopup(matchmakerLobbyView(game, latencyMs, hotkeyLabels))) return;

	const endsAt = Date.now() + (game.remainingTime * 1_000);
	startMatchmakerTicker(() => {
		if (!countdownValue) return;
		const remaining = Math.round((endsAt - Date.now()) / 1_000);
		const chip = matchmakerTimeLeftChip(remaining);
		countdownValue.textContent = chip.value;
		applyMatchmakerChipTone(countdownValue, chip);
		if (remaining <= 0) stopMatchmakerTicker();
	});
}

function showMatchmakerNoGamesPopup(criteria: IMatchmakerCriteria) {
	currentMatch = 'none';
	popupElement.style.backgroundImage = '';
	showMatchmakerPopup(matchmakerNoGamesView(criteria, hotkeyLabels, openServerWindow));
}

/**
 * Waits out the remainder of the minimum searching window. Aborts immediately if the search was
 * superseded, so a rapid re-search is never delayed by the previous one's floor.
 */
function holdSearchingViewUntilReadable(shownAt: number, request: AbortController): Promise<void> {
	const remaining = MATCHMAKER_MINIMUM_SEARCH_VISIBLE_MS - (Date.now() - shownAt);
	if (remaining <= 0 || request.signal.aborted) return Promise.resolve();
	return new Promise<void>(resolve => {
		const finish = () => {
			window.clearTimeout(timer);
			request.signal.removeEventListener('abort', finish);
			resolve();
		};
		const timer = window.setTimeout(finish, remaining);
		request.signal.addEventListener('abort', finish, { once: true });
	});
}

function showMatchmakerSearchingPopup(
	criteria: IMatchmakerCriteria
): { session: number; shownAt: number } | undefined {
	popupElement.style.backgroundImage = '';
	const session = showMatchmakerPopup(
		matchmakerSearchingView(criteria, hotkeyLabels)
	);
	if (session === undefined) return undefined;

	const shownAt = Date.now();
	startMatchmakerTicker(() => {
		popupTimer.textContent = matchmakerDurationLabel(
			Math.floor((Date.now() - shownAt) / 1_000)
		);
	});
	return { session, shownAt };
}

function showMatchmakerErrorPopup(message: string) {
	currentMatch = 'none';
	popupElement.style.backgroundImage = '';
	showMatchmakerPopup(matchmakerErrorView(message, hotkeyLabels, openServerWindow));
}

function showMatchmakerCancelledPopup() {
	// currentMatch is left alone: a cancelled search should not un-reject the lobby the user last skipped.
	popupElement.style.backgroundImage = '';
	const session = showMatchmakerPopup(
		matchmakerCancelledView(hotkeyLabels)
	);
	if (session === undefined) return;

	popupAutoDismiss = window.setTimeout(() => {
		popupAutoDismiss = undefined;
		if (!popupLifecycle.isCurrent(session)) return;
		applyMatchmakerPopupDismissal(popupLifecycle.replace());
	}, MATCHMAKER_CANCELLED_POPUP_MS);
}

/**
 * The last found match ID, used to filter matchmaker results and to handle acceptance or rejection of the new lobby
 * - When set to "none", popup interactions act like no lobby was found.
 */
let currentMatch = '';

function assertCurrentMatchmakerRequest(
	request: AbortController,
	generation: number,
	popupSession: number
): void {
	if (
		matchmakerRequest !== request
		|| matchmakerRequestGeneration !== generation
	) {
		throw new MatchmakerRequestSupersededError();
	}
	if (
		!popupLifecycle.isCurrent(popupSession)
		|| !popupElement.isConnected
	) {
		teardownMatchmakerPopup();
		throw new MatchmakerRequestSupersededError();
	}
	if (request.signal.aborted) throw new DOMException('Matchmaker request was aborted.', 'AbortError');
}

async function loadMatchmakerGameList(
	request: AbortController,
	generation: number,
	popupSession: number
): Promise<unknown> {
	const response = await fetch(`${MATCHMAKER_GAME_LIST_URL}?hostname=${window.location.hostname}`, {
		signal: request.signal
	});
	assertCurrentMatchmakerRequest(request, generation, popupSession);
	if (!response.ok) {
		throw new MatchmakerHttpError(
			response.status,
			response.status === 429 ? response.headers.get('Retry-After') : null
		);
	}

	const result = await readBoundedMatchmakerJson(response);
	assertCurrentMatchmakerRequest(request, generation, popupSession);
	return result;
}

function matchmakerRegionLatencies(value: unknown): Readonly<Record<string, unknown>> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>>
		: {};
}

function matchmakerHotkeyLabel(value: unknown, fallback: string): string {
	const pref = value as KeybindUserPref | undefined;
	return pref && typeof pref.key === 'string' && pref.key.length > 0
		? parseKeybindSettingDisplay(pref)
		: fallback;
}

/**
 * Retrieves a lobby using the custom matchmaker, presents the user with a popup
 * @param _userPrefs User Preferences Object
 */
export async function fetchGame(_userPrefs: UserPrefs) {
	if (_userPrefs.matchmaker !== true) {
		teardownMatchmakerPopup();
		return;
	}
	openServerWindow = _userPrefs.matchmaker_openServerWindow as boolean;
	confirmKey = _userPrefs.matchmakerAcceptKey as KeybindUserPref;
	cancelKey = _userPrefs.matchmakerCancelKey as KeybindUserPref;
	hotkeyLabels = {
		accept: matchmakerHotkeyLabel(confirmKey, 'ENTER'),
		cancel: matchmakerHotkeyLabel(cancelKey, 'ESCAPE'),
		search: matchmakerHotkeyLabel(_userPrefs.matchmakerKey, '')
	};

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

	const request = new AbortController();
	const requestGeneration = ++matchmakerRequestGeneration;
	matchmakerRequest = request;
	const searchingPopup = showMatchmakerSearchingPopup(criteria);
	if (!searchingPopup) {
		abortActiveMatchmakerSearch();
		return;
	}
	const {
		session: searchingPopupSession,
		shownAt: searchingShownAt
	} = searchingPopup;

	let timedOut = false;
	const timeoutHandle = window.setTimeout(() => {
		timedOut = true;
		request.abort();
	}, MATCHMAKER_REQUEST_TIMEOUT_MS);

	try {
		const initialResult = await loadMatchmakerGameList(
			request,
			requestGeneration,
			searchingPopupSession
		);
		const candidates = collectMatchmakerCandidates(
			initialResult,
			criteria,
			selectionContext,
			MATCHMAKER_GAMEMODES
		);
		if (candidates.length === 0) {
			showMatchmakerNoGamesPopup(criteria);
			return;
		}

		// The fresh list is used only to revalidate the candidates we already ranked. Fetch and
		// parse it while region latency is being measured instead of after that IPC round trip;
		// both operations depend only on the initial candidate set. If the list fetch fails, fall
		// back to the old sequential behavior, where the first request's result is the freshest.
		// Attach both handlers immediately. The refresh can fail before latency measurement
		// finishes, so leaving rejection handling until a later await can emit an unhandled rejection.
		const freshListPromise = loadMatchmakerGameList(
			request,
			requestGeneration,
			searchingPopupSession
		).then(
			result => ({ result, succeeded: true as const }),
			() => ({ succeeded: false as const })
		);
		let latencyResult: unknown = {};
		try {
			latencyResult = await waitForMatchmakerOperation(
				request.signal,
				() => ipcRenderer.invoke(
					'matchmaker_measure_region_latency',
					matchmakerCandidateRegions(candidates)
				)
			);
			assertCurrentMatchmakerRequest(
				request,
				requestGeneration,
				searchingPopupSession
			);
		} catch (error) {
			assertCurrentMatchmakerRequest(
				request,
				requestGeneration,
				searchingPopupSession
			);
			console.warn('Failed to measure matchmaker region latency', error);
		}
		const latencies = matchmakerRegionLatencies(latencyResult);
		const rankedCandidates = rankMatchmakerCandidates(candidates, latencies);

		const freshList = await freshListPromise;
		assertCurrentMatchmakerRequest(
			request,
			requestGeneration,
			searchingPopupSession
		);
		const freshResult = freshList.succeeded ? freshList.result : initialResult;
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
		await holdSearchingViewUntilReadable(searchingShownAt, request);
		assertCurrentMatchmakerRequest(
			request,
			requestGeneration,
			searchingPopupSession
		);
		if (selectedGame) showMatchmakerLobbyPopup(selectedGame, matchmakerRegionLatency(latencies, selectedGame.region));
		else showMatchmakerNoGamesPopup(criteria);
	} catch (error) {
		if (!popupLifecycle.isCurrent(searchingPopupSession)) return;
		if (!popupElement.isConnected) {
			teardownMatchmakerPopup();
			return;
		}
		if (
			matchmakerRequest !== request
			|| matchmakerRequestGeneration !== requestGeneration
			|| error instanceof MatchmakerRequestSupersededError
		) return;
		if (timedOut) {
			showMatchmakerErrorPopup('The matchmaker timed out.');
			return;
		}
		if ((error as Error).name === 'AbortError') return;
		console.error('Failed to fetch a matchmaker game', error);
		showMatchmakerErrorPopup(error instanceof MatchmakerResponseTooLargeError
			? 'The server list response was too large.'
			: error instanceof MatchmakerHttpError && error.retryAfter
				? `Rate limited. Try again after ${error.retryAfter}.`
				: "The server list couldn't be loaded.");
	} finally {
		window.clearTimeout(timeoutHandle);
		if (matchmakerRequest === request && matchmakerRequestGeneration === requestGeneration) {
			matchmakerRequest = undefined;
		}
	}
}
