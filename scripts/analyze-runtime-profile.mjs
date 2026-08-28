import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function finiteNumber(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value) {
	return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function callFrameFor(node) {
	const frame = node?.callFrame;
	if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return undefined;
	return {
		columnNumber: nonNegativeInteger(frame.columnNumber) ?? 0,
		functionName: typeof frame.functionName === 'string' && frame.functionName.length > 0 ? frame.functionName : '(anonymous)',
		lineNumber: nonNegativeInteger(frame.lineNumber) ?? 0,
		url: typeof frame.url === 'string' ? frame.url : ''
	};
}

function frameCategory(frame) {
	if (frame.functionName === '(idle)') return 'idle';
	if (frame.functionName === '(garbage collector)') return 'garbage-collector';
	if (frame.functionName === '(program)') return 'program';
	if (frame.url.includes('preload.') || frame.url.includes('/Wok/') || frame.url.includes('wok-client')) return 'wok';
	if (frame.url.startsWith('node:') || frame.url.startsWith('electron:')) return 'runtime';
	return 'page';
}

export function analyzeCpuProfile(profile, limit = 40) {
	if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('CPU profile must be an object.');
	if (!Array.isArray(profile.nodes) || !Array.isArray(profile.samples)) throw new Error('CPU profile must contain nodes and samples arrays.');
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Result limit must be an integer from 1 through 500.');

	const nodes = new Map();
	const parents = new Map();
	for (const node of profile.nodes) {
		const id = nonNegativeInteger(node?.id);
		const frame = callFrameFor(node);
		if (id === undefined || !frame) continue;
		nodes.set(id, { frame, id });
		if (Array.isArray(node.children)) {
			for (const child of node.children) {
				const childId = nonNegativeInteger(child);
				if (childId !== undefined) parents.set(childId, id);
			}
		}
	}
	if (nodes.size === 0) throw new Error('CPU profile contains no valid nodes.');

	const startTime = finiteNumber(profile.startTime);
	const endTime = finiteNumber(profile.endTime);
	const measuredDurationUs = startTime !== undefined && endTime !== undefined && endTime > startTime
		? endTime - startTime
		: undefined;
	const deltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas : [];
	const validDeltas = deltas.length === profile.samples.length && deltas.every(delta => finiteNumber(delta) !== undefined && delta >= 0);
	const fallbackSampleUs = measuredDurationUs !== undefined && profile.samples.length > 0
		? measuredDurationUs / profile.samples.length
		: 1_000;
	const byNode = new Map();
	const inclusiveByNode = new Map();
	let attributedUs = 0;
	let unattributedSamples = 0;

	for (let index = 0; index < profile.samples.length; index++) {
		const id = nonNegativeInteger(profile.samples[index]);
		const node = id === undefined ? undefined : nodes.get(id);
		if (!node) {
			unattributedSamples++;
			continue;
		}
		const sampleUs = validDeltas ? deltas[index] : fallbackSampleUs;
		const existing = byNode.get(id) ?? { node, samples: 0, selfUs: 0 };
		existing.samples++;
		existing.selfUs += sampleUs;
		byNode.set(id, existing);
		const visited = new Set();
		let ancestorId = id;
		while (nodes.has(ancestorId) && !visited.has(ancestorId)) {
			visited.add(ancestorId);
			inclusiveByNode.set(ancestorId, (inclusiveByNode.get(ancestorId) ?? 0) + sampleUs);
			const parentId = parents.get(ancestorId);
			if (parentId === undefined) break;
			ancestorId = parentId;
		}
		attributedUs += sampleUs;
	}

	const totalUs = measuredDurationUs ?? attributedUs;
	const entries = [...nodes.values()].map(node => {
		const self = byNode.get(node.id) ?? { samples: 0, selfUs: 0 };
		const inclusiveUs = inclusiveByNode.get(node.id) ?? 0;
		return {
			category: frameCategory(node.frame),
			column: node.frame.columnNumber + 1,
			functionName: node.frame.functionName,
			inclusiveMs: inclusiveUs / 1_000,
			inclusivePercent: totalUs > 0 ? 100 * inclusiveUs / totalUs : 0,
			line: node.frame.lineNumber + 1,
			nodeId: node.id,
			samples: self.samples,
			selfMs: self.selfUs / 1_000,
			selfPercent: totalUs > 0 ? 100 * self.selfUs / totalUs : 0,
			url: node.frame.url
		};
	});
	const topInclusive = entries
		.filter(entry => entry.functionName !== '(root)' && entry.inclusiveMs > 0)
		.sort((left, right) => right.inclusiveMs - left.inclusiveMs || right.selfMs - left.selfMs)
		.slice(0, limit);
	const topSelf = entries
		.filter(entry => entry.selfMs > 0)
		.sort((left, right) => right.selfMs - left.selfMs || right.samples - left.samples)
		.slice(0, limit);
	const categories = new Map();
	for (const entry of byNode.values()) {
		const category = frameCategory(entry.node.frame);
		categories.set(category, (categories.get(category) ?? 0) + entry.selfUs);
	}

	return {
		attributedMs: attributedUs / 1_000,
		categories: [...categories.entries()]
			.map(([category, selfUs]) => ({
				category,
				selfMs: selfUs / 1_000,
				selfPercent: totalUs > 0 ? 100 * selfUs / totalUs : 0
			}))
			.sort((left, right) => right.selfMs - left.selfMs),
		durationMs: totalUs / 1_000,
		sampleCount: profile.samples.length,
		top: topSelf,
		topInclusive,
		unattributedSamples,
		usedRecordedTimeDeltas: validDeltas
	};
}

function printableLocation(entry) {
	const source = entry.url || '<anonymous-script>';
	return `${source}:${entry.line}:${entry.column}`;
}

export function formatCpuProfileAnalysis(analysis) {
	const lines = [
		`Duration: ${analysis.durationMs.toFixed(1)} ms`,
		`Samples: ${analysis.sampleCount} (${analysis.unattributedSamples} unattributed)`,
		'',
		'Categories:'
	];
	for (const category of analysis.categories) {
		lines.push(`  ${category.category.padEnd(18)} ${category.selfMs.toFixed(1).padStart(9)} ms  ${category.selfPercent.toFixed(2).padStart(6)}%`);
	}
	lines.push('', 'Top inclusive time:');
	for (const entry of analysis.topInclusive) {
		lines.push(
			`${entry.inclusivePercent.toFixed(2).padStart(6)}%  ${entry.inclusiveMs.toFixed(1).padStart(9)} ms  ${entry.functionName}  ${printableLocation(entry)}`
		);
	}
	lines.push('', 'Top self-time:');
	for (const entry of analysis.top) {
		lines.push(
			`${entry.selfPercent.toFixed(2).padStart(6)}%  ${entry.selfMs.toFixed(1).padStart(9)} ms  ${entry.functionName}  ${printableLocation(entry)}`
		);
	}
	return `${lines.join('\n')}\n`;
}

function parseLimit(argumentsList) {
	const index = argumentsList.indexOf('--limit');
	if (index === -1) return 40;
	const value = Number.parseInt(argumentsList[index + 1] ?? '', 10);
	if (!Number.isInteger(value) || value < 1 || value > 500) throw new Error('--limit must be an integer from 1 through 500.');
	return value;
}

function parseProfilePath(argumentsList) {
	for (let index = 0; index < argumentsList.length; index++) {
		const argument = argumentsList[index];
		if (argument === '--limit') {
			index++;
			continue;
		}
		if (argument === '--json') continue;
		if (!argument.startsWith('--')) return argument;
	}
	return undefined;
}

async function main() {
	const argumentsList = process.argv.slice(2);
	const profilePath = parseProfilePath(argumentsList);
	if (!profilePath) throw new Error('Usage: node scripts/analyze-runtime-profile.mjs <renderer.cpuprofile> [--limit 40] [--json]');
	const profile = JSON.parse(await readFile(profilePath, 'utf-8'));
	const analysis = analyzeCpuProfile(profile, parseLimit(argumentsList));
	process.stdout.write(argumentsList.includes('--json') ? `${JSON.stringify(analysis, null, 2)}\n` : formatCpuProfileAnalysis(analysis));
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
