export const GAMEPLAY_BRANDING_ID = 'wokGameplayBranding';
export const GAMEPLAY_BRANDING_STYLE_ID = 'wokGameplayBrandingStyle';
export const GAMEPLAY_BRANDING_CSS = `
#${GAMEPLAY_BRANDING_ID} {
	display: flex;
	align-items: baseline;
	gap: 7px;
	width: max-content;
	margin: 1px 0 5px;
	padding: 3px 7px 3px 6px;
	border-left: 3px solid #fbc02d;
	border-radius: 2px;
	background: rgba(0, 0, 0, 0.58);
	color: rgba(255, 255, 255, 0.82);
	font-size: 13px;
	font-weight: 700;
	line-height: 16px;
	letter-spacing: 0.03em;
	text-shadow: 1px 1px 0 #202020, -1px -1px 0 #202020;
	pointer-events: none;
	user-select: none;
	contain: layout style paint;
}
#${GAMEPLAY_BRANDING_ID} .wok-gameplay-brand-url {
	color: #fbc02d;
	font-size: 15px;
	letter-spacing: 0.05em;
}
`;

/** Insert one static, click-through brand strip between Krunker's timer and match details. */
export function mountGameplayBranding(targetDocument: Document = document): boolean {
	if (targetDocument.getElementById(GAMEPLAY_BRANDING_ID)) return true;
	const holder = targetDocument.getElementById('topLeftMatchData');
	if (!holder) return false;

	if (!targetDocument.getElementById(GAMEPLAY_BRANDING_STYLE_ID)) {
		const style = targetDocument.createElement('style');
		style.id = GAMEPLAY_BRANDING_STYLE_ID;
		style.textContent = GAMEPLAY_BRANDING_CSS;
		(targetDocument.head ?? targetDocument.body ?? targetDocument.documentElement)?.append(style);
	}

	const branding = targetDocument.createElement('div');
	branding.id = GAMEPLAY_BRANDING_ID;
	branding.className = 'wok-gameplay-branding';

	const url = targetDocument.createElement('span');
	url.className = 'wok-gameplay-brand-url';
	url.textContent = 'WOK.SOCIAL';

	branding.append(url);
	holder.insertBefore(branding, targetDocument.getElementById('matchInfo'));
	return true;
}

/** Observe only until Krunker's static HUD shell has been parsed, then leave no running work. */
export function installGameplayBranding(): () => void {
	if (mountGameplayBranding()) return () => {};
	if (typeof MutationObserver !== 'function') return () => {};
	if (!document.documentElement) {
		const mountWhenParsed = () => { mountGameplayBranding(); };
		document.addEventListener('DOMContentLoaded', mountWhenParsed, { once: true });
		return () => { document.removeEventListener('DOMContentLoaded', mountWhenParsed); };
	}

	const observer = new MutationObserver(() => {
		if (mountGameplayBranding()) observer.disconnect();
	});
	observer.observe(document.documentElement, { childList: true, subtree: true });
	const stop = () => { observer.disconnect(); };
	window.addEventListener('beforeunload', stop, { once: true });
	return stop;
}
