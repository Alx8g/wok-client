import assert from 'node:assert/strict';
import test from 'node:test';
import { menuDeclutterMutationsAreRelevant } from '../src/menu-declutter.ts';
import type { MutationElementLike } from '../src/mutation-relevance.ts';

class Element implements MutationElementLike {
	parentElement: Element | null = null;
	readonly children: Element[] = [];
	readonly selectors: string[];
	constructor(selectors: string[]) { this.selectors = selectors; }
	append(child: Element): void { child.parentElement = this; this.children.push(child); }
	matches(selectors: string): boolean { return selectors.split(',').some(selector => this.selectors.includes(selector.trim())); }
	closest(selectors: string): Element | null {
		let current: Element | null = this;
		while (current) { if (current.matches(selectors)) return current; current = current.parentElement; }
		return null;
	}
	querySelector(selectors: string): Element | null {
		for (const child of this.children) {
			if (child.matches(selectors)) return child;
			const nested = child.querySelector(selectors);
			if (nested) return nested;
		}
		return null;
	}
}

test('ordinary menu text updates do not trigger a complete declutter scan', () => {
	const holder = new Element(['#menuHolder']);
	const mainMenu = new Element(['#mainMenu']);
	const timer = new Element(['#menuTimer']);
	holder.append(mainMenu);
	mainMenu.append(timer);
	const records = [{ target: timer, addedNodes: [{ parentElement: timer }], removedNodes: [{}] }];
	for (let frame = 0; frame < 10000; frame++) assert.equal(menuDeclutterMutationsAreRelevant(records), false);
});

test('every owned menu surface still responds to changed content', () => {
	for (const selector of [
		'#signedInHeaderBar', '#dailySpinDiv', '#homeStoreAd', '#termsInfo', '#topLeftAdHolder',
		'#menuBtnBattlepass', '#menuBtnCustomGames', '#menuBtnGuide', '#menuBtnLeaderboards',
		'#menuBtnNotifications', '#menuBtnSideCommunity', '#menuBtnWallet', '#leaderboardsButton',
		'#notificationsButton', '#walletButton', '.menuItem', '.ph-item', '.headerBarLeft',
		'.headerBarRight', '.nav-item', '.nav-notif-section', '.nav-wallet-section',
		'.streams-overlay', '.streams-grid', '.stream-card', '.featured-section', '.top-ad-row',
		'.shop-badge', '.kr-sale-info', '.settingsBtn'
	]) {
		const surface = new Element([selector]);
		const child = new Element(['span']);
		surface.append(child);
		assert.equal(menuDeclutterMutationsAreRelevant([{ target: child }]), true, selector);
	}
});

test('replacing a menu container still discovers nested owned controls', () => {
	const body = new Element(['body']);
	const mainMenu = new Element(['#mainMenu']);
	const group = new Element(['div']);
	group.append(new Element(['.settingsBtn']));
	mainMenu.append(group);
	assert.equal(menuDeclutterMutationsAreRelevant([{ target: body, addedNodes: [mainMenu] }]), true);
	assert.equal(menuDeclutterMutationsAreRelevant([{ target: body, removedNodes: [mainMenu] }]), true);
});

test('unrelated siblings of an owned menu component remain irrelevant', () => {
	const holder = new Element(['#menuHolder']);
	holder.append(new Element(['.streams-overlay']));
	const chat = new Element(['#chatList']);
	holder.append(chat);
	assert.equal(menuDeclutterMutationsAreRelevant([{ target: chat, addedNodes: [{ parentElement: chat }] }]), false);
});
