

export const CUSTOM_NAME_MAX_LENGTH = 16;

export const CUSTOM_CLAN_MAX_LENGTH = 5;

const DISALLOWED_CHARACTERS = /[^A-Za-z0-9_-]/gu;

export interface CustomIdentity {
	clan: string;
	name: string;
}

export const EMPTY_CUSTOM_IDENTITY: CustomIdentity = Object.freeze({ clan: '', name: '' });

function sanitize(value: unknown, maxLength: number): string {
	if (typeof value !== 'string') return '';

	return value.trim().replace(DISALLOWED_CHARACTERS, '').slice(0, maxLength);
}

export function sanitizeCustomName(value: unknown): string {
	return sanitize(value, CUSTOM_NAME_MAX_LENGTH);
}

export function sanitizeCustomClan(value: unknown): string {
	return sanitize(value, CUSTOM_CLAN_MAX_LENGTH);
}

export const CUSTOM_NAME_PREFERENCE_KEY = 'customName';
export const CUSTOM_CLAN_PREFERENCE_KEY = 'customClan';

export const CUSTOM_IDENTITY_RGB_CYCLE_PREFERENCE_KEY = 'customIdentityRgbCycle';

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

export function isCustomIdentityPreferenceKey(key: string): boolean {
	return IDENTITY_PREFERENCE_KEYS.has(key);
}

export function isCustomIdentityTextPreferenceKey(key: string): boolean {
	return TEXT_IDENTITY_PREFERENCE_KEYS.has(key);
}

export function resolveCustomIdentityRgbCycle(prefs: Readonly<Partial<UserPrefs>> | undefined): boolean {
	return prefs?.[CUSTOM_IDENTITY_RGB_CYCLE_PREFERENCE_KEY] === true;
}

export function parseCustomIdentityPreference(key: string, value: unknown): string | boolean | undefined {
	if (key === CUSTOM_IDENTITY_RGB_CYCLE_PREFERENCE_KEY) return typeof value === 'boolean' ? value : undefined;
	if (!isCustomIdentityTextPreferenceKey(key) || typeof value !== 'string') return undefined;
	const sanitized = CLAN_PREFERENCE_KEYS.has(key) ? sanitizeCustomClan(value) : sanitizeCustomName(value);
	return sanitized === value ? value : undefined;
}

export function resolveCustomIdentity(prefs: Readonly<Partial<UserPrefs>> | undefined): CustomIdentity {
	if (!prefs) return EMPTY_CUSTOM_IDENTITY;
	return {
		clan: sanitizeCustomClan(prefs[CUSTOM_CLAN_PREFERENCE_KEY]),
		name: sanitizeCustomName(prefs[CUSTOM_NAME_PREFERENCE_KEY])
	};
}

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

export function formatCustomIdentityLabel(identity: Readonly<CustomIdentity>): string {
	const clan = identity.clan === '' ? '' : `[${identity.clan}]`;
	return [clan, identity.name].filter(part => part !== '').join(' ');
}

const PLAUSIBLE_REAL_NAME = /^[^\s<>"'&]{1,32}$/u;

const PLACEHOLDER_REAL_NAMES = new Set(['guest', 'player', 'unknown', 'anonymous']);

export function isPlaceholderRealName(value: string): boolean {
	return PLACEHOLDER_REAL_NAMES.has(value.trim().toLowerCase());
}

export function isPlausibleRealName(value: unknown): value is string {
	return typeof value === 'string'
		&& PLAUSIBLE_REAL_NAME.test(value)
		&& !isPlaceholderRealName(value);
}

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
