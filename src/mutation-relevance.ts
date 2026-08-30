export interface MutationElementLike {
	closest?(selector: string): unknown;
	matches?(selector: string): boolean;
	parentElement?: MutationElementLike | null;
	querySelector?(selector: string): unknown;
}

export interface MutationRecordLike {
	addedNodes?: Iterable<MutationElementLike>;
	removedNodes?: Iterable<MutationElementLike>;
	target: MutationElementLike;
}

function nodeTouchesSelector(
	node: MutationElementLike,
	selector: string,
	includeDescendants: boolean
): boolean {
	const element = typeof node.matches === 'function' ? node : node.parentElement;
	if (!element) return false;
	return element.matches?.(selector) === true
		|| element.closest?.(selector) != null
		|| (includeDescendants && element.querySelector?.(selector) != null);
}

/** Ignore document-wide mutations that cannot add, remove, or change the owned surface. */
export function mutationRecordsTouchSelector(
	records: readonly MutationRecordLike[],
	selector: string
): boolean {
	for (const record of records) {
		if (nodeTouchesSelector(record.target, selector, false)) return true;
		for (const node of record.addedNodes ?? []) {
			if (nodeTouchesSelector(node, selector, true)) return true;
		}
		for (const node of record.removedNodes ?? []) {
			if (nodeTouchesSelector(node, selector, true)) return true;
		}
	}
	return false;
}
