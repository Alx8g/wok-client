import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { buildCalibrationParityPage } from '../src/page/calibration-parity.ts';
import { startLoopbackServer } from '../src/host/loopback-server.ts';
import {
	RUNTIME_LAB_DEFAULT_BENCHMARK_MS,
	RUNTIME_LAB_DEFAULT_MIN_SAMPLES,
	RUNTIME_LAB_DEFAULT_TIMEOUT_MS
} from '../src/shared/protocol.ts';

function parseArguments(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (!argument.startsWith('--')) throw new TypeError(`Unexpected argument: ${argument}`);
		const name = argument.slice(2);
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) throw new TypeError(`Missing value for --${name}.`);
		values.set(name, value);
		index++;
	}
	return values;
}

function integerOption(values, name, fallback, minimum, maximum) {
	const raw = values.get(name);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < minimum || value > maximum) throw new TypeError(`--${name} must be an integer from ${minimum} to ${maximum}.`);
	return value;
}

const repositoryRoot = join(import.meta.dirname, '..', '..', '..');
const argumentsByName = parseArguments(process.argv.slice(2));
const allowedArguments = new Set(['benchmark-ms', 'candidate-id', 'input-mode', 'min-samples', 'output', 'port', 'run-id', 'timeout-ms', 'token']);
for (const name of argumentsByName.keys()) {
	if (!allowedArguments.has(name)) throw new TypeError(`Unknown option: --${name}`);
}

const benchmarkMs = integerOption(argumentsByName, 'benchmark-ms', RUNTIME_LAB_DEFAULT_BENCHMARK_MS, 1_000, 300_000);
const inputMode = argumentsByName.get('input-mode') ?? 'off';
if (inputMode !== 'off' && inputMode !== 'synthetic') throw new TypeError('--input-mode must be off or synthetic.');
const minSamples = integerOption(argumentsByName, 'min-samples', RUNTIME_LAB_DEFAULT_MIN_SAMPLES, 10, 100_000);
const timeoutMs = integerOption(argumentsByName, 'timeout-ms', Math.max(RUNTIME_LAB_DEFAULT_TIMEOUT_MS, benchmarkMs + 30_000), benchmarkMs + 1, 600_000);
const port = integerOption(argumentsByName, 'port', 0, 0, 65_535);
const runId = argumentsByName.get('run-id') ?? `tier1-${new Date().toISOString().replaceAll(/[^0-9]/gu, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`;
const candidateId = argumentsByName.get('candidate-id') ?? 'manual-candidate';
const outputArgument = argumentsByName.get('output') ?? join('.working', 'runtime-lab', 'runs', runId);
const outputDirectory = isAbsolute(outputArgument) ? outputArgument : resolve(repositoryRoot, outputArgument);
const markSvg = await readFile(join(repositoryRoot, 'assets', 'wok-mark.svg'), 'utf8');
const page = buildCalibrationParityPage(markSvg);

const server = await startLoopbackServer({
	benchmarkMs,
	candidateId,
	inputMode,
	minSamples,
	outputDirectory,
	page,
	port,
	runId,
	timeoutMs,
	...(argumentsByName.has('token') ? { token: argumentsByName.get('token') } : {})
});

console.log(`WOK_RUNTIME_LAB_READY ${JSON.stringify({
	benchmarkMs,
	candidateId,
	inputMode,
	minSamples,
	outputDirectory,
	pageSha256: page.sha256,
	pageUrl: server.pageUrl,
	port: server.port,
	runId,
	timeoutMs,
	workloadVersion: page.workloadVersion
})}`);

let signalReceived = false;
const stopForSignal = async signal => {
	if (signalReceived) return;
	signalReceived = true;
	console.error(`Runtime lab received ${signal}.`);
	try {
		await server.close();
	} finally {
		process.exitCode = 130;
	}
};
process.once('SIGINT', () => { void stopForSignal('SIGINT'); });
process.once('SIGTERM', () => { void stopForSignal('SIGTERM'); });

try {
	const completed = await server.completed;
	console.log(`WOK_RUNTIME_LAB_RESULT ${JSON.stringify({
		averageFps: completed.result.benchmark.averageFps,
		onePercentLowFps: completed.result.benchmark.onePercentLowFps,
		outputDirectory: completed.outputDirectory,
		p95FrameTimeMs: completed.result.benchmark.p95FrameTimeMs,
		rejected: completed.result.benchmark.rejected,
		success: completed.result.benchmark.success,
		valid: completed.valid,
		violations: completed.violations,
		worstFrameTimeMs: completed.result.benchmark.worstFrameTimeMs
	})}`);
	if (!completed.valid) process.exitCode = 2;
} catch (error) {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
} finally {
	await server.close();
}
