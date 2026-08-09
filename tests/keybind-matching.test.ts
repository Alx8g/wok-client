import assert from 'node:assert/strict';
import test from 'node:test';
import {
	type KeybindEventLike,
	type KeybindFocusTarget,
	keyboardEventMatchesKeybind
} from '../src/keybind-matching.ts';

const numberOne: KeybindUserPref = {
	alt: false,
	ctrl: false,
	key: '1',
	shift: false
};

function keyEvent(overrides: Partial<KeybindEventLike> = {}): KeybindEventLike {
	return {
		altKey: false,
		ctrlKey: false,
		key: '1',
		shiftKey: false,
		...overrides
	};
}

function focusTarget(tagName: string, visible: boolean, isContentEditable = false): KeybindFocusTarget {
	return {
		getClientRects: () => ({ length: visible ? 1 : 0 }),
		isContentEditable,
		tagName
	};
}

test('matches a configured number key and exact modifiers', () => {
	assert.equal(keyboardEventMatchesKeybind(numberOne, keyEvent()), true);
	assert.equal(keyboardEventMatchesKeybind(numberOne, keyEvent({ ctrlKey: true })), false);
	assert.equal(keyboardEventMatchesKeybind(numberOne, keyEvent({ key: '2' })), false);
});

test('does not fire while the player is typing into a visible control', () => {
	assert.equal(keyboardEventMatchesKeybind(numberOne, keyEvent(), focusTarget('INPUT', true)), false);
	assert.equal(keyboardEventMatchesKeybind(numberOne, keyEvent(), focusTarget('TEXTAREA', true)), false);
	assert.equal(keyboardEventMatchesKeybind(numberOne, keyEvent(), focusTarget('DIV', true, true)), false);
});

test('a hidden settings input cannot keep blocking the hotkey after settings close', () => {
	assert.equal(keyboardEventMatchesKeybind(numberOne, keyEvent(), focusTarget('INPUT', false)), true);
});
