import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildRuntimeTournamentSchedule,
	type RuntimeTournamentScheduleBlock
} from '../src/controller/tournament-schedule.ts';

function positionCounts(
	blocks: readonly RuntimeTournamentScheduleBlock[],
	candidateIds: readonly string[]
): Map<string, number[]> {
	const positionCount =
		blocks[0]?.order.length
		?? candidateIds.length;
	const counts = new Map(
		candidateIds.map(candidateId => [
			candidateId,
			Array.from(
				{ length: positionCount },
				() => 0
			)
		])
	);
	for (const block of blocks) {
		block.order.forEach((candidateId, position) => {
			const candidateCounts = counts.get(candidateId);
			assert.ok(candidateCounts);
			candidateCounts[position] += 1;
		});
	}
	return counts;
}

function transitionCounts(
	blocks: readonly RuntimeTournamentScheduleBlock[]
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const block of blocks) {
		for (
			let index = 1;
			index < block.order.length;
			index += 1
		) {
			const key =
				`${block.order[index - 1]}`
					+ `>${block.order[index]}`;
			counts.set(
				key,
				(counts.get(key) ?? 0) + 1
			);
		}
	}
	return counts;
}

test('two-candidate schedules alternate seeded ABBA and BAAB blocks', () => {
	const resolved = buildRuntimeTournamentSchedule({
		candidateIds: ['candidate-a', 'candidate-b'],
		requestedBlockCount: 7,
		seed: 'schedule-seed-a'
	});
	const { schedule } = resolved;
	assert.equal(schedule.design, 'abba-baab');
	assert.equal(schedule.actualBlockCount, 7);
	assert.match(
		resolved.scheduleSha256,
		/^[a-f0-9]{64}$/u
	);
	for (const block of schedule.blocks) {
		assert.equal(block.order.length, 4);
		assert.equal(
			block.order.filter(
				candidateId =>
					candidateId === 'candidate-a'
			).length,
			2
		);
		assert.equal(
			block.order.filter(
				candidateId =>
					candidateId === 'candidate-b'
			).length,
			2
		);
	}
	for (
		let blockIndex = 1;
		blockIndex < schedule.blocks.length;
		blockIndex += 1
	) {
		assert.notEqual(
			schedule.blocks[blockIndex].pattern,
			schedule.blocks[blockIndex - 1].pattern
		);
	}
	for (
		let blockIndex = 0;
		blockIndex + 1 < schedule.blocks.length;
		blockIndex += 2
	) {
		const counts = positionCounts(
			schedule.blocks.slice(
				blockIndex,
				blockIndex + 2
			),
			schedule.candidateIds
		);
		for (const candidateCounts of counts.values()) {
			assert.deepEqual(
				candidateCounts,
				[1, 1, 1, 1]
			);
		}
	}
});

test('even balanced Latin-square cycles balance position and carryover once', () => {
	const candidateIds = [
		'candidate-a',
		'candidate-b',
		'candidate-c',
		'candidate-d'
	];
	const { schedule } =
		buildRuntimeTournamentSchedule({
			candidateIds,
			requestedBlockCount: 7,
			seed: 'latin-even-seed'
		});
	assert.equal(
		schedule.design,
		'balanced-latin-square'
	);
	assert.equal(schedule.designRowCount, 4);
	assert.equal(schedule.actualBlockCount, 8);
	for (let cycleIndex = 0; cycleIndex < 2; cycleIndex += 1) {
		const blocks = schedule.blocks.filter(
			block => block.cycleIndex === cycleIndex
		);
		assert.equal(blocks.length, 4);
		const positions = positionCounts(
			blocks,
			candidateIds
		);
		for (const counts of positions.values()) {
			assert.deepEqual(counts, [1, 1, 1, 1]);
		}
		const transitions = transitionCounts(blocks);
		for (const left of candidateIds) {
			for (const right of candidateIds) {
				if (left === right) continue;
				assert.equal(
					transitions.get(`${left}>${right}`),
					1
				);
			}
		}
	}
});

test('odd balanced Latin-square cycles add reversed rows to balance carryover', () => {
	const candidateIds = [
		'candidate-a',
		'candidate-b',
		'candidate-c'
	];
	const { schedule } =
		buildRuntimeTournamentSchedule({
			candidateIds,
			requestedBlockCount: 7,
			seed: 'latin-odd-seed'
		});
	assert.equal(schedule.designRowCount, 6);
	assert.equal(schedule.actualBlockCount, 12);
	for (let cycleIndex = 0; cycleIndex < 2; cycleIndex += 1) {
		const blocks = schedule.blocks.filter(
			block => block.cycleIndex === cycleIndex
		);
		const positions = positionCounts(
			blocks,
			candidateIds
		);
		for (const counts of positions.values()) {
			assert.deepEqual(counts, [2, 2, 2]);
		}
		const transitions = transitionCounts(blocks);
		for (const left of candidateIds) {
			for (const right of candidateIds) {
				if (left === right) continue;
				assert.equal(
					transitions.get(`${left}>${right}`),
					2
				);
			}
		}
	}
});

test('schedule construction is deterministic and rejects ambiguous inputs', () => {
	const options = {
		candidateIds: [
			'candidate-a',
			'candidate-b',
			'candidate-c'
		],
		requestedBlockCount: 7,
		seed: 'deterministic-seed'
	} as const;
	assert.deepEqual(
		buildRuntimeTournamentSchedule(options),
		buildRuntimeTournamentSchedule(options)
	);
	assert.throws(
		() => buildRuntimeTournamentSchedule({
			candidateIds: ['candidate-a'],
			requestedBlockCount: 7,
			seed: 'invalid-count'
		}),
		/2 through 16/u
	);
	assert.throws(
		() => buildRuntimeTournamentSchedule({
			candidateIds: [
				'candidate-a',
				'candidate-a'
			],
			requestedBlockCount: 7,
			seed: 'duplicate-candidate'
		}),
		/unique/u
	);
	assert.throws(
		() => buildRuntimeTournamentSchedule({
			candidateIds: [
				'candidate-a',
				'candidate-b'
			],
			requestedBlockCount: 0,
			seed: 'invalid-blocks'
		}),
		/7 through 10,000/u
	);
});
