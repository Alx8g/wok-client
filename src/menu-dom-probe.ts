/**
 * Diagnostic-only Krunker menu structure probe.
 *
 * Client features that reorganise parts of the game menu have to be written against the markup
 * the game actually produces. Guessing selectors produces code that silently does nothing the
 * day the game changes, so this captures the real structure once and prints it.
 *
 * Inert unless WOK_DUMP_DOM is set, and it never modifies anything it inspects.
 */

export interface MenuProbeNode {
	attributes: Record<string, string>;
	childCount: number;
	depth: number;
	tag: string;
	text: string;
}

export interface MenuProbeMatch {
	nodes: MenuProbeNode[];
	rootDescription: string;
}

interface ProbeElement {
	attributes?: ArrayLike<{ name: string; value: string }>;
	children?: ArrayLike<ProbeElement>;
	className?: unknown;
	id?: string;
	tagName?: string;
	textContent?: string | null;
}

function describe(element: ProbeElement): string {
	const id = element.id ? `#${element.id}` : '';
	const className = typeof element.className === 'string' && element.className ? `.${element.className.trim().split(/\s+/u).join('.')}` : '';
	return `${(element.tagName ?? 'node').toLowerCase()}${id}${className}`;
}

/** Flattens an element tree to a bounded, readable outline: tags, ids, classes, and short text. */
export function outlineElement(root: ProbeElement, maxDepth = 4, maxNodes = 120): MenuProbeNode[] {
	const nodes: MenuProbeNode[] = [];
	const visit = (element: ProbeElement, depth: number) => {
		if (nodes.length >= maxNodes || depth > maxDepth) return;
		const attributes: Record<string, string> = {};
		for (const attribute of Array.from(element.attributes ?? [])) {
			if (attribute.name === 'style') continue;
			attributes[attribute.name] = attribute.value.length > 120 ? `${attribute.value.slice(0, 120)}...` : attribute.value;
		}
		const children = Array.from(element.children ?? []);
		const ownText = (element.textContent ?? '').trim().replace(/\s+/gu, ' ');
		nodes.push({
			attributes,
			childCount: children.length,
			depth,
			tag: (element.tagName ?? 'node').toLowerCase(),
			text: children.length === 0 && ownText.length <= 80 ? ownText : ''
		});
		for (const child of children) visit(child, depth + 1);
	};
	visit(root, 0);
	return nodes;
}

export function formatMenuProbe(matches: MenuProbeMatch[]): string {
	if (matches.length === 0) return '[wok-dom] no matching elements found';
	return matches
		.map(match => {
			const body = match.nodes
				.map(node => {
					const attributes = Object.entries(node.attributes)
						.map(([name, value]) => `${name}="${value}"`)
						.join(' ');
					const text = node.text ? `  "${node.text}"` : '';
					return `${'  '.repeat(node.depth)}<${node.tag}${attributes ? ` ${attributes}` : ''}>${node.childCount > 0 ? ` (${node.childCount} children)` : ''}${text}`;
				})
				.join('\n');
			return `[wok-dom] ROOT ${match.rootDescription}\n${body}`;
		})
		.join('\n\n');
}

export interface MenuProbeHooks {
	/** Case-insensitive text fragments that identify the region of interest. */
	keywords: string[];
	queryAll(selector: string): ProbeElement[];
	report(text: string): void;
}

/**
 * Finds the smallest containers whose text mentions the given keywords and outlines them. Working
 * from text rather than selectors means the probe keeps working when the game renames classes.
 */
export function probeMenuStructure(hooks: MenuProbeHooks): void {
	const keywords = hooks.keywords.map(keyword => keyword.toLowerCase());
	const candidates = hooks.queryAll('div, section, aside');
	const matches: MenuProbeMatch[] = [];

	const matchesKeyword = (element: ProbeElement) => {
		const text = (element.textContent ?? '').toLowerCase();
		return keywords.some(keyword => text.includes(keyword));
	};
	const candidateSet = new Set(candidates);
	const containsMatchingCandidate = (element: ProbeElement): boolean => {
		for (const child of Array.from(element.children ?? [])) {
			if (candidateSet.has(child) && matchesKeyword(child)) return true;
			if (containsMatchingCandidate(child)) return true;
		}
		return false;
	};

	for (const element of candidates) {
		if (!matchesKeyword(element)) continue;
		// Report the tightest container. An element is skipped only when a *candidate* descendant
		// also matches; deferring to any matching child at all would drill down to leaf text nodes
		// and report nothing useful.
		if (containsMatchingCandidate(element)) continue;
		matches.push({ nodes: outlineElement(element), rootDescription: describe(element) });
		if (matches.length >= 4) break;
	}

	hooks.report(formatMenuProbe(matches));
}
