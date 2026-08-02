import { isAbsolute, join, resolve } from 'node:path';
import {
	deriveRuntimeTournamentNoiseFloorFile
} from '../src/controller/tournament-noise-floor.ts';
import {
	RUNTIME_TOURNAMENT_MINIMUM_BLOCKS
} from '../src/controller/tournament-schedule.ts';

const VALUE_OPTIONS = new Set([
	'input',
	'minimum-blocks',
	'output',
	'percentile'
]);

function parseArguments(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index++) {
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
		if (values.has(name)) {
			throw new TypeError(
				`Duplicate option: --${name}`
			);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) {
			throw new TypeError(
				`Missing value for --${name}.`
			);
		}
		values.set(name, value);
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

function optionalNumber(
	values,
	name,
	minimum,
	maximum
) {
	const raw = values.get(name);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (
		!Number.isFinite(value)
		|| value < minimum
		|| value > maximum
	) {
		throw new TypeError(
			`--${name} must be a number from `
				+ `${minimum} through ${maximum}.`
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
const minimumPairedBlocks = optionalInteger(
	values,
	'minimum-blocks',
	RUNTIME_TOURNAMENT_MINIMUM_BLOCKS,
	1_000
);
const percentile = optionalNumber(
	values,
	'percentile',
	0.5,
	1
);

try {
	const report =
		await deriveRuntimeTournamentNoiseFloorFile({
			...(minimumPairedBlocks === undefined
				? {}
				: { minimumPairedBlocks }),
			outputPath: absoluteFromRepository(
				repositoryRoot,
				requiredString(values, 'output')
			),
			...(percentile === undefined
				? {}
				: { percentile }),
			tournamentResultPath: absoluteFromRepository(
				repositoryRoot,
				requiredString(values, 'input')
			)
		});
	console.log(
		'WOK_RUNTIME_NOISE_FLOOR_RESULT '
			+ JSON.stringify({
				executableSha256:
					report.executableSha256,
				metricPolicies: report.metricPolicies,
				reportSha256: report.reportSha256,
				tournamentId: report.tournamentId
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
