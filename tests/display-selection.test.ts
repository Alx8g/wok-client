import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildDisplayOptions,
	describeDisplay,
	DISPLAY_PREFERENCE_AUTO,
	displayKey,
	displayName,
	displayNameSlug,
	isDisplayPreference,
	selectGameplayDisplay,
	type SelectableDisplay
} from '../src/display-selection.ts';

function makeDisplay(overrides: Partial<SelectableDisplay> & Pick<SelectableDisplay, 'id'>): SelectableDisplay {
	return {
		bounds: { height: 1080, width: 1920, x: 0, y: 0 },
		scaleFactor: 1,
		size: { height: 1080, width: 1920 },
		...overrides
	};
}

const primary = makeDisplay({
	bounds: { height: 1440, width: 2560, x: 0, y: 0 },
	displayFrequency: 60,
	id: 11,
	label: 'ASUS VG259',
	size: { height: 1440, width: 2560 }
});

const secondary = makeDisplay({
	bounds: { height: 1080, width: 1920, x: 2560, y: 120 },
	displayFrequency: 240,
	id: 22,
	label: 'LG 27GN950'
});

const displays = [primary, secondary];

test('the default preference means the primary display, exactly as before the setting existed', () => {
	const resolution = selectGameplayDisplay(DISPLAY_PREFERENCE_AUTO, displays, primary);

	assert.equal(resolution.display, primary);
	assert.equal(resolution.fellBack, false);
	assert.equal(resolution.matchedBy, 'auto');
});

test('a stored key resolves to the display it names, not to the primary', () => {
	const resolution = selectGameplayDisplay(displayKey(secondary), displays, primary);

	assert.equal(resolution.display, secondary);
	assert.equal(resolution.fellBack, false);
	assert.equal(resolution.matchedBy, 'key');
});

test('a monitor that is not attached falls back to primary and says so', () => {
	const resolution = selectGameplayDisplay(displayKey(secondary), [primary], primary);

	assert.equal(resolution.display, primary);
	assert.equal(resolution.fellBack, true);
	assert.equal(resolution.matchedBy, 'primary-fallback');
});

test('a replugged monitor keeps its selection when its id churns but its name is unique', () => {
	const stored = displayKey(secondary);
	const renumbered = { ...secondary, id: 987 };

	const resolution = selectGameplayDisplay(stored, [primary, renumbered], primary);

	assert.equal(resolution.display, renumbered);
	assert.equal(resolution.fellBack, false);
	assert.equal(resolution.matchedBy, 'name');
});

test('two identical panels are never guessed between: an ambiguous name falls back to primary', () => {
	const stored = displayKey(secondary);
	const twinA = { ...secondary, id: 101 };
	const twinB = { ...secondary, id: 102 };

	const resolution = selectGameplayDisplay(stored, [primary, twinA, twinB], primary);

	assert.equal(resolution.display, primary);
	assert.equal(resolution.fellBack, true);
});

test('a nameless display is matched by id alone', () => {
	const nameless = makeDisplay({ id: 44, label: '\\\\.\\DISPLAY2' });
	const stored = displayKey(nameless);

	assert.equal(stored, 'd:44');
	const resolution = selectGameplayDisplay(stored, [primary, nameless], primary);
	assert.equal(resolution.display, nameless);
	assert.equal(resolution.matchedBy, 'key');
});

test('a renamed monitor still matches on its id', () => {
	const renamed = { ...secondary, label: 'LG Ultragear' };

	const resolution = selectGameplayDisplay(displayKey(secondary), [primary, renamed], primary);

	assert.equal(resolution.display, renamed);
	assert.equal(resolution.matchedBy, 'id');
});

test('a resolution change does not lose the selection: keys carry no geometry', () => {
	const rescaled = {
		...secondary,
		bounds: { height: 720, width: 1280, x: 2560, y: 120 },
		displayFrequency: 60,
		size: { height: 720, width: 1280 }
	};

	const resolution = selectGameplayDisplay(displayKey(secondary), [primary, rescaled], primary);
	assert.equal(resolution.display, rescaled);
	assert.equal(resolution.matchedBy, 'key');
});

test('hand-edited and malformed preference values resolve to primary rather than throwing', () => {
	for (const value of [undefined, null, 42, '', 'primary', 'd:', 'd:abc', 'd:1:UPPER', `d:1:${'x'.repeat(33)}`, { id: 22 }]) {
		const resolution = selectGameplayDisplay(value, displays, primary);
		assert.equal(resolution.display, primary, `expected primary for ${JSON.stringify(value)}`);
		assert.equal(resolution.matchedBy, 'auto');
	}
});

test('preference validation accepts auto and well-formed keys only', () => {
	assert.equal(isDisplayPreference(DISPLAY_PREFERENCE_AUTO), true);
	assert.equal(isDisplayPreference('d:11:asus-vg259'), true);
	assert.equal(isDisplayPreference('d:-3'), true);
	assert.equal(isDisplayPreference('d:11:'), false);
	assert.equal(isDisplayPreference('d:11:asus vg259'), false);
	assert.equal(isDisplayPreference('auto '), false);
	assert.equal(isDisplayPreference(11), false);
	assert.equal(isDisplayPreference('d:11:asus:extra'), false);
});

test('positional device paths are not treated as monitor names', () => {
	assert.equal(displayName('\\\\.\\DISPLAY1'), '');
	assert.equal(displayName('Display 2'), '');
	assert.equal(displayName('/dev/dri/card0'), '');
	assert.equal(displayName('  LG  27GN950 '), 'LG 27GN950');
	assert.equal(displayNameSlug('LG 27GN950'), 'lg-27gn950');
	assert.equal(displayNameSlug('!!!'), '');
	assert.equal(displayNameSlug(undefined), '');
});

test('labels give a player an index, a name, native resolution, refresh rate and the primary marker', () => {
	assert.equal(describeDisplay(primary, 0, true), 'Display 1 - ASUS VG259 - 2560x1440 @ 60 Hz (primary)');
	assert.equal(describeDisplay(secondary, 1, false), 'Display 2 - LG 27GN950 - 1920x1080 @ 240 Hz');
});

test('labels report native pixels, so a scaled panel is not mislabelled with its DIP size', () => {
	const scaled = makeDisplay({
		id: 5,
		scaleFactor: 1.5,
		size: { height: 1440, width: 2560 }
	});

	assert.equal(describeDisplay(scaled, 0, false), 'Display 1 - 3840x2160');
});

test('an unknown refresh rate is omitted rather than reported as zero', () => {
	const noHz = makeDisplay({ displayFrequency: 0, id: 7, label: 'Generic PnP Monitor' });
	assert.equal(describeDisplay(noHz, 2, false), 'Display 3 - Generic PnP Monitor - 1920x1080');
});

test('the dropdown always offers automatic first, then every attached display', () => {
	assert.deepEqual(buildDisplayOptions(displays, primary.id, DISPLAY_PREFERENCE_AUTO), [
		{ value: 'auto', label: 'Automatic (primary display)' },
		{ value: 'd:11:asus-vg259', label: 'Display 1 - ASUS VG259 - 2560x1440 @ 60 Hz (primary)' },
		{ value: 'd:22:lg-27gn950', label: 'Display 2 - LG 27GN950 - 1920x1080 @ 240 Hz' }
	]);
});

test('a remembered but unplugged monitor keeps an entry, so the picker never lies about the saved value', () => {
	const options = buildDisplayOptions([primary], primary.id, displayKey(secondary));

	assert.deepEqual(options.at(-1), {
		value: 'd:22:lg-27gn950',
		label: 'Saved display (not connected)'
	});
});

test('a malformed stored value adds no phantom entry', () => {
	assert.deepEqual(buildDisplayOptions([primary], primary.id, 'nonsense').length, 2);
	assert.deepEqual(buildDisplayOptions([primary], primary.id, DISPLAY_PREFERENCE_AUTO).length, 2);
});

test('enumeration failing entirely still yields a usable automatic-only dropdown', () => {
	assert.deepEqual(buildDisplayOptions([], -1, DISPLAY_PREFERENCE_AUTO), [
		{ value: 'auto', label: 'Automatic (primary display)' }
	]);
});
