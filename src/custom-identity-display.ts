import {
	type CustomIdentity,
	customIdentitiesAreEqual,
	EMPTY_CUSTOM_IDENTITY,
	formatCustomIdentityLabel,
	hasCustomIdentity,
	resolveCustomIdentity
} from './custom-identity.ts';

/**
 * The client-owned surface for the local display identity (src/custom-identity.ts).
 *
 * A single WOK-owned nameplate is mounted on <body>, next to the client splash and the
 * performance overlay, and never inside Krunker's own UI: no Krunker element is read, rewritten
 * or observed, and nothing here reaches the network. Menu-only visibility is a CSS rule keyed on
 * the same '#uiBase.onMenu' state the Menu Timer setting uses, so there is no observer and no
 * per-frame work; showing and hiding is the compositor's job. Teardown removes both nodes.
 */

export const CUSTOM_IDENTITY_ELEMENT_ID = 'wokCustomIdentity';
export const CUSTOM_IDENTITY_STYLE_ID = 'wokCustomIdentityStyle';

/** Marks the nameplate as carrying something; the CSS rule below keys off it instead of inline styles. */
const IDENTITY_STATE_ATTRIBUTE = 'data-wok-identity';

const NAMEPLATE_CSS = `
#${CUSTOM_IDENTITY_ELEMENT_ID} {
	display: none;
	position: fixed;
	bottom: 8px;
	left: 8px;
	z-index: 2147483646;
	max-width: 320px;
	padding: 6px 10px;
	border: 1px solid rgba(251, 192, 45, 0.72);
	border-radius: 6px;
	background: rgba(8, 10, 14, 0.82);
	color: #FFFFFF;
	contain: content;
	font: 600 13px/1.35 Consolas, monospace;
	pointer-events: none;
	text-align: left;
	user-select: none;
}
#${CUSTOM_IDENTITY_ELEMENT_ID} .wok-custom-identity-label {
	display: block;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
#${CUSTOM_IDENTITY_ELEMENT_ID} .wok-custom-identity-note {
	display: block;
	color: rgba(255, 255, 255, 0.58);
	font-size: 10px;
	font-weight: 400;
	letter-spacing: 0.04em;
	text-transform: uppercase;
}
body:has(#uiBase.onMenu) #${CUSTOM_IDENTITY_ELEMENT_ID}[${IDENTITY_STATE_ATTRIBUTE}="set"] {
	display: block;
}
`;

/** Spelled out on the badge itself so nobody mistakes it for having renamed their account. */
const LOCAL_ONLY_NOTE = 'Local display only';

export interface CustomIdentityNameplateOptions {
	document: Document;
}

export interface CustomIdentityNameplate {
	destroy(): void;
	update(identity: Readonly<CustomIdentity>): void;
}

/**
 * Mount the nameplate. Returns undefined when the document has no mount point yet, so callers can
 * simply try again on the next preference change instead of holding a half-built handle.
 */
export function mountCustomIdentityNameplate(
	identity: Readonly<CustomIdentity>,
	options: CustomIdentityNameplateOptions
): CustomIdentityNameplate | undefined {
	const { document: hostDocument } = options;
	const body = hostDocument.body;
	if (!body) return undefined;

	const style = hostDocument.createElement('style');
	style.id = CUSTOM_IDENTITY_STYLE_ID;
	style.textContent = NAMEPLATE_CSS;
	(hostDocument.head ?? body).appendChild(style);

	const container = hostDocument.createElement('div');
	container.id = CUSTOM_IDENTITY_ELEMENT_ID;
	container.setAttribute('aria-live', 'off');
	container.setAttribute('role', 'note');

	const label = hostDocument.createElement('span');
	label.className = 'wok-custom-identity-label';
	const note = hostDocument.createElement('span');
	note.className = 'wok-custom-identity-note';
	note.textContent = LOCAL_ONLY_NOTE;
	container.appendChild(label);
	container.appendChild(note);
	body.appendChild(container);

	let destroyed = false;
	const nameplate: CustomIdentityNameplate = {
		destroy() {
			if (destroyed) return;
			destroyed = true;
			container.remove();
			style.remove();
		},
		update(next) {
			if (destroyed) return;
			const text = formatCustomIdentityLabel(next);
			label.textContent = text;
			container.setAttribute('aria-label', text === '' ? LOCAL_ONLY_NOTE : `${text} (${LOCAL_ONLY_NOTE.toLowerCase()})`);
			container.setAttribute(IDENTITY_STATE_ATTRIBUTE, text === '' ? 'unset' : 'set');
		}
	};
	nameplate.update(identity);
	return nameplate;
}

let nameplate: CustomIdentityNameplate | undefined;
let currentIdentity: CustomIdentity = EMPTY_CUSTOM_IDENTITY;
let currentLabel = '';

/** The formatted identity for other client-owned surfaces (currently the performance overlay). */
export function getCustomIdentityLabel(): string {
	return currentLabel;
}

export function getCustomIdentity(): Readonly<CustomIdentity> {
	return currentIdentity;
}

/**
 * Apply a preferences object to the live surfaces. Cheap enough to call on every keystroke in the
 * settings UI: identical values are a no-op, and the nameplate is only created once something is
 * actually set, so users who never touch these settings never get an extra element.
 */
export function applyCustomIdentity(prefs: Readonly<Partial<UserPrefs>> | undefined): Readonly<CustomIdentity> {
	const identity = resolveCustomIdentity(prefs);
	if (nameplate && customIdentitiesAreEqual(identity, currentIdentity)) return currentIdentity;

	currentIdentity = identity;
	currentLabel = formatCustomIdentityLabel(identity);
	if (!nameplate) {
		if (!hasCustomIdentity(identity) || typeof document === 'undefined') return currentIdentity;
		nameplate = mountCustomIdentityNameplate(identity, { document });
		return currentIdentity;
	}
	nameplate.update(identity);
	return currentIdentity;
}

export function stopCustomIdentityDisplay(): void {
	nameplate?.destroy();
	nameplate = undefined;
	currentIdentity = EMPTY_CUSTOM_IDENTITY;
	currentLabel = '';
}
