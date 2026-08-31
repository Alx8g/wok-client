/**
 * Local display identity: an optional name and clan tag that replace the player's own name and
 * clan wherever this client draws them - chat, the kill feed, the scoreboard, the HUD, the menu
 * card.
 *
 * These values are display-only and deliberately dead-ended here. Nothing in this module, or in
 * the surfaces that consume it, touches what Krunker sends or receives: the account identity the
 * servers know, and therefore what every other player sees, is untouched. Spoofing the transmitted
 * identity would break Krunker's rules and get users banned, so the custom values never leave the
 * local renderer.
 *
 * Pure and dependency-free so the rules can be tested directly (tests/custom-identity.test.ts).
 */

/** Krunker account names are at most 16 characters; the local display follows the same ceiling. */
export const CUSTOM_NAME_MAX_LENGTH = 16;

/** Generous enough for Krunker's clan tags, short enough to stay a tag rather than a second name. */
export const CUSTOM_CLAN_MAX_LENGTH = 5;

/**
 * Krunker names are letters, digits and underscores. The dash is allowed too because this string
 * is never sent anywhere, and the set stays narrow on purpose: the settings UI renders text
 * settings into markup, so an accepted value must never be able to carry quotes or angle brackets.
 */
const DISALLOWED_CHARACTERS = /[^A-Za-z0-9_-]/gu;

export interface CustomIdentity {
	clan: string;
	name: string;
}

/** Nothing set: both surfaces fall back to whatever Krunker itself displays. */
export const EMPTY_CUSTOM_IDENTITY: CustomIdentity = Object.freeze({ clan: '', name: '' });

function sanitize(value: unknown, maxLength: number): string {
	if (typeof value !== 'string') return '';
	// Trim first so surrounding whitespace never eats into the length budget, then drop every
	// character outside the allowed set (which removes any remaining inner whitespace), then cut
	// to length. The result contains no whitespace at all, so it is already trimmed and slicing
	// cannot leave a dangling space: sanitize(sanitize(x)) === sanitize(x).
	return value.trim().replace(DISALLOWED_CHARACTERS, '').slice(0, maxLength);
}

/** Coerce any input into a storable custom name. Returns '' when nothing usable is left. */
export function sanitizeCustomName(value: unknown): string {
	return sanitize(value, CUSTOM_NAME_MAX_LENGTH);
}

/** Coerce any input into a storable custom clan tag. Returns '' when nothing usable is left. */
export function sanitizeCustomClan(value: unknown): string {
	return sanitize(value, CUSTOM_CLAN_MAX_LENGTH);
}

/** Preference keys this module owns, so user-preferences.ts and main.ts cannot drift apart. */
export const CUSTOM_NAME_PREFERENCE_KEY = 'customName';
export const CUSTOM_CLAN_PREFERENCE_KEY = 'customClan';
/** Opt-in legacy-style fast RGB animation for the rewritten identity fragments. */
export const CUSTOM_IDENTITY_RGB_CYCLE_PREFERENCE_KEY = 'customIdentityRgbCycle';

/**
 * The manual half of identity discovery. The client reads the real name from Krunker at runtime
 * (see src/custom-identity-display.ts); these keys exist so a player whose account the game does
 * not expose in time - or whose clan tag it never exposes at all - can still say what to look for
 * instead of getting a feature that silently does nothing.
 */
export const REAL_NAME_PREFERENCE_KEY = 'realName';
export const REAL_CLAN_PREFERENCE_KEY = 'realClan';

const CLAN_PREFERENCE_KEYS = new Set<string>([CUSTOM_CLAN_PREFERENCE_KEY, REAL_CLAN_PREFERENCE_KEY]);
const TEXT_IDENTITY_PREFERENCE_KEYS = new Set<string>([
	CUSTOM_CLAN_PREFERENCE_KEY,
	CUSTOM_NAME_PREFERENCE_KEY,
	REAL_CLAN_PREFERENCE_KEY,
	REAL_NAME_PREFERENCE_KEY
]);
const IDENTITY_PREFERENCE_KEYS = new Set<string>([
	...TEXT_IDENTITY_PREFERENCE_KEYS,
	CUSTOM_IDENTITY_RGB_CYCLE_PREFERENCE_KEY
]);

/** True for every custom-identity preference, including the RGB-cycle toggle. */
export function isCustomIdentityPreferenceKey(key: string): boolean {
	return IDENTITY_PREFERENCE_KEYS.has(key);
}

/** True for the identity preferences whose values are sanitized handle strings. */
export function isCustomIdentityTextPreferenceKey(key: string): boolean {
	return TEXT_IDENTITY_PREFERENCE_KEYS.has(key);
}

/** Read the opt-in legacy RGB animation preference with a safe-off default. */
export function resolveCustomIdentityRgbCycle(prefs: Readonly<Partial<UserPrefs>> | undefined): boolean {
	return prefs?.[CUSTOM_IDENTITY_RGB_CYCLE_PREFERENCE_KEY] === true;
}

/**
 * Preference-loader entry point. A stored value is accepted only when it is already exactly what
 * sanitising would produce, so a hand-edited settings.json cannot smuggle in an over-long or
 * markup-bearing value; anything else is dropped and the empty default applies. '' is valid and
 * means "use the real one".
 */
export function parseCustomIdentityPreference(key: string, value: unknown): string | boolean | undefined {
	if (key === CUSTOM_IDENTITY_RGB_CYCLE_PREFERENCE_KEY) return typeof value === 'boolean' ? value : undefined;
	if (!isCustomIdentityTextPreferenceKey(key) || typeof value !== 'string') return undefined;
	const sanitized = CLAN_PREFERENCE_KEYS.has(key) ? sanitizeCustomClan(value) : sanitizeCustomName(value);
	return sanitized === value ? value : undefined;
}

/** Read the display identity out of a preferences object. Unset or invalid entries become ''. */
export function resolveCustomIdentity(prefs: Readonly<Partial<UserPrefs>> | undefined): CustomIdentity {
	if (!prefs) return EMPTY_CUSTOM_IDENTITY;
	return {
		clan: sanitizeCustomClan(prefs[CUSTOM_CLAN_PREFERENCE_KEY]),
		name: sanitizeCustomName(prefs[CUSTOM_NAME_PREFERENCE_KEY])
	};
}

/** Read the manually configured real identity - what to search the game's UI for. */
export function resolveConfiguredRealIdentity(prefs: Readonly<Partial<UserPrefs>> | undefined): CustomIdentity {
	if (!prefs) return EMPTY_CUSTOM_IDENTITY;
	return {
		clan: sanitizeCustomClan(prefs[REAL_CLAN_PREFERENCE_KEY]),
		name: sanitizeCustomName(prefs[REAL_NAME_PREFERENCE_KEY])
	};
}

export function hasCustomIdentity(identity: Readonly<CustomIdentity>): boolean {
	return identity.clan !== '' || identity.name !== '';
}

export function customIdentitiesAreEqual(first: Readonly<CustomIdentity>, second: Readonly<CustomIdentity>): boolean {
	return first.clan === second.clan && first.name === second.name;
}

/** '[CLAN] Name', or whichever half is set. '' when neither is. */
export function formatCustomIdentityLabel(identity: Readonly<CustomIdentity>): string {
	const clan = identity.clan === '' ? '' : `[${identity.clan}]`;
	return [clan, identity.name].filter(part => part !== '').join(' ');
}

/*
 * Discovering the real identity.
 *
 * A discovered name is only ever used as a search string: it is compared against text the game
 * already rendered and is never written into markup, so it does not have to survive the settings
 * charset. It does have to be a single visible token, which rules out the placeholder strings and
 * sentences an unauthenticated or half-loaded game returns.
 */
const PLAUSIBLE_REAL_NAME = /^[^\s<>"'&]{1,32}$/u;

/** True for something that could be an account name Krunker prints in its UI. */
/**
 * Names Krunker reports before an account session exists. Latching onto one of these is worse
 * than finding nothing: discovery stops on its first hit, so a placeholder captured during
 * start-up would be treated as the player's name for the whole session - which is exactly what
 * happened, with 'Guest' recorded seconds before the real account name became available.
 */
const PLACEHOLDER_REAL_NAMES = new Set(['guest', 'player', 'unknown', 'anonymous']);

export function isPlaceholderRealName(value: string): boolean {
	return PLACEHOLDER_REAL_NAMES.has(value.trim().toLowerCase());
}

export function isPlausibleRealName(value: unknown): value is string {
	return typeof value === 'string'
		&& PLAUSIBLE_REAL_NAME.test(value)
		&& !isPlaceholderRealName(value);
}

/**
 * Pull the signed-in player's name out of Krunker's own game-activity object.
 *
 * `window.getGameActivity()` is the API this client already reads for Discord presence, and its
 * `user` field is the account name (see GameInfo in src/global.d.ts). Reading it means the feature
 * does not have to guess at a DOM element that happens to hold the name today. The whole call is
 * defensive because it is Krunker's object, not ours: anything unexpected yields ''.
 */
export function readGameActivityName(getGameActivity: unknown): string {
	if (typeof getGameActivity !== 'function') return '';
	let activity: unknown;
	try {
		activity = (getGameActivity as () => unknown)();
	} catch (_error) {
		return '';
	}
	if (!activity || typeof activity !== 'object') return '';
	const user = (activity as { user?: unknown }).user;
	return isPlausibleRealName(user) ? user : '';
}

/**
 * Recover a clan tag from text the game already rendered, given the real name.
 *
 * Krunker does not expose the clan through getGameActivity, but it does print '[TAG] Name'. Only
 * the bracketed form counts: an unbracketed word before a name is just as likely to be someone
 * saying "gg Rocketeer" in chat. Returns '' when the text reveals nothing.
 */
export function extractClanTag(text: unknown, name: string): string {
	if (typeof text !== 'string' || name === '' || !text.includes(name)) return '';
	const pattern = new RegExp(
		`\\[([A-Za-z0-9_-]{1,${CUSTOM_CLAN_MAX_LENGTH}})\\]\\s*${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![A-Za-z0-9_-])`,
		'u'
	);
	const match = pattern.exec(text);
	return match ? match[1] : '';
}

export interface RealIdentityCandidates {
	clans: string[];
	names: string[];
}

/**
 * Everything worth searching the UI for. The configured values come first so a player who typed
 * their name explicitly is matched even when the game reports something else, and duplicates and
 * blanks are dropped so the matcher never builds a pattern with an empty alternative.
 */
export function mergeRealIdentityCandidates(
	configured: Readonly<CustomIdentity>,
	discovered: Readonly<Partial<CustomIdentity>>
): RealIdentityCandidates {
	const collect = (...values: (string | undefined)[]) => [
		...new Set(values.filter((value): value is string => typeof value === 'string' && value !== ''))
	];
	return {
		clans: collect(configured.clan, discovered.clan),
		names: collect(configured.name, discovered.name)
	};
}
