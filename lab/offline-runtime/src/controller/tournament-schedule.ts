import {
	canonicalJson,
	sha256Hex
} from '../shared/hash.ts';
import {
	assertRuntimeLabIdentifier
} from '../shared/protocol.ts';

export const RUNTIME_TOURNAMENT_MINIMUM_BLOCKS = 7;
export const RUNTIME_TOURNAMENT_SCHEDULE_VERSION = 1;

export type RuntimeTournamentScheduleDesign =
	| 'abba-baab'
	| 'balanced-latin-square';

export interface RuntimeTournamentScheduleBlock {
	blockIndex: number;
	cycleIndex: number;
	order: string[];
	pattern?: 'ABBA' | 'BAAB';
}

export interface RuntimeTournamentSchedule {
	actualBlockCount: number;
	blocks: RuntimeTournamentScheduleBlock[];
	candidateIds: string[];
	design: RuntimeTournamentScheduleDesign;
	designRowCount: number;
	requestedBlockCount: number;
	seed: string;
	version: typeof RUNTIME_TOURNAMENT_SCHEDULE_VERSION;
}

export interface ResolvedRuntimeTournamentSchedule {
	schedule: RuntimeTournamentSchedule;
	scheduleSha256: string;
}

interface SeededDraw {
	next(maximumExclusive: number): number;
}

function validateCandidateIds(
	candidateIds: readonly string[]
): string[] {
	if (!Array.isArray(candidateIds)) {
		throw new TypeError(
			'candidateIds must be an array.'
		);
	}
	if (
		candidateIds.length < 2
		|| candidateIds.length > 16
	) {
		throw new RangeError(
			'candidateIds must contain from '
				+ '2 through 16 candidates.'
		);
	}
	const validated = candidateIds.map(
		(candidateId, index) => {
			assertRuntimeLabIdentifier(
				candidateId,
				`candidateIds[${index}]`
			);
			return candidateId;
		}
	);
	if (new Set(validated).size !== validated.length) {
		throw new TypeError(
			'candidateIds must be unique.'
		);
	}
	return validated;
}

function validateRequestedBlockCount(
	value: number
): number {
	if (
		!Number.isInteger(value)
		|| value < RUNTIME_TOURNAMENT_MINIMUM_BLOCKS
		|| value > 10_000
	) {
		throw new RangeError(
			'requestedBlockCount must be an integer from '
				+ `${RUNTIME_TOURNAMENT_MINIMUM_BLOCKS} through 10,000.`
		);
	}
	return value;
}

function createSeededDraw(seed: string): SeededDraw {
	assertRuntimeLabIdentifier(seed, 'seed');
	let counter = 0;
	return {
		next(maximumExclusive) {
			if (
				!Number.isInteger(maximumExclusive)
				|| maximumExclusive < 1
			) {
				throw new RangeError(
					'maximumExclusive must be a '
						+ 'positive integer.'
				);
			}
			const digest = sha256Hex(
				`${seed}:${counter}`
			);
			counter += 1;
			const value = Number.parseInt(
				digest.slice(0, 8),
				16
			);
			return value % maximumExclusive;
		}
	};
}

function shuffled<T>(
	values: readonly T[],
	draw: SeededDraw
): T[] {
	const result = [...values];
	for (
		let index = result.length - 1;
		index > 0;
		index -= 1
	) {
		const swapIndex = draw.next(index + 1);
		[
			result[index],
			result[swapIndex]
		] = [
			result[swapIndex],
			result[index]
		];
	}
	return result;
}

function buildLatinBaseRow(
	candidateCount: number
): number[] {
	const row = [0];
	for (
		let position = 1;
		position < candidateCount;
		position += 1
	) {
		row.push(
			position % 2 === 1
				? (position + 1) / 2
				: candidateCount
					- position / 2
		);
	}
	return row;
}

function buildBalancedLatinRows(
	candidateCount: number
): number[][] {
	const base = buildLatinBaseRow(candidateCount);
	const rows = Array.from(
		{ length: candidateCount },
		(_value, rowIndex) =>
			base.map(
				candidateIndex =>
					(candidateIndex + rowIndex)
					% candidateCount
			)
	);
	if (candidateCount % 2 === 0) return rows;
	return [
		...rows,
		...rows.map(row => [...row].reverse())
	];
}

function buildTwoCandidateBlocks(
	candidateIds: readonly string[],
	requestedBlockCount: number,
	draw: SeededDraw
): RuntimeTournamentScheduleBlock[] {
	const [candidateA, candidateB] = shuffled(
		candidateIds,
		draw
	);
	const firstPattern =
		draw.next(2) === 0 ? 'ABBA' : 'BAAB';
	return Array.from(
		{ length: requestedBlockCount },
		(_value, blockIndex) => {
			const pattern = blockIndex % 2 === 0
				? firstPattern
				: firstPattern === 'ABBA'
					? 'BAAB'
					: 'ABBA';
			return {
				blockIndex,
				cycleIndex: Math.floor(
					blockIndex / 2
				),
				order: pattern === 'ABBA'
					? [
						candidateA,
						candidateB,
						candidateB,
						candidateA
					]
					: [
						candidateB,
						candidateA,
						candidateA,
						candidateB
					],
				pattern
			};
		}
	);
}

function buildLatinBlocks(
	candidateIds: readonly string[],
	requestedBlockCount: number,
	draw: SeededDraw
): {
	blocks: RuntimeTournamentScheduleBlock[];
	designRowCount: number;
} {
	const mappedCandidateIds = shuffled(
		candidateIds,
		draw
	);
	const rows = buildBalancedLatinRows(
		candidateIds.length
	);
	const cycleCount = Math.ceil(
		requestedBlockCount / rows.length
	);
	const blocks: RuntimeTournamentScheduleBlock[] = [];
	for (
		let cycleIndex = 0;
		cycleIndex < cycleCount;
		cycleIndex += 1
	) {
		const rowOrder = shuffled(
			rows.map((_row, rowIndex) => rowIndex),
			draw
		);
		for (const rowIndex of rowOrder) {
			blocks.push({
				blockIndex: blocks.length,
				cycleIndex,
				order: rows[rowIndex].map(
					candidateIndex =>
						mappedCandidateIds[
							candidateIndex
						]
				)
			});
		}
	}
	return {
		blocks,
		designRowCount: rows.length
	};
}

export function buildRuntimeTournamentSchedule(options: {
	candidateIds: readonly string[];
	requestedBlockCount: number;
	seed: string;
}): ResolvedRuntimeTournamentSchedule {
	const candidateIds = validateCandidateIds(
		options.candidateIds
	);
	const requestedBlockCount =
		validateRequestedBlockCount(
			options.requestedBlockCount
		);
	assertRuntimeLabIdentifier(options.seed, 'seed');
	const draw = createSeededDraw(options.seed);
	let schedule: RuntimeTournamentSchedule;
	if (candidateIds.length === 2) {
		const blocks = buildTwoCandidateBlocks(
			candidateIds,
			requestedBlockCount,
			draw
		);
		schedule = {
			actualBlockCount: blocks.length,
			blocks,
			candidateIds,
			design: 'abba-baab',
			designRowCount: 2,
			requestedBlockCount,
			seed: options.seed,
			version:
				RUNTIME_TOURNAMENT_SCHEDULE_VERSION
		};
	} else {
		const latin = buildLatinBlocks(
			candidateIds,
			requestedBlockCount,
			draw
		);
		schedule = {
			actualBlockCount: latin.blocks.length,
			blocks: latin.blocks,
			candidateIds,
			design: 'balanced-latin-square',
			designRowCount: latin.designRowCount,
			requestedBlockCount,
			seed: options.seed,
			version:
				RUNTIME_TOURNAMENT_SCHEDULE_VERSION
		};
	}
	return {
		schedule,
		scheduleSha256: sha256Hex(
			canonicalJson(schedule)
		)
	};
}
