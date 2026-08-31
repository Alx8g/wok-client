import assert from 'node:assert/strict';
import test from 'node:test';
import {
	matchmakerPointerDownIsOutside,
	MatchmakerPopupLifecycle
} from '../src/matchmaker-popup-lifecycle.ts';

const noDismissal = {
	abortSearch: false,
	dismissed: false,
	joinGame: false,
	openServerWindow: false,
	playSelect: false
};

test('retrying replaces an error popup without opening the server browser when enabled', () => {
	const lifecycle = new MatchmakerPopupLifecycle();
	const session = lifecycle.show('error');

	assert.equal(lifecycle.isCurrent(session), true);
	assert.deepEqual(lifecycle.replace(), {
		abortSearch: false,
		dismissed: true,
		joinGame: false,
		openServerWindow: false,
		playSelect: false
	});
	assert.deepEqual(lifecycle.decide(session, false, true), noDismissal);
});

test('replacement never reuses the no-games cancellation side effect', () => {
	const lifecycle = new MatchmakerPopupLifecycle();
	lifecycle.show('no-games');

	assert.equal(lifecycle.replace().openServerWindow, false);
});

test('genuine no-games and error cancellation still opens the enabled server browser', () => {
	for (const state of ['no-games', 'error'] as const) {
		const lifecycle = new MatchmakerPopupLifecycle();
		const session = lifecycle.show(state);

		assert.deepEqual(lifecycle.decide(session, false, true), {
			abortSearch: false,
			dismissed: true,
			joinGame: false,
			openServerWindow: true,
			playSelect: true
		});
	}
});

test('game decisions retain join and cancellation behavior', () => {
	const accepted = new MatchmakerPopupLifecycle();
	const acceptedSession = accepted.show('game');
	assert.deepEqual(accepted.decide(acceptedSession, true, true), {
		abortSearch: false,
		dismissed: true,
		joinGame: true,
		openServerWindow: false,
		playSelect: true
	});

	const cancelled = new MatchmakerPopupLifecycle();
	const cancelledSession = cancelled.show('game');
	assert.deepEqual(cancelled.decide(cancelledSession, false, true), {
		abortSearch: false,
		dismissed: true,
		joinGame: false,
		openServerWindow: false,
		playSelect: true
	});
});

test('searching can only be cancelled and never opens the server browser', () => {
	const lifecycle = new MatchmakerPopupLifecycle();
	const session = lifecycle.show('searching');

	assert.deepEqual(lifecycle.decide(session, true, true), noDismissal);
	assert.deepEqual(lifecycle.decide(session, false, true), {
		abortSearch: true,
		dismissed: true,
		joinGame: false,
		openServerWindow: false,
		playSelect: true
	});
});

test('the cancellation confirmation dismisses on any key and never joins or opens the server browser', () => {
	for (const accept of [true, false]) {
		const lifecycle = new MatchmakerPopupLifecycle();
		const session = lifecycle.show('cancelled');

		assert.deepEqual(lifecycle.decide(session, accept, true), {
			abortSearch: false,
			dismissed: true,
			joinGame: false,
			openServerWindow: false,
			playSelect: true
		});
	}
});

test('the cancellation confirmation clears itself without a second cancellation sound', () => {
	const lifecycle = new MatchmakerPopupLifecycle();
	lifecycle.show('cancelled');

	assert.deepEqual(lifecycle.replace(), {
		abortSearch: false,
		dismissed: true,
		joinGame: false,
		openServerWindow: false,
		playSelect: false
	});
	assert.deepEqual(lifecycle.replace(), noDismissal);
});

test('replacing a search does not report a user cancellation', () => {
	const lifecycle = new MatchmakerPopupLifecycle();
	lifecycle.show('searching');

	assert.deepEqual(lifecycle.replace(), {
		abortSearch: false,
		dismissed: true,
		joinGame: false,
		openServerWindow: false,
		playSelect: false
	});
});

test('silent teardown aborts a search without feedback and is idempotent', () => {
	const lifecycle = new MatchmakerPopupLifecycle();
	lifecycle.show('searching');

	assert.deepEqual(lifecycle.teardown(), {
		abortSearch: true,
		dismissed: true,
		joinGame: false,
		openServerWindow: false,
		playSelect: false
	});
	assert.deepEqual(lifecycle.teardown(), noDismissal);
});

test('silent teardown never joins, plays feedback, or opens servers for an offered lobby', () => {
	const lifecycle = new MatchmakerPopupLifecycle();
	lifecycle.show('game');

	assert.deepEqual(lifecycle.teardown(), {
		abortSearch: false,
		dismissed: true,
		joinGame: false,
		openServerWindow: false,
		playSelect: false
	});
});

test('input begun on a replaced view cannot act on the current popup session', () => {
	const lifecycle = new MatchmakerPopupLifecycle();
	const oldSession = lifecycle.show('game');
	lifecycle.replace();
	const currentSession = lifecycle.show('searching');

	assert.equal(lifecycle.isCurrent(oldSession), false);
	assert.equal(lifecycle.isCurrent(currentSession), true);
	assert.deepEqual(lifecycle.decide(oldSession, true, true), noDismissal);
	assert.equal(lifecycle.isCurrent(currentSession), true);
	assert.deepEqual(lifecycle.decide(currentSession, false, true), {
		abortSearch: true,
		dismissed: true,
		joinGame: false,
		openServerWindow: false,
		playSelect: true
	});
});

test('pointerdown containment keeps popup controls interactive and treats the rest as outside', () => {
	const inside = {} as Node;
	const outside = {} as Node;
	const popup = { contains: (target: Node | null) => target === inside };

	assert.equal(matchmakerPointerDownIsOutside(popup, inside), false);
	assert.equal(matchmakerPointerDownIsOutside(popup, outside), true);
	assert.equal(matchmakerPointerDownIsOutside(popup, null), true);
});
