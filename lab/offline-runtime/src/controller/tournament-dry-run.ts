import { constants as fsConstants } from 'node:fs';
import {
	access,
	mkdir,
	readFile,
	realpath,
	stat,
	writeFile
} from 'node:fs/promises';
import {
	basename,
	dirname,
	isAbsolute,
	join,
	parse,
	relative,
	resolve
} from 'node:path';
import {
	buildRuntimeLaunchPlan
} from '../adapter/launch-plan.ts';
import {
	resolveRuntimeCandidateManifest,
	type ResolvedRuntimeCandidate
} from '../candidate/manifest.ts';
import {
	resolveRuntimeLabScenario
} from '../scenario/manifest.ts';
import {
	canonicalJson,
	sha256FileHex,
	sha256Hex
} from '../shared/hash.ts';
import {
	assertRuntimeLabIdentifier
} from '../shared/protocol.ts';
import {
	attestRuntimeControllerSources,
	getRuntimeControllerAttestationIdentity,
	type RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION,
	type RuntimeControllerSourceAttestation,
	type RuntimeControllerSourceName,
	type VerifiedRuntimeControllerElectronHost,
	type VerifiedRuntimeControllerSource
} from './source-attestation.ts';
import type {
	RuntimeTournamentMetricId,
	RuntimeTournamentMetricPolicy
} from './tournament-controller.ts';
import {
	buildRuntimeTournamentPairedBlocks,
	measureRuntimeTournamentNoiseFloor,
	RUNTIME_TOURNAMENT_BOOTSTRAP_ITERATIONS,
	RUNTIME_TOURNAMENT_CONFIDENCE_LEVEL
} from './tournament-analysis.ts';
import {
	buildRuntimeTournamentPlannedRuns,
	type RuntimeTournamentPlannedRun
} from './tournament-plan.ts';
import {
	resolveRuntimeTournamentMetricPolicyFileWithProvenance,
	type ResolvedRuntimeTournamentMetricPolicyFile
} from './tournament-policy.ts';
import {
	resolveRuntimeTournamentResultEvidence
} from './tournament-result-evidence.ts';
import {
	buildRuntimeTournamentSchedule,
	RUNTIME_TOURNAMENT_MINIMUM_BLOCKS,
	type ResolvedRuntimeTournamentSchedule
} from './tournament-schedule.ts';

export const RUNTIME_TOURNAMENT_DRY_RUN_VERSION = 3;

const MAX_CONTROLLER_BENCHMARK_MS = 300_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REQUIRED_METRICS = new Set<RuntimeTournamentMetricId>([
	'average-fps',
	'frame-time-p95-ms',
	'frame-time-p99-ms',
	'one-percent-low-fps'
]);

export interface RuntimeTournamentDryRunOptions {
	bootstrapIterations?: number;
	candidateManifestPaths: readonly string[];
	confidenceLevel?: number;
	electronHostDirectory: string;
	etlRecorderPath: string;
	etlRecorderSha256: string;
	metricPolicyPath: string;
	minimumPairedBlocks?: number;
	outputRootDirectory: string;
	presentMonPath: string;
	presentMonSha256: string;
	quietBaselineMs?: number;
	requestedBlockCount?: number;
	scenarioManifestPath: string;
	seed: string;
	startupTimeoutMs?: number;
	tournamentId: string;
	warmupRunsPerCandidate?: number;
}

export interface RuntimeTournamentAnalysisControls {
	bootstrapIterations: number;
	confidenceLevel: number;
	minimumPairedBlocks: number;
}

export interface RuntimeTournamentExecutionControls {
	quietBaselineMs: number;
	startupTimeoutMs: number;
	warmupRunsPerCandidate: number;
}

interface VerifiedFile {
	path: string;
	sha256: string;
	sizeBytes: number;
}

export interface RuntimeTournamentDryRunCandidate {
	executableName: string;
	executablePath: string;
	executableSha256: string;
	executableSizeBytes: number;
	id: string;
	manifestPath: string;
	manifestSha256: string;
	runtimeKind: ResolvedRuntimeCandidate['manifest']['runtimeKind'];
}

export interface RuntimeTournamentDryRunReport {
	analysisControls: RuntimeTournamentAnalysisControls;
	candidateIds: string[];
	candidates: RuntimeTournamentDryRunCandidate[];
	controllerSourceInventoryVersion:
		typeof RUNTIME_CONTROLLER_SOURCE_INVENTORY_VERSION;
	controllerSources: Record<
		RuntimeControllerSourceName,
		VerifiedRuntimeControllerSource
	>;
	electronHost: VerifiedRuntimeControllerElectronHost;
	etlRecorder: VerifiedFile;
	executionControls: RuntimeTournamentExecutionControls;
	isolation: {
		activeProcessCollisionCheck: 'deferred to immediately before each launch';
		alternateImageChildEgressGapEliminated: true;
		browserNetworkControls: 'loopback-only proxy and resolver controls';
		firewallScope: 'run-scoped all-program non-loopback block';
		requiredMeasurementEnvironment: 'idle isolated Windows environment';
	};
	metricPolicy: {
		filePath: string;
		fileSha256: string;
		kind: ResolvedRuntimeTournamentMetricPolicyFile['kind'];
		metricPolicies: RuntimeTournamentMetricPolicy[];
		reportSha256?: string;
	};
	mode: 'comparison' | 'same-build-noise-capture';
	operationsPerformed: {
		candidateLaunched: false;
		etlRecorderLaunched: false;
		firewallRuleInstalled: false;
		presentMonLaunched: false;
	};
	output: {
		existingWritableAncestor: string;
		outputRootDirectory: string;
		tournamentDirectory: string;
		tournamentDirectoryExisted: false;
	};
	plannedRuns: RuntimeTournamentPlannedRun[];
	plannedRunsSha256: string;
	presentMon: VerifiedFile;
	ready: true;
	reportSha256: string;
	scenario: {
		id: string;
		manifestPath: string;
		manifestSha256: string;
	};
	schedule: ResolvedRuntimeTournamentSchedule;
	seed: string;
	tournamentId: string;
	version: typeof RUNTIME_TOURNAMENT_DRY_RUN_VERSION;
}

export interface ResolvedRuntimeTournamentDryRunReport {
	report: RuntimeTournamentDryRunReport;
	reportBytes: Buffer;
	reportPath: string;
	runtimeControllerAttestation: RuntimeControllerSourceAttestation;
}

interface PreparedRuntimeTournamentDryRun {
	report: RuntimeTournamentDryRunReport;
	runtimeControllerAttestation: RuntimeControllerSourceAttestation;
}

export interface RuntimeTournamentDryRunResolveOptions {
	completedTournamentDirectory?: string;
}

function validateBoundedInteger(
	value: number,
	label: string,
	minimum: number,
	maximum: number
): number {
	if (
		!Number.isInteger(value)
		|| value < minimum
		|| value > maximum
	) {
		throw new RangeError(
			`${label} must be an integer from ${minimum} `
				+ `through ${maximum}.`
		);
	}
	return value;
}

function validateBoundedNumber(
	value: number,
	label: string,
	minimum: number,
	maximumExclusive: number
): number {
	if (
		typeof value !== 'number'
		|| !Number.isFinite(value)
		|| value < minimum
		|| value >= maximumExclusive
	) {
		throw new RangeError(
			`${label} must be a finite number from ${minimum} `
				+ `through less than ${maximumExclusive}.`
		);
	}
	return value;
}

function isNotFound(error: unknown): boolean {
	return (
		error !== null
		&& typeof error === 'object'
		&& 'code' in error
		&& error.code === 'ENOENT'
	);
}

async function verifyRegularFile(
	path: string,
	label: string
): Promise<VerifiedFile> {
	const resolvedPath = await realpath(resolve(path));
	const metadata = await stat(resolvedPath);
	if (!metadata.isFile()) {
		throw new TypeError(
			`${label} path must resolve to a regular file.`
		);
	}
	return {
		path: resolvedPath,
		sha256: await sha256FileHex(resolvedPath),
		sizeBytes: metadata.size
	};
}

async function verifyTool(
	path: string,
	expectedSha256: string,
	label: string
): Promise<VerifiedFile> {
	if (!SHA256_PATTERN.test(expectedSha256)) {
		throw new TypeError(
			`${label} SHA-256 must be a lowercase digest.`
		);
	}
	const verified = await verifyRegularFile(path, label);
	if (verified.sha256 !== expectedSha256) {
		throw new Error(
			`${label} SHA-256 mismatch: expected `
				+ `${expectedSha256}, received ${verified.sha256}.`
		);
	}
	return verified;
}

async function nearestExistingDirectory(
	path: string
): Promise<string> {
	let current = resolve(path);
	for (;;) {
		try {
			const metadata = await stat(current);
			if (!metadata.isDirectory()) {
				throw new TypeError(
					`Output ancestor is not a directory: ${current}`
				);
			}
			await access(current, fsConstants.W_OK);
			return await realpath(current);
		} catch (error) {
			if (!isNotFound(error)) throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			current = parent;
		}
	}
}

async function verifyOutputDestination(options: {
	outputRootDirectory: string;
	tournamentId: string;
}): Promise<RuntimeTournamentDryRunReport['output']> {
	const outputRootDirectory = resolve(
		options.outputRootDirectory
	);
	if (
		parse(outputRootDirectory).root
		=== outputRootDirectory
	) {
		throw new TypeError(
			'outputRootDirectory cannot be a filesystem root.'
		);
	}
	try {
		const metadata = await stat(outputRootDirectory);
		if (!metadata.isDirectory()) {
			throw new TypeError(
				'outputRootDirectory must be a directory when it exists.'
			);
		}
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
	const tournamentDirectory = join(
		outputRootDirectory,
		options.tournamentId
	);
	const relativeTournamentPath = relative(
		outputRootDirectory,
		tournamentDirectory
	);
	if (
		relativeTournamentPath.startsWith('..')
		|| resolve(
			outputRootDirectory,
			relativeTournamentPath
		) !== tournamentDirectory
	) {
		throw new Error(
			'Tournament directory escaped outputRootDirectory.'
		);
	}
	try {
		await stat(tournamentDirectory);
		throw new Error(
			`Future tournament directory already exists: ${tournamentDirectory}`
		);
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
	return {
		existingWritableAncestor:
			await nearestExistingDirectory(outputRootDirectory),
		outputRootDirectory,
		tournamentDirectory,
		tournamentDirectoryExisted: false
	};
}

function validateMetricCoverage(
	policies: readonly RuntimeTournamentMetricPolicy[]
): void {
	const metricIds = new Set(
		policies.map(policy => policy.metricId)
	);
	if (
		metricIds.size !== REQUIRED_METRICS.size
		|| [...REQUIRED_METRICS].some(
			metricId => !metricIds.has(metricId)
		)
	) {
		throw new TypeError(
			'Dry-run policy must define every headline metric exactly once.'
		);
	}
}

async function validateNoiseReportBaseline(options: {
	candidateExecutableHashes: ReadonlySet<string>;
	policy: ResolvedRuntimeTournamentMetricPolicyFile;
}): Promise<void> {
	if (options.policy.kind !== 'noise-floor-report') return;
	const report = options.policy.noiseFloorReport;
	if (report === undefined) {
		throw new Error(
			'Noise-floor policy is missing its verified report.'
		);
	}
	if (
		!options.candidateExecutableHashes.has(
			report.executableSha256
		)
	) {
		throw new Error(
			'Noise-floor report was not measured from any '
				+ 'candidate executable in this tournament.'
		);
	}
	const { result } =
		await resolveRuntimeTournamentResultEvidence(
			report.tournamentResultPath,
			resolveRuntimeTournamentDryRunReport
		);
	if (
		result.resultSha256 !== report.tournamentResultSha256
		|| result.tournamentId !== report.tournamentId
		|| canonicalJson(result.candidateIds)
			!== canonicalJson(report.candidateIds)
		|| result.candidateIdentities.some(identity =>
			identity.executableSha256
			!== report.executableSha256
		)
	) {
		throw new Error(
			'Noise-floor report provenance does not match its attested tournament result.'
		);
	}
	const analysesByMetric = new Map(
		result.analyses.map(entry => [entry.metricId, entry])
	);
	for (const metric of report.metrics) {
		const analysis = analysesByMetric.get(metric.metricId);
		if (
			analysis?.analysis === undefined
			|| analysis.analysis.direction !== metric.direction
			|| analysis.analysis.practicalMargin
				!== metric.practicalMargin
		) {
			throw new Error(
				`Noise-floor metric ${metric.metricId} does not match its tournament analysis.`
			);
		}
		const observations = result.runRecords
			.filter(record => record.phase === 'measured')
			.map(record => ({
				blockId:
					`block-${String(record.blockIndex).padStart(4, '0')}`,
				candidateId: record.candidateId,
				valid: record.valid
					&& record.metricValues[metric.metricId]
						!== undefined,
				value: record.metricValues[metric.metricId]
			}));
		const paired = buildRuntimeTournamentPairedBlocks(
			observations,
			{
				baselineCandidateId: report.candidateIds[0],
				challengerCandidateId: report.candidateIds[1],
				expectedObservationsPerCandidate: 2
			}
		);
		if (
			paired.excludedBlocks.length > 0
			|| paired.blocks.length !== metric.blockCount
			|| paired.blocks.length
				< report.minimumPairedBlocks
			|| measureRuntimeTournamentNoiseFloor(
				paired.blocks,
				report.percentile
			) !== metric.noiseFloor
		) {
			throw new Error(
				`Noise-floor metric ${metric.metricId} does not reproduce from its attested tournament result.`
			);
		}
	}
}

function validateCandidateExecutableNames(
	candidates: readonly ResolvedRuntimeCandidate[]
): void {
	const byName = new Map<string, ResolvedRuntimeCandidate[]>();
	for (const candidate of candidates) {
		const executableName = basename(candidate.executablePath);
		if (
			!/^[a-z0-9._-]+\.exe$/iu.test(executableName)
			|| executableName.length > 260
		) {
			throw new TypeError(
				`Candidate ${candidate.manifest.id} executable `
					+ 'must have a bounded Windows .exe base name.'
			);
		}
		const normalized = executableName.toLowerCase();
		const entries = byName.get(normalized) ?? [];
		entries.push(candidate);
		byName.set(normalized, entries);
	}
	for (const [executableName, entries] of byName) {
		if (entries.length < 2) continue;
		const hashes = new Set(
			entries.map(candidate => candidate.executableSha256)
		);
		if (hashes.size > 1) {
			throw new Error(
				'Distinct candidate binaries cannot share '
					+ `the executable name ${executableName}; `
					+ 'offline PresentMon replay and process ownership '
					+ 'require unambiguous image names.'
			);
		}
	}
}

function classifyMode(options: {
	candidates: readonly ResolvedRuntimeCandidate[];
	policy: ResolvedRuntimeTournamentMetricPolicyFile;
}): RuntimeTournamentDryRunReport['mode'] {
	const executableHashes = new Set(
		options.candidates.map(
			candidate => candidate.executableSha256
		)
	);
	const sameBuild = options.candidates.length === 2
		&& executableHashes.size === 1;
	if (sameBuild) {
		if (options.policy.kind !== 'raw-policy') {
			throw new Error(
				'Same-build noise capture requires the raw '
					+ 'zero-noise capture policy, not a derived report.'
			);
		}
		if (
			options.policy.metricPolicies.some(
				policy => policy.noiseFloor !== 0
			)
		) {
			throw new Error(
				'Same-build noise capture requires every '
					+ 'policy noise floor to be zero.'
			);
		}
		return 'same-build-noise-capture';
	}
	if (options.policy.kind !== 'noise-floor-report') {
		throw new Error(
			'Cross-build comparison requires a verified '
				+ 'content-addressed noise-floor report; raw '
				+ 'or zero-noise policies cannot select a winner.'
		);
	}
	return 'comparison';
}

async function prepareRuntimeTournamentDryRunInternal(
	options: RuntimeTournamentDryRunOptions,
	sealedOutput?: RuntimeTournamentDryRunReport['output']
): Promise<PreparedRuntimeTournamentDryRun> {
	assertRuntimeLabIdentifier(
		options.tournamentId,
		'tournamentId'
	);
	assertRuntimeLabIdentifier(options.seed, 'seed');
	if (
		!Array.isArray(options.candidateManifestPaths)
		|| options.candidateManifestPaths.length < 2
		|| options.candidateManifestPaths.length > 16
	) {
		throw new RangeError(
			'candidateManifestPaths must contain from 2 through 16 manifests.'
		);
	}
	const minimumPairedBlocks = validateBoundedInteger(
		options.minimumPairedBlocks
			?? RUNTIME_TOURNAMENT_MINIMUM_BLOCKS,
		'minimumPairedBlocks',
		RUNTIME_TOURNAMENT_MINIMUM_BLOCKS,
		1_000
	);
	const requestedBlockCount = validateBoundedInteger(
		options.requestedBlockCount
			?? RUNTIME_TOURNAMENT_MINIMUM_BLOCKS,
		'requestedBlockCount',
		minimumPairedBlocks,
		10_000
	);
	const executionControls: RuntimeTournamentExecutionControls = {
		quietBaselineMs: validateBoundedInteger(
			options.quietBaselineMs ?? 30_000,
			'quietBaselineMs',
			0,
			300_000
		),
		startupTimeoutMs: validateBoundedInteger(
			options.startupTimeoutMs ?? 15_000,
			'startupTimeoutMs',
			1_000,
			120_000
		),
		warmupRunsPerCandidate: validateBoundedInteger(
			options.warmupRunsPerCandidate ?? 1,
			'warmupRunsPerCandidate',
			0,
			4
		)
	};
	const analysisControls: RuntimeTournamentAnalysisControls = {
		bootstrapIterations: validateBoundedInteger(
			options.bootstrapIterations
				?? RUNTIME_TOURNAMENT_BOOTSTRAP_ITERATIONS,
			'bootstrapIterations',
			1_000,
			100_000
		),
		confidenceLevel: validateBoundedNumber(
			options.confidenceLevel
				?? RUNTIME_TOURNAMENT_CONFIDENCE_LEVEL,
			'confidenceLevel',
			0.8,
			1
		),
		minimumPairedBlocks
	};
	const [
		candidates,
		scenario,
		etlRecorder,
		presentMon,
		metricPolicy,
		runtimeControllerAttestation,
		output
	] = await Promise.all([
		Promise.all(
			options.candidateManifestPaths.map(path =>
				resolveRuntimeCandidateManifest(path)
			)
		),
		resolveRuntimeLabScenario(
			options.scenarioManifestPath
		),
		verifyTool(
			options.etlRecorderPath,
			options.etlRecorderSha256,
			'ETL recorder'
		),
		verifyTool(
			options.presentMonPath,
			options.presentMonSha256,
			'PresentMon'
		),
		resolveRuntimeTournamentMetricPolicyFileWithProvenance(
			options.metricPolicyPath
		),
		attestRuntimeControllerSources(options.electronHostDirectory),
		sealedOutput === undefined
			? verifyOutputDestination({
				outputRootDirectory: options.outputRootDirectory,
				tournamentId: options.tournamentId
			})
			: Promise.resolve(sealedOutput)
	]);
	const {
		electronHost,
		inventory: controllerSourceInventory
	} = getRuntimeControllerAttestationIdentity(
		runtimeControllerAttestation
	);
	const candidateIds = candidates.map(
		candidate => candidate.manifest.id
	);
	if (new Set(candidateIds).size !== candidateIds.length) {
		throw new TypeError(
			'Candidate manifests must use unique IDs.'
		);
	}
	for (const candidate of candidates) {
		if (!candidate.manifest.capabilities.presentMon) {
			throw new Error(
				`Candidate ${candidate.manifest.id} does not declare PresentMon support.`
			);
		}
	}
	if (
		scenario.scenario.benchmarkMs
		> MAX_CONTROLLER_BENCHMARK_MS
	) {
		throw new Error(
			'The controller page currently bounds benchmarkMs '
				+ `to ${MAX_CONTROLLER_BENCHMARK_MS}.`
		);
	}
	validateCandidateExecutableNames(candidates);
	validateMetricCoverage(metricPolicy.metricPolicies);
	const candidateExecutableHashes = new Set(
		candidates.map(candidate => candidate.executableSha256)
	);
	const mode = classifyMode({
		candidates,
		policy: metricPolicy
	});
	await validateNoiseReportBaseline({
		candidateExecutableHashes,
		policy: metricPolicy
	});
	const schedule = buildRuntimeTournamentSchedule({
		candidateIds,
		requestedBlockCount,
		seed: options.seed
	});
	if (
		mode === 'same-build-noise-capture'
		&& schedule.schedule.design !== 'abba-baab'
	) {
		throw new Error(
			'Same-build noise capture requires an ABBA/BAAB schedule.'
		);
	}
	const plannedRuns = buildRuntimeTournamentPlannedRuns({
		schedule,
		tournamentId: options.tournamentId,
		warmupRunsPerCandidate:
			executionControls.warmupRunsPerCandidate
	});
	for (const candidate of candidates) {
		buildRuntimeLaunchPlan({
			candidate,
			electronHostDirectory: electronHost.directory,
			pageUrl:
				'http://127.0.0.1:49152/v1/pages/dry-run/placeholder.html',
			runDirectory: join(
				output.tournamentDirectory,
				'runs',
				`dry-run-${candidate.manifest.id}`
			),
			scenario: scenario.scenario,
			sourceEnvironment: {}
		});
	}
	const reportWithoutHash: Omit<
		RuntimeTournamentDryRunReport,
		'reportSha256'
	> = {
		analysisControls,
		candidateIds,
		candidates: candidates.map(candidate => ({
			executableName: basename(candidate.executablePath),
			executablePath: candidate.executablePath,
			executableSha256: candidate.executableSha256,
			executableSizeBytes: candidate.executableSizeBytes,
			id: candidate.manifest.id,
			manifestPath: candidate.manifestPath,
			manifestSha256: candidate.manifestSha256,
			runtimeKind: candidate.manifest.runtimeKind
		})),
		controllerSourceInventoryVersion:
			controllerSourceInventory.version,
		controllerSources: controllerSourceInventory.sources,
		electronHost,
		etlRecorder,
		executionControls,
		isolation: {
			activeProcessCollisionCheck:
				'deferred to immediately before each launch',
			alternateImageChildEgressGapEliminated: true,
			browserNetworkControls:
				'loopback-only proxy and resolver controls',
			firewallScope:
				'run-scoped all-program non-loopback block',
			requiredMeasurementEnvironment:
				'idle isolated Windows environment'
		},
		metricPolicy: {
			filePath: metricPolicy.filePath,
			fileSha256: metricPolicy.fileSha256,
			kind: metricPolicy.kind,
			metricPolicies: metricPolicy.metricPolicies,
			...(metricPolicy.reportSha256 === undefined
				? {}
				: {
					reportSha256:
						metricPolicy.reportSha256
				})
		},
		mode,
		operationsPerformed: {
			candidateLaunched: false,
			etlRecorderLaunched: false,
			firewallRuleInstalled: false,
			presentMonLaunched: false
		},
		output,
		plannedRuns,
		plannedRunsSha256: sha256Hex(
			canonicalJson(plannedRuns)
		),
		presentMon,
		ready: true as const,
		scenario: {
			id: scenario.scenario.id,
			manifestPath: scenario.manifestPath,
			manifestSha256: scenario.manifestSha256
		},
		schedule,
		seed: options.seed,
		tournamentId: options.tournamentId,
		version: RUNTIME_TOURNAMENT_DRY_RUN_VERSION
	};
	return {
		report: {
			...reportWithoutHash,
			reportSha256: sha256Hex(
				canonicalJson(reportWithoutHash)
			)
		},
		runtimeControllerAttestation
	};
}

export async function prepareRuntimeTournamentDryRun(
	options: RuntimeTournamentDryRunOptions
): Promise<RuntimeTournamentDryRunReport> {
	return (
		await prepareRuntimeTournamentDryRunInternal(options)
	).report;
}

function expectRecord(
	value: unknown,
	label: string
): Record<string, unknown> {
	if (
		value === null
		|| typeof value !== 'object'
		|| Array.isArray(value)
	) {
		throw new TypeError(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function expectExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
	label: string
): void {
	const expected = new Set(keys);
	for (const key of Object.keys(value)) {
		if (!expected.has(key)) {
			throw new TypeError(`${label}.${key} is not supported.`);
		}
	}
	for (const key of keys) {
		if (!(key in value)) {
			throw new TypeError(`${label}.${key} is required.`);
		}
	}
}

function expectString(
	value: unknown,
	label: string
): string {
	if (
		typeof value !== 'string'
		|| value.length < 1
		|| value.length > 4_096
		|| value.includes('\0')
	) {
		throw new TypeError(`${label} must be a bounded string.`);
	}
	return value;
}

function expectNumber(
	value: unknown,
	label: string
): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new TypeError(`${label} must be a finite number.`);
	}
	return value;
}

export async function resolveRuntimeTournamentDryRunReport(
	path: string,
	options: RuntimeTournamentDryRunResolveOptions = {}
): Promise<ResolvedRuntimeTournamentDryRunReport> {
	const reportPath = await realpath(resolve(path));
	const metadata = await stat(reportPath);
	if (!metadata.isFile()) {
		throw new TypeError(
			'Dry-run report path must resolve to a regular file.'
		);
	}
	const reportBytes = await readFile(reportPath);
	let parsed: unknown;
	try {
		parsed = JSON.parse(reportBytes.toString('utf8'));
	} catch (error) {
		throw new TypeError(
			'Dry-run report is not valid JSON: '
				+ (
					error instanceof Error
						? error.message
						: String(error)
				)
		);
	}
	const root = expectRecord(parsed, 'dry-run report');
	expectExactKeys(
		root,
		[
			'analysisControls',
			'candidateIds',
			'candidates',
			'controllerSourceInventoryVersion',
			'controllerSources',
			'electronHost',
			'etlRecorder',
			'executionControls',
			'isolation',
			'metricPolicy',
			'mode',
			'operationsPerformed',
			'output',
			'plannedRuns',
			'plannedRunsSha256',
			'presentMon',
			'ready',
			'reportSha256',
			'scenario',
			'schedule',
			'seed',
			'tournamentId',
			'version'
		],
		'dry-run report'
	);
	if (root.version !== RUNTIME_TOURNAMENT_DRY_RUN_VERSION) {
		throw new TypeError(
			`Dry-run report version must be ${RUNTIME_TOURNAMENT_DRY_RUN_VERSION}.`
		);
	}
	if (root.ready !== true) {
		throw new TypeError('Dry-run report must be ready.');
	}
	const reportSha256 = expectString(
		root.reportSha256,
		'dry-run report.reportSha256'
	);
	if (!SHA256_PATTERN.test(reportSha256)) {
		throw new TypeError(
			'Dry-run report SHA-256 must be a lowercase digest.'
		);
	}
	if (basename(reportPath) !== `${reportSha256}.json`) {
		throw new Error(
			'Dry-run report filename must match its content address.'
		);
	}
	const {
		reportSha256: _reportSha256,
		...withoutHash
	} = root;
	if (sha256Hex(canonicalJson(withoutHash)) !== reportSha256) {
		throw new Error(
			'Dry-run report SHA-256 does not match its canonical contents.'
		);
	}
	const operations = expectRecord(
		root.operationsPerformed,
		'dry-run report.operationsPerformed'
	);
	expectExactKeys(
		operations,
		[
			'candidateLaunched',
			'etlRecorderLaunched',
			'firewallRuleInstalled',
			'presentMonLaunched'
		],
		'dry-run report.operationsPerformed'
	);
	if (
		operations.candidateLaunched !== false
		|| operations.etlRecorderLaunched !== false
		|| operations.firewallRuleInstalled !== false
		|| operations.presentMonLaunched !== false
	) {
		throw new Error(
			'Dry-run report cannot attest preparation after launch operations.'
		);
	}
	if (!Array.isArray(root.candidates)) {
		throw new TypeError('Dry-run report candidates must be an array.');
	}
	const candidateManifestPaths = root.candidates.map(
		(candidate, index) => expectString(
			expectRecord(
				candidate,
				`dry-run report.candidates[${index}]`
			).manifestPath,
			`dry-run report.candidates[${index}].manifestPath`
		)
	);
	const electronHost = expectRecord(
		root.electronHost,
		'dry-run report.electronHost'
	);
	const etlRecorder = expectRecord(
		root.etlRecorder,
		'dry-run report.etlRecorder'
	);
	const metricPolicy = expectRecord(
		root.metricPolicy,
		'dry-run report.metricPolicy'
	);
	const output = expectRecord(
		root.output,
		'dry-run report.output'
	);
	expectExactKeys(
		output,
		[
			'existingWritableAncestor',
			'outputRootDirectory',
			'tournamentDirectory',
			'tournamentDirectoryExisted'
		],
		'dry-run report.output'
	);
	if (output.tournamentDirectoryExisted !== false) {
		throw new TypeError(
			'Dry-run report output must attest that the tournament directory did not exist.'
		);
	}
	const sealedOutput: RuntimeTournamentDryRunReport['output'] = {
		existingWritableAncestor: expectString(
			output.existingWritableAncestor,
			'dry-run report.output.existingWritableAncestor'
		),
		outputRootDirectory: expectString(
			output.outputRootDirectory,
			'dry-run report.output.outputRootDirectory'
		),
		tournamentDirectory: expectString(
			output.tournamentDirectory,
			'dry-run report.output.tournamentDirectory'
		),
		tournamentDirectoryExisted: false
	};
	if (
		resolve(sealedOutput.outputRootDirectory)
		!== sealedOutput.outputRootDirectory
		|| join(
			sealedOutput.outputRootDirectory,
			expectString(root.tournamentId, 'dry-run report.tournamentId')
		) !== sealedOutput.tournamentDirectory
	) {
		throw new Error(
			'Dry-run report output paths are not canonical or internally consistent.'
		);
	}
	if (options.completedTournamentDirectory !== undefined) {
		const completedTournamentDirectory = await realpath(
			resolve(options.completedTournamentDirectory)
		);
		const completedMetadata = await stat(
			completedTournamentDirectory
		);
		if (!completedMetadata.isDirectory()) {
			throw new TypeError(
				'Completed tournament path must resolve to a directory.'
			);
		}
		if (
			await realpath(sealedOutput.tournamentDirectory)
			!== completedTournamentDirectory
		) {
			throw new Error(
				'Dry-run report does not identify the completed tournament directory.'
			);
		}
		const ancestor = await realpath(
			sealedOutput.existingWritableAncestor
		);
		const ancestorMetadata = await stat(ancestor);
		if (!ancestorMetadata.isDirectory()) {
			throw new TypeError(
				'Dry-run writable ancestor is no longer a directory.'
			);
		}
		const relativeOutput = relative(
			ancestor,
			sealedOutput.outputRootDirectory
		);
		if (
			relativeOutput.startsWith('..')
			|| isAbsolute(relativeOutput)
		) {
			throw new Error(
				'Dry-run writable ancestor does not contain the tournament output root.'
			);
		}
	}
	const presentMon = expectRecord(
		root.presentMon,
		'dry-run report.presentMon'
	);
	const scenario = expectRecord(
		root.scenario,
		'dry-run report.scenario'
	);
	const executionControls = expectRecord(
		root.executionControls,
		'dry-run report.executionControls'
	);
	const analysisControls = expectRecord(
		root.analysisControls,
		'dry-run report.analysisControls'
	);
	const schedule = expectRecord(
		root.schedule,
		'dry-run report.schedule'
	);
	const scheduleValue = expectRecord(
		schedule.schedule,
		'dry-run report.schedule.schedule'
	);
	const scheduleSha256 = expectString(
		schedule.scheduleSha256,
		'dry-run report.schedule.scheduleSha256'
	);
	if (
		!SHA256_PATTERN.test(scheduleSha256)
		|| sha256Hex(canonicalJson(scheduleValue))
			!== scheduleSha256
	) {
		throw new Error(
			'Dry-run schedule SHA-256 does not match its canonical contents.'
		);
	}
	if (!Array.isArray(root.plannedRuns)) {
		throw new TypeError(
			'Dry-run report plannedRuns must be an array.'
		);
	}
	const plannedRunsSha256 = expectString(
		root.plannedRunsSha256,
		'dry-run report.plannedRunsSha256'
	);
	if (
		!SHA256_PATTERN.test(plannedRunsSha256)
		|| sha256Hex(canonicalJson(root.plannedRuns))
			!== plannedRunsSha256
	) {
		throw new Error(
			'Dry-run plan SHA-256 does not match its canonical contents.'
		);
	}
	const relativeReportPath = relative(
		expectString(
			output.tournamentDirectory,
			'dry-run report.output.tournamentDirectory'
		),
		reportPath
	);
	if (
		relativeReportPath === ''
		|| (
			!relativeReportPath.startsWith('..')
			&& !isAbsolute(relativeReportPath)
		)
	) {
		throw new Error(
			'Dry-run report cannot be stored inside the future tournament directory.'
		);
	}
	const prepared = await prepareRuntimeTournamentDryRunInternal({
		bootstrapIterations: expectNumber(
			analysisControls.bootstrapIterations,
			'dry-run report.analysisControls.bootstrapIterations'
		),
		candidateManifestPaths,
		confidenceLevel: expectNumber(
			analysisControls.confidenceLevel,
			'dry-run report.analysisControls.confidenceLevel'
		),
		electronHostDirectory: expectString(
			electronHost.directory,
			'dry-run report.electronHost.directory'
		),
		etlRecorderPath: expectString(
			etlRecorder.path,
			'dry-run report.etlRecorder.path'
		),
		etlRecorderSha256: expectString(
			etlRecorder.sha256,
			'dry-run report.etlRecorder.sha256'
		),
		metricPolicyPath: expectString(
			metricPolicy.filePath,
			'dry-run report.metricPolicy.filePath'
		),
		minimumPairedBlocks: expectNumber(
			analysisControls.minimumPairedBlocks,
			'dry-run report.analysisControls.minimumPairedBlocks'
		),
		outputRootDirectory: expectString(
			output.outputRootDirectory,
			'dry-run report.output.outputRootDirectory'
		),
		presentMonPath: expectString(
			presentMon.path,
			'dry-run report.presentMon.path'
		),
		presentMonSha256: expectString(
			presentMon.sha256,
			'dry-run report.presentMon.sha256'
		),
		quietBaselineMs: expectNumber(
			executionControls.quietBaselineMs,
			'dry-run report.executionControls.quietBaselineMs'
		),
		requestedBlockCount: expectNumber(
			scheduleValue.requestedBlockCount,
			'dry-run report.schedule.schedule.requestedBlockCount'
		),
		scenarioManifestPath: expectString(
			scenario.manifestPath,
			'dry-run report.scenario.manifestPath'
		),
		seed: expectString(root.seed, 'dry-run report.seed'),
		startupTimeoutMs: expectNumber(
			executionControls.startupTimeoutMs,
			'dry-run report.executionControls.startupTimeoutMs'
		),
		tournamentId: expectString(
			root.tournamentId,
			'dry-run report.tournamentId'
		),
		warmupRunsPerCandidate: expectNumber(
			executionControls.warmupRunsPerCandidate,
			'dry-run report.executionControls.warmupRunsPerCandidate'
		)
	}, options.completedTournamentDirectory === undefined
		? undefined
		: sealedOutput);
	if (canonicalJson(prepared.report) !== canonicalJson(root)) {
		throw new Error(
			'Dry-run report does not match the current attested tournament preparation.'
		);
	}
	return {
		report: prepared.report,
		reportBytes,
		reportPath,
		runtimeControllerAttestation:
			prepared.runtimeControllerAttestation
	};
}

export async function writeRuntimeTournamentDryRunReport(
	report: RuntimeTournamentDryRunReport,
	outputDirectory: string
): Promise<string> {
	const {
		reportSha256,
		...withoutHash
	} = report;
	if (
		!SHA256_PATTERN.test(reportSha256)
		|| sha256Hex(canonicalJson(withoutHash))
			!== reportSha256
	) {
		throw new Error(
			'Dry-run report SHA-256 does not match its canonical contents.'
		);
	}
	const resolvedOutputDirectory = resolve(outputDirectory);
	const relativeToTournament = relative(
		report.output.tournamentDirectory,
		resolvedOutputDirectory
	);
	if (
		relativeToTournament === ''
		|| (
			!relativeToTournament.startsWith('..')
			&& !isAbsolute(relativeToTournament)
		)
	) {
		throw new Error(
			'Dry-run report output cannot reserve or write '
				+ 'inside the future tournament directory.'
		);
	}
	await mkdir(resolvedOutputDirectory, { recursive: true });
	const outputPath = join(
		resolvedOutputDirectory,
		`${reportSha256}.json`
	);
	const reportBytes = Buffer.from(
		`${JSON.stringify(report, null, '\t')}\n`,
		'utf8'
	);
	await writeFile(
		outputPath,
		reportBytes,
		{ flag: 'wx' }
	);
	if (!(await readFile(outputPath)).equals(reportBytes)) {
		throw new Error(
			'Dry-run report bytes changed immediately after the exclusive write.'
		);
	}
	return outputPath;
}
