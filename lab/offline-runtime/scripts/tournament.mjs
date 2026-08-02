import {
	isAbsolute,
	join,
	resolve
} from 'node:path';
import {
	runRuntimeTournament
} from '../src/controller/tournament-controller.ts';

const BOOLEAN_OPTIONS = new Set([
	'confirm-idle-system'
]);
const VALUE_OPTIONS = new Set([
	'dry-run-report'
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
		if (BOOLEAN_OPTIONS.has(name)) {
			if (values.has(name)) {
				throw new TypeError(
					`Duplicate option: --${name}`
				);
			}
			values.set(name, true);
			continue;
		}
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
const abortController = new AbortController();
let receivedSignal;
const abortForSignal = signal => {
	if (receivedSignal) return;
	receivedSignal = signal;
	abortController.abort(
		new Error(
			`Runtime tournament interrupted by ${signal}.`
		)
	);
};
const onSigint = () => abortForSignal('SIGINT');
const onSigterm = () => abortForSignal('SIGTERM');
process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);

try {
	const result = await runRuntimeTournament({
		confirmIdleSystem:
			values.get('confirm-idle-system') === true,
		dryRunReportPath: absoluteFromRepository(
			repositoryRoot,
			requiredString(values, 'dry-run-report')
		),
		signal: abortController.signal
	});
	console.log(
		'WOK_RUNTIME_TOURNAMENT_RESULT '
			+ JSON.stringify({
				analyses: result.analyses.map(entry => ({
					baselineCandidateId:
						entry.baselineCandidateId,
					challengerCandidateId:
						entry.challengerCandidateId,
					decision:
						entry.analysis?.decision
						?? 'unavailable',
					metricId: entry.metricId
				})),
				dryRunReportSha256:
					result.dryRunReport.reportSha256,
				fatalError: result.fatalError,
				resultSha256: result.resultSha256,
				tournamentDirectory:
					result.tournamentDirectory,
				tournamentId: result.tournamentId,
				valid: result.valid
			})
	);
	if (receivedSignal) process.exitCode = 130;
	else if (!result.valid) process.exitCode = 2;
} catch (error) {
	console.error(
		error instanceof Error
			? error.stack ?? error.message
			: String(error)
	);
	process.exitCode = receivedSignal ? 130 : 1;
} finally {
	process.removeListener('SIGINT', onSigint);
	process.removeListener('SIGTERM', onSigterm);
}
