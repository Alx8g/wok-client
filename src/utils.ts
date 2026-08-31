import { webFrame } from 'electron';
import { strippedConsole } from './preload.ts';
import * as os from 'os';
import { UPSTREAM_REPO_ID } from './branding.ts';
import { keyboardEventMatchesKeybind } from './keybind-matching.ts';
export const upstreamRepoID = UPSTREAM_REPO_ID;
export function createElement(type: string, options: Object = {}) {
	const element = document.createElement(type);
	Object.entries(options).forEach(([key, value]) => {
		if (key === 'class') {
			if (Array.isArray(value))
				value.forEach((cls: string) => {
					element.classList.add(cls);
				});
			else element.classList.add(value);
			return;
		}
		if (key === 'dataset') {
			Object.entries(value).forEach((entry) => {
				const [dataKey, dataValue] = entry;
				element.dataset[dataKey] = dataValue as string;
			});
			return;
		}
		if (key === 'text') {
			element.textContent = value;
			return;
		}
		if (key === 'innerHTML') {
			element.innerHTML = value;
			return;
		}
		if (key === 'innerText') {
			element.innerText = value;
			return;
		}
		element.setAttribute(key, value);
	});
	return element;
}
const insertedCSS: InsertedCSS = {};
export function toggleSettingCSS(css: string, identifier: string, value: 'toggle' | boolean = 'toggle') {
	function inject() {
		insertedCSS[identifier] = webFrame.insertCSS(css);
	}
	function uninject() {
		try {
			webFrame.removeInsertedCSS(insertedCSS[identifier]);
			delete insertedCSS[identifier];
		} catch (error) {
			strippedConsole.error("couldn't uninject css: ", error);
		}
	}
	if (value === 'toggle') {
		if (!(identifier in insertedCSS)) inject();
		else uninject();
	} else if (!(identifier in insertedCSS) && value === true) {
		inject();
	} else if (identifier in insertedCSS && value === false) {
		uninject();
	}
}
export function hiddenClassesImages(classesCount: number) {
	const prepend = 'menuClassPicker0'.slice(0, -1);
	const gaps = 4 * (classesCount - 1);
	const theoreticalButtonSize = Math.round((810 - gaps) / classesCount);
	const buttonSize = Math.min(theoreticalButtonSize, 50);
	let css = `#hiddenClasses [id^="menuClassPicker"] {
		width: ${buttonSize}px; height: ${buttonSize}px;
		background-size: ${buttonSize - 6}px ${buttonSize - 6}px;
	}\n`;
	for (let i = 0; i < classesCount; i++) css += `#${prepend}${i} { background-image: url("https://assets.krunker.io/textures/classes/icon_${i}.png"); } \n`;
	return css;
}
export function secondsToTimestring(num: number) {
	const minutes = Math.floor(num / 60);
	const seconds = num % 60;
	if (minutes < 1) return `${num}s`;
	return `${minutes}m ${seconds}s`;
}
export function haveSameContents(array1: unknown[], array2: unknown[]) {
	if (array1.length !== array2.length) return false;
	const remaining = new Map<unknown, number>();
	for (const value of array1) remaining.set(value, (remaining.get(value) ?? 0) + 1);
	for (const value of array2) {
		const count = remaining.get(value);
		if (!count) return false;
		if (count === 1) remaining.delete(value);
		else remaining.set(value, count - 1);
	}
	return remaining.size === 0;
}
export function objectsAreEqual(
	object1: {
		[key: string]: any;
	},
	object2: {
		[key: string]: any;
	}
) {
	if (typeof object1 !== typeof object2) return false;
	if (Array.isArray(object1) && Array.isArray(object2) && !haveSameContents(object1, object2)) return false;
	if (!haveSameContents(Object.keys(object1), Object.keys(object2))) return false;
	for (const key of Object.keys(object1)) {
		const object1Value = object1[key];
		const object2Value = object2[key];
		if (typeof object1Value !== typeof object2Value) return false;
		if (Array.isArray(object1Value)) {
			if (!Array.isArray(object2Value)) return false;
			if (!haveSameContents(object1Value, object2Value)) return false;
			continue;
		}
		if (typeof object1Value === 'object') {
			if (!objectsAreEqual(object1Value, object2Value)) return false;
			continue;
		}
		if (object1Value !== object2Value) return false;
	}
	return true;
}
export function keyboardEventMatchesCustomSetting(setting: KeybindUserPref, event: KeyboardEvent) {
	return keyboardEventMatchesKeybind(setting, event, document.activeElement as HTMLElement | null);
}
export function parseKeybindSettingDisplay(setting: KeybindUserPref) {
	return (setting.shift ? 'Shift+' : '') + (setting.ctrl ? (os.platform() === 'darwin' ? 'CMD+' : 'CTRL+') : '') + (setting.alt ? 'Alt+' : '') + setting.key.toUpperCase();
}
export function turnKeyboardEventIntoSettingValue(event: KeyboardEvent): KeybindUserPref {
	if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt')
		return {
			shift: false,
			ctrl: false,
			alt: false,
			key: event.key
		};
	return {
		shift: event.shiftKey,
		ctrl: event.ctrlKey,
		alt: event.altKey,
		key: event.key
	};
}
