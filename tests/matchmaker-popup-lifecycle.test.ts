import assert from 'node:assert/strict';
import test from 'node:test';
import { MatchmakerPopupLifecycle } from '../src/matchmaker-popup-lifecycle.ts';

const noDismissal = {
	dismissed: false,
	joinGame: false,
	openServerWindow: false,
	playSelect: false
};

test('retrying replaces an error popup without opening the server browser when enabled', () => {
	const lifecycle = new MatchmakerPopupLifecycle();
	lifecycle.show('error');

	assert.deepEqual(lifecycle.replace(), {
		dismissed: true,
		joinGame: false,
		openServerWindow: false,
		playSelect: false
	});
	assert.deepEqual(lifecycle.decide(false, true), noDismissal);
});

test('replacement never reuses the no-games cancellation side effect', () => {
	const lifecycle = new MatchmakerPopupLifecycle();
	lifecycle.show('no-games');

	assert.equal(lifecycle.replace().openServerWindow, false);
});

test('genuine no-games and error cancellation still opens the enabled server browser', () => {
	for (const state of ['no-games', 'error'] as const) {
		const lifecycle = new MatchmakerPopupLifecycle();
		lifecycle.show(state);

		assert.deepEqual(lifecycle.decide(false, true), {
			dismissed: true,
			joinGame: false,
			openServerWindow: true,
			playSelect: true
		});
	}
});

test('game decisions retain join and cancellation behavior', () => {
	const accepted = new MatchmakerPopupLifecycle();
	accepted.show('game');
	assert.deepEqual(accepted.decide(true, true), {
		dismissed: true,
		joinGame: true,
		openServerWindow: false,
		playSelect: true
	});

	const cancelled = new MatchmakerPopupLifecycle();
	cancelled.show('game');
	assert.deepEqual(cancelled.decide(false, true), {
		dismissed: true,
		joinGame: false,
		openServerWindow: false,
		playSelect: true
	});
});
