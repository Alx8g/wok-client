import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMenuProbe, outlineElement, probeMenuStructure } from '../src/menu-dom-probe.ts';

interface FakeElement {
	attributes: { name: string; value: string }[];
	children: FakeElement[];
	className: string;
	id: string;
	tagName: string;
	textContent: string;
}

function el(tagName: string, options: Partial<FakeElement> = {}): FakeElement {
	const children = options.children ?? [];
	return {
		attributes: options.attributes ?? [],
		children,
		className: options.className ?? '',
		id: options.id ?? '',
		tagName,
		textContent: options.textContent ?? children.map(child => child.textContent).join(' ')
	};
}

test('outlines a tree with bounded depth and readable leaf text', () => {
	const tree = el('DIV', {
		children: [el('SPAN', { className: 'title', textContent: 'Live Streams' })],
		id: 'streams'
	});
	const nodes = outlineElement(tree);

	assert.equal(nodes[0].tag, 'div');
	assert.equal(nodes[0].childCount, 1);
	assert.equal(nodes[1].text, 'Live Streams', 'leaf text is captured');
	assert.equal(nodes[0].text, '', 'container text is not repeated');
});

test('reports the tightest container mentioning a keyword, not its ancestors', () => {
	const inner = el('DIV', { className: 'panel', children: [el('SPAN', { textContent: 'Featured' })] });
	const outer = el('DIV', { children: [inner], id: 'wrapper' });
	const reports: string[] = [];

	probeMenuStructure({
		keywords: ['featured'],
		queryAll: () => [outer, inner],
		report: text => { reports.push(text); }
	});

	assert.equal(reports.length, 1);
	assert.match(reports[0], /ROOT div\.panel/u, 'the innermost match is reported');
	assert.doesNotMatch(reports[0], /ROOT div#wrapper/u, 'ancestors are skipped');
});

test('says so plainly when nothing matches', () => {
	const reports: string[] = [];
	probeMenuStructure({ keywords: ['nothing-here'], queryAll: () => [el('DIV', { textContent: 'menu' })], report: text => { reports.push(text); } });
	assert.match(reports[0], /no matching elements found/u);
	assert.equal(formatMenuProbe([]), '[wok-dom] no matching elements found');
});
