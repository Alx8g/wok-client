import assert from 'node:assert/strict';
import test from 'node:test';
import {
	collectMenuDeclutterLayoutTargets,
	collectMenuDeclutterTargets,
	createMenuDeclutterLifecycleObserver,
	isKrunkerStreamPromotionText,
	MENU_DECLUTTER_ATTRIBUTE,
	MENU_DECLUTTER_COLLAPSE_ATTRIBUTE,
	MENU_DECLUTTER_GRID_COLUMNS_ATTRIBUTE,
	MENU_DECLUTTER_STREAMS_RAISED_ATTRIBUTE,
	MENU_DECLUTTER_STREAMS_WIDTH_ATTRIBUTE,
	MENU_DECLUTTER_STATIC_CSS,
	MenuDeclutterController,
	type MenuDeclutterElement,
	type MenuDeclutterObserver
} from '../src/menu-declutter.ts';

class FakeMenuElement implements MenuDeclutterElement {
	public readonly attributes = new Map<string, string>();
	public readonly children: FakeMenuElement[] = [];
	public readonly classes: readonly string[];
	public readonly id: string;
	public parent: FakeMenuElement | undefined;
	public readonly tagName: string;
	private ownTextContent: string | null = null;

	get textContent(): string | null {
		const childText = this.children.map(child => child.textContent).filter(Boolean).join(' ');
		const value = [this.ownTextContent, childText].filter(Boolean).join(' ');
		return value || null;
	}

	set textContent(value: string | null) {
		this.ownTextContent = value;
	}

	get previousElementSibling(): FakeMenuElement | null {
		if (!this.parent) return null;
		const index = this.parent.children.indexOf(this);
		return index > 0 ? this.parent.children[index - 1] : null;
	}

	get nextElementSibling(): FakeMenuElement | null {
		if (!this.parent) return null;
		const index = this.parent.children.indexOf(this);
		return index >= 0 ? this.parent.children[index + 1] ?? null : null;
	}

	constructor(
		tagName: string,
		id = '',
		classes: readonly string[] = [],
		textContent: string | null = null
	) {
		this.tagName = tagName;
		this.id = id;
		this.classes = classes;
		this.textContent = textContent;
	}

	append(...children: FakeMenuElement[]): void {
		for (const child of children) {
			child.parent?.remove(child);
			child.parent = this;
			this.children.push(child);
		}
	}

	remove(child: FakeMenuElement): void {
		const index = this.children.indexOf(child);
		if (index >= 0) this.children.splice(index, 1);
		child.parent = undefined;
	}

	closest(selector: string): FakeMenuElement | null {
		let current: FakeMenuElement | undefined = this;
		while (current) {
			if (current.matches(selector)) return current;
			current = current.parent;
		}
		return null;
	}

	querySelector(selector: string): FakeMenuElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	querySelectorAll(selector: string): FakeMenuElement[] {
		const matches: FakeMenuElement[] = [];
		const visit = (element: FakeMenuElement) => {
			for (const child of element.children) {
				if (child.matches(selector)) matches.push(child);
				visit(child);
			}
		};
		visit(this);
		return matches;
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	private matches(selector: string): boolean {
		const directChild = /^(.*)\s*>\s*\*$/u.exec(selector);
		if (directChild) return this.parent?.matches(directChild[1].trim()) === true;
		if (selector.startsWith('#')) return this.id === selector.slice(1);
		const classes = selector.split('.').filter(Boolean);
		if (selector.startsWith('.')) return classes.every(value => this.classes.includes(value));
		const [tagName, ...tagClasses] = selector.split('.');
		return this.tagName.toLowerCase() === tagName.toLowerCase()
			&& tagClasses.every(value => this.classes.includes(value));
	}
}

class FakeObserver implements MenuDeclutterObserver {
	private readonly callback: () => void;
	public disconnected = false;
	public observing = false;

	constructor(callback: () => void) {
		this.callback = callback;
	}

	disconnect(): void {
		this.disconnected = true;
		this.observing = false;
	}

	observe(): void {
		this.observing = true;
	}

	trigger(): void {
		if (this.observing) this.callback();
	}
}

function createHarness(root: FakeMenuElement, hidden = new Set<FakeMenuElement>()) {
	let stylesheetMounted = false;
	let observer: FakeObserver | undefined;
	const environment = {
		createObserver: (callback: () => void) => {
			observer = new FakeObserver(callback);
			return observer;
		},
		ensureStylesheet: () => { stylesheetMounted = true; },
		queryAll: (selector: string) => root.querySelectorAll(selector),
		removeStylesheet: () => { stylesheetMounted = false; },
		isHidden: (element: MenuDeclutterElement) => hidden.has(element as FakeMenuElement)
	};
	return {
		controller: new MenuDeclutterController(environment),
		environment,
		get observer() { return observer; },
		get stylesheetMounted() { return stylesheetMounted; }
	};
}

function createLifecycleHarness(initialBody: FakeMenuElement | undefined) {
	let currentDocument: object = {};
	let currentBody = initialBody;
	let mutationCallback: (() => void) | undefined;
	let lifecycleCallback: (() => void) | undefined;
	let pollCallback: (() => void) | undefined;
	let stylesheetMounted = false;
	let observedTarget: unknown;
	let mutationDisconnects = 0;
	let timerId = 0;
	const hidden = new Set<FakeMenuElement>();
	const mutationObserver = {
		disconnect: () => { mutationDisconnects++; },
		observe: (target: unknown) => { observedTarget = target; }
	};
	const environment = {
		createObserver: (callback: () => void) => createMenuDeclutterLifecycleObserver(callback, {
			currentBody: () => currentBody,
			currentDocument: () => currentDocument,
			createMutationObserver: callbackFromObserver => {
				mutationCallback = callbackFromObserver;
				return mutationObserver;
			},
			addLifecycleListener: callbackFromLifecycle => { lifecycleCallback = callbackFromLifecycle; },
			removeLifecycleListener: callbackFromLifecycle => {
				if (lifecycleCallback === callbackFromLifecycle) lifecycleCallback = undefined;
			},
			setInterval: callbackFromTimer => {
				pollCallback = callbackFromTimer;
				return ++timerId;
			},
			clearInterval: () => { pollCallback = undefined; }
		}),
		ensureStylesheet: () => { stylesheetMounted = true; },
		queryAll: (selector: string) => currentBody?.querySelectorAll(selector) ?? [],
		removeStylesheet: () => { stylesheetMounted = false; },
		isHidden: (element: MenuDeclutterElement) => hidden.has(element as FakeMenuElement)
	};
	return {
		controller: new MenuDeclutterController(environment),
		environment,
		hidden,
		get lifecycleListening() { return lifecycleCallback !== undefined; },
		get mutationDisconnects() { return mutationDisconnects; },
		get observedTarget() { return observedTarget; },
		get pollInstalled() { return pollCallback !== undefined; },
		get stylesheetMounted() { return stylesheetMounted; },
		setBody: (body: FakeMenuElement | undefined) => { currentBody = body; },
		replaceDocument: (body: FakeMenuElement | undefined) => {
			currentDocument = {};
			currentBody = body;
		},
		triggerMutation: () => { mutationCallback?.(); },
		triggerLifecycle: () => { lifecycleCallback?.(); },
		triggerPoll: () => { pollCallback?.(); }
	};
}

function createPromotionCard(title = 'Stream Krunker and get featured!'): FakeMenuElement {
	const card = new FakeMenuElement('div', '', ['stream-card', 'promo-card']);
	card.append(new FakeMenuElement('h3', '', ['stream-title', 'promo-title'], title));
	return card;
}

function createCurrentControlFixture() {
	const header = new FakeMenuElement('div', 'signedInHeaderBar', ['headerBarRight']);
	const balance = new FakeMenuElement('div', '', ['ph-item']);
	balance.append(
		new FakeMenuElement('span', '', ['ph-currency-icon'], 'KR'),
		new FakeMenuElement('span', 'menuKRCount', ['ph-value'], '125')
	);
	const walletBefore = new FakeMenuElement('div', '', ['verticalSeparator']);
	const wallet = new FakeMenuElement('div', '', ['ph-item']);
	wallet.append(
		new FakeMenuElement('span', '', ['material-icons', 'ph-icon'], 'backpack'),
		new FakeMenuElement('span', '', ['ph-label'], 'Wallet')
	);
	const walletAfter = new FakeMenuElement('div', '', ['verticalSeparator']);
	const notification = new FakeMenuElement('div', '', ['nav-notif-section']);
	const notificationTitle = new FakeMenuElement('span', '', ['webpush-title']);
	notificationTitle.append(new FakeMenuElement('span', '', ['material-icons'], 'notification'));
	notificationTitle.textContent = 'Notification';
	notification.append(notificationTitle, new FakeMenuElement('button', '', ['webpush-details-toggle'], '▶'));
	const notificationSeparator = new FakeMenuElement('div', '', ['verticalSeparator']);
	const settings = new FakeMenuElement('div', '', ['nav-item'], 'settings Settings');
	header.append(balance, walletBefore, wallet, walletAfter, notification, notificationSeparator, settings);

	const leaderboards = new FakeMenuElement('div', '', ['menuItem']);
	leaderboards.append(
		new FakeMenuElement('span', '', ['menuItemIcon'], 'leaderboard'),
		new FakeMenuElement('div', 'menuBtnLeaderboards', [], 'Leaderboard')
	);
	return { balance, header, leaderboards, leaderboardsTarget: leaderboards, notification, notificationSeparator, settings, wallet, walletAfter, walletBefore };
}

function createLayoutFixture(root: FakeMenuElement, hidden: Set<FakeMenuElement>) {
	const panel = new FakeMenuElement('div', 'tlInfHold', ['right-panel']);
	const adRow = new FakeMenuElement('div', 'topLeftAdHolder');
	const topRightAd = new FakeMenuElement('div', 'topRightAdHolder');
	const swapSlot = new FakeMenuElement('div', '', ['swap-slot']);
	const paidPromotion = new FakeMenuElement('div', 'homeStoreAd');
	const alternateAd = new FakeMenuElement('div', 'adCon');
	swapSlot.append(paidPromotion, alternateAd);
	adRow.append(topRightAd, swapSlot);

	const streamsOverlay = new FakeMenuElement('div', '', ['streams-overlay', 'small']);
	const more = new FakeMenuElement('button', '', ['toggle-button'], 'More');
	const hide = new FakeMenuElement('button', '', ['hide-button'], 'Hide');
	const controls = new FakeMenuElement('div', '', ['button-group']);
	controls.append(more, hide);
	const grid = new FakeMenuElement('div', '', ['streams-grid', 'regular-grid']);
	const firstStream = new FakeMenuElement('div', 'stream-one', ['stream-card']);
	const secondStream = new FakeMenuElement('div', 'stream-two', ['stream-card']);
	const selfPromotion = createPromotionCard();
	grid.append(firstStream, secondStream, selfPromotion);
	streamsOverlay.append(controls, grid);
	panel.append(adRow, streamsOverlay);
	root.append(panel);
	hidden.add(topRightAd);
	hidden.add(alternateAd);

	return {
		adRow,
		alternateAd,
		controls,
		firstStream,
		grid,
		hide,
		more,
		paidPromotion,
		panel,
		secondStream,
		selfPromotion,
		streamsOverlay,
		swapSlot,
		topRightAd
	};
}

test('matches only the exact Krunker self-promotion label', () => {
	assert.equal(isKrunkerStreamPromotionText('Stream Krunker and get featured!'), true);
	assert.equal(isKrunkerStreamPromotionText('Stream Krunker and get featured'), true);
	assert.equal(isKrunkerStreamPromotionText('Stream Krunker & Get Featured!'), true);
	assert.equal(isKrunkerStreamPromotionText('Stream Krunker / Get Featured'), true);
	assert.equal(isKrunkerStreamPromotionText('  STREAM   KRUNKER and get FEATURED!  '), true);
	assert.equal(isKrunkerStreamPromotionText('Zangi - Stream Krunker'), false);
	assert.equal(isKrunkerStreamPromotionText('Stream Krunker and get featured today!'), false);
	assert.equal(isKrunkerStreamPromotionText('Stream Krunker and get featured creators!'), false);
});

test('collects stable menu promotions without hiding real stream cards', () => {
	const root = new FakeMenuElement('body');
	const battlePass = new FakeMenuElement('div', '', ['menuItem', 'bpItem']);
	battlePass.append(new FakeMenuElement('div', 'menuBtnBattlepass'));
	const dailySpin = new FakeMenuElement('div', 'dailySpinDiv', ['menuItem', 'dsItem']);
	const paidPackage = new FakeMenuElement('div', 'homeStoreAd');
	const leaderboards = new FakeMenuElement('div', 'menuBtnLeaderboards', ['menuItem'], 'leaderboard Leaderboards');
	const notifications = new FakeMenuElement('button', 'menuBtnNotifications', [], 'notifications Notifications');
	const wallet = new FakeMenuElement('button', 'menuBtnWallet', [], 'account_balance_wallet Wallet');
	const featured = new FakeMenuElement('section', '', ['featured-section']);
	const realStream = new FakeMenuElement('div', '', ['stream-card']);
	const promotion = createPromotionCard();
	featured.append(realStream, promotion);
	root.append(battlePass, dailySpin, paidPackage, leaderboards, notifications, wallet, featured);

	const targets = collectMenuDeclutterTargets({ queryAll: selector => root.querySelectorAll(selector) });
	assert.equal(targets.has(battlePass), true);
	assert.equal(targets.has(dailySpin), true);
	assert.equal(targets.has(paidPackage), true);
	assert.equal(targets.has(leaderboards), true);
	assert.equal(targets.has(notifications), true);
	assert.equal(targets.has(wallet), true);
	assert.equal(targets.has(promotion), true);
	assert.equal(targets.has(realStream), false);
	assert.equal(targets.has(featured), false, 'a real featured stream keeps the frame visible');
});

test('uses exact generated control labels for Wallet, Notifications, and Leaderboards', () => {
	const root = new FakeMenuElement('body');
	const headerLeft = new FakeMenuElement('div', '', ['headerBarLeft']);
	const headerRight = new FakeMenuElement('div', '', ['headerBarRight']);
	const wallet = new FakeMenuElement('button', '', [], 'account_balance_wallet Wallet');
	const notifications = new FakeMenuElement('button', '', [], 'notifications Notifications 2 keyboard_arrow_right');
	const leaderboards = new FakeMenuElement('div', '', ['menuItem'], 'emoji_events Leaderboards');
	const unrelatedWalletText = new FakeMenuElement('div', '', [], 'Wallet transaction history');
	headerLeft.append(wallet);
	headerRight.append(notifications);
	root.append(headerLeft, headerRight, leaderboards, unrelatedWalletText);

	const targets = collectMenuDeclutterTargets({ queryAll: selector => root.querySelectorAll(selector) });
	assert.equal(targets.has(wallet), true);
	assert.equal(targets.has(notifications), true);
	assert.equal(targets.has(leaderboards), true);
	assert.equal(targets.has(unrelatedWalletText), false, 'unrelated content with a loose keyword remains visible');
});

test('removes the current Wallet control while preserving the separate KR balance', () => {
	const root = new FakeMenuElement('body');
	const headerLeft = new FakeMenuElement('div', 'signedInHeaderBar', ['headerBarLeft']);
	const headerRight = new FakeMenuElement('div', '', ['headerBarRight']);
	const balance = new FakeMenuElement('div', '', ['ph-item']);
	balance.append(
		new FakeMenuElement('span', '', ['ph-currency-icon'], 'KR'),
		new FakeMenuElement('span', 'menuKRCount', ['ph-value'], '125')
	);
	const leftSeparator = new FakeMenuElement('div', '', ['verticalSeparator']);
	const wallet = new FakeMenuElement('div', '', ['ph-item']);
	wallet.append(
		new FakeMenuElement('span', '', ['material-icons', 'ph-icon'], 'backpack'),
		new FakeMenuElement('span', '', ['ph-label'], 'Wallet')
	);
	const rightSeparator = new FakeMenuElement('div', '', ['verticalSeparator']);
	const notification = new FakeMenuElement('div', '', ['nav-notif-section']);
	const webpush = new FakeMenuElement('div', '', ['webpush-container', 'not-expanded']);
	const webpushHeader = new FakeMenuElement('div', '', ['webpush-header']);
	const webpushTitle = new FakeMenuElement('span', '', ['webpush-title']);
	webpushTitle.append(new FakeMenuElement('span', '', ['material-icons', 'bell-icon'], 'notification'));
	webpushTitle.textContent = 'Notification';
	webpushHeader.append(webpushTitle, new FakeMenuElement('button', '', ['webpush-details-toggle'], '▶'));
	webpush.append(webpushHeader);
	notification.append(webpush);
	const notificationSeparator = new FakeMenuElement('div', '', ['verticalSeparator']);
	const settings = new FakeMenuElement('div', '', ['nav-item']);
	settings.append(new FakeMenuElement('span', '', ['nav-label'], 'Settings'));
	const junk = new FakeMenuElement('div', '', ['junkInfo']);
	junk.append(new FakeMenuElement('span', '', ['material-icons'], 'local_fire_department'));
	headerLeft.append(balance, leftSeparator, wallet, rightSeparator, junk);
	headerRight.append(notification, notificationSeparator, settings);
	root.append(headerLeft, headerRight);

	const targets = collectMenuDeclutterTargets({ queryAll: selector => root.querySelectorAll(selector) });
	assert.equal(targets.has(wallet), true);
	assert.equal(targets.has(balance), false, 'the KR balance remains visible');
	assert.equal(targets.has(leftSeparator), true, 'the separator before Wallet is hidden');
	assert.equal(targets.has(rightSeparator), true, 'the separator after Wallet is hidden');
	assert.equal(targets.has(notification), true, 'the live .nav-notif-section is hidden');
	assert.equal(targets.has(notificationSeparator), true, 'the separator after Notifications is hidden');
	assert.equal(targets.has(settings), false, 'Settings remains visible');
	assert.equal(targets.has(junk), false, 'the unrelated JUNK counter remains visible');
	assert.equal(targets.has(webpushTitle), false, 'only the notification surface is marked');
});

test('removes signed-in header separators and the Now Playing prefix styling only', () => {
	const root = new FakeMenuElement('body');
	const header = new FakeMenuElement('div', 'signedInHeaderBar');
	const profile = new FakeMenuElement('div', '', ['ph-item'], 'Larp Lv 13');
	const firstSeparator = new FakeMenuElement('div', '', ['verticalSeparator']);
	const balance = new FakeMenuElement('div', '', ['ph-item'], 'KR 6495');
	const secondSeparator = new FakeMenuElement('div', '', ['verticalSeparator']);
	header.append(profile, firstSeparator, balance, secondSeparator);
	root.append(header);

	const targets = collectMenuDeclutterTargets({ queryAll: selector => root.querySelectorAll(selector) });
	assert.equal(targets.has(profile), false);
	assert.equal(targets.has(balance), false);
	assert.equal(targets.has(firstSeparator), true);
	assert.equal(targets.has(secondSeparator), true);
	assert.match(MENU_DECLUTTER_STATIC_CSS, /#mapInfoHld\s*\{\s*font-size:\s*0/iu);
	assert.match(MENU_DECLUTTER_STATIC_CSS, /#mapInfoHld\s*>\s*#mapInfo\s*\{\s*font-size:\s*20px/iu);
});

test('removes the requested Custom Games, Community, Guide, and Whats New controls', () => {
	const root = new FakeMenuElement('body');
	const customGames = new FakeMenuElement('div', 'menuBtnCustomGames', ['button'], 'Custom Games');
	const community = new FakeMenuElement('div', '', ['menuItem']);
	community.append(
		new FakeMenuElement('span', '', ['menuItemIcon'], 'public'),
		new FakeMenuElement('div', 'menuBtnSideCommunity', ['menuItemTitle'], 'Community & Events')
	);
	const guide = new FakeMenuElement('div', '', ['menuItem', 'guideItem']);
	guide.append(new FakeMenuElement('div', 'menuBtnGuide', ['menuItemTitle'], 'Guide'));
	const whatsNew = new FakeMenuElement('div', '', ['menuItem']);
	whatsNew.append(
		new FakeMenuElement('span', '', ['menuItemIcon'], 'campaign'),
		new FakeMenuElement('div', '', ['menuItemTitle'], "What's New - v7.2.1")
	);
	const unrelatedCampaign = new FakeMenuElement('div', '', ['menuItem']);
	unrelatedCampaign.append(
		new FakeMenuElement('span', '', ['menuItemIcon'], 'campaign'),
		new FakeMenuElement('div', '', ['menuItemTitle'], 'Community Campaigns')
	);
	root.append(customGames, community, guide, whatsNew, unrelatedCampaign);

	const targets = collectMenuDeclutterTargets({ queryAll: selector => root.querySelectorAll(selector) });
	assert.equal(targets.has(customGames), true);
	assert.equal(targets.has(community), true);
	assert.equal(targets.has(guide), true);
	assert.equal(targets.has(whatsNew), true);
	assert.equal(targets.has(unrelatedCampaign), false);
});

test('hides only Store promo badges and the dedicated legal footer container', () => {
	const root = new FakeMenuElement('body');
	const store = new FakeMenuElement('div', '', ['menuItem']);
	const storeTitle = new FakeMenuElement('div', 'menuBtnShop', ['menuItemTitle'], 'Store');
	const spinBadge = new FakeMenuElement('span', '', ['shop-badge'], 'Riptide spin available');
	const saleInfo = new FakeMenuElement('span', '', ['kr-sale-info'], 'KR DISCOUNT 24:27:22');
	store.append(storeTitle, spinBadge, saleInfo);
	const footer = new FakeMenuElement('div', 'termsInfo');
	footer.append(
		new FakeMenuElement('span', '', ['terms'], 'Contact'),
		new FakeMenuElement('span', '', ['terms'], 'Terms'),
		new FakeMenuElement('span', '', ['terms'], 'Changelog')
	);
	root.append(store, footer);

	const targets = collectMenuDeclutterTargets({ queryAll: selector => root.querySelectorAll(selector) });
	assert.equal(targets.has(spinBadge), true);
	assert.equal(targets.has(saleInfo), true);
	assert.equal(targets.has(footer), true);
	assert.equal(targets.has(store), false, 'Store remains visible and interactive');
	assert.equal(targets.has(storeTitle), false, 'the Store title remains visible');
});

test('accepts exact accessible labels while rejecting partial control names', () => {
	const root = new FakeMenuElement('body');
	const wallet = new FakeMenuElement('div', '', ['nav-item'], 'payments 125');
	wallet.setAttribute('aria-label', 'Wallet');
	const notifications = new FakeMenuElement('div', '', ['nav-item'], 'notifications');
	notifications.setAttribute('title', 'Notifications');
	const leaderboards = new FakeMenuElement('div', '', ['menuItem'], 'ranking');
	leaderboards.setAttribute('aria-label', 'Leaderboards');
	const walletHistory = new FakeMenuElement('div', '', ['nav-item'], 'Wallet transaction history');
	const notificationSettings = new FakeMenuElement('div', '', ['nav-item'], 'Notifications settings');
	root.append(wallet, notifications, leaderboards, walletHistory, notificationSettings);

	const targets = collectMenuDeclutterTargets({ queryAll: selector => root.querySelectorAll(selector) });
	assert.equal(targets.has(wallet), true);
	assert.equal(targets.has(notifications), true);
	assert.equal(targets.has(leaderboards), true);
	assert.equal(targets.has(walletHistory), false);
	assert.equal(targets.has(notificationSettings), false);
});

test('applies after the feature is enabled before a body exists', () => {
	const harness = createLifecycleHarness(undefined);
	harness.controller.apply(true);
	assert.equal(harness.stylesheetMounted, true);
	assert.equal(harness.lifecycleListening, true);

	const body = new FakeMenuElement('body');
	const dailySpin = new FakeMenuElement('div', 'dailySpinDiv', ['menuItem', 'dsItem']);
	body.append(dailySpin);
	harness.setBody(body);
	harness.triggerPoll();

	assert.equal(dailySpin.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true);
});

test('rebinds across body replacement and restores markers on the detached body', () => {
	const firstBody = new FakeMenuElement('body');
	const firstDailySpin = new FakeMenuElement('div', 'dailySpinDiv', ['menuItem', 'dsItem']);
	firstBody.append(firstDailySpin);
	const harness = createLifecycleHarness(firstBody);
	harness.controller.apply(true);
	assert.equal(firstDailySpin.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true);

	const replacementBody = new FakeMenuElement('body');
	const replacementDailySpin = new FakeMenuElement('div', 'dailySpinDiv', ['menuItem', 'dsItem']);
	replacementBody.append(replacementDailySpin);
	harness.setBody(replacementBody);
	harness.triggerMutation();

	assert.equal(firstDailySpin.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false);
	assert.equal(replacementDailySpin.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true);
});

test('rebinds the mutation observer when the whole document is replaced', () => {
	const firstBody = new FakeMenuElement('body');
	const firstDailySpin = new FakeMenuElement('div', 'dailySpinDiv', ['menuItem', 'dsItem']);
	firstBody.append(firstDailySpin);
	const harness = createLifecycleHarness(firstBody);
	harness.controller.apply(true);
	const firstDocument = harness.observedTarget;
	assert.equal(firstDailySpin.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true);

	const replacementBody = new FakeMenuElement('body');
	const replacementDailySpin = new FakeMenuElement('div', 'dailySpinDiv', ['menuItem', 'dsItem']);
	replacementBody.append(replacementDailySpin);
	harness.replaceDocument(replacementBody);
	harness.triggerLifecycle();
	assert.notEqual(harness.observedTarget, firstDocument);
	assert.equal(firstDailySpin.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false);
	assert.equal(replacementDailySpin.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true);

	const latePromotion = new FakeMenuElement('div', 'homeStoreAd');
	replacementBody.append(latePromotion);
	harness.triggerMutation();
	assert.equal(latePromotion.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true);
});

test('marks initial and late-added menu DOM, then restores everything on disable', () => {
	const root = new FakeMenuElement('body');
	const dailySpin = new FakeMenuElement('div', 'dailySpinDiv', ['menuItem', 'dsItem']);
	root.append(dailySpin);
	const harness = createHarness(root);

	harness.controller.apply(true);
	assert.equal(harness.stylesheetMounted, true);
	assert.equal(harness.observer?.observing, true);
	assert.equal(dailySpin.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true);

	const paidPackage = new FakeMenuElement('div', 'homeStoreAd');
	root.append(paidPackage);
	harness.observer?.trigger();
	assert.equal(paidPackage.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true, 'late paid promotions are hidden');

	root.remove(dailySpin);
	const replacementSpin = new FakeMenuElement('div', 'dailySpinDiv', ['menuItem', 'dsItem']);
	root.append(replacementSpin);
	harness.observer?.trigger();
	assert.equal(dailySpin.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false, 'replaced stale DOM is restored');
	assert.equal(replacementSpin.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true, 'replacement DOM is hidden');

	harness.controller.apply(false);
	assert.equal(harness.stylesheetMounted, false);
	assert.equal(harness.observer?.disconnected, true);
	assert.equal(paidPackage.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false);
	assert.equal(replacementSpin.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false);
});

test('reconciles late and replaced current menu controls and restores their spacing markers', () => {
	const root = new FakeMenuElement('body');
	const harness = createHarness(root);
	harness.controller.apply(true);

	const first = createCurrentControlFixture();
	root.append(first.header, first.leaderboards);
	harness.observer?.trigger();
	assert.equal(first.wallet.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true);
	assert.equal(first.balance.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false);
	assert.equal(first.notification.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true);
	assert.equal(first.leaderboardsTarget.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true);
	assert.equal(first.walletBefore.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true);
	assert.equal(first.notificationSeparator.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true);

	root.remove(first.header);
	root.remove(first.leaderboards);
	const replacement = createCurrentControlFixture();
	root.append(replacement.header, replacement.leaderboards);
	harness.observer?.trigger();
	assert.equal(first.wallet.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false, 'replaced Wallet is restored');
	assert.equal(first.notification.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false, 'replaced Notifications is restored');
	assert.equal(first.leaderboardsTarget.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false, 'replaced Leaderboards is restored');
	assert.equal(first.walletBefore.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false, 'stale Wallet spacing is restored');
	assert.equal(first.notificationSeparator.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false, 'stale notification spacing is restored');
	assert.equal(replacement.wallet.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true, 'late Wallet is hidden');
	assert.equal(replacement.balance.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false, 'late KR balance remains visible');
	assert.equal(replacement.notification.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true, 'late Notifications is hidden');
	assert.equal(replacement.leaderboardsTarget.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true, 'late Leaderboards is hidden');

	harness.controller.apply(false);
	assert.equal(replacement.wallet.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false);
	assert.equal(replacement.notification.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false);
	assert.equal(replacement.leaderboardsTarget.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false);
	assert.equal(replacement.walletBefore.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false);
	assert.equal(replacement.notificationSeparator.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false);
});

test('hides an empty featured promotion frame but preserves unrelated promo cards', () => {
	const root = new FakeMenuElement('body');
	const emptyFeatured = new FakeMenuElement('section', '', ['featured-section']);
	const selfPromotion = createPromotionCard();
	emptyFeatured.append(selfPromotion);
	const unrelatedPromotion = createPromotionCard('Featured creator challenge');
	root.append(emptyFeatured, unrelatedPromotion);

	const targets = collectMenuDeclutterTargets({ queryAll: selector => root.querySelectorAll(selector) });
	assert.equal(targets.has(selfPromotion), true);
	assert.equal(targets.has(emptyFeatured), true, 'the otherwise empty Featured frame is hidden');
	assert.equal(targets.has(unrelatedPromotion), false, 'unrelated promo-card content is untouched');
});

test('collapses empty ad slots, removes the hidden promo grid column, and moves streams into that space', () => {
	const root = new FakeMenuElement('body');
	const hidden = new Set<FakeMenuElement>();
	const fixture = createLayoutFixture(root, hidden);
	const harness = createHarness(root, hidden);

	const layout = collectMenuDeclutterLayoutTargets(harness.environment);
	assert.equal(layout.collapsed.has(fixture.adRow), true);
	assert.equal(layout.collapsed.has(fixture.swapSlot), true);
	assert.equal(layout.gridColumns.get(fixture.grid), 2);
	assert.equal(layout.raisedStreams.has(fixture.streamsOverlay), true);
	assert.equal(layout.streamWidths.get(fixture.streamsOverlay), 408);

	harness.controller.apply(true);
	assert.equal(fixture.paidPromotion.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true);
	assert.equal(fixture.selfPromotion.attributes.has(MENU_DECLUTTER_ATTRIBUTE), true);
	assert.equal(fixture.firstStream.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false);
	assert.equal(fixture.secondStream.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false);
	assert.equal(fixture.adRow.attributes.has(MENU_DECLUTTER_COLLAPSE_ATTRIBUTE), true);
	assert.equal(fixture.swapSlot.attributes.has(MENU_DECLUTTER_COLLAPSE_ATTRIBUTE), true);
	assert.equal(fixture.grid.attributes.get(MENU_DECLUTTER_GRID_COLUMNS_ATTRIBUTE), '2');
	assert.equal(fixture.streamsOverlay.attributes.has(MENU_DECLUTTER_STREAMS_RAISED_ATTRIBUTE), true);
	assert.equal(fixture.streamsOverlay.attributes.get(MENU_DECLUTTER_STREAMS_WIDTH_ATTRIBUTE), '408');

	// The hidden row no longer participates in the right-panel flow, so Live Streams is the first
	// visible child in the former ad area. The original panel and button nodes stay untouched.
	assert.deepEqual(
		fixture.panel.children.filter(child => !child.attributes.has(MENU_DECLUTTER_COLLAPSE_ATTRIBUTE)),
		[fixture.streamsOverlay]
	);
	assert.equal(fixture.streamsOverlay.children[0], fixture.controls);
	assert.equal(fixture.more.textContent, 'More');
	assert.equal(fixture.hide.textContent, 'Hide');

	harness.controller.apply(false);
	assert.equal(fixture.paidPromotion.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false);
	assert.equal(fixture.selfPromotion.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false);
	assert.equal(fixture.adRow.attributes.has(MENU_DECLUTTER_COLLAPSE_ATTRIBUTE), false);
	assert.equal(fixture.swapSlot.attributes.has(MENU_DECLUTTER_COLLAPSE_ATTRIBUTE), false);
	assert.equal(fixture.grid.attributes.has(MENU_DECLUTTER_GRID_COLUMNS_ATTRIBUTE), false);
	assert.equal(fixture.streamsOverlay.attributes.has(MENU_DECLUTTER_STREAMS_RAISED_ATTRIBUTE), false);
	assert.equal(fixture.streamsOverlay.attributes.has(MENU_DECLUTTER_STREAMS_WIDTH_ATTRIBUTE), false);
	assert.deepEqual(fixture.panel.children, [fixture.adRow, fixture.streamsOverlay]);
	assert.equal(fixture.more, fixture.streamsOverlay.children[0]?.children[0]);
});

test('reconciles late and replaced stream/ad layout without leaving markers on stale nodes', () => {
	const root = new FakeMenuElement('body');
	const hidden = new Set<FakeMenuElement>();
	const harness = createHarness(root, hidden);
	harness.controller.apply(true);

	const first = createLayoutFixture(root, hidden);
	harness.observer?.trigger();
	assert.equal(first.adRow.attributes.has(MENU_DECLUTTER_COLLAPSE_ATTRIBUTE), true);
	assert.equal(first.grid.attributes.get(MENU_DECLUTTER_GRID_COLUMNS_ATTRIBUTE), '2');
	assert.equal(first.streamsOverlay.attributes.has(MENU_DECLUTTER_STREAMS_RAISED_ATTRIBUTE), true);

	root.remove(first.panel);
	const replacement = createLayoutFixture(root, hidden);
	harness.observer?.trigger();
	assert.equal(first.adRow.attributes.has(MENU_DECLUTTER_COLLAPSE_ATTRIBUTE), false);
	assert.equal(first.grid.attributes.has(MENU_DECLUTTER_GRID_COLUMNS_ATTRIBUTE), false);
	assert.equal(first.streamsOverlay.attributes.has(MENU_DECLUTTER_STREAMS_RAISED_ATTRIBUTE), false);
	assert.equal(first.streamsOverlay.attributes.has(MENU_DECLUTTER_STREAMS_WIDTH_ATTRIBUTE), false);
	assert.equal(replacement.adRow.attributes.has(MENU_DECLUTTER_COLLAPSE_ATTRIBUTE), true);
	assert.equal(replacement.grid.attributes.get(MENU_DECLUTTER_GRID_COLUMNS_ATTRIBUTE), '2');
	assert.equal(replacement.streamsOverlay.attributes.has(MENU_DECLUTTER_STREAMS_RAISED_ATTRIBUTE), true);
	assert.equal(replacement.streamsOverlay.attributes.get(MENU_DECLUTTER_STREAMS_WIDTH_ATTRIBUTE), '408');

	harness.controller.apply(false);
	assert.equal(replacement.adRow.attributes.has(MENU_DECLUTTER_COLLAPSE_ATTRIBUTE), false);
	assert.equal(replacement.selfPromotion.attributes.has(MENU_DECLUTTER_ATTRIBUTE), false);
});
