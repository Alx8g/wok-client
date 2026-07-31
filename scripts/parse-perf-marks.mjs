// Parses WOK_PERF_MARKS diagnostic output and emits per-mark medians as JSON.
//
// The app, launched with WOK_PERF_MARKS=1 (and typically WOK_PERF_EXIT_MS so it quits
// itself shortly after load), prints lines of the form:
//   [wok-mark] <name> <milliseconds-since-process-start>
// Concatenate the stdout of any number of runs into one log file, then:
//   node scripts/parse-perf-marks.mjs <log-file>
// prints {"marks":{"<name>":{"count":n,"medianMs":x,"minMs":x,"maxMs":x}}} on stdout.
//
// Parsing never launches anything; parsePerfMarks is exported for unit tests. The CLI
// exits with code 2 when the log contains no marks so a future CI consumer can flag a
// broken capture without treating malformed lines as fatal.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MARK_LINE = /\[wok-mark\]\s+(\S{1,64})\s+(-?\d+(?:\.\d+)?)\s*$/;

/**
 * @param {string} text Concatenated stdout of one or more WOK_PERF_MARKS runs.
 * @returns {{ marks: Record<string, { count: number, medianMs: number, minMs: number, maxMs: number }> }}
 */
export function parsePerfMarks(text) {
	const samples = new Map();
	for (const line of String(text).split(/\r?\n/)) {
		const match = MARK_LINE.exec(line);
		if (!match) continue;
		const value = Number.parseFloat(match[2]);
		if (!Number.isFinite(value)) continue;
		const values = samples.get(match[1]) ?? [];
		values.push(value);
		samples.set(match[1], values);
	}

	const marks = {};
	for (const [name, values] of samples) {
		values.sort((a, b) => a - b);
		marks[name] = {
			count: values.length,
			medianMs: roundMs(median(values)),
			minMs: roundMs(values[0]),
			maxMs: roundMs(values[values.length - 1])
		};
	}
	return { marks };
}

/** @param {number[]} sortedValues */
function median(sortedValues) {
	const middle = Math.floor(sortedValues.length / 2);
	return sortedValues.length % 2 === 1
		? sortedValues[middle]
		: (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}

/** @param {number} value */
function roundMs(value) {
	return Math.round(value * 10) / 10;
}

function runCli() {
	const [logPath] = process.argv.slice(2);
	if (!logPath) {
		console.error('Usage: node scripts/parse-perf-marks.mjs <log-file>');
		process.exit(1);
	}

	let text;
	try {
		text = readFileSync(logPath, 'utf-8');
	} catch (error) {
		console.error(`Failed to read ${logPath}: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}

	const summary = parsePerfMarks(text);
	console.log(JSON.stringify(summary, null, 2));
	if (Object.keys(summary.marks).length === 0) {
		console.error(`No [wok-mark] lines were found in ${logPath}; was WOK_PERF_MARKS=1 set?`);
		process.exitCode = 2;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
