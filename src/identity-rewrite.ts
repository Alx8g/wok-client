

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const IDENTIFIER_CHARACTER_CLASS = 'A-Za-z0-9_-';

export const NO_REWRITE_ATTRIBUTE = 'data-wok-no-identity-rewrite';

const EXCLUDED_TAGS = new Set([
	'CANVAS',
	'EMBED',
	'IFRAME',
	'INPUT',
	'NOSCRIPT',
	'OBJECT',
	'OPTION',
	'SCRIPT',
	'SELECT',
	'STYLE',
	'TEMPLATE',
	'TEXTAREA',
	'TITLE'
]);

export interface IdentityRewriteNode {
	childNodes?: ArrayLike<IdentityRewriteNode>;

	parentNode?: IdentityRewriteNode | null;

	data?: string;
	hasAttribute?(name: string): boolean;
	isConnected?: boolean;
	nodeType: number;
	setAttribute?(name: string, value: string): void;
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

export interface IdentityTextFragment {
	end: number;
	start: number;
}

export const IDENTITY_RGB_MARKER_ATTRIBUTE = 'data-wok-identity-rgb';
export const IDENTITY_RGB_CLASS = 'wok-identity-rgb';

export interface IdentityRewriteRules {

	clans: readonly string[];

	decorateUnchanged?: boolean;

	displayClan: string;

	displayName: string;

	names: readonly string[];
}

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function prepareNeedles(values: readonly string[], replacement: string, keepReplacement = false): string[] {
	const unique = new Set<string>();
	for (const value of values) {
		if (typeof value !== 'string') continue;
		if (value === '' || (!keepReplacement && value === replacement)) continue;
		unique.add(value);
	}
	return [...unique].sort((first, second) => second.length - first.length);
}

function alternation(needles: readonly string[]): string {
	return needles.map(escapeForRegExp).join('|');
}

function replaceMatchesWithFragments(
	text: string,
	fragments: readonly IdentityTextFragment[],
	pattern: RegExp,
	replacement: string
): IdentityTextRewrite {
	pattern.lastIndex = 0;
	const matches: IdentityTextFragment[] = [];
	for (const match of text.matchAll(pattern)) {
		const start = match.index;
		if (start !== undefined && match[0].length > 0) matches.push({ end: start + match[0].length, start });
	}
	if (matches.length === 0) return { fragments, text };

	let cursor = 0;
	let next = '';
	for (const match of matches) {
		next += text.slice(cursor, match.start) + replacement;
		cursor = match.end;
	}
	next += text.slice(cursor);

	const retained = fragments.flatMap(fragment => {
		if (matches.some(match => match.start < fragment.end && match.end > fragment.start)) return [];
		const shift = matches
			.filter(match => match.end <= fragment.start)
			.reduce((total, match) => total + replacement.length - (match.end - match.start), 0);
		return [{ start: fragment.start + shift, end: fragment.end + shift }];
	});
	let shift = 0;
	const additions = matches.map(match => {
		const result = { start: match.start + shift, end: match.start + shift + replacement.length };
		shift += replacement.length - (match.end - match.start);
		return result;
	});
	return { fragments: [...retained, ...additions].sort((first, second) => first.start - second.start), text: next };
}

function mergeIdentityFragments(
	text: string,
	fragments: readonly IdentityTextFragment[],
	displayClan: string
): IdentityTextFragment[] {
	const sorted = [...fragments].sort((first, second) => first.start - second.start || second.end - first.end);
	const isClan = (fragment: IdentityTextFragment) => {
		const value = text.slice(fragment.start, fragment.end).trim();
		return value === displayClan || value === `[${displayClan}]`;
	};
	const merged: IdentityTextFragment[] = [];
	for (const fragment of sorted) {
		const previous = merged.at(-1);
		if (!previous) {
			merged.push({ ...fragment });
			continue;
		}
		if (fragment.start <= previous.end) {
			previous.end = Math.max(previous.end, fragment.end);
			continue;
		}
		const between = text.slice(previous.end, fragment.start);
		if (displayClan !== '' && between.trim() === '' && isClan(previous) !== isClan(fragment)) previous.end = fragment.end;
		else merged.push({ ...fragment });
	}
	return merged;
}

export interface IdentityTextRewrite {
	fragments: readonly IdentityTextFragment[];
	text: string;
}

export type IdentityTextRewriteResolver = (text: string) => IdentityTextRewrite | undefined;

export function createIdentityTextRewrite(rules: Readonly<IdentityRewriteRules>): IdentityTextRewriteResolver | undefined {
	const { decorateUnchanged = false, displayClan, displayName } = rules;
	const nameNeedles = displayName === '' ? [] : prepareNeedles(rules.names, displayName, decorateUnchanged);
	const clanNeedles = displayClan === '' ? [] : prepareNeedles(rules.clans, displayClan, decorateUnchanged);
	if (nameNeedles.length === 0 && clanNeedles.length === 0) return undefined;

	const namePattern = nameNeedles.length === 0
		? undefined
		: new RegExp(`(?<![${IDENTIFIER_CHARACTER_CLASS}])(?:${alternation(nameNeedles)})(?![${IDENTIFIER_CHARACTER_CLASS}])`, 'gu');
	const bracketedClanPattern = clanNeedles.length === 0
		? undefined
		: new RegExp(`\\[(?:${alternation(clanNeedles)})\\]`, 'gu');
	const realNames = prepareNeedles(rules.names, '');
	const clanBeforeNamePattern = clanNeedles.length === 0 || realNames.length === 0
		? undefined
		: new RegExp(`(?<![${IDENTIFIER_CHARACTER_CLASS}])(?:${alternation(clanNeedles)})(?=\\s*(?:${alternation(realNames)})(?![${IDENTIFIER_CHARACTER_CLASS}]))`, 'gu');
	const clanSet = new Set(clanNeedles);
	const gates = [...nameNeedles, ...clanNeedles];
	const shortestGate = Math.min(...gates.map(gate => gate.length));

	return text => {
		if (text.length < shortestGate || !gates.some(gate => text.includes(gate))) return undefined;
		let next = text;
		let fragments: IdentityTextFragment[] = [];
		if (clanNeedles.length > 0) {
			const trimmed = next.trim();
			if (clanSet.has(trimmed)) {
				const result = replaceMatchesWithFragments(next, fragments, new RegExp(escapeForRegExp(trimmed), 'gu'), displayClan);
				next = result.text;
				fragments = result.fragments as IdentityTextFragment[];
			} else {
				if (bracketedClanPattern) {
					const result = replaceMatchesWithFragments(next, fragments, bracketedClanPattern, `[${displayClan}]`);
					next = result.text;
					fragments = result.fragments as IdentityTextFragment[];
				}
				if (clanBeforeNamePattern) {
					const result = replaceMatchesWithFragments(next, fragments, clanBeforeNamePattern, displayClan);
					next = result.text;
					fragments = result.fragments as IdentityTextFragment[];
				}
			}
		}
		if (namePattern) {
			const result = replaceMatchesWithFragments(next, fragments, namePattern, displayName);
			next = result.text;
			fragments = result.fragments as IdentityTextFragment[];
		}
		return next === text && (!decorateUnchanged || fragments.length === 0)
			? undefined
			: { fragments: mergeIdentityFragments(next, fragments, displayClan), text: next };
	};
}

export function createIdentityTextRewriter(rules: Readonly<IdentityRewriteRules>): IdentityTextRewriter | undefined {
	const rewrite = createIdentityTextRewrite(rules);
	return rewrite ? text => rewrite(text)?.text : undefined;
}

export interface IdentityRewriteApplication {

	node: IdentityRewriteNode;

	connectedNode?: IdentityRewriteNode;
	applied: string;
	original: string;

	restore(): void;
}

export interface IdentityRewriteEngineOptions {
	createObserver(callback: IdentityRewriteCallback): IdentityRewriteObserver;

	isExcluded?(element: IdentityRewriteNode): boolean;

	maxNodesPerFlush?: number;

	pruneThreshold?: number;
	rewrite: IdentityTextRewriter;

	rewriteDetailed?: IdentityTextRewriteResolver;

	applyRewrite?(node: IdentityRewriteNode, original: string, rewrite: IdentityTextRewrite): IdentityRewriteApplication | undefined;
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
	connectedNode?: IdentityRewriteNode;
	restore?: () => void;
}

function isExcludedByDefault(element: IdentityRewriteNode): boolean {
	const tagName = element.tagName;
	if (typeof tagName === 'string' && EXCLUDED_TAGS.has(tagName.toUpperCase())) return true;
	if (typeof element.hasAttribute !== 'function') return false;

	return element.hasAttribute(NO_REWRITE_ATTRIBUTE) || element.hasAttribute('contenteditable');
}

export function startIdentityRewriteEngine(options: IdentityRewriteEngineOptions): IdentityRewriteEngine {
	const maxNodesPerFlush = options.maxNodesPerFlush ?? 4_000;
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
		if (record) {
			record.restore?.();
			tracked.delete(node);
		}

		const detailed = options.rewriteDetailed?.(current);
		const next = detailed?.text ?? options.rewrite(current);
		if (next === undefined) return;

		const application = detailed && options.applyRewrite?.(node, current, detailed);
		if (application) {
			tracked.set(application.node, {
				applied: application.applied,
				connectedNode: application.connectedNode,
				original: application.original,
				restore: application.restore
			});
			return;
		}
		if (next === current) return;
		node.data = next;
		tracked.set(node, { applied: next, original: current });
	}

	function prune(): void {
		if (tracked.size <= pruneThreshold) return;
		for (const [node, record] of tracked) {
			if (!(record.connectedNode ?? node).isConnected) tracked.delete(node);
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

	const observer = options.createObserver(records => {
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

				if (record.restore || (node.data ?? '') === record.applied) {
					if (record.restore) record.restore();
					else node.data = record.original;
				}
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
