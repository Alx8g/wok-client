export const GAMEPLAY_BRANDING_ID = 'wokGameplayBranding';
export const GAMEPLAY_BRANDING_STYLE_ID = 'wokGameplayBrandingStyle';
export const GAMEPLAY_BRANDING_CSS = `
#${GAMEPLAY_BRANDING_ID} {
	display: block;
	width: max-content;
	margin: 1px 0 5px;
	padding: 0;
	color: #fff;
	font-size: 13px;
	font-weight: 700;
	line-height: 16px;
	letter-spacing: 0.04em;
	opacity: 0.88;
	text-shadow: 1px 1px 0 #202020, -1px -1px 0 #202020;
	pointer-events: none;
	user-select: none;
	contain: layout style paint;
}
#${GAMEPLAY_BRANDING_ID} .wok-gameplay-brand-url {
	color: #fff;
}
`;

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
