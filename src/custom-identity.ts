/**
 * Local display identity: an optional name and clan tag that WOK renders on its own surfaces.
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

/**
 * Preference-loader entry point. A stored value is accepted only when it is already exactly what
 * sanitising would produce, so a hand-edited settings.json cannot smuggle in an over-long or
 * markup-bearing value; anything else is dropped and the empty default applies. '' is valid and
 * means "use the real one".
 */
export function parseCustomIdentityPreference(key: string, value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const sanitized = key === CUSTOM_CLAN_PREFERENCE_KEY ? sanitizeCustomClan(value) : sanitizeCustomName(value);
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
