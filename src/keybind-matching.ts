export interface KeybindEventLike {
	altKey: boolean;
	ctrlKey: boolean;
	key: string;
	shiftKey: boolean;
}

export interface KeybindFocusTarget {
	getClientRects(): { length: number };
	isContentEditable?: boolean;
	tagName: string;
}

export function keyboardEventMatchesKeybind(
	setting: KeybindUserPref,
	event: KeybindEventLike,
	activeElement?: KeybindFocusTarget | null
): boolean {
	const acceptsText = activeElement
		&& (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName) || activeElement.isContentEditable);
	// Hidden settings controls can retain focus after the panel closes. They should not keep blocking
	// client hotkeys when they no longer have a rendered box capable of receiving typed input.
	if (acceptsText && activeElement.getClientRects().length > 0) return false;
	return event.key === setting.key
		&& event.shiftKey === setting.shift
		&& event.altKey === setting.alt
		&& event.ctrlKey === setting.ctrl;
}
