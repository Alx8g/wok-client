import {
	mkdir,
	readFile,
	writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import type {
	RuntimeLabFailure
} from '../host/failure-classification.ts';
import type {
	PresentMonProcessLifetimeBinding
} from '../host/etl-process-lifetimes.ts';
import type {
	PresentMonCsvAnalysis,
	PresentMonStreamAnalysis
} from '../host/presentmon-csv.ts';
import {
	canonicalJson,
	sha256Hex
} from '../shared/hash.ts';
import {
	persistAttestedRuntimeControllerSources,
	type RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION,
	type PersistedRuntimeControllerSource
} from './source-attestation.ts';
import {
	runRuntimeLabSingleRun,
	type ArtifactRecord,
	type RuntimeLabAcceptedEtlEvidence,
	type RuntimeLabExecutionIdentities,
	type RuntimeLabSingleRunOptions
} from './single-run.ts';
import {
	buildRuntimeTournamentPairAnalyses,
	type RuntimeTournamentMetricAnalysis,
	type RuntimeTournamentMetricDirection,
	type RuntimeTournamentPairedBlocks
} from './tournament-analysis.ts';
import {
	resolveRuntimeTournamentDryRunReport,
	type RuntimeTournamentAnalysisControls,
	type RuntimeTournamentDryRunCandidate,
	type RuntimeTournamentExecutionControls
} from './tournament-dry-run.ts';
import type {
	RuntimeTournamentPlannedRun
} from './tournament-plan.ts';
import type {
	ResolvedRuntimeTournamentSchedule
} from './tournament-schedule.ts';

export type {
	RuntimeTournamentPlannedRun
} from './tournament-plan.ts';

export const RUNTIME_TOURNAMENT_CONTROLLER_VERSION = 6;

export type RuntimeTournamentMetricId =
	| 'average-fps'
	| 'frame-time-p95-ms'
	| 'frame-time-p99-ms'
	| 'one-percent-low-fps';

export interface RuntimeTournamentMetricPolicy {
	direction: RuntimeTournamentMetricDirection;
	metricId: RuntimeTournamentMetricId;
	noiseFloor: number;
	practicalMargin: number;
}

export interface RuntimeTournamentRunResult {
	cleanup?: {
		orphanProcessIds: number[];
	};
	etlEvidence?: RuntimeLabAcceptedEtlEvidence;
	etlProcessLifetimeEvidence?: ArtifactRecord;
	executionIdentities?: RuntimeLabExecutionIdentities;
	failures?: readonly RuntimeLabFailure[];
	headlineAnalysis?: PresentMonCsvAnalysis;
	headlineStream?: PresentMonStreamAnalysis;
	headlineStreamKey?: string;
	presentingProcessId?: number;
	presentMonProcessLifetimeBinding?: PresentMonProcessLifetimeBinding;
	presentMonProcessLifetimeBindingEvidence?: ArtifactRecord;
	runDirectory: string;
	runId: string;
	valid: boolean;
	violations: string[];
}

export interface RuntimeTournamentRunRecord {
	blockIndex?: number;
	candidateId: string;
	cycleIndex?: number;
	error?: string;
	etlEvidence?: RuntimeLabAcceptedEtlEvidence;
	etlProcessLifetimeEvidence?: ArtifactRecord;
	executionIdentities?: RuntimeLabExecutionIdentities;
	failureReasons: string[];
	failures: RuntimeLabFailure[];
	headlineStream?: PresentMonStreamAnalysis;
	headlineStreamKey?: string;
	metricValues: Partial<
		Record<RuntimeTournamentMetricId, number>
	>;
	phase: 'measured' | 'warmup';
	presentingProcessId?: number;
	presentMonProcessLifetimeBinding?: PresentMonProcessLifetimeBinding;
	presentMonProcessLifetimeBindingEvidence?: ArtifactRecord;
	runDirectory?: string;
	runId: string;
	sequenceIndex: number;
	valid: boolean;
	violations: string[];
}

export type RuntimeTournamentControllerSource =
	PersistedRuntimeControllerSource;

export interface RuntimeTournamentCandidateIdentity {
	executableSha256: string;
	id: string;
	manifestSha256: string;
}

export interface RuntimeTournamentPairMetricAnalysis {
	analysis?: RuntimeTournamentMetricAnalysis;
	baselineCandidateId: string;
	challengerCandidateId: string;
	metricId: RuntimeTournamentMetricId;
	paired: RuntimeTournamentPairedBlocks;
	unavailableReason?: string;
}

export interface RuntimeTournamentDryRunEvidence {
	evidencePath: string;
	path: string;
	plannedRunsSha256: string;
	reportSha256: string;
	version: number;
}

export interface RuntimeTournamentResult {
	analyses: RuntimeTournamentPairMetricAnalysis[];
	analysisControls: RuntimeTournamentAnalysisControls;
	candidateIds: string[];
	candidateIdentities: RuntimeTournamentCandidateIdentity[];
	completedAt: string;
	controllerSourceInventoryVersion:
		typeof RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION;
	controllerSources: Record<
		string,
		RuntimeTournamentControllerSource
	>;
	controllerVersion:
		typeof RUNTIME_TOURNAMENT_CONTROLLER_VERSION;
	dryRunReport: RuntimeTournamentDryRunEvidence;
	executionControls: RuntimeTournamentExecutionControls;
	executionMode: 'attested-runtime' | 'injected-test';
	fatalError?: string;
	plannedRuns: RuntimeTournamentPlannedRun[];
	resultSha256: string;
	runRecords: RuntimeTournamentRunRecord[];
	scenarioId: string;
	schedule: ResolvedRuntimeTournamentSchedule;
	startedAt: string;
	tournamentDirectory: string;
	tournamentId: string;
	valid: boolean;
}

export interface RuntimeTournamentOptions {
	confirmIdleSystem: boolean;
	dryRunReportPath: string;
	signal?: AbortSignal;
}

export interface RuntimeTournamentDependencies {
	runSingle(
		options: RuntimeLabSingleRunOptions
	): Promise<RuntimeTournamentRunResult>;
	wait(
		milliseconds: number,
		signal?: AbortSignal
	): Promise<void>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: String(error);
}

async function writeJson(
	path: string,
	value: unknown
): Promise<void> {
	const bytes = Buffer.from(
		`${JSON.stringify(value, null, '\t')}\n`,
		'utf8'
	);
	await writeFile(path, bytes);
	if (!(await readFile(path)).equals(bytes)) {
		throw new Error(
			`Mutable tournament evidence changed after write: ${path}.`
		);
	}
}

async function writeJsonOnce(
	path: string,
	value: unknown
): Promise<void> {
	const bytes = Buffer.from(
		`${JSON.stringify(value, null, '\t')}\n`,
		'utf8'
	);
	await writeFile(path, bytes, { flag: 'wx' });
	if (!(await readFile(path)).equals(bytes)) {
		throw new Error(
			`Immutable tournament evidence changed after write: ${path}.`
		);
	}
}

function isFinitePositiveMetric(
	value: number | undefined
): value is number {
	return typeof value === 'number'
		&& Number.isFinite(value)
		&& value > 0;
}

export function resolveTournamentHeadlineStreamEvidence(
	result: RuntimeTournamentRunResult
): {
	stream?: PresentMonStreamAnalysis;
	violations: string[];
} {
	const violations: string[] = [];
	const analysis = result.headlineAnalysis;
	if (analysis === undefined) {
		return {
			violations: ['tournament-headline-analysis-missing']
		};
	}
	if (!analysis.valid) {
		violations.push(
			'tournament-headline-analysis-invalid'
		);
	}
	const expectedProcessId = result.presentingProcessId;
	if (
		expectedProcessId === undefined
		|| !Number.isInteger(expectedProcessId)
		|| expectedProcessId < 1
	) {
		violations.push(
			'tournament-presenting-pid-missing'
		);
	}
	const streamKey = result.headlineStreamKey;
	if (
		typeof streamKey !== 'string'
		|| streamKey.length === 0
	) {
		violations.push(
			'tournament-headline-stream-key-missing'
		);
	}
	if (result.headlineStream === undefined) {
		violations.push(
			'tournament-headline-stream-evidence-missing'
		);
	}
	if (!Array.isArray(analysis.streams)) {
		violations.push(
			'tournament-headline-streams-missing'
		);
		return { violations };
	}
	if (
		typeof streamKey !== 'string'
		|| streamKey.length === 0
	) {
		return { violations };
	}
	const matchingStreams = analysis.streams.filter(
		stream => stream.key === streamKey
	);
	if (matchingStreams.length === 0) {
		violations.push(
			'tournament-headline-stream-missing'
		);
		return { violations };
	}
	if (matchingStreams.length > 1) {
		violations.push(
			'tournament-headline-stream-key-ambiguous'
		);
		return { violations };
	}
	const stream = matchingStreams[0];
	if (
		expectedProcessId !== undefined
		&& stream.processId !== expectedProcessId
	) {
		violations.push(
			'tournament-headline-stream-pid-mismatch'
		);
	}
	if (!stream.valid) {
		violations.push(
			'tournament-headline-stream-invalid'
		);
	}
	if (
		result.headlineStream !== undefined
		&& canonicalJson(result.headlineStream)
			!== canonicalJson(stream)
	) {
		violations.push(
			'tournament-headline-stream-evidence-mismatch'
		);
	}
	return violations.length === 0
		? { stream, violations }
		: { violations };
}

function extractMetricValues(
	stream: PresentMonStreamAnalysis | undefined
): Partial<Record<RuntimeTournamentMetricId, number>> {
	if (stream === undefined) return {};
	return {
		...(isFinitePositiveMetric(stream.averageFps)
			? { 'average-fps': stream.averageFps }
			: {}),
		...(isFinitePositiveMetric(
			stream.frameTimeP95Ms
		)
			? {
				'frame-time-p95-ms':
					stream.frameTimeP95Ms
			}
			: {}),
		...(isFinitePositiveMetric(
			stream.frameTimeP99Ms
		)
			? {
				'frame-time-p99-ms':
					stream.frameTimeP99Ms
			}
			: {}),
		...(isFinitePositiveMetric(
			stream.onePercentLowFps
		)
			? {
				'one-percent-low-fps':
					stream.onePercentLowFps
			}
			: {})
	};
}

function cleanupMayBeIncomplete(
	result: RuntimeTournamentRunResult
): boolean {
	if (
		(result.cleanup?.orphanProcessIds.length ?? 0) > 0
	) {
		return true;
	}
	return result.violations.some(violation =>
		/^(?:candidate-cleanup|candidate-exit|firewall-|presentmon-.*-cleanup|process-monitor-(?:cleanup|force-close)|server-cleanup|taskkill:)/u
			.test(violation)
	);
}

function normalizedFailureReasons(
	failures: readonly RuntimeLabFailure[]
): string[] {
	const reasons: string[] = [];
	for (const failure of failures) {
		const reasonCountBeforeFailure = reasons.length;
		for (const key of [
			'reasons',
			'violations',
			'analysisReasons'
		]) {
			const values = failure.details[key];
			if (!Array.isArray(values)) continue;
			for (const value of values) {
				if (typeof value !== 'string') continue;
				const reason = value.trim();
				if (reason.length > 0) reasons.push(reason);
			}
		}
		if (reasons.length === reasonCountBeforeFailure) {
			reasons.push(failure.kind);
		}
	}
	return [...new Set(reasons)];
}

function invalidRunStopReason(
	record: RuntimeTournamentRunRecord
): string {
	const reason = record.error
		?? record.failureReasons[0]
		?? record.violations[0]
		?? 'invalid-run';
	const phase = record.phase === 'warmup'
		? 'Warmup'
		: 'Measured';
	return `${phase} run ${record.runId} was invalid: ${reason}.`;
}

async function abortableWait(
	milliseconds: number,
	signal?: AbortSignal
): Promise<void> {
	if (milliseconds === 0) return;
	signal?.throwIfAborted();
	await new Promise<void>((resolveWait, rejectWait) => {
		const finish = (): void => {
			signal?.removeEventListener('abort', abort);
			resolveWait();
		};
		const timeout = setTimeout(finish, milliseconds);
		const abort = (): void => {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', abort);
			rejectWait(
				signal?.reason instanceof Error
					? signal.reason
					: new Error('Tournament wait aborted.')
			);
		};
		signal?.addEventListener('abort', abort, {
			once: true
		});
	});
}

const DEFAULT_DEPENDENCIES: RuntimeTournamentDependencies = {
	runSingle: options =>
		runRuntimeLabSingleRun(options),
	wait: abortableWait
};

function candidateById(
	candidates: readonly RuntimeTournamentDryRunCandidate[]
): Map<string, RuntimeTournamentDryRunCandidate> {
	return new Map(candidates.map(candidate => [
		candidate.id,
		candidate
	]));
}

function runRecordMatchesPlan(
	record: RuntimeTournamentRunRecord,
	plannedRun: RuntimeTournamentPlannedRun
): boolean {
	return record.blockIndex === plannedRun.blockIndex
		&& record.candidateId === plannedRun.candidateId
		&& record.cycleIndex === plannedRun.cycleIndex
		&& record.phase === plannedRun.phase
		&& record.runId === plannedRun.runId
		&& record.sequenceIndex === plannedRun.sequenceIndex;
}

export async function runRuntimeTournament(
	options: RuntimeTournamentOptions,
	dependencies: RuntimeTournamentDependencies =
		DEFAULT_DEPENDENCIES
): Promise<RuntimeTournamentResult> {
	if (!options.confirmIdleSystem) {
		throw new Error(
			'A runtime tournament requires an '
				+ 'explicit idle-system confirmation; '
				+ 'no candidate will be launched while '
				+ 'the active client may be in use.'
		);
	}
	options.signal?.throwIfAborted();
	const executionMode = dependencies === DEFAULT_DEPENDENCIES
		? 'attested-runtime' as const
		: 'injected-test' as const;
	const resolvedDryRun =
		await resolveRuntimeTournamentDryRunReport(
			options.dryRunReportPath
		);
	options.signal?.throwIfAborted();
	const {
		report,
		reportBytes,
		reportPath,
		runtimeControllerAttestation
	} = resolvedDryRun;
	const {
		analysisControls,
		candidateIds,
		candidates,
		executionControls,
		metricPolicy,
		plannedRuns,
		schedule,
		seed,
		tournamentId
	} = report;
	const candidateIdentities:
	RuntimeTournamentCandidateIdentity[] = candidates.map(
		candidate => ({
			executableSha256: candidate.executableSha256,
			id: candidate.id,
			manifestSha256: candidate.manifestSha256
		})
	);
	const candidatesById = candidateById(candidates);
	const {
		outputRootDirectory,
		tournamentDirectory
	} = report.output;
	await mkdir(outputRootDirectory, { recursive: true });
	await mkdir(tournamentDirectory);
	const candidatesDirectory = join(
		tournamentDirectory,
		'candidates'
	);
	const controllerSourcesDirectory = join(
		tournamentDirectory,
		'controller-sources'
	);
	const runsDirectory = join(
		tournamentDirectory,
		'runs'
	);
	await Promise.all([
		mkdir(candidatesDirectory),
		mkdir(controllerSourcesDirectory),
		mkdir(runsDirectory)
	]);
	const dryRunReportEvidencePath = join(
		tournamentDirectory,
		'dry-run-report.json'
	);
	await writeFile(
		dryRunReportEvidencePath,
		reportBytes,
		{ flag: 'wx' }
	);
	if (
		!(await readFile(dryRunReportEvidencePath))
			.equals(reportBytes)
	) {
		throw new Error(
			'Dry-run report evidence changed immediately after the exclusive write.'
		);
	}
	const controllerSourceInventory =
		await persistAttestedRuntimeControllerSources(
			runtimeControllerAttestation,
			controllerSourcesDirectory
		);
	const persistedSourceIdentity = {
		sources: Object.fromEntries(
			Object.entries(
				controllerSourceInventory.sources
			).map(([name, source]) => [
				name,
				{
					path: source.path,
					sha256: source.sha256,
					sizeBytes: source.sizeBytes
				}
			])
		),
		version: controllerSourceInventory.version
	};
	const expectedSourceIdentity = {
		sources: report.controllerSources,
		version: report.controllerSourceInventoryVersion
	};
	if (
		canonicalJson(persistedSourceIdentity)
		!== canonicalJson(expectedSourceIdentity)
	) {
		throw new Error(
			'Controller sources changed after dry-run verification.'
		);
	}
	const controllerSources = controllerSourceInventory.sources;
	await Promise.all(candidates.map(candidate =>
		writeJsonOnce(
			join(candidatesDirectory, `${candidate.id}.json`),
			candidate
		)
	));
	await Promise.all([
		writeJsonOnce(
			join(tournamentDirectory, 'planned-runs.json'),
			{
				executionControls,
				plannedRuns,
				plannedRunsSha256:
					report.plannedRunsSha256
			}
		),
		writeJsonOnce(
			join(tournamentDirectory, 'scenario.json'),
			report.scenario
		),
		writeJsonOnce(
			join(tournamentDirectory, 'schedule.json'),
			schedule
		)
	]);
	const startedAt = new Date().toISOString();
	const runRecords: RuntimeTournamentRunRecord[] = [];
	const manifestPath = join(
		tournamentDirectory,
		'tournament-manifest.json'
	);
	const recordsPath = join(
		tournamentDirectory,
		'run-records.json'
	);
	const dryRunReport: RuntimeTournamentDryRunEvidence = {
		evidencePath: dryRunReportEvidencePath,
		path: reportPath,
		plannedRunsSha256: report.plannedRunsSha256,
		reportSha256: report.reportSha256,
		version: report.version
	};
	const manifestBase = {
		analysisControls,
		candidateIds,
		candidates,
		controllerSourceInventoryVersion:
			controllerSourceInventory.version,
		controllerSources,
		controllerVersion:
			RUNTIME_TOURNAMENT_CONTROLLER_VERSION,
		dryRunReport,
		executionControls,
		executionMode,
		metricPolicies: metricPolicy.metricPolicies,
		plannedRunCount: plannedRuns.length,
		plannedRunsSha256: report.plannedRunsSha256,
		scenario: report.scenario,
		scheduleSha256: schedule.scheduleSha256,
		seed,
		startedAt,
		tournamentId
	};
	await Promise.all([
		writeJsonOnce(manifestPath, {
			...manifestBase,
			status: 'running'
		}),
		writeJsonOnce(recordsPath, runRecords)
	]);
	let fatalError: string | undefined;
	const executeRun = async (
		plannedRun: RuntimeTournamentPlannedRun
	): Promise<boolean> => {
		if (options.signal?.aborted) {
			fatalError = 'Tournament aborted before launch.';
			return false;
		}
		const {
			candidateId,
			phase,
			runId,
			sequenceIndex
		} = plannedRun;
		const candidate = candidatesById.get(candidateId);
		if (!candidate) {
			throw new Error(
				`Dry-run plan referenced unknown candidate ${candidateId}.`
			);
		}
		try {
			const result = await dependencies.runSingle({
				candidateManifestPath: candidate.manifestPath,
				confirmIdleSystem: true,
				electronHostDirectory:
					report.electronHost.directory,
				expectedAttestation: {
					candidate: {
						executablePath:
							candidate.executablePath,
						executableSha256:
							candidate.executableSha256,
						executableSizeBytes:
							candidate.executableSizeBytes,
						id: candidate.id,
						manifestPath:
							candidate.manifestPath,
						manifestSha256:
							candidate.manifestSha256,
						runtimeKind:
							candidate.runtimeKind
					},
					controllerSourceInventory: {
						sources: report.controllerSources,
						version:
							report.controllerSourceInventoryVersion
					},
					electronHost: report.electronHost,
					etlRecorder: report.etlRecorder,
					presentMon: report.presentMon,
					scenario: report.scenario
				},
				etlRecorderPath: report.etlRecorder.path,
				etlRecorderSha256: report.etlRecorder.sha256,
				outputRootDirectory: runsDirectory,
				presentMonPath: report.presentMon.path,
				presentMonSha256: report.presentMon.sha256,
				runtimeControllerAttestation,
				runId,
				scenarioManifestPath:
					report.scenario.manifestPath,
				...(options.signal === undefined
					? {}
					: { signal: options.signal }),
				startupTimeoutMs:
					executionControls.startupTimeoutMs
			});
			if (result.runId !== runId) {
				throw new Error(
					'Single-run result identity mismatch: '
						+ `expected ${runId}, received `
						+ `${result.runId}.`
				);
			}
			const cleanupIncomplete =
				cleanupMayBeIncomplete(result);
			const failures = [...(result.failures ?? [])];
			const failureReasons = normalizedFailureReasons(
				failures
			);
			const headlineEvidence =
				resolveTournamentHeadlineStreamEvidence(
					result
				);
			const metricValues = extractMetricValues(
				headlineEvidence.stream
			);
			const missingMetrics = metricPolicy.metricPolicies
				.map(policy => policy.metricId)
				.filter(
					metricId =>
						metricValues[metricId]
						=== undefined
				);
			const record: RuntimeTournamentRunRecord = {
				...(plannedRun.blockIndex === undefined
					? {}
					: {
						blockIndex: plannedRun.blockIndex,
						cycleIndex: plannedRun.cycleIndex
					}),
				candidateId,
				...(result.etlEvidence === undefined
					? {}
					: { etlEvidence: result.etlEvidence }),
				...(result.etlProcessLifetimeEvidence === undefined
					? {}
					: {
						etlProcessLifetimeEvidence:
							result.etlProcessLifetimeEvidence
					}),
				...(result.executionIdentities === undefined
					? {}
					: {
						executionIdentities:
							result.executionIdentities
					}),
				failureReasons,
				failures,
				...(result.headlineStream === undefined
					? {}
					: { headlineStream: result.headlineStream }),
				...(result.headlineStreamKey === undefined
					? {}
					: {
						headlineStreamKey:
							result.headlineStreamKey
					}),
				metricValues,
				phase,
				...(result.presentingProcessId === undefined
					? {}
					: {
						presentingProcessId:
							result.presentingProcessId
					}),
				...(result.presentMonProcessLifetimeBinding === undefined
					? {}
					: {
						presentMonProcessLifetimeBinding:
							result.presentMonProcessLifetimeBinding
					}),
				...(result.presentMonProcessLifetimeBindingEvidence === undefined
					? {}
					: {
						presentMonProcessLifetimeBindingEvidence:
							result.presentMonProcessLifetimeBindingEvidence
					}),
				runDirectory: result.runDirectory,
				runId,
				sequenceIndex,
				valid: result.valid
					&& headlineEvidence.violations.length === 0
					&& !cleanupIncomplete
					&& missingMetrics.length === 0,
				violations: [
					...result.violations,
					...headlineEvidence.violations,
					...(cleanupIncomplete
						? ['tournament-cleanup-uncertain']
						: []),
					...missingMetrics.map(
						metricId =>
							`tournament-metric-missing:${metricId}`
					)
				]
			};
			runRecords.push(record);
			await writeJson(recordsPath, runRecords);
			if (!record.valid) {
				fatalError = invalidRunStopReason(record);
				return false;
			}
			return true;
		} catch (error) {
			const message = options.signal?.aborted
				? `Tournament aborted: ${errorMessage(error)}`
				: errorMessage(error);
			runRecords.push({
				...(plannedRun.blockIndex === undefined
					? {}
					: {
						blockIndex: plannedRun.blockIndex,
						cycleIndex: plannedRun.cycleIndex
					}),
				candidateId,
				error: message,
				failureReasons: [],
				failures: [],
				metricValues: {},
				phase,
				runId,
				sequenceIndex,
				valid: false,
				violations: [
					`tournament-run-error:${message}`
				]
			});
			await writeJson(recordsPath, runRecords);
			fatalError = message;
			return false;
		}
	};

	let quietBaselinePerformed = false;
	for (const plannedRun of plannedRuns) {
		if (
			plannedRun.phase === 'measured'
			&& !quietBaselinePerformed
		) {
			try {
				await dependencies.wait(
					executionControls.quietBaselineMs,
					options.signal
				);
				quietBaselinePerformed = true;
			} catch (error) {
				fatalError = options.signal?.aborted
					? `Tournament aborted: ${errorMessage(error)}`
					: `Quiet baseline failed: ${errorMessage(error)}`;
				break;
			}
		}
		if (!await executeRun(plannedRun)) break;
	}
	const analyses = buildRuntimeTournamentPairAnalyses({
		analysisControls,
		candidateIds,
		metricPolicies: metricPolicy.metricPolicies,
		runRecords,
		seed
	});
	if (
		executionMode === 'injected-test'
		&& fatalError === undefined
	) {
		fatalError =
			'Injected tournament dependencies cannot produce attested runtime evidence.';
	}
	const completedAt = new Date().toISOString();
	const expectedMeasuredRuns = plannedRuns.filter(
		run => run.phase === 'measured'
	).length;
	const measuredRuns = runRecords.filter(
		record => record.phase === 'measured'
	);
	const valid = fatalError === undefined
		&& runRecords.length === plannedRuns.length
		&& measuredRuns.length === expectedMeasuredRuns
		&& runRecords.every((record, index) =>
			record.valid
			&& runRecordMatchesPlan(record, plannedRuns[index])
		);
	const resultWithoutHash: Omit<
		RuntimeTournamentResult,
		'resultSha256'
	> = {
		analyses,
		analysisControls,
		candidateIds,
		candidateIdentities,
		completedAt,
		controllerSourceInventoryVersion:
			controllerSourceInventory.version,
		controllerSources,
		controllerVersion:
			RUNTIME_TOURNAMENT_CONTROLLER_VERSION,
		dryRunReport,
		executionControls,
		executionMode,
		...(fatalError === undefined
			? {}
			: { fatalError }),
		plannedRuns,
		runRecords,
		scenarioId: report.scenario.id,
		schedule,
		startedAt,
		tournamentDirectory,
		tournamentId,
		valid
	};
	const result: RuntimeTournamentResult = {
		...resultWithoutHash,
		resultSha256: sha256Hex(
			canonicalJson(resultWithoutHash)
		)
	};
	await Promise.all([
		writeJsonOnce(
			join(tournamentDirectory, 'analysis.json'),
			analyses
		),
		writeJsonOnce(
			join(tournamentDirectory, 'tournament-result.json'),
			result
		),
		writeJson(manifestPath, {
			...manifestBase,
			completedAt,
			...(fatalError === undefined
				? {}
				: { fatalError }),
			status: valid ? 'complete' : 'failed',
			valid
		})
	]);
	return result;
}
