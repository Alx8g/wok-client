/**
 * Local display identity: the text-replacement engine.
 *
 * The feature is "everywhere Krunker prints my name, print the one I chose instead", and it is
 * local only. Nothing here reads or writes the network, and nothing here changes what Krunker
 * sends: the account identity the servers know, and therefore what every other player sees, is
 * untouched. Only the pixels in this renderer change.
 *
 * The engine is deliberately content-based rather than selector-based. WOK's own probe
 * (src/menu-dom-probe.ts on the diagnostics branch) exists because guessing Krunker's class names
 * produces code that silently does nothing the day the game renames something. So instead of
 * knowing where the chat, the kill feed, the scoreboard and the menu card are, this module is told
 * what the player's real name and clan tag are and replaces those strings wherever they are
 * rendered. The day Krunker reorganises its UI, the replacement still lands.
 *
 * Everything is injected - the root, the observer factory, the frame scheduler - so the whole
 * engine runs under `node --test` against plain objects (tests/identity-rewrite.test.ts).
 */

/** Node types, spelled out so the engine never needs a real DOM to run. */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * Characters that can be part of a handle. A match only counts when it is not glued to one of
 * these on either side, so the real name "Rocket" never rewrites another player called
 * "Rocket_2" or "Rocket-alt".
 */
const IDENTIFIER_CHARACTER_CLASS = 'A-Za-z0-9_-';

/** Mark a subtree with this to keep the engine out of it. WOK's own surfaces carry it. */
export const NO_REWRITE_ATTRIBUTE = 'data-wok-no-identity-rewrite';

/**
 * Never rewritten, for two different reasons. Form controls and editable regions hold what the
 * user typed, and rewriting them would corrupt real input (including the chat box and the name
 * field in Krunker's own settings). The rest are not player-visible prose at all, and touching
 * them would mean rewriting code or markup.
 */
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

/** The slice of Node the engine touches, so tests can pass literals. */
export interface IdentityRewriteNode {
	childNodes?: ArrayLike<IdentityRewriteNode>;
	/** DOM parent, present in the renderer and optional in pure test nodes. */
	parentNode?: IdentityRewriteNode | null;
	/** Text node contents. */
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

/** Returns the replacement text, or undefined when the input needs no change. */
export type IdentityTextRewriter = (text: string) => string | undefined;

/** A range in a rendered text node that belongs to the local identity. */
export interface IdentityTextFragment {
	end: number;
	start: number;
}

/** Marker shared by the DOM decoration engine and its stylesheet. */
export const IDENTITY_RGB_MARKER_ATTRIBUTE = 'data-wok-identity-rgb';
export const IDENTITY_RGB_CLASS = 'wok-identity-rgb';

export interface IdentityRewriteRules {
	/** The real clan tags to look for, without brackets. */
	clans: readonly string[];
	/** Keep same-value matches as fragments so a renderer can decorate the real identity. */
	decorateUnchanged?: boolean;
	/** What to show instead of the real clan tag. '' leaves clan tags alone. */
	displayClan: string;
	/** What to show instead of the real name. '' leaves names alone. */
	displayName: string;
	/** The real names to look for. */
	names: readonly string[];
}

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Dedupe, drop empties, drop needles that already equal the replacement (rewriting those is a
 * no-op that would only cost time), and put the longest first so alternation prefers the most
 * specific match.
 */
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

/** A rewrite result with exact ranges for the custom identity in the resulting text. */
export interface IdentityTextRewrite {
	fragments: readonly IdentityTextFragment[];
	text: string;
}

/** Detailed form used by the RGB decorator; the ordinary rewriter remains text-only. */
export type IdentityTextRewriteResolver = (text: string) => IdentityTextRewrite | undefined;

/**
 * Build the text rewriter and preserve the ranges that came from each identity replacement. Keeping
 * this beside the ordinary parser means RGB styling cannot accidentally infer a user's name from
 * unrelated chat text.
 */
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
	const standaloneClanPatterns = new Map(clanNeedles.map(clan => [clan, new RegExp(escapeForRegExp(clan), 'gu')]));
	const gates = [...nameNeedles, ...clanNeedles];
	const shortestGate = Math.min(...gates.map(gate => gate.length));

	return text => {
		if (text.length < shortestGate || !gates.some(gate => text.includes(gate))) return undefined;
		let next = text;
		let fragments: IdentityTextFragment[] = [];
		if (clanNeedles.length > 0) {
			const standaloneClanPattern = standaloneClanPatterns.get(next.trim());
			if (standaloneClanPattern) {
				const result = replaceMatchesWithFragments(next, fragments, standaloneClanPattern, displayClan);
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

/** Build the legacy text-only API from the detailed parser. */
export function createIdentityTextRewriter(rules: Readonly<IdentityRewriteRules>): IdentityTextRewriter | undefined {
	const rewrite = createIdentityTextRewrite(rules);
	return rewrite ? text => rewrite(text)?.text : undefined;
}

export interface IdentityRewriteApplication {
	/** Node whose data is the applied replacement, used to recognize observer echoes. */
	node: IdentityRewriteNode;
	/** Optional connected node used to prune an application whose source was split into DOM. */
	connectedNode?: IdentityRewriteNode;
	applied: string;
	original: string;
	/** Restore the source node and remove any DOM decoration. Must be safe to call once. */
	restore(): void;
}

export interface IdentityRewriteEngineOptions {
	createObserver(callback: IdentityRewriteCallback): IdentityRewriteObserver;
	/** Extra exclusion on top of the built-in tag and attribute rules. */
	isExcluded?(element: IdentityRewriteNode): boolean;
	/** Upper bound on nodes visited per frame; the remainder carries over to the next one. */
	maxNodesPerFlush?: number;
	/** Tracked nodes tolerated before detached ones are swept out. */
	pruneThreshold?: number;
	rewrite: IdentityTextRewriter;
	/** When present, replaces the text-only parser, including on misses, and supplies decoration ranges. */
	rewriteDetailed?: IdentityTextRewriteResolver;
	/** Applies a detailed rewrite, optionally replacing the text node with marked DOM fragments. */
	applyRewrite?(node: IdentityRewriteNode, original: string, rewrite: IdentityTextRewrite): IdentityRewriteApplication | undefined;
	root: IdentityRewriteNode;
	/** Batching hook. requestAnimationFrame in the renderer. */
	schedule(callback: () => void): unknown;
	unschedule?(handle: unknown): void;
}

export interface IdentityRewriteEngine {
	/** Run the pending queue now, instead of waiting for the next frame. */
	flush(): void;
	/** Queue a full re-scan of the root. */
	refresh(): void;
	/** Put every tracked node back to exactly what Krunker last wrote into it. */
	restoreAll(): void;
	/** Text nodes currently carrying a replaced value. */
	readonly rewrittenNodeCount: number;
	/** Detach the observer and drop pending work. Does not restore; call restoreAll() first. */
	stop(): void;
}

interface RewriteRecord {
	/** Exactly what the engine wrote, so its own mutations can be recognised and ignored. */
	applied: string;
	/** Exactly what Krunker had written, so it can be handed back verbatim. */
	original: string;
	connectedNode?: IdentityRewriteNode;
	restore?: () => void;
}

function isExcludedByDefault(element: IdentityRewriteNode): boolean {
	const tagName = element.tagName;
	if (typeof tagName === 'string' && EXCLUDED_TAGS.has(tagName.toUpperCase())) return true;
	if (typeof element.hasAttribute !== 'function') return false;
	// contenteditable regions are user input too, whatever tag they happen to use.
	return element.hasAttribute(NO_REWRITE_ATTRIBUTE) || element.hasAttribute('contenteditable');
}

/**
 * Start replacing. The engine never re-walks the document per mutation: the observer callback
 * only pushes the mutated nodes onto a queue and asks for one frame, and the flush walks just the
 * queued subtrees, under a per-frame node budget that carries the remainder over rather than
 * blowing the frame. During gameplay the queue is a handful of chat, kill-feed and HUD nodes.
 */
export function startIdentityRewriteEngine(options: IdentityRewriteEngineOptions): IdentityRewriteEngine {
	const maxNodesPerFlush = options.maxNodesPerFlush ?? 4_000;
	const pruneThreshold = options.pruneThreshold ?? 256;
	const isExcluded = options.isExcluded;
	const tracked = new Map<IdentityRewriteNode, RewriteRecord>();
	const pending = new Set<IdentityRewriteNode>();
	/** Carries the unfinished walk between frames when a flush runs out of budget. */
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
		// The engine's own writes come back through the observer as characterData mutations.
		// Recognising them here is what keeps this from being an infinite loop, and it is cheaper
		// and safer than disconnecting and reconnecting the observer around every write.
		if (record && current === record.applied) return;
		if (record) {
			record.restore?.();
			tracked.delete(node);
		}

		const detailed = options.rewriteDetailed?.(current);
		const next = options.rewriteDetailed ? detailed?.text : options.rewrite(current);
		if (next === undefined) return;
		// A detailed rewrite can intentionally preserve the text while decorating its exact identity
		// ranges (the RGB toggle with no custom alias). Give that renderer hook the first chance to
		// apply before treating same-value text as a no-op.
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

	/** Detached nodes (a chat line that scrolled off) are dropped so the map cannot grow forever. */
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
		// Out of budget rather than out of work: finish on the next frame.
		if (stack.length > 0) scheduleFlush();
	}

	const observer = options.createObserver(records => {
		if (stopped) return;
		for (const record of records) {
			if (record.type === 'characterData') {
				// An observer echo needs no frame at all. Keep the flush-time check too because
				// Krunker can change queued text again before the scheduled callback runs.
				const target = record.target;
				const applied = target && tracked.get(target);
				if (applied && target.data === applied.applied) continue;
				queue(target);
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
				// Only hand back nodes still carrying the engine's own value; anything Krunker has
				// rewritten since is already correct and must not be clobbered.
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
