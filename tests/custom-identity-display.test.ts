import assert from 'node:assert/strict';
import test from 'node:test';
import {
	applyCustomIdentity,
	type CustomIdentityEnvironment,
	getCustomIdentity,
	getCustomIdentityOverlayLines,
	getRealIdentityForDisplay,
	startRealIdentityDiscovery,
	stopCustomIdentityDisplay,
	withRealIdentity
} from '../src/custom-identity-display.ts';
import type { IdentityMutationRecord, IdentityRewriteNode } from '../src/identity-rewrite.ts';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

interface FakeNode extends IdentityRewriteNode {
	childNodes: FakeNode[];
}

function text(value: string): FakeNode {
	return { childNodes: [], data: value, isConnected: true, nodeType: TEXT_NODE };
}

function element(tagName: string, children: FakeNode[] = []): FakeNode {
	return { childNodes: children, hasAttribute: () => false, isConnected: true, nodeType: ELEMENT_NODE, tagName };
}

function allText(node: FakeNode): string[] {
	if (node.nodeType === TEXT_NODE) return [node.data ?? ''];
	return node.childNodes.flatMap(allText);
}

function createEnvironment(root: FakeNode) {
	const frames: (() => void)[] = [];
	const timers = new Map<number, () => void>();
	let timerSequence = 0;
	let observerCount = 0;
	let disconnectCount = 0;
	let gameActivity: (() => unknown) | undefined;

	const environment: CustomIdentityEnvironment = {
		clearTimer: handle => { timers.delete(handle); },
		createObserver: (_callback: (records: readonly IdentityMutationRecord[]) => void) => {
			observerCount += 1;
			return {
				disconnect: () => { disconnectCount += 1; },
				observe: () => {}
			};
		},
		getGameActivity: () => gameActivity,
		root: () => root,
		schedule: callback => {
			frames.push(callback);
			return frames.length;
		},
		setTimer: callback => {
			timerSequence += 1;
			timers.set(timerSequence, callback);
			return timerSequence;
		},
		unschedule: () => {}
	};

	return {
		get disconnectCount() { return disconnectCount; },
		environment,
		get observerCount() { return observerCount; },
		get pendingTimers() { return timers.size; },
		runFrames(count = 6) {
			for (let index = 0; index < count; index += 1) {
				const frame = frames.shift();
				if (!frame) return;
				frame();
			}
		},
		runTimers(count = 1) {
			for (let index = 0; index < count; index += 1) {
				const next = [...timers.entries()][0];
				if (!next) return;
				timers.delete(next[0]);
				next[1]();
			}
		},
		setGameActivity(activity: (() => unknown) | undefined) { gameActivity = activity; }
	};
}

test('discovery reads the name out of Krunker game activity and then stops', () => {
	const names: string[] = [];
	const timers: (() => void)[] = [];
	let activity: unknown;
	const stop = startRealIdentityDiscovery({
		clearTimer: () => {},
		getGameActivity: () => activity,
		onName: name => { names.push(name); },
		setTimer: callback => {
			timers.push(callback);
			return timers.length;
		}
	});

	// Krunker has not defined it yet, then defines it before it knows the player.
	assert.deepEqual(names, []);
	activity = () => ({ id: 'FRA:h83cx', map: 'Subzero' });
	timers.shift()?.();
	assert.deepEqual(names, []);

	activity = () => ({ id: 'FRA:h83cx', map: 'Subzero', user: 'Rocketeer' });
	timers.shift()?.();
	assert.deepEqual(names, ['Rocketeer']);
	assert.equal(timers.length, 0, 'polling ends the moment the name is known');
	stop();
});

test('discovery survives a hostile activity object and gives up eventually', () => {
	const names: string[] = [];
	const timers: (() => void)[] = [];
	startRealIdentityDiscovery({
		clearTimer: () => {},
		getGameActivity: () => () => { throw new Error('krunker exploded'); },
		maxAttempts: 3,
		onName: name => { names.push(name); },
		setTimer: callback => {
			timers.push(callback);
			return timers.length;
		}
	});
	timers.shift()?.();
	timers.shift()?.();
	assert.deepEqual(names, []);
	assert.equal(timers.length, 0, 'it stops rather than polling a broken game forever');

	// Values that are not a usable account name are refused.
	for (const user of ['', '   ', 'not a name', 42, null, 'x'.repeat(64)]) {
		const found: string[] = [];
		startRealIdentityDiscovery({
			clearTimer: () => {},
			getGameActivity: () => () => ({ user }),
			maxAttempts: 1,
			onName: name => { found.push(name); },
			setTimer: () => 0
		});
		assert.deepEqual(found, [], `refused ${JSON.stringify(user)}`);
	}
});

test('a cancelled discovery stops polling', () => {
	let cleared = 0;
	const stop = startRealIdentityDiscovery({
		clearTimer: () => { cleared += 1; },
		getGameActivity: () => undefined,
		onName: () => { assert.fail('should not resolve'); },
		setTimer: () => 7
	});
	stop();
	assert.equal(cleared, 1);
});

test('nothing set means no observer, no timer and no label', () => {
	const root = element('BODY', [text('Rocketeer: gg')]);
	const harness = createEnvironment(root);
	try {
		applyCustomIdentity({}, harness.environment);
		harness.runFrames();
		assert.equal(harness.observerCount, 0);
		assert.equal(harness.pendingTimers, 0);
		assert.equal(getCustomIdentity().name, '');
		assert.deepEqual(getCustomIdentityOverlayLines(), []);
		assert.deepEqual(allText(root), ['Rocketeer: gg']);
	} finally {
		stopCustomIdentityDisplay();
	}
});

test('the discovered name is what gets replaced across the whole UI', () => {
	const chat = text('Rocketeer: gg');
	const killFeed = text('Rocketeer killed Bandit');
	const scoreboard = element('DIV', [text('1.'), text('Rocketeer'), text('42')]);
	const otherPlayer = text('Rocketeer2 killed Bandit');
	const root = element('BODY', [element('DIV', [chat, killFeed]), scoreboard, otherPlayer]);
	const harness = createEnvironment(root);
	try {
		harness.setGameActivity(() => ({ user: 'Rocketeer' }));
		applyCustomIdentity({ customName: 'Nightfall' }, harness.environment);
		harness.runFrames();

		assert.equal(chat.data, 'Nightfall: gg');
		assert.equal(killFeed.data, 'Nightfall killed Bandit');
		assert.deepEqual(allText(scoreboard), ['1.', 'Nightfall', '42']);
		assert.equal(otherPlayer.data, 'Rocketeer2 killed Bandit', 'another player is not the local player');
		assert.deepEqual(getCustomIdentity(), { clan: '', name: 'Nightfall' });
		assert.equal(getRealIdentityForDisplay().name, 'Rocketeer');
	} finally {
		stopCustomIdentityDisplay();
	}
});

test('a name that only arrives once the game has loaded still starts the swap', () => {
	const chat = text('Rocketeer: gg');
	const root = element('BODY', [chat]);
	const harness = createEnvironment(root);
	try {
		// Krunker has not published getGameActivity yet, which is the normal case at DOM-ready.
		applyCustomIdentity({ customName: 'Nightfall' }, harness.environment);
		harness.runFrames();
		assert.equal(harness.observerCount, 0, 'nothing to search for yet, so nothing is observed');
		assert.equal(chat.data, 'Rocketeer: gg');

		harness.setGameActivity(() => ({ user: 'Rocketeer' }));
		harness.runTimers();
		harness.runFrames();
		assert.equal(chat.data, 'Nightfall: gg');
		assert.equal(harness.pendingTimers, 0, 'discovery stops once it succeeds');
	} finally {
		stopCustomIdentityDisplay();
	}
});

test('a manually configured real name is used when the game never reports one', () => {
	const chat = text('Rocketeer: gg');
	const root = element('BODY', [chat]);
	const harness = createEnvironment(root);
	try {
		// No getGameActivity at all: this is the fallback the setting exists for.
		applyCustomIdentity({ customName: 'Nightfall', realName: 'Rocketeer' }, harness.environment);
		harness.runFrames();
		assert.equal(chat.data, 'Nightfall: gg');
	} finally {
		stopCustomIdentityDisplay();
	}
});

test('the clan tag is learned from the game rendering it beside the real name', () => {
	const card = text('[OLD] Rocketeer');
	const chat = text('[OLD] Rocketeer: gg');
	const root = element('BODY', [card, chat]);
	const harness = createEnvironment(root);
	try {
		harness.setGameActivity(() => ({ user: 'Rocketeer' }));
		applyCustomIdentity({ customClan: 'WOK', customName: 'Nightfall' }, harness.environment);
		harness.runFrames(10);

		assert.equal(getRealIdentityForDisplay().clan, 'OLD');
		assert.equal(card.data, '[WOK] Nightfall');
		assert.equal(chat.data, '[WOK] Nightfall: gg');
	} finally {
		stopCustomIdentityDisplay();
	}
});

test('changing the settings live re-applies, and clearing them puts the game back', () => {
	const chat = text('Rocketeer: gg');
	const root = element('BODY', [chat]);
	const harness = createEnvironment(root);
	try {
		harness.setGameActivity(() => ({ user: 'Rocketeer' }));
		applyCustomIdentity({ customName: 'Nightfall' }, harness.environment);
		harness.runFrames();
		assert.equal(chat.data, 'Nightfall: gg');

		const observersAfterStart = harness.observerCount;
		applyCustomIdentity({ customName: 'Nightfall' }, harness.environment);
		harness.runFrames();
		assert.equal(harness.observerCount, observersAfterStart, 'an unchanged setting does not rebuild anything');

		applyCustomIdentity({ customName: 'Daybreak' }, harness.environment);
		harness.runFrames();
		assert.equal(chat.data, 'Daybreak: gg');

		applyCustomIdentity({ customName: '' }, harness.environment);
		harness.runFrames();
		assert.equal(chat.data, 'Rocketeer: gg', 'clearing the setting restores the real text immediately');
		assert.equal(harness.disconnectCount, 2);
	} finally {
		stopCustomIdentityDisplay();
	}
});

test('text this client copies back out is read with the real name in place', () => {
	const scoreboardName = text('Rocketeer');
	const root = element('BODY', [scoreboardName]);
	const harness = createEnvironment(root);
	try {
		harness.setGameActivity(() => ({ user: 'Rocketeer' }));
		applyCustomIdentity({ customName: 'Nightfall' }, harness.environment);
		harness.runFrames();
		assert.equal(scoreboardName.data, 'Nightfall');

		const copied = withRealIdentity(() => scoreboardName.data);
		assert.equal(copied, 'Rocketeer', 'a pasted match result must not rename anyone');

		// The display swap comes straight back afterwards.
		harness.runFrames();
		assert.equal(scoreboardName.data, 'Nightfall');
	} finally {
		stopCustomIdentityDisplay();
	}
});

test('withRealIdentity is a plain call when nothing is being rewritten', () => {
	const root = element('BODY', [text('Bandit: gg')]);
	const harness = createEnvironment(root);
	try {
		applyCustomIdentity({}, harness.environment);
		assert.equal(withRealIdentity(() => 'read'), 'read');
	} finally {
		stopCustomIdentityDisplay();
	}
});

test('the overlay says what is being shown, what is being searched for, and how much landed', () => {
	const root = element('BODY', [text('[OLD] Rocketeer: gg')]);
	const harness = createEnvironment(root);
	try {
		applyCustomIdentity({ customClan: 'WOK', customName: 'Nightfall' }, harness.environment);
		assert.deepEqual(getCustomIdentityOverlayLines(), [
			'local name    [WOK] Nightfall',
			'local swap    idle - real name not detected yet'
		]);

		harness.setGameActivity(() => ({ user: 'Rocketeer' }));
		applyCustomIdentity({ customClan: 'WOK', customName: 'Nightfall', realClan: 'OLD', realName: 'Rocketeer' }, harness.environment);
		harness.runFrames();
		assert.deepEqual(getCustomIdentityOverlayLines(), [
			'local name    [WOK] Nightfall',
			'local swap    1 live - matching [OLD] Rocketeer'
		]);
	} finally {
		stopCustomIdentityDisplay();
	}
});

test('teardown disconnects, restores, and clears the shared state', () => {
	const chat = text('Rocketeer: gg');
	const root = element('BODY', [chat]);
	const harness = createEnvironment(root);
	harness.setGameActivity(() => ({ user: 'Rocketeer' }));
	applyCustomIdentity({ customClan: 'WOK', customName: 'Nightfall', realClan: 'OLD' }, harness.environment);
	harness.runFrames();
	assert.equal(chat.data, 'Nightfall: gg');

	stopCustomIdentityDisplay();
	assert.equal(chat.data, 'Rocketeer: gg');
	assert.equal(harness.disconnectCount, 1);
	assert.equal(getCustomIdentity().name, '');
	assert.deepEqual(getCustomIdentity(), { clan: '', name: '' });
	assert.deepEqual(getRealIdentityForDisplay(), { clan: '', name: '' });

	// Repeating teardown is harmless.
	stopCustomIdentityDisplay();
	assert.equal(harness.disconnectCount, 1);
});

test('discovery keeps watching past the first minute, because the name only exists in a match', () => {
	// Field evidence: getGameActivity() carries `user` only once the player is in a game. A
	// ceiling of sixty attempts expired while the player was still in the menu, so by the time the
	// name existed nothing was watching and the feature silently required manual entry.
	const timers: (() => void)[] = [];
	let activity: unknown;
	let discovered = '';

	startRealIdentityDiscovery({
		clearTimer: () => {},
		getGameActivity: () => activity,
		intervalMs: 1_000,
		onName: name => { discovered = name; },
		setTimer: callback => { timers.push(callback); return timers.length; }
	});

	// Two hundred attempts of menu time - well past the old ceiling.
	for (let attempt = 0; attempt < 200; attempt++) {
		const next = timers.shift();
		assert.ok(next, `discovery stopped watching after ${attempt} attempts`);
		next();
	}
	assert.equal(discovered, '', 'nothing to find while still in the menu');

	// The player finally joins a match.
	// getGameActivity resolves to Krunker's function, which returns the activity.
	activity = () => ({ id: 'SYD:t2d9f', user: 'lamboiigoni', map: 'Sandstorm' });
	const next = timers.shift();
	assert.ok(next, 'discovery must still be watching when the match starts');
	next();
	assert.equal(discovered, 'lamboiigoni');

	assert.equal(timers.length, 0, 'discovery stops for good once the name is known');
});
