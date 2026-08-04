import type { Display } from 'electron';

/**
 * Which monitor the game opens on.
 *
 * Electron hands us a list of displays with numeric ids, and those ids are meaningless to a player
 * and only semi-stable to us. Chromium derives them per platform - a hash of the Windows device
 * name, the CGDirectDisplayID on macOS, the output name on X11 - so they survive an ordinary reboot
 * on an unchanged setup, but they can and do churn when monitors are replugged, when the cable
 * moves to another port, or when the GPU re-enumerates outputs. Persisting a bare id would
 * therefore silently drop the user's choice on the exact day their hardware changed.
 *
 * So the persisted value is a compound key, `d:<id>:<name-slug>`, and resolution is a ranked match
 * (see {@link selectGameplayDisplay}). The slug comes from `Display.label`, the monitor name the OS
 * reports - usually straight off the panel's EDID, which is the most stable identifier available
 * here. Generic device paths (`\\.\DISPLAY1` on Windows) are deliberately excluded from the slug:
 * they are positional, so they shift on exactly the replug we are trying to survive. A display with
 * no meaningful name gets a key of `d:<id>` and is matched by id alone.
 *
 * ## Missing displays
 *
 * If nothing matches, the game opens on the primary display and the preference is left untouched on
 * disk. Undocking a laptop must not cost the user the setting they will want again tomorrow, and a
 * remembered rectangle must never be used for a monitor that is not there - that is how a window
 * ends up off-screen.
 *
 * ## Launch-time only
 *
 * The display is resolved when a window is created, not continuously. Electron's `screen` module
 * does emit `display-added` / `display-removed` / `display-metrics-changed`, and we deliberately do
 * not act on them: yanking a running game window onto another monitor mid-match is a worse outcome
 * than leaving it where the user can see it, and the OS already relocates windows off a display
 * that disappears, so no live handling is needed to stay on-screen. The choice takes effect on the
 * next launch, which is what the setting's restart marker already tells the user.
 *
 * Electron-free by design so the whole matrix is testable under `node --test`.
 */

/** Persisted value meaning "whatever the OS calls primary" - the default, and the pre-feature behaviour. */
export const DISPLAY_PREFERENCE_AUTO = 'auto';

/** The subset of Electron's Display this module reads. */
export type SelectableDisplay = Pick<Display, 'id' | 'bounds' | 'size' | 'scaleFactor'>
	& Partial<Pick<Display, 'label' | 'displayFrequency'>>;

export interface DisplayOption {
	/** Persisted preference value. */
	value: string;
	/** What the player reads in the dropdown. */
	label: string;
}

export interface DisplayResolution<TDisplay extends SelectableDisplay = SelectableDisplay> {
	/** The display to place windows on. Never undefined: falls back to `primary`. */
	display: TDisplay;
	/** True when the requested display could not be found and primary was substituted. */
	fellBack: boolean;
	/** How the match was made, for logs and tests. */
	matchedBy: 'auto' | 'key' | 'name' | 'id' | 'primary-fallback';
}

const MAX_NAME_LENGTH = 40;
const MAX_SLUG_LENGTH = 32;
const DISPLAY_KEY_PATTERN = /^d:-?\d{1,19}(?::[a-z0-9-]{1,32})?$/u;

/**
 * The monitor's own name, or empty when the OS only offers a positional device path. Windows
 * commonly reports `\\.\DISPLAY1`, which both tells the player nothing the list index does not
 * already say and renumbers itself when monitors are replugged.
 */
export function displayName(label: string | undefined): string {
	if (typeof label !== 'string') return '';
	const trimmed = label.trim().replace(/\s+/gu, ' ').slice(0, MAX_NAME_LENGTH);
	if (!trimmed) return '';
	if (/^\\\\[.?]\\display\s*\d+$/iu.test(trimmed)) return '';
	if (/^display\s*\d+$/iu.test(trimmed)) return '';
	if (/^\/dev\//u.test(trimmed)) return '';
	return trimmed;
}

/**
 * Reduce a monitor name to a short, comparable, markup-safe slug. Names come from EDID, so they can
 * carry punctuation and non-ASCII; none of that belongs in a persisted key.
 */
export function displayNameSlug(label: string | undefined): string {
	return displayName(label)
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.slice(0, MAX_SLUG_LENGTH)
		.replace(/^-+|-+$/gu, '');
}

/** The persisted key for a display: its Electron id, anchored by a slug of its OS name when it has one. */
export function displayKey(display: SelectableDisplay): string {
	const slug = displayNameSlug(display.label);
	return slug ? `d:${display.id}:${slug}` : `d:${display.id}`;
}

/** Accepts `auto` and well-formed display keys only; anything else is a hand-edited config. */
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

/**
 * Ranked resolution of a persisted preference against the displays actually attached right now.
 *
 * The order matters. An exact key match is the normal path. A unique name match comes next because
 * an EDID panel name effectively never changes while Chromium's id churns on a replug - so when the
 * two disagree, the name is the better evidence of which physical monitor the user meant.
 * Uniqueness is required: two identical panels slug identically, and guessing between them would be
 * worse than using primary. An id-only match then covers displays with no usable name at all.
 * Everything else is a genuine miss.
 */
export function selectGameplayDisplay<TDisplay extends SelectableDisplay>(
	preference: unknown,
	displays: readonly TDisplay[],
	primary: TDisplay
): DisplayResolution<TDisplay> {
	if (!isDisplayPreference(preference) || preference === DISPLAY_PREFERENCE_AUTO) {
		return { display: primary, fellBack: false, matchedBy: 'auto' };
	}

	const exact = displays.find(display => displayKey(display) === preference);
	if (exact) return { display: exact, fellBack: false, matchedBy: 'key' };

	const wantedSlug = keySlug(preference);
	if (wantedSlug) {
		const byName = displays.filter(display => displayNameSlug(display.label) === wantedSlug);
		if (byName.length === 1) return { display: byName[0], fellBack: false, matchedBy: 'name' };
	}

	const wantedId = keyId(preference);
	if (wantedId !== undefined) {
		const byId = displays.find(display => display.id === wantedId);
		if (byId) return { display: byId, fellBack: false, matchedBy: 'id' };
	}

	return { display: primary, fellBack: true, matchedBy: 'primary-fallback' };
}

/**
 * Native pixel dimensions, which is the number a player recognises as "their resolution". Electron
 * reports `size` in device-independent pixels, so a 4K panel at 150% scaling would otherwise be
 * labelled 2560x1440 and look like the wrong monitor.
 */
function nativeResolution(display: SelectableDisplay): string {
	const scale = typeof display.scaleFactor === 'number' && display.scaleFactor > 0 ? display.scaleFactor : 1;
	return `${Math.round(display.size.width * scale)}x${Math.round(display.size.height * scale)}`;
}

/**
 * A dropdown line a player can act on: position in the list, the monitor's own name when the OS
 * gives us a useful one, native resolution, refresh rate, and which one the OS calls primary.
 */
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

/**
 * Build the dropdown. `storedValue` is the preference as persisted: when it names a display that is
 * not attached, an extra entry is appended so the select shows the truth instead of silently
 * reading back as "Automatic" - the preference is still on disk and will be honoured the moment
 * that monitor comes back.
 */
export function buildDisplayOptions(
	displays: readonly SelectableDisplay[],
	primaryId: number,
	storedValue?: unknown
): DisplayOption[] {
	const options: DisplayOption[] = [
		{ value: DISPLAY_PREFERENCE_AUTO, label: 'Automatic (primary display)' }
	];
	for (const [index, display] of displays.entries()) {
		options.push({
			value: displayKey(display),
			label: describeDisplay(display, index, display.id === primaryId)
		});
	}

	if (
		isDisplayPreference(storedValue)
		&& storedValue !== DISPLAY_PREFERENCE_AUTO
		&& !options.some(option => option.value === storedValue)
	) {
		options.push({ value: storedValue, label: 'Saved display (not connected)' });
	}

	return options;
}
