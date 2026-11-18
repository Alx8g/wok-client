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
	// closest tests the element itself before its ancestors. A separate matches call repeats it.
	const matches = typeof element.closest === 'function'
		? element.closest(selector) != null
		: element.matches?.(selector) === true;
	// A text node can inherit its parent's membership, but cannot contain a surface. Searching
	// its parent's descendants instead scans unrelated siblings on every HUD text replacement.
	return matches || (includeDescendants && node === element && element.querySelector?.(selector) != null);
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
