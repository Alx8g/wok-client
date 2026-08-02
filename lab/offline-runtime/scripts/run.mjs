import { isAbsolute, join, resolve } from 'node:path';
import { runRuntimeLabSingleRun } from '../src/controller/single-run.ts';

const BOOLEAN_OPTIONS = new Set(['confirm-idle-system']);
const VALUE_OPTIONS = new Set([
	'candidate',
	'etl-recorder',
	'etl-recorder-sha256',
	'output-root',
	'presentmon',
	'presentmon-sha256',
	'run-id',
	'scenario',
	'startup-timeout-ms'
]);

function parseArguments(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (!argument.startsWith('--')) throw new TypeError(`Unexpected argument: ${argument}`);
		const name = argument.slice(2);
		if (BOOLEAN_OPTIONS.has(name)) {
			if (values.has(name)) throw new TypeError(`Duplicate option: --${name}`);
			values.set(name, true);
			continue;
		}
		if (!VALUE_OPTIONS.has(name)) throw new TypeError(`Unknown option: --${name}`);
		if (values.has(name)) throw new TypeError(`Duplicate option: --${name}`);
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) throw new TypeError(`Missing value for --${name}.`);
		values.set(name, value);
		index++;
	}
	return values;
}

function requiredString(values, name) {
	const value = values.get(name);
	if (typeof value !== 'string' || value.length === 0) throw new TypeError(`--${name} is required.`);
	return value;
}

function optionalInteger(values, name, minimum, maximum) {
	const raw = values.get(name);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new TypeError(`--${name} must be an integer from ${minimum} through ${maximum}.`);
	}
	return value;
}

function absoluteFromRepository(repositoryRoot, value) {
	return isAbsolute(value) ? value : resolve(repositoryRoot, value);
}

const repositoryRoot = join(import.meta.dirname, '..', '..', '..');
const values = parseArguments(process.argv.slice(2));
const candidateManifestPath = absoluteFromRepository(repositoryRoot, requiredString(values, 'candidate'));
const scenarioManifestPath = absoluteFromRepository(repositoryRoot, requiredString(values, 'scenario'));
const etlRecorderPath = absoluteFromRepository(repositoryRoot, requiredString(values, 'etl-recorder'));
const presentMonPath = absoluteFromRepository(repositoryRoot, requiredString(values, 'presentmon'));
const outputRootDirectory = absoluteFromRepository(
	repositoryRoot,
	values.get('output-root') ?? join('.working', 'runtime-lab', 'runs')
);
const startupTimeoutMs = optionalInteger(values, 'startup-timeout-ms', 1_000, 120_000);
const abortController = new AbortController();
let receivedSignal;
const abortForSignal = signal => {
	if (receivedSignal) return;
	receivedSignal = signal;
	abortController.abort(new Error(`Runtime Lab interrupted by ${signal}.`));
};
const onSigint = () => abortForSignal('SIGINT');
const onSigterm = () => abortForSignal('SIGTERM');
process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);

try {
	const result = await runRuntimeLabSingleRun({
		candidateManifestPath,
		confirmIdleSystem: values.get('confirm-idle-system') === true,
		electronHostDirectory: join(repositoryRoot, 'lab', 'offline-runtime', 'hosts', 'electron'),
		etlRecorderPath,
		etlRecorderSha256: requiredString(values, 'etl-recorder-sha256'),
		outputRootDirectory,
		presentMonPath,
		presentMonSha256: requiredString(values, 'presentmon-sha256'),
		...(typeof values.get('run-id') === 'string' ? { runId: values.get('run-id') } : {}),
		scenarioManifestPath,
		signal: abortController.signal,
		...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs })
	});
	console.log(`WOK_RUNTIME_LAB_CONTROLLER_RESULT ${JSON.stringify({
		artifactManifestPath: result.artifactManifestPath,
		failures: result.failures,
		presentingProcessId: result.presentingProcessId,
		runDirectory: result.runDirectory,
		runId: result.runId,
		valid: result.valid,
		violations: result.violations
	})}`);
	if (receivedSignal) process.exitCode = 130;
	else if (!result.valid) process.exitCode = 2;
} catch (error) {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = receivedSignal ? 130 : 1;
} finally {
	process.removeListener('SIGINT', onSigint);
	process.removeListener('SIGTERM', onSigterm);
}
