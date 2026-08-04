import { MATCHMAKER_REGION_NAMES } from './matchmaker-data.ts';
import type { MatchmakerPopupState } from './matchmaker-popup-lifecycle.ts';

/** Every popup state that is actually rendered. */
export type MatchmakerViewState = Exclude<MatchmakerPopupState, 'closed'>;

export type MatchmakerChipTone = 'bad' | 'good' | 'warn';

export interface MatchmakerChip {
	/** Set on values that keep updating after the first render. */
	key?: 'timeLeft';
	label: string;
	tone?: MatchmakerChipTone;
	value: string;
}

export interface MatchmakerAction {
	hotkey: string;
	label: string;
}

export interface MatchmakerHotkeyLabels {
	accept: string;
	cancel: string;
	search: string;
}

export interface MatchmakerView {
	cancel: MatchmakerAction;
	chips: MatchmakerChip[];
	/** Absent when the popup has nothing to accept. */
	confirm?: MatchmakerAction;
	description: string;
	hint: string;
	state: MatchmakerViewState;
	title: string;
}

const MATCHMAKER_GOOD_PING_MS = 60;
const MATCHMAKER_FAIR_PING_MS = 120;
const MATCHMAKER_URGENT_TIME_LEFT_S = 60;
const MATCHMAKER_LONG_TIME_FILTER_S = 240;
const MATCHMAKER_REGION_CHIP_LIMIT = 3;
const MATCHMAKER_GAMEMODE_CHIP_LIMIT = 2;
const MATCHMAKER_FEW_MAPS = 2;
const MATCHMAKER_EMPTY_VALUE = '—';

/** Lobby text comes off the network, so it is trimmed to something a chip can show. */
function shortText(value: unknown, limit: number): string {
	const text = typeof value === 'string' ? value.trim() : '';
	if (text.length === 0) return MATCHMAKER_EMPTY_VALUE;
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function listLabel(values: readonly string[], limit: number): string {
	const entries = Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.length > 0) : [];
	if (entries.length === 0) return 'Any';
	const shown = entries.slice(0, limit).map(entry => shortText(entry, 18)).join(', ');
	return entries.length > limit ? `${shown} +${entries.length - limit}` : shown;
}

export function matchmakerDurationLabel(seconds: number): string {
	const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
	const minutes = Math.floor(total / 60);
	return minutes < 1 ? `${total}s` : `${minutes}m ${total % 60}s`;
}

export function matchmakerRegionLabel(region: string): string {
	const named = MATCHMAKER_REGION_NAMES[region as keyof typeof MATCHMAKER_REGION_NAMES];
	return shortText(named ?? region, 16);
}

export function matchmakerPingChip(latencyMs: number | undefined): MatchmakerChip {
	if (latencyMs === undefined || !Number.isFinite(latencyMs) || latencyMs < 0) {
		return { label: 'Ping', value: MATCHMAKER_EMPTY_VALUE };
	}
	const rounded = Math.round(latencyMs);
	return {
		label: 'Ping',
		tone: rounded <= MATCHMAKER_GOOD_PING_MS ? 'good' : rounded <= MATCHMAKER_FAIR_PING_MS ? 'warn' : 'bad',
		value: `${rounded} ms`
	};
}

export function matchmakerTimeLeftChip(seconds: number): MatchmakerChip {
	const remaining = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
	const chip: MatchmakerChip = {
		key: 'timeLeft',
		label: 'Time Left',
		value: remaining === 0 ? 'Ending' : matchmakerDurationLabel(remaining)
	};
	if (remaining === 0) chip.tone = 'bad';
	else if (remaining <= MATCHMAKER_URGENT_TIME_LEFT_S) chip.tone = 'warn';
	return chip;
}

export function matchmakerLobbyChips(game: IMatchmakerGame, latencyMs?: number): MatchmakerChip[] {
	return [
		{ label: 'Region', value: matchmakerRegionLabel(game.region) },
		matchmakerPingChip(latencyMs),
		{ label: 'Mode', value: shortText(game.gamemode, 20) },
		{ label: 'Map', value: shortText(game.map, 18) },
		{ label: 'Players', value: `${game.playerCount}/${game.playerLimit}` },
		matchmakerTimeLeftChip(game.remainingTime)
	];
}

function mapScopeLabel(criteria: IMatchmakerCriteria): string {
	if (criteria.mapScope === 'all') return 'Any';
	if (criteria.mapScope === 'official') return 'Official';
	if (criteria.maps.length === 0) return 'None';
	if (criteria.maps.length === 1) return shortText(criteria.maps[0], 18);
	return `${criteria.maps.length} picked`;
}

export function matchmakerFilterChips(criteria: IMatchmakerCriteria): MatchmakerChip[] {
	const chips: MatchmakerChip[] = [
		{ label: 'Regions', value: listLabel(criteria.regions, MATCHMAKER_REGION_CHIP_LIMIT) },
		{ label: 'Modes', value: listLabel(criteria.gameModes, MATCHMAKER_GAMEMODE_CHIP_LIMIT) },
		{ label: 'Maps', value: mapScopeLabel(criteria) },
		{ label: 'Players', value: `${criteria.minPlayers}–${criteria.maxPlayers}` }
	];
	if (criteria.minRemainingTime > 0) {
		chips.push({ label: 'Time Left', value: `${matchmakerDurationLabel(criteria.minRemainingTime)}+` });
	}
	return chips;
}

/** Names the filter most likely to be the reason nothing matched. */
export function matchmakerNoResultsHint(criteria: IMatchmakerCriteria): string {
	if (criteria.mapScope === 'selected' && criteria.maps.length === 0) return 'No maps are selected.';
	if (criteria.minPlayers > criteria.maxPlayers) return 'Minimum players is above maximum.';
	if (criteria.mapScope === 'selected' && criteria.maps.length <= MATCHMAKER_FEW_MAPS) return 'Try selecting more maps.';
	if (criteria.regions.length === 1) return 'Try more regions.';
	if (criteria.gameModes.length === 1) return 'Try more gamemodes.';
	if (criteria.minRemainingTime >= MATCHMAKER_LONG_TIME_FILTER_S) return 'Try lowering minimum time left.';
	if (criteria.maxPlayers - criteria.minPlayers <= 1) return 'Try a wider player range.';
	return 'Lobbies fill fast. Try again.';
}

function closeAction(hotkeys: MatchmakerHotkeyLabels, openServerWindow: boolean): MatchmakerAction {
	return { hotkey: hotkeys.cancel, label: openServerWindow ? 'Servers' : 'Close' };
}

function searchAgainHint(hotkeys: MatchmakerHotkeyLabels, verb: string): string {
	return hotkeys.search ? `Press ${hotkeys.search} to ${verb}` : '';
}

export function matchmakerSearchingView(
	criteria: IMatchmakerCriteria,
	hotkeys: MatchmakerHotkeyLabels
): MatchmakerView {
	return {
		cancel: { hotkey: hotkeys.cancel, label: 'Cancel' },
		chips: matchmakerFilterChips(criteria),
		description: '',
		hint: '',
		state: 'searching',
		title: 'Searching'
	};
}

export function matchmakerLobbyView(
	game: IMatchmakerGame,
	latencyMs: number | undefined,
	hotkeys: MatchmakerHotkeyLabels
): MatchmakerView {
	return {
		cancel: { hotkey: hotkeys.cancel, label: 'Skip' },
		chips: matchmakerLobbyChips(game, latencyMs),
		confirm: { hotkey: hotkeys.accept, label: 'Join' },
		description: '',
		hint: '',
		state: 'game',
		title: 'Lobby Found'
	};
}

export function matchmakerNoGamesView(
	criteria: IMatchmakerCriteria,
	hotkeys: MatchmakerHotkeyLabels,
	openServerWindow: boolean
): MatchmakerView {
	return {
		cancel: closeAction(hotkeys, openServerWindow),
		chips: matchmakerFilterChips(criteria),
		description: matchmakerNoResultsHint(criteria),
		hint: searchAgainHint(hotkeys, 'search again'),
		state: 'no-games',
		title: 'No Lobbies Match'
	};
}

export function matchmakerErrorView(
	message: string,
	hotkeys: MatchmakerHotkeyLabels,
	openServerWindow: boolean
): MatchmakerView {
	return {
		cancel: closeAction(hotkeys, openServerWindow),
		chips: [],
		description: message,
		hint: searchAgainHint(hotkeys, 'try again'),
		state: 'error',
		title: 'Search Failed'
	};
}

export function matchmakerCancelledView(hotkeys: MatchmakerHotkeyLabels): MatchmakerView {
	return {
		cancel: { hotkey: hotkeys.cancel, label: 'Close' },
		chips: [],
		description: '',
		hint: searchAgainHint(hotkeys, 'search again'),
		state: 'cancelled',
		title: 'Search Cancelled'
	};
}
