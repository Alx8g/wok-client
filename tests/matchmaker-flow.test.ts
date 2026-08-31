import assert from 'node:assert/strict';
import test from 'node:test';
import { matchmakerCandidateRegions, waitForMatchmakerOperation } from '../src/matchmaker-flow.ts';
function candidate(gameID: string, region: string): IMatchmakerGame {
	return {
		gameID,
		gamemode: 'Free for All',
		map: 'Burg',
		playerCount: 2,
		playerLimit: 8,
		region,
		remainingTime: 180
	};
}
test('candidate regions are known, deduplicated, and bounded independently of lobby count', () => {
	const candidates = Array.from({ length: 100 }, (_unused, index) => candidate(`${index % 2 === 0 ? 'FRA' : 'NY'}:${index}`, index % 2 === 0 ? 'FRA' : 'NY'));
	candidates.splice(40, 0, candidate('MOON:unknown', 'MOON'));
	assert.deepEqual(matchmakerCandidateRegions(candidates), ['FRA', 'NY']);
});
test('an already-aborted request never starts its operation', async () => {
	const controller = new AbortController();
	controller.abort();
	let started = false;
	await assert.rejects(
		waitForMatchmakerOperation(controller.signal, async () => {
			started = true;
			return 1;
		}),
		{ name: 'AbortError' }
	);
	assert.equal(started, false);
});
test('aborting stops waiting for an unresolved operation', async () => {
	const controller = new AbortController();
	let release: ((value: number) => void) | undefined;
	let started = false;
	const result = waitForMatchmakerOperation(controller.signal, () => {
		started = true;
		return new Promise<number>((resolve) => {
			release = resolve;
		});
	});
	await Promise.resolve();
	assert.equal(started, true);
	controller.abort();
	await assert.rejects(result, { name: 'AbortError' });
	release?.(42);
	await Promise.resolve();
});
test('operation results and failures pass through while the request remains active', async () => {
	const signal = new AbortController().signal;
	assert.equal(await waitForMatchmakerOperation(signal, async () => 42), 42);
	await assert.rejects(
		waitForMatchmakerOperation(signal, async () => {
			throw new Error('offline');
		}),
		/offline/u
	);
});
