import {
	canonicalJson,
	sha256Hex
} from '../shared/hash.ts';
import type {
	ResolvedRuntimeTournamentSchedule,
	RuntimeTournamentScheduleBlock
} from './tournament-schedule.ts';

export interface RuntimeTournamentPlannedRun {
	blockIndex?: number;
	candidateId: string;
	cycleIndex?: number;
	phase: 'measured' | 'warmup';
	runId: string;
	sequenceIndex: number;
}

function buildChildRunId(options: {
	candidateId: string;
	phase: 'measured' | 'warmup';
	sequenceIndex: number;
	tournamentId: string;
}): string {
	const suffix = sha256Hex(
		canonicalJson(options)
	).slice(0, 8);
	const prefix = [
		options.tournamentId,
		options.phase,
		String(options.sequenceIndex).padStart(4, '0'),
		options.candidateId
	].join('-');
	return `${prefix.slice(0, 119)}-${suffix}`;
}

function firstCandidateOrder(
	schedule: ResolvedRuntimeTournamentSchedule
): string[] {
	const seen = new Set<string>();
	const order: string[] = [];
	for (const block of schedule.schedule.blocks) {
		for (const candidateId of block.order) {
			if (seen.has(candidateId)) continue;
			seen.add(candidateId);
			order.push(candidateId);
		}
	}
	return order;
}

export function buildRuntimeTournamentPlannedRuns(options: {
	schedule: ResolvedRuntimeTournamentSchedule;
	tournamentId: string;
	warmupRunsPerCandidate: number;
}): RuntimeTournamentPlannedRun[] {
	const plan: RuntimeTournamentPlannedRun[] = [];
	const append = (
		candidateId: string,
		phase: 'measured' | 'warmup',
		block?: RuntimeTournamentScheduleBlock
	): void => {
		const sequenceIndex = plan.length;
		plan.push({
			...(block === undefined
				? {}
				: {
					blockIndex: block.blockIndex,
					cycleIndex: block.cycleIndex
				}),
			candidateId,
			phase,
			runId: buildChildRunId({
				candidateId,
				phase,
				sequenceIndex,
				tournamentId: options.tournamentId
			}),
			sequenceIndex
		});
	};
	const warmupOrder = firstCandidateOrder(
		options.schedule
	);
	for (
		let repetition = 0;
		repetition < options.warmupRunsPerCandidate;
		repetition += 1
	) {
		for (const candidateId of warmupOrder) {
			append(candidateId, 'warmup');
		}
	}
	for (const block of options.schedule.schedule.blocks) {
		for (const candidateId of block.order) {
			append(candidateId, 'measured', block);
		}
	}
	return plan;
}
