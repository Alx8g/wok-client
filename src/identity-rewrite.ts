const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const IDENTIFIER_CHARACTER_CLASS = 'A-Za-z0-9_-';
export const NO_REWRITE_ATTRIBUTE = 'data-wok-no-identity-rewrite';
const EXCLUDED_TAGS = new Set(['CANVAS', 'EMBED', 'IFRAME', 'INPUT', 'NOSCRIPT', 'OBJECT', 'OPTION', 'SCRIPT', 'SELECT', 'STYLE', 'TEMPLATE', 'TEXTAREA', 'TITLE']);
export interface IdentityRewriteNode {
	childNodes?: ArrayLike<IdentityRewriteNode>;
	data?: string;
	hasAttribute?(name: string): boolean;
	isConnected?: boolean;
	nodeType: number;
	tagName?: string;
}
export interface IdentityMutationRecord {
	addedNodes?: ArrayLike<IdentityRewriteNode>;
	target?: IdentityRewriteNode;
	type: string;
}
export type IdentityRewriteCallback = (records: readonly IdentityMutationRecord[]) => void;
export interface IdentityRewriteObserver {
	disconnect(): void;
	observe(target: IdentityRewriteNode, options?: unknown): void;
}
export type IdentityTextRewriter = (text: string) => string | undefined;
export interface IdentityRewriteRules {
	clans: readonly string[];
	displayClan: string;
	displayName: string;
	names: readonly string[];
}
function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
function prepareNeedles(values: readonly string[], replacement: string): string[] {
	const unique = new Set<string>();
	for (const value of values) {
		if (typeof value !== 'string') continue;
		if (value === '' || value === replacement) continue;
		unique.add(value);
	}
	return [...unique].sort((first, second) => second.length - first.length);
}
function alternation(needles: readonly string[]): string {
	return needles.map(escapeForRegExp).join('|');
}
export function createIdentityTextRewriter(rules: Readonly<IdentityRewriteRules>): IdentityTextRewriter | undefined {
	const { displayClan, displayName } = rules;
	const nameNeedles = displayName === '' ? [] : prepareNeedles(rules.names, displayName);
	const clanNeedles = displayClan === '' ? [] : prepareNeedles(rules.clans, displayClan);
	if (nameNeedles.length === 0 && clanNeedles.length === 0) return undefined;
	const namePattern = nameNeedles.length === 0 ? undefined : new RegExp(`(?<![${IDENTIFIER_CHARACTER_CLASS}])(?:${alternation(nameNeedles)})(?![${IDENTIFIER_CHARACTER_CLASS}])`, 'gu');
	const bracketedClanPattern = clanNeedles.length === 0 ? undefined : new RegExp(`\\[(?:${alternation(clanNeedles)})\\]`, 'gu');
	const realNames = prepareNeedles(rules.names, '');
	const clanBeforeNamePattern =
		clanNeedles.length === 0 || realNames.length === 0
			? undefined
			: new RegExp(`(?<![${IDENTIFIER_CHARACTER_CLASS}])(?:${alternation(clanNeedles)})(?=\\s*(?:${alternation(realNames)})(?![${IDENTIFIER_CHARACTER_CLASS}]))`, 'gu');
	const clanSet = new Set(clanNeedles);
	const gates = [...nameNeedles, ...clanNeedles];
	const shortestGate = Math.min(...gates.map((gate) => gate.length));
	return (text) => {
		if (text.length < shortestGate) return undefined;
		let gated = false;
		for (const gate of gates) {
			if (text.includes(gate)) {
				gated = true;
				break;
			}
		}
		if (!gated) return undefined;
		let next = text;
		if (clanNeedles.length > 0) {
			const trimmed = next.trim();
			if (clanSet.has(trimmed)) next = next.replace(trimmed, () => displayClan);
			else {
				if (bracketedClanPattern) next = next.replace(bracketedClanPattern, () => `[${displayClan}]`);
				if (clanBeforeNamePattern) next = next.replace(clanBeforeNamePattern, () => displayClan);
			}
		}
		if (namePattern) next = next.replace(namePattern, () => displayName);
		return next === text ? undefined : next;
	};
}
export interface IdentityRewriteEngineOptions {
	createObserver(callback: IdentityRewriteCallback): IdentityRewriteObserver;
	isExcluded?(element: IdentityRewriteNode): boolean;
	maxNodesPerFlush?: number;
	pruneThreshold?: number;
	rewrite: IdentityTextRewriter;
	root: IdentityRewriteNode;
	schedule(callback: () => void): unknown;
	unschedule?(handle: unknown): void;
}
export interface IdentityRewriteEngine {
	flush(): void;
	refresh(): void;
	restoreAll(): void;
	readonly rewrittenNodeCount: number;
	stop(): void;
}
interface RewriteRecord {
	applied: string;
	original: string;
}
function isExcludedByDefault(element: IdentityRewriteNode): boolean {
	const tagName = element.tagName;
	if (typeof tagName === 'string' && EXCLUDED_TAGS.has(tagName.toUpperCase())) return true;
	if (typeof element.hasAttribute !== 'function') return false;
	return element.hasAttribute(NO_REWRITE_ATTRIBUTE) || element.hasAttribute('contenteditable');
}
export function startIdentityRewriteEngine(options: IdentityRewriteEngineOptions): IdentityRewriteEngine {
	const maxNodesPerFlush = options.maxNodesPerFlush ?? 4000;
	const pruneThreshold = options.pruneThreshold ?? 256;
	const isExcluded = options.isExcluded;
	const tracked = new Map<IdentityRewriteNode, RewriteRecord>();
	const pending = new Set<IdentityRewriteNode>();
	let stack: IdentityRewriteNode[] = [];
	let scheduledHandle: unknown;
	let flushScheduled = false;
	let stopped = false;
	function scheduleFlush(): void {
		if (flushScheduled || stopped) return;
		flushScheduled = true;
		scheduledHandle = options.schedule(() => {
			flushScheduled = false;
			scheduledHandle = undefined;
			runFlush();
		});
	}
	function queue(node: IdentityRewriteNode | undefined): void {
		if (stopped || !node) return;
		pending.add(node);
		scheduleFlush();
	}
	function processText(node: IdentityRewriteNode): void {
		const record = tracked.get(node);
		const current = node.data ?? '';
		if (record && current === record.applied) return;
		const next = options.rewrite(current);
		if (next === undefined || next === current) {
			if (record) tracked.delete(node);
			return;
		}
		node.data = next;
		tracked.set(node, { applied: next, original: current });
	}
	function prune(): void {
		if (tracked.size <= pruneThreshold) return;
		for (const node of [...tracked.keys()]) {
			if (!node.isConnected) tracked.delete(node);
		}
	}
	function runFlush(): void {
		if (stopped) return;
		for (const node of pending) stack.push(node);
		pending.clear();
		let budget = maxNodesPerFlush;
		while (stack.length > 0 && budget > 0) {
			budget -= 1;
			const node = stack.pop();
			if (!node) break;
			if (node.nodeType === TEXT_NODE) {
				processText(node);
				continue;
			}
			if (node.nodeType !== ELEMENT_NODE) continue;
			if (isExcludedByDefault(node) || isExcluded?.(node)) continue;
			const children = node.childNodes;
			if (!children) continue;
			for (let index = 0; index < children.length; index += 1) stack.push(children[index]);
		}
		prune();
		if (stack.length > 0) scheduleFlush();
	}
	const observer = options.createObserver((records) => {
		if (stopped) return;
		for (const record of records) {
			if (record.type === 'characterData') {
				queue(record.target);
				continue;
			}
			const added = record.addedNodes;
			if (!added) continue;
			for (let index = 0; index < added.length; index += 1) queue(added[index]);
		}
	});
	observer.observe(options.root, {
		characterData: true,
		childList: true,
		subtree: true
	});
	queue(options.root);
	return {
		flush() {
			if (stopped) return;
			runFlush();
		},
		refresh() {
			queue(options.root);
		},
		restoreAll() {
			for (const [node, record] of tracked) {
				if ((node.data ?? '') === record.applied) node.data = record.original;
			}
			tracked.clear();
		},
		get rewrittenNodeCount() {
			return tracked.size;
		},
		stop() {
			if (stopped) return;
			stopped = true;
			observer.disconnect();
			if (flushScheduled && options.unschedule) options.unschedule(scheduledHandle);
			flushScheduled = false;
			scheduledHandle = undefined;
			pending.clear();
			stack = [];
		}
	};
}
