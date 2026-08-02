import {
	isAbsolute,
	join,
	resolve
} from 'node:path';
import {
	prepareRuntimeTournamentDryRun,
	writeRuntimeTournamentDryRunReport
} from '../src/controller/tournament-dry-run.ts';

const REPEATABLE_OPTIONS = new Set([
	'candidate'
]);
const VALUE_OPTIONS = new Set([
	'blocks',
	'bootstrap-iterations',
	'candidate',
	'confidence-level',
	'etl-recorder',
	'etl-recorder-sha256',
	'metric-policy',
	'minimum-paired-blocks',
	'output-root',
	'presentmon',
	'presentmon-sha256',
	'quiet-baseline-ms',
	'report-output',
	'scenario',
	'seed',
	'startup-timeout-ms',
	'tournament-id',
	'warmup-runs'
]);

function parseArguments(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith('--')) {
			throw new TypeError(
				`Unexpected argument: ${argument}`
			);
		}
		const name = argument.slice(2);
		if (!VALUE_OPTIONS.has(name)) {
			throw new TypeError(
				`Unknown option: --${name}`
			);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) {
			throw new TypeError(
				`Missing value for --${name}.`
			);
		}
		if (REPEATABLE_OPTIONS.has(name)) {
			const existing = values.get(name) ?? [];
			existing.push(value);
			values.set(name, existing);
		} else {
			if (values.has(name)) {
				throw new TypeError(
					`Duplicate option: --${name}`
				);
			}
			values.set(name, value);
		}
		index += 1;
	}
	return values;
}

function requiredString(values, name) {
	const value = values.get(name);
	if (typeof value !== 'string' || value.length === 0) {
		throw new TypeError(`--${name} is required.`);
	}
	return value;
}

function requiredStrings(values, name, minimum, maximum) {
	const entries = values.get(name);
	if (
		!Array.isArray(entries)
		|| entries.length < minimum
		|| entries.length > maximum
	) {
		throw new TypeError(
			`--${name} must be repeated from ${minimum} `
				+ `through ${maximum} times.`
		);
	}
	return entries;
}

function optionalInteger(
	values,
	name,
	minimum,
	maximum
) {
	const raw = values.get(name);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (
		!Number.isInteger(value)
		|| value < minimum
		|| value > maximum
	) {
		throw new TypeError(
			`--${name} must be an integer from `
				+ `${minimum} through ${maximum}.`
		);
	}
	return value;
}

function optionalNumberBelow(
	values,
	name,
	minimum,
	maximumExclusive
) {
	const raw = values.get(name);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (
		!Number.isFinite(value)
		|| value < minimum
		|| value >= maximumExclusive
	) {
		throw new TypeError(
			`--${name} must be a number from `
				+ `${minimum} up to but not including `
				+ `${maximumExclusive}.`
		);
	}
	return value;
}

function absoluteFromRepository(repositoryRoot, value) {
	return isAbsolute(value)
		? value
		: resolve(repositoryRoot, value);
}

const repositoryRoot = join(
	import.meta.dirname,
	'..',
	'..',
	'..'
);
const values = parseArguments(process.argv.slice(2));
const candidateManifestPaths = requiredStrings(
	values,
	'candidate',
	2,
	16
).map(value =>
	absoluteFromRepository(repositoryRoot, value));
const bootstrapIterations = optionalInteger(
	values,
	'bootstrap-iterations',
	1_000,
	100_000
);
const confidenceLevel = optionalNumberBelow(
	values,
	'confidence-level',
	0.8,
	1
);
const minimumPairedBlocks = optionalInteger(
	values,
	'minimum-paired-blocks',
	7,
	1_000
);
const requestedBlockCount = optionalInteger(
	values,
	'blocks',
	minimumPairedBlocks ?? 7,
	10_000
);
const quietBaselineMs = optionalInteger(
	values,
	'quiet-baseline-ms',
	0,
	300_000
);
const startupTimeoutMs = optionalInteger(
	values,
	'startup-timeout-ms',
	1_000,
	120_000
);
const warmupRunsPerCandidate = optionalInteger(
	values,
	'warmup-runs',
	0,
	4
);

try {
	const report = await prepareRuntimeTournamentDryRun({
		...(bootstrapIterations === undefined
			? {}
			: { bootstrapIterations }),
		candidateManifestPaths,
		...(confidenceLevel === undefined
			? {}
			: { confidenceLevel }),
		electronHostDirectory: join(
			repositoryRoot,
			'lab',
			'offline-runtime',
			'hosts',
			'electron'
		),
		etlRecorderPath: absoluteFromRepository(
			repositoryRoot,
			requiredString(values, 'etl-recorder')
		),
		etlRecorderSha256: requiredString(
			values,
			'etl-recorder-sha256'
		),
		metricPolicyPath: absoluteFromRepository(
			repositoryRoot,
			requiredString(values, 'metric-policy')
		),
		...(minimumPairedBlocks === undefined
			? {}
			: { minimumPairedBlocks }),
		outputRootDirectory: absoluteFromRepository(
			repositoryRoot,
			values.get('output-root')
				?? join(
					'.working',
					'runtime-lab',
					'tournaments'
				)
		),
		presentMonPath: absoluteFromRepository(
			repositoryRoot,
			requiredString(values, 'presentmon')
		),
		presentMonSha256: requiredString(
			values,
			'presentmon-sha256'
		),
		...(quietBaselineMs === undefined
			? {}
			: { quietBaselineMs }),
		...(requestedBlockCount === undefined
			? {}
			: { requestedBlockCount }),
		scenarioManifestPath: absoluteFromRepository(
			repositoryRoot,
			requiredString(values, 'scenario')
		),
		seed: requiredString(values, 'seed'),
		...(startupTimeoutMs === undefined
			? {}
			: { startupTimeoutMs }),
		tournamentId: requiredString(
			values,
			'tournament-id'
		),
		...(warmupRunsPerCandidate === undefined
			? {}
			: { warmupRunsPerCandidate })
	});
	const reportPath =
		await writeRuntimeTournamentDryRunReport(
			report,
			absoluteFromRepository(
				repositoryRoot,
				values.get('report-output')
					?? join(
						'.working',
						'runtime-lab',
						'preparations'
					)
			)
		);
	console.log(
		'WOK_RUNTIME_TOURNAMENT_DRY_RUN '
			+ JSON.stringify({
				mode: report.mode,
				plannedRunCount: report.plannedRuns.length,
				ready: report.ready,
				reportPath,
				reportSha256: report.reportSha256,
				tournamentDirectory:
					report.output.tournamentDirectory
			})
	);
} catch (error) {
	console.error(
		error instanceof Error
			? error.stack ?? error.message
			: String(error)
	);
	process.exitCode = 1;
}
