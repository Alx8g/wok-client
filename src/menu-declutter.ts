

import { mutationRecordsTouchSelector } from './mutation-relevance.ts';

export const MENU_DECLUTTER_PREFERENCE_KEY = 'wokMenuDeclutter';
export const MENU_DECLUTTER_ATTRIBUTE = 'data-wok-menu-declutter';
export const MENU_DECLUTTER_COLLAPSE_ATTRIBUTE = 'data-wok-menu-declutter-collapse';
export const MENU_DECLUTTER_GRID_COLUMNS_ATTRIBUTE = 'data-wok-menu-declutter-grid-columns';
export const MENU_DECLUTTER_STREAMS_WIDTH_ATTRIBUTE = 'data-wok-menu-declutter-streams-width';
export const MENU_DECLUTTER_STREAMS_RAISED_ATTRIBUTE = 'data-wok-menu-declutter-streams-raised';
export const MENU_DECLUTTER_STYLE_ID = 'wokMenuDeclutterStyle';
export const MENU_DECLUTTER_STATIC_CSS = `
#signedInHeaderBar > .verticalSeparator { display: none !important; }
#mapInfoHld { font-size: 0 !important; }
#mapInfoHld > #mapInfo { font-size: 20px !important; }
.stream-card.promo-card { display: none !important; }
`;
export const STREAM_PROMOTION_TEXT = 'Stream Krunker and get featured!';

const MENU_DECLUTTER_SURFACE_SELECTOR = [
	'#signedInHeaderBar',
	'#menuHolder',
	'#mainMenu',
	'#dailySpinDiv',
	'#homeStoreAd',
	'#termsInfo',
	'#topLeftAdHolder',
	'#menuBtnBattlepass',
	'#menuBtnCustomGames',
	'#menuBtnGuide',
	'#menuBtnLeaderboards',
	'#menuBtnNotifications',
	'#menuBtnSideCommunity',
	'#menuBtnWallet',
	'#leaderboardsButton',
	'#notificationsButton',
	'#walletButton',
	'.menuItem',
	'.ph-item',
	'.headerBarLeft',
	'.headerBarRight',
	'.nav-item',
	'.nav-notif-section',
	'.nav-wallet-section',
	'.streams-overlay',
	'.stream-card',
	'.featured-section',
	'.top-ad-row',
	'.shop-badge',
	'.kr-sale-info'
].join(', ');

export interface MenuDeclutterElement {
	textContent: string | null;
	closest(selector: string): MenuDeclutterElement | null;
	querySelector(selector: string): MenuDeclutterElement | null;
	querySelectorAll(selector: string): readonly MenuDeclutterElement[];
	removeAttribute(name: string): void;
	setAttribute(name: string, value: string): void;
	getAttribute?(name: string): string | null;
	previousElementSibling?: MenuDeclutterElement | null;
	nextElementSibling?: MenuDeclutterElement | null;
}

export interface MenuDeclutterObserver {
	disconnect(): void;
	observe(): void;
}

interface MenuDeclutterMutationObserver {
	disconnect(): void;
	observe(target: unknown): void;
}

export interface MenuDeclutterLifecycleHooks {
	currentBody(): unknown;
	currentDocument(): unknown;
	createMutationObserver(callback: () => void): MenuDeclutterMutationObserver | undefined;
	addLifecycleListener(callback: () => void): void;
	removeLifecycleListener(callback: () => void): void;
	setInterval(callback: () => void, delayMs: number): unknown;
	clearInterval(handle: unknown): void;
}

export function createMenuDeclutterLifecycleObserver(
	callback: () => void,
	hooks: MenuDeclutterLifecycleHooks
): MenuDeclutterObserver {
	let connected = false;
	let observedBody: unknown;
	let observedDocument: unknown;
	let pollHandle: unknown;
	const mutationObserver = hooks.createMutationObserver(() => { refresh(true); });

	const refresh = (notify: boolean): void => {
		if (!connected) return;
		const nextDocument = hooks.currentDocument();
		const nextBody = hooks.currentBody();
		const documentChanged = nextDocument !== observedDocument;
		const bodyChanged = nextBody !== observedBody;
		if (documentChanged || bodyChanged) {
			mutationObserver?.disconnect();
			observedDocument = nextDocument;
			if (nextDocument !== undefined && nextDocument !== null) mutationObserver?.observe(nextDocument);
			observedBody = nextBody;
		}
		if (notify || documentChanged || bodyChanged) callback();
	};
	const refreshFromLifecycle = (): void => { refresh(true); };

	return {
		disconnect: () => {
			if (!connected) return;
			connected = false;
			hooks.removeLifecycleListener(refreshFromLifecycle);
			if (pollHandle !== undefined) {
				hooks.clearInterval(pollHandle);
				pollHandle = undefined;
			}
			mutationObserver?.disconnect();
		},
		observe: () => {
			if (connected) return;
			connected = true;
			hooks.addLifecycleListener(refreshFromLifecycle);
			pollHandle = hooks.setInterval(() => { refresh(false); }, 250);
			refresh(true);
		}
	};
}

export interface MenuDeclutterEnvironment {
	createObserver(callback: () => void): MenuDeclutterObserver | undefined;
	ensureStylesheet(): void;
	queryAll(selector: string): readonly MenuDeclutterElement[];
	removeStylesheet(): void;

	isHidden?(element: MenuDeclutterElement): boolean;
}

export interface MenuDeclutterLayoutTargets {
	readonly collapsed: ReadonlySet<MenuDeclutterElement>;
	readonly gridColumns: ReadonlyMap<MenuDeclutterElement, number>;
	readonly raisedStreams: ReadonlySet<MenuDeclutterElement>;
	readonly streamWidths: ReadonlyMap<MenuDeclutterElement, number>;
}

function normalizeLabel(value: string | null | undefined): string {
	return (value ?? '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

const CONTROL_ICON_TOKENS = new Set([
	'account_balance_wallet',
	'backpack',
	'campaign',
	'emoji_events',
	'leaderboard',
	'military_tech',
	'notification',
	'notifications',
	'notifications_active',
	'notifications_none'
]);
const CONTROL_AFFORDANCE_TOKENS = new Set([
	'-',
	'>',
	'▶',
	'arrow_drop_down',
	'chevron_right',
	'keyboard_arrow_right'
]);

function semanticControlLabel(value: string | null | undefined): string {
	const tokens = normalizeLabel(value).split(' ').filter(Boolean);
	if (tokens.length > 0 && CONTROL_ICON_TOKENS.has(tokens[0])) tokens.shift();
	while (tokens.length > 0 && CONTROL_AFFORDANCE_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
	return tokens.join(' ');
}

function matchesRemovableControlLabel(value: string | null | undefined): boolean {
	const normalized = normalizeLabel(value);
	if (normalized === 'wallet' || normalized === 'notification' || normalized === 'notifications'
		|| normalized === 'leaderboard' || normalized === 'leaderboards'
		|| normalized === 'custom games' || normalized === 'community & events'
		|| normalized === 'guide' || normalized === "what's new") return true;
	const label = semanticControlLabel(normalized);
	return /^wallet(?:\s+\d+)?$/u.test(label)
		|| /^(?:notification|notifications)(?:\s+\d+)?$/u.test(label)
		|| /^(?:leaderboard|leaderboards)$/u.test(label)
		|| /^(?:custom games|community & events|guide|what's new)$/u.test(label);
}

function matchesAnySemanticLabel(element: MenuDeclutterElement): boolean {
	const values = [
		element.textContent,
		element.getAttribute?.('aria-label'),
		element.getAttribute?.('title'),
		element.getAttribute?.('data-label')
	];
	return values.some(value => matchesRemovableControlLabel(value));
}

function addControlTarget(
	targets: Set<MenuDeclutterElement>,
	candidate: MenuDeclutterElement
): MenuDeclutterElement {
	for (const selector of [
		'.menuItem',
		'.ph-item',
		'.headerBarItem',
		'.headerBarButton',
		'.nav-item',
		'.krInfo',
		'.nav-wallet-section',
		'button',
		'a'
	]) {
		const container = candidate.closest(selector);
		if (container) {
			targets.add(container);
			return container;
		}
	}
	targets.add(candidate);
	return candidate;
}

function isVerticalSeparator(element: MenuDeclutterElement | null | undefined): element is MenuDeclutterElement {
	return element?.closest('.verticalSeparator') === element;
}

function addAdjacentSeparatorTargets(
	targets: Set<MenuDeclutterElement>,
	control: MenuDeclutterElement
): void {
	for (const separator of [control.previousElementSibling, control.nextElementSibling]) {
		if (isVerticalSeparator(separator)) targets.add(separator);
	}
}

function addControlAndSpacingTargets(
	targets: Set<MenuDeclutterElement>,
	candidate: MenuDeclutterElement
): void {
	const control = addControlTarget(targets, candidate);
	addAdjacentSeparatorTargets(targets, control);
}

function normalizePromotionText(value: string | null | undefined): string {
	return normalizeLabel(value)
		.replace(/[!?.,]+$/u, '')
		.replace(/\s*&\s*/gu, ' and ')
		.replace(/\s*[/|]\s*/gu, ' and ')
		.replace(/\s+/gu, ' ')
		.trim();
}

export function isKrunkerStreamPromotionText(value: string | null | undefined): boolean {
	return normalizePromotionText(value) === normalizePromotionText(STREAM_PROMOTION_TEXT);
}

function isKrunkerStreamPromotionCard(card: MenuDeclutterElement): boolean {
	const title = card.querySelector('.promo-title') ?? card.querySelector('.stream-title');
	return isKrunkerStreamPromotionText(title?.textContent);
}

export function collectMenuDeclutterTargets(
	environment: Pick<MenuDeclutterEnvironment, 'queryAll'>
): ReadonlySet<MenuDeclutterElement> {
	const targets = new Set<MenuDeclutterElement>();

	for (const title of environment.queryAll('#menuBtnBattlepass')) {
		const item = title.closest('.menuItem.bpItem');
		if (item) targets.add(item);
	}
	for (const dailySpin of environment.queryAll('#dailySpinDiv')) targets.add(dailySpin);
	for (const storePromotion of environment.queryAll('#homeStoreAd')) targets.add(storePromotion);

	for (const shopBadge of environment.queryAll('.shop-badge')) targets.add(shopBadge);
	for (const saleInfo of environment.queryAll('.kr-sale-info')) targets.add(saleInfo);

	for (const footerLinks of environment.queryAll('#termsInfo')) targets.add(footerLinks);

	for (const settingsButton of environment.queryAll('.settingsBtn')) {
		if (normalizeLabel(settingsButton.textContent) === 'manage ads') targets.add(settingsButton);
	}
	for (const headerChild of environment.queryAll('#signedInHeaderBar > *')) {
		if (isVerticalSeparator(headerChild)) targets.add(headerChild);
	}

	const isRemovableControl = (control: MenuDeclutterElement): boolean => {
		if (matchesAnySemanticLabel(control)) return true;

		const notificationTitle = control.querySelector('.webpush-title');
		if (notificationTitle !== null && matchesAnySemanticLabel(notificationTitle)) return true;

		const icon = normalizeLabel(control.querySelector('.menuItemIcon')?.textContent);
		const title = normalizeLabel(control.querySelector('.menuItemTitle')?.textContent);
		return icon === 'campaign' && (title === "what's new" || title.startsWith("what's new -"));
	};

	for (const selector of [
		'#menuBtnCustomGames',
		'#menuBtnGuide',
		'#menuBtnLeaderboards',
		'#menuBtnNotifications',
		'#menuBtnSideCommunity',
		'#menuBtnWallet',
		'#leaderboardsButton',
		'#notificationsButton',
		'#walletButton',
		'.nav-notif-section',
		'.nav-wallet-section'
	]) {
		for (const control of environment.queryAll(selector)) {
			if (selector === '.nav-notif-section' && !isRemovableControl(control)) continue;
			addControlAndSpacingTargets(targets, control);
		}
	}
	for (const selector of [
		'.menuItem',
		'.ph-item',
		'.headerBarLeft > *',
		'.headerBarRight > *',
		'#signedInHeaderBar > *',
		'.nav-item'
	]) {
		for (const control of environment.queryAll(selector)) {
			if (isRemovableControl(control)) addControlAndSpacingTargets(targets, control);
		}
	}

	const streamPromotions = environment
		.queryAll('.stream-card.promo-card')
		.filter(isKrunkerStreamPromotionCard);
	for (const promotion of streamPromotions) targets.add(promotion);

	for (const promotion of streamPromotions) {
		const section = promotion.closest('.featured-section');
		if (!section) continue;
		const cards = section.querySelectorAll('.stream-card');
		if (cards.length > 0 && cards.every(isKrunkerStreamPromotionCard)) targets.add(section);
	}

	return targets;
}

function hasRenderableAdContent(
	element: MenuDeclutterElement,
	hiddenTargets: ReadonlySet<MenuDeclutterElement>
): boolean {
	if (hiddenTargets.has(element)) return false;

	const paidPromotion = element.querySelector('#homeStoreAd');
	const elementText = normalizeLabel(element.textContent);
	const paidText = normalizeLabel(paidPromotion?.textContent);
	if (elementText.length > 0 && elementText !== paidText) return true;

	for (const selector of ['iframe', 'img', 'video', 'object', 'embed', 'canvas', 'ins']) {
		if (element.querySelectorAll(selector).length > 0) return true;
	}
	return false;
}

function isHiddenOrEmptyAdSlot(
	element: MenuDeclutterElement,
	environment: Pick<MenuDeclutterEnvironment, 'isHidden'>,
	hiddenTargets: ReadonlySet<MenuDeclutterElement>
): boolean {
	return environment.isHidden?.(element) === true || !hasRenderableAdContent(element, hiddenTargets);
}

function collectAdLayoutTargets(
	environment: Pick<MenuDeclutterEnvironment, 'queryAll' | 'isHidden'>,
	hiddenTargets: ReadonlySet<MenuDeclutterElement>,
	collapsed: Set<MenuDeclutterElement>
): void {
	const rows = new Set([
		...environment.queryAll('.top-ad-row'),
		...environment.queryAll('#topLeftAdHolder')
	]);
	for (const row of rows) {
		const topRightAd = row.querySelector('#topRightAdHolder');
		const swapSlot = row.querySelector('.swap-slot');
		const rowSlots = [topRightAd, swapSlot].filter((slot): slot is MenuDeclutterElement => slot !== null);

		if (topRightAd && isHiddenOrEmptyAdSlot(topRightAd, environment, hiddenTargets)) {
			collapsed.add(topRightAd);
		}

		if (swapSlot) {
			const paidPromotion = swapSlot.querySelector('#homeStoreAd');
			const alternateAd = swapSlot.querySelector('#adCon');
			if (paidPromotion && hiddenTargets.has(paidPromotion)
				&& (!alternateAd || isHiddenOrEmptyAdSlot(alternateAd, environment, hiddenTargets))) {
				collapsed.add(swapSlot);
			}
		}

		if (rowSlots.length > 0 && rowSlots.every(slot => collapsed.has(slot) || environment.isHidden?.(slot) === true)) {
			collapsed.add(row);
		}
	}
}

function streamOverlayWidth(columns: number): number {
	return columns * 180 + Math.max(columns - 1, 0) * 16 + 32;
}

function collectStreamLayoutTargets(
	environment: Pick<MenuDeclutterEnvironment, 'queryAll'>,
	hiddenTargets: ReadonlySet<MenuDeclutterElement>,
	collapsed: Set<MenuDeclutterElement>,
	gridColumns: Map<MenuDeclutterElement, number>,
	streamWidths: Map<MenuDeclutterElement, number>
): void {
	const smallOverlays = new Set(environment.queryAll('.streams-overlay.small'));
	for (const grid of environment.queryAll('.streams-grid')) {
		const cards = grid.querySelectorAll('.stream-card');
		const promotions = cards.filter(card => hiddenTargets.has(card) || isKrunkerStreamPromotionCard(card));
		if (promotions.length === 0) continue;

		const genuineCards = cards.filter(card => !isKrunkerStreamPromotionCard(card));
		if (genuineCards.length === 0) {
			collapsed.add(grid);
			continue;
		}

		gridColumns.set(grid, genuineCards.length);

		const overlay = grid.closest('.streams-overlay');
		if (overlay && smallOverlays.has(overlay)) {
			const width = streamOverlayWidth(genuineCards.length);
			streamWidths.set(overlay, Math.max(streamWidths.get(overlay) ?? 0, width));
		}
	}
}

function collectRaisedStreamTargets(
	environment: Pick<MenuDeclutterEnvironment, 'queryAll'>,
	collapsed: ReadonlySet<MenuDeclutterElement>,
	raisedStreams: Set<MenuDeclutterElement>
): void {
	const panels = new Set([
		...environment.queryAll('#tlInfHold'),
		...environment.queryAll('.right-panel')
	]);
	for (const panel of panels) {
		const adRows = [
			...panel.querySelectorAll('.top-ad-row'),
			...panel.querySelectorAll('#topLeftAdHolder')
		];
		if (!adRows.some(row => collapsed.has(row))) continue;
		for (const overlay of panel.querySelectorAll('.streams-overlay')) raisedStreams.add(overlay);
	}
}

export function collectMenuDeclutterLayoutTargets(
	environment: Pick<MenuDeclutterEnvironment, 'queryAll' | 'isHidden'>,
	hiddenTargets: ReadonlySet<MenuDeclutterElement> = collectMenuDeclutterTargets(environment)
): MenuDeclutterLayoutTargets {
	const collapsed = new Set<MenuDeclutterElement>();
	const gridColumns = new Map<MenuDeclutterElement, number>();
	const raisedStreams = new Set<MenuDeclutterElement>();
	const streamWidths = new Map<MenuDeclutterElement, number>();
	collectAdLayoutTargets(environment, hiddenTargets, collapsed);
	collectStreamLayoutTargets(environment, hiddenTargets, collapsed, gridColumns, streamWidths);
	collectRaisedStreamTargets(environment, collapsed, raisedStreams);
	return { collapsed, gridColumns, raisedStreams, streamWidths };
}

export class MenuDeclutterController {
	private readonly decorated = new Set<MenuDeclutterElement>();
	private readonly collapsed = new Set<MenuDeclutterElement>();
	private readonly gridColumns = new Map<MenuDeclutterElement, number>();
	private readonly raisedStreams = new Set<MenuDeclutterElement>();
	private readonly streamWidths = new Map<MenuDeclutterElement, number>();
	private enabled = false;
	private readonly environment: MenuDeclutterEnvironment;
	private observer: MenuDeclutterObserver | undefined;

	constructor(environment: MenuDeclutterEnvironment) {
		this.environment = environment;
	}

	apply(enabled: boolean): void {
		if (!enabled) {
			this.stop();
			return;
		}

		this.enabled = true;
		this.environment.ensureStylesheet();
		if (!this.observer) {
			this.observer = this.environment.createObserver(() => { this.reconcile(); });
			this.observer?.observe();
		}
		this.reconcile();
	}

	reconcile(): void {
		if (!this.enabled) return;
		this.environment.ensureStylesheet();
		const targets = collectMenuDeclutterTargets(this.environment);
		const layoutTargets = collectMenuDeclutterLayoutTargets(this.environment, targets);

		for (const element of this.decorated) {
			if (targets.has(element)) continue;
			element.removeAttribute(MENU_DECLUTTER_ATTRIBUTE);
			this.decorated.delete(element);
		}
		for (const element of targets) {
			if (this.decorated.has(element)) continue;
			element.setAttribute(MENU_DECLUTTER_ATTRIBUTE, '');
			this.decorated.add(element);
		}

		for (const element of this.collapsed) {
			if (layoutTargets.collapsed.has(element)) continue;
			element.removeAttribute(MENU_DECLUTTER_COLLAPSE_ATTRIBUTE);
			this.collapsed.delete(element);
		}
		for (const element of layoutTargets.collapsed) {
			if (this.collapsed.has(element)) continue;
			element.setAttribute(MENU_DECLUTTER_COLLAPSE_ATTRIBUTE, '');
			this.collapsed.add(element);
		}

		for (const [element, columns] of this.gridColumns) {
			const nextColumns = layoutTargets.gridColumns.get(element);
			if (nextColumns !== columns) {
				element.removeAttribute(MENU_DECLUTTER_GRID_COLUMNS_ATTRIBUTE);
				this.gridColumns.delete(element);
			}
		}
		for (const [element, columns] of layoutTargets.gridColumns) {
			if (this.gridColumns.get(element) === columns) continue;
			element.setAttribute(MENU_DECLUTTER_GRID_COLUMNS_ATTRIBUTE, String(columns));
			this.gridColumns.set(element, columns);
		}

		for (const element of this.raisedStreams) {
			if (layoutTargets.raisedStreams.has(element)) continue;
			element.removeAttribute(MENU_DECLUTTER_STREAMS_RAISED_ATTRIBUTE);
			this.raisedStreams.delete(element);
		}
		for (const element of layoutTargets.raisedStreams) {
			if (this.raisedStreams.has(element)) continue;
			element.setAttribute(MENU_DECLUTTER_STREAMS_RAISED_ATTRIBUTE, '');
			this.raisedStreams.add(element);
		}

		for (const [element, width] of this.streamWidths) {
			const nextWidth = layoutTargets.streamWidths.get(element);
			if (nextWidth !== width) {
				element.removeAttribute(MENU_DECLUTTER_STREAMS_WIDTH_ATTRIBUTE);
				this.streamWidths.delete(element);
			}
		}
		for (const [element, width] of layoutTargets.streamWidths) {
			if (this.streamWidths.get(element) === width) continue;
			element.setAttribute(MENU_DECLUTTER_STREAMS_WIDTH_ATTRIBUTE, String(width));
			this.streamWidths.set(element, width);
		}
	}

	stop(): void {
		this.enabled = false;
		this.observer?.disconnect();
		this.observer = undefined;
		for (const element of this.decorated) {
			element.removeAttribute(MENU_DECLUTTER_ATTRIBUTE);
		}
		for (const element of this.collapsed) {
			element.removeAttribute(MENU_DECLUTTER_COLLAPSE_ATTRIBUTE);
		}
		for (const element of this.gridColumns.keys()) {
			element.removeAttribute(MENU_DECLUTTER_GRID_COLUMNS_ATTRIBUTE);
		}
		for (const element of this.raisedStreams) {
			element.removeAttribute(MENU_DECLUTTER_STREAMS_RAISED_ATTRIBUTE);
		}
		for (const element of this.streamWidths.keys()) {
			element.removeAttribute(MENU_DECLUTTER_STREAMS_WIDTH_ATTRIBUTE);
		}
		this.decorated.clear();
		this.collapsed.clear();
		this.gridColumns.clear();
		this.raisedStreams.clear();
		this.streamWidths.clear();
		this.environment.removeStylesheet();
	}
}

function createBrowserEnvironment(): MenuDeclutterEnvironment {
	return {
		createObserver: callback => createMenuDeclutterLifecycleObserver(callback, {
			currentBody: () => typeof document === 'undefined' ? undefined : document.body,
			currentDocument: () => typeof document === 'undefined' ? undefined : document,
			createMutationObserver: mutationCallback => {
				if (typeof MutationObserver !== 'function') return undefined;
				const observer = new MutationObserver(records => {
					if (mutationRecordsTouchSelector(records, MENU_DECLUTTER_SURFACE_SELECTOR)) mutationCallback();
				});
				return {
					disconnect: () => { observer.disconnect(); },
					observe: target => {

						observer.observe(target as Node, {
							childList: true,
							subtree: true
						});
					}
				};
			},
			addLifecycleListener: callback => {
				window.addEventListener('DOMContentLoaded', callback);
				window.addEventListener('load', callback);
				window.addEventListener('pageshow', callback);
			},
			removeLifecycleListener: callback => {
				window.removeEventListener('DOMContentLoaded', callback);
				window.removeEventListener('load', callback);
				window.removeEventListener('pageshow', callback);
			},
			setInterval: (callback, delayMs) => window.setInterval(callback, delayMs),
			clearInterval: handle => { window.clearInterval(handle as number); }
		}),
		ensureStylesheet: () => {
			if (document.getElementById(MENU_DECLUTTER_STYLE_ID)) return;
			const style = document.createElement('style');
			style.id = MENU_DECLUTTER_STYLE_ID;
			const gridRules = Array.from({ length: 16 }, (_, index) => {
				const columns = index + 1;
				return `[${MENU_DECLUTTER_GRID_COLUMNS_ATTRIBUTE}="${columns}"] { grid-template-columns: repeat(${columns}, 180px) !important; }`;
			}).join('\n');
			const streamWidthRules = Array.from({ length: 16 }, (_, index) => {
				const width = streamOverlayWidth(index + 1);
				return `[${MENU_DECLUTTER_STREAMS_WIDTH_ATTRIBUTE}="${width}"] { width: ${width}px !important; }`;
			}).join('\n');
			style.textContent = `
[${MENU_DECLUTTER_ATTRIBUTE}] { display: none !important; }
[${MENU_DECLUTTER_COLLAPSE_ATTRIBUTE}] { display: none !important; }
[${MENU_DECLUTTER_STREAMS_RAISED_ATTRIBUTE}] { top: 90px !important; margin-top: 0 !important; }
${MENU_DECLUTTER_STATIC_CSS}
${gridRules}
${streamWidthRules}`;
			(document.head ?? document.body ?? document.documentElement)?.append(style);
		},
		queryAll: selector => [...document.querySelectorAll(selector)] as unknown as MenuDeclutterElement[],
		removeStylesheet: () => { document.getElementById(MENU_DECLUTTER_STYLE_ID)?.remove(); },
		isHidden: element => {
			if (typeof getComputedStyle !== 'function') return false;
			const style = getComputedStyle(element as unknown as Element);
			return style.display === 'none' || style.visibility === 'hidden';
		}
	};
}

let browserController: MenuDeclutterController | undefined;

export function applyMenuDeclutterSettings(
	preferences: Readonly<Partial<UserPrefs>> | undefined
): void {
	const enabled = preferences?.[MENU_DECLUTTER_PREFERENCE_KEY] === true;
	if (!enabled) {
		browserController?.stop();
		return;
	}
	if (typeof document === 'undefined') return;
	browserController ??= new MenuDeclutterController(createBrowserEnvironment());
	browserController.apply(true);
}
