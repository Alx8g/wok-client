import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const MARK_LINE = /\[wok-mark\]\s+(\S{1,64})\s+(-?\d+(?:\.\d+)?)\s*$/;
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
function median(sortedValues) {
	const middle = Math.floor(sortedValues.length / 2);
	return sortedValues.length % 2 === 1 ? sortedValues[middle] : (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}
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
