import type { Display } from 'electron';
export const DISPLAY_PREFERENCE_AUTO = 'auto';
export type SelectableDisplay = Pick<Display, 'id' | 'bounds' | 'size' | 'scaleFactor'> & Partial<Pick<Display, 'label' | 'displayFrequency'>>;
export interface DisplayOption {
	value: string;
	label: string;
}
export interface DisplayResolution<TDisplay extends SelectableDisplay = SelectableDisplay> {
	display: TDisplay;
	fellBack: boolean;
	matchedBy: 'auto' | 'key' | 'name' | 'id' | 'primary-fallback';
}
const MAX_NAME_LENGTH = 40;
const MAX_SLUG_LENGTH = 32;
const DISPLAY_KEY_PATTERN = /^d:-?\d{1,19}(?::[a-z0-9-]{1,32})?$/u;
export function displayName(label: string | undefined): string {
	if (typeof label !== 'string') return '';
	const trimmed = label.trim().replace(/\s+/gu, ' ').slice(0, MAX_NAME_LENGTH);
	if (!trimmed) return '';
	if (/^\\\\[.?]\\display\s*\d+$/iu.test(trimmed)) return '';
	if (/^display\s*\d+$/iu.test(trimmed)) return '';
	if (/^\/dev\//u.test(trimmed)) return '';
	return trimmed;
}
export function displayNameSlug(label: string | undefined): string {
	return displayName(label)
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.slice(0, MAX_SLUG_LENGTH)
		.replace(/^-+|-+$/gu, '');
}
export function displayKey(display: SelectableDisplay): string {
	const slug = displayNameSlug(display.label);
	return slug ? `d:${display.id}:${slug}` : `d:${display.id}`;
}
export function isDisplayPreference(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	return value === DISPLAY_PREFERENCE_AUTO || DISPLAY_KEY_PATTERN.test(value);
}
function keyId(key: string): number | undefined {
	const parsed = Number(key.split(':')[1]);
	return Number.isInteger(parsed) ? parsed : undefined;
}
function keySlug(key: string): string {
	return key.split(':')[2] ?? '';
}
export function selectGameplayDisplay<TDisplay extends SelectableDisplay>(preference: unknown, displays: readonly TDisplay[], primary: TDisplay): DisplayResolution<TDisplay> {
	if (!isDisplayPreference(preference) || preference === DISPLAY_PREFERENCE_AUTO) {
		return { display: primary, fellBack: false, matchedBy: 'auto' };
	}
	const exact = displays.find((display) => displayKey(display) === preference);
	if (exact) return { display: exact, fellBack: false, matchedBy: 'key' };
	const wantedSlug = keySlug(preference);
	if (wantedSlug) {
		const byName = displays.filter((display) => displayNameSlug(display.label) === wantedSlug);
		if (byName.length === 1) return { display: byName[0], fellBack: false, matchedBy: 'name' };
	}
	const wantedId = keyId(preference);
	if (wantedId !== undefined) {
		const byId = displays.find((display) => display.id === wantedId);
		if (byId) return { display: byId, fellBack: false, matchedBy: 'id' };
	}
	return { display: primary, fellBack: true, matchedBy: 'primary-fallback' };
}
function nativeResolution(display: SelectableDisplay): string {
	const scale = typeof display.scaleFactor === 'number' && display.scaleFactor > 0 ? display.scaleFactor : 1;
	return `${Math.round(display.size.width * scale)}x${Math.round(display.size.height * scale)}`;
}
export function describeDisplay(display: SelectableDisplay, index: number, isPrimary: boolean): string {
	const parts = [`Display ${index + 1}`];
	const name = displayName(display.label);
	if (name) parts.push(name);
	let spec = nativeResolution(display);
	const hz = display.displayFrequency;
	if (typeof hz === 'number' && Number.isFinite(hz) && hz > 0) spec += ` @ ${Math.round(hz)} Hz`;
	parts.push(spec);
	const line = parts.join(' - ');
	return isPrimary ? `${line} (primary)` : line;
}
export function buildDisplayOptions(displays: readonly SelectableDisplay[], primaryId: number, storedValue?: unknown): DisplayOption[] {
	const options: DisplayOption[] = [{ value: DISPLAY_PREFERENCE_AUTO, label: 'Automatic (primary display)' }];
	for (const [index, display] of displays.entries()) {
		options.push({
			value: displayKey(display),
			label: describeDisplay(display, index, display.id === primaryId)
		});
	}
	if (isDisplayPreference(storedValue) && storedValue !== DISPLAY_PREFERENCE_AUTO && !options.some((option) => option.value === storedValue)) {
		options.push({ value: storedValue, label: 'Saved display (not connected)' });
	}
	return options;
}
