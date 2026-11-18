import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const baselineRef = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${process.argv[2] ?? 'origin/main'}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
mkdirSync(join(root, '.working/tmp'), { recursive: true });
const scratch = mkdtempSync(join(root, '.working/tmp/overhead-benchmark-'));
const modules = {};
for (const name of ['identity-rewrite', 'mutation-relevance']) {
	const baselinePath = join(scratch, `${name}.ts`);
	writeFileSync(baselinePath, execFileSync('git', ['show', `${baselineRef}:src/${name}.ts`], { cwd: root }));
	modules[name] = {
		baseline: await import(pathToFileURL(baselinePath)),
		candidate: await import(pathToFileURL(join(root, `src/${name}.ts`)))
	};
}
const rules = { clans: ['OLD'], displayClan: 'WOK', displayName: 'Nightfall', names: ['Rocketeer'] };
function identityMisses(module) {
	let pending;
	let calls = 0;
	const resolver = module.createIdentityTextRewrite(rules);
	const rewriteDetailed = text => { calls++; return resolver(text); };
	const children = Array.from({ length: 64 }, (_, i) => ({ nodeType: 3, data: `FPS ${1000 + i}`, isConnected: true }));
	const engine = module.startIdentityRewriteEngine({
		root: { nodeType: 1, tagName: 'BODY', childNodes: children },
		rewrite: text => rewriteDetailed(text)?.text,
		rewriteDetailed,
		createObserver: () => ({ observe() {}, disconnect() {} }),
		schedule: callback => { pending = callback; }
	});
	pending();
	calls = 0;
	for (let i = 0; i < 2000; i++) {
		engine.refresh();
		pending();
	}
	engine.stop();
	assert.equal(children[0].data, 'FPS 1000');
	return { textNodes: 128000, resolverCalls: calls };
}
function identityEchoes(module) {
	let pending;
	let observe;
	let frames = 0;
	const text = { nodeType: 3, data: 'Rocketeer', isConnected: true };
	const engine = module.startIdentityRewriteEngine({
		root: { nodeType: 1, tagName: 'BODY', childNodes: [text] },
		rewrite: module.createIdentityTextRewriter(rules),
		createObserver: callback => { observe = callback; return { observe() {}, disconnect() {} }; },
		schedule: callback => { pending = callback; frames++; }
	});
	pending();
	pending = undefined;
	frames = 0;
	const records = [{ type: 'characterData', target: text }];
	for (let i = 0; i < 50000; i++) {
		observe(records);
		if (pending) { const frame = pending; pending = undefined; frame(); }
	}
	assert.equal(text.data, 'Nightfall');
	engine.restoreAll();
	assert.equal(text.data, 'Rocketeer');
	engine.stop();
	return { echoes: 50000, scheduledFrames: frames };
}
function clanRewrites(module) {
	const resolver = module.createIdentityTextRewrite(rules);
	let rewrites = 0;
	for (let i = 0; i < 30000; i++) if (resolver('  OLD  ')?.text === '  WOK  ') rewrites++;
	assert.equal(rewrites, 30000);
	return { rewrites };
}
function mutationMisses(module) {
	let selectorCalls = 0;
	const element = {
		matches: () => { selectorCalls++; return false; },
		closest: () => { selectorCalls++; return null; },
		querySelector: () => { selectorCalls++; return null; }
	};
	const records = [{ target: element, addedNodes: [{ parentElement: element }], removedNodes: [{}] }];
	for (let i = 0; i < 50000; i++) assert.equal(module.mutationRecordsTouchSelector(records, '#owned'), false);
	return { mutations: 50000, selectorCalls };
}
const cases = [
	['identity misses', 'identity-rewrite', identityMisses],
	['identity echoes', 'identity-rewrite', identityEchoes],
	['standalone clan rewrites', 'identity-rewrite', clanRewrites],
	['unrelated text mutations', 'mutation-relevance', mutationMisses]
];
const results = [];
for (const [name, key, run] of cases) {
	const variants = modules[key];
	for (let warmup = 0; warmup < 4; warmup++) { run(variants.baseline); run(variants.candidate); }
	const times = { baseline: [], candidate: [] };
	const counts = {};
	for (let round = 0; round < 11; round++) {
		for (const variant of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
			const started = performance.now();
			counts[variant] = run(variants[variant]);
			times[variant].push(performance.now() - started);
		}
	}
	const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
	const baselineMs = median(times.baseline);
	const candidateMs = median(times.candidate);
	results.push({ name, baselineMs, candidateMs, reductionPercent: 100 * (1 - candidateMs / baselineMs), counts, times });
}
const report = { baselineRef, runtime: process.version, rounds: 11, scope: 'Synthetic client CPU work only. Not a gameplay FPS or presentation measurement. DOM selector timings use stubs. Selector counts, not those timings, establish the DOM saving.', results };
writeFileSync(join(scratch, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`Results saved to ${join(scratch, 'results.json')}`);
