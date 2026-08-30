import assert from 'node:assert/strict';
import test from 'node:test';
import {
	readPublicServerRegionHeadingLabel,
	sortPublicServerRegionBlocks,
	type PublicServerRegionBlock
} from '../src/public-server-ping-sort.ts';

interface FakeNode {
	nodeType: number;
	textContent: string | null;
}

function block(label: string, regionCode?: string): PublicServerRegionBlock<string> {
	return {
		heading: `heading:${label}`,
		label,
		nodes: [`heading:${label}`, `body:${label}`],
		...(regionCode ? { regionCode } : {})
	};
}

test('reads only direct region heading text and ignores nested controls/counts', () => {
	const childNodes: FakeNode[] = [
		{ nodeType: 1, textContent: 'navigate_next' },
		{ nodeType: 3, textContent: '  Frankfurt  ' },
		{ nodeType: 1, textContent: '42 online' },
		{ nodeType: 1, textContent: 'Quick Join' }
	];
	assert.equal(readPublicServerRegionHeadingLabel({ childNodes } as never), 'Frankfurt');
});

test('pins fixed Public categories and sorts measured geographic blocks by ping', () => {
	const blocks = [
		block('Sydney', 'SYD'),
		block('Custom Games'),
		block('Frankfurt', 'FRA'),
		block('Official Customs'),
		block('New York', 'NY')
	];
	const sorted = sortPublicServerRegionBlocks(blocks, {
		FRA: 91,
		NY: 34,
		SYD: 212
	});

	assert.deepEqual(sorted.map(item => item.label), [
		'Custom Games',
		'Official Customs',
		'New York',
		'Frankfurt',
		'Sydney'
	]);
	assert.deepEqual(sorted.find(item => item.label === 'Frankfurt')?.nodes, [
		'heading:Frankfurt',
		'body:Frankfurt'
	], 'the region heading and its server body remain one block');
});

test('keeps timed-out and unknown Public sections stable at the bottom', () => {
	const blocks = [
		block('Sydney', 'SYD'),
		block('Moon Base'),
		block('Frankfurt', 'FRA'),
		block('Mystery'),
		block('New York', 'NY')
	];
	assert.deepEqual(
		sortPublicServerRegionBlocks(blocks, { FRA: 90 }).map(item => item.label),
		['Frankfurt', 'Sydney', 'Moon Base', 'Mystery', 'New York']
	);
});
