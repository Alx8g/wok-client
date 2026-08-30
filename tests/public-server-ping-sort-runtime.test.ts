import assert from 'node:assert/strict';
import test from 'node:test';
import {
	PUBLIC_SERVER_PING_LABEL_CLASS,
	PUBLIC_SERVER_PING_STYLE_ID,
	applyPublicServerPingSortSettings,
	stopPublicServerPingSort
} from '../src/public-server-ping-sort.ts';

class FakeTextNode {
	readonly nodeType = 3;
	public parentElement: FakeHTMLElement | null = null;
	public textContent: string;

	public constructor(textContent: string) {
		this.textContent = textContent;
	}
}

type FakeChildNode = FakeHTMLElement | FakeTextNode;

class FakeHTMLElement {
	readonly nodeType = 1;
	public id = '';
	public className = '';
	public title = '';
	public textContent: string | null = '';
	public parentElement: FakeHTMLElement | null = null;
	public childNodes: FakeChildNode[] = [];
	public isDocumentRoot = false;
	public readonly tagName: string;

	public constructor(tagName: string) {
		this.tagName = tagName.toUpperCase();
	}

	public get children(): FakeHTMLElement[] {
		return this.childNodes.filter(node => node instanceof FakeHTMLElement);
	}

	public get isConnected(): boolean {
		let root: FakeHTMLElement = this;
		while (root.parentElement) root = root.parentElement;
		return root.isDocumentRoot;
	}

	public append(...nodes: FakeChildNode[]): void {
		for (const node of nodes) {
			this.detachNode(node);
			node.parentElement = this;
			this.childNodes.push(node);
		}
	}

	public insertBefore(node: FakeChildNode, reference: FakeChildNode | null): void {
		this.detachNode(node);
		node.parentElement = this;
		if (reference === null) {
			this.childNodes.push(node);
			return;
		}
		const index = this.childNodes.indexOf(reference);
		if (index < 0) this.childNodes.push(node);
		else this.childNodes.splice(index, 0, node);
	}

	public replaceChildren(...nodes: FakeChildNode[]): void {
		for (const child of this.childNodes) child.parentElement = null;
		this.childNodes = [];
		this.append(...nodes);
	}

	public remove(): void {
		this.parentElement?.detachNode(this);
	}

	public matches(selector: string): boolean {
		if (selector.startsWith('.')) return this.className.split(/\s+/u).includes(selector.slice(1));
		if (selector.startsWith('#')) return this.id === selector.slice(1);
		return this.tagName.toLowerCase() === selector.toLowerCase();
	}

	public querySelector<T extends FakeHTMLElement = FakeHTMLElement>(selector: string): T | null {
		return this.querySelectorAll<T>(selector)[0] ?? null;
	}

	public querySelectorAll<T extends FakeHTMLElement = FakeHTMLElement>(selector: string): T[] {
		const matches: T[] = [];
		const visit = (element: FakeHTMLElement) => {
			for (const child of element.children) {
				if (child.matches(selector)) matches.push(child as T);
				visit(child);
			}
		};
		visit(this);
		return matches;
	}

	private detachNode(node: FakeChildNode): void {
		if (!node.parentElement) return;
		const siblings = node.parentElement.childNodes;
		const index = siblings.indexOf(node);
		if (index >= 0) siblings.splice(index, 1);
		node.parentElement = null;
	}
}

class FakeDocument {
	public readonly documentElement = new FakeHTMLElement('html');
	public readonly head = new FakeHTMLElement('head');
	public readonly body = new FakeHTMLElement('body');

	public constructor() {
		this.documentElement.isDocumentRoot = true;
		this.documentElement.append(this.head, this.body);
	}

	public createElement(tagName: string): FakeHTMLElement {
		return new FakeHTMLElement(tagName);
	}

	public getElementById(id: string): FakeHTMLElement | null {
		if (this.documentElement.id === id) return this.documentElement;
		return this.documentElement.querySelector(`#${id}`);
	}

	public querySelectorAll<T extends FakeHTMLElement = FakeHTMLElement>(selector: string): T[] {
		return this.documentElement.querySelectorAll<T>(selector);
	}
}

type FakeObserver = {
	disconnected: boolean;
	target: object | undefined;
	options: MutationObserverInit | undefined;
};

type ServerBlock = {
	label: string;
	heading: FakeHTMLElement;
	nodes: readonly FakeHTMLElement[];
};

type RuntimeHarness = {
	document: FakeDocument;
	observers: FakeObserver[];
	triggerMutations: () => void;
	restore: () => void;
};

function installGlobal(
	key: PropertyKey,
	value: unknown,
	descriptors: Map<PropertyKey, PropertyDescriptor | undefined>
): void {
	descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
}

function createRuntimeHarness(): RuntimeHarness {
	const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
	const document = new FakeDocument();
	const observers: FakeObserver[] = [];

	class TestMutationObserver {
		public disconnected = false;
		public target: object | undefined;
		public options: MutationObserverInit | undefined;
		public readonly callback: MutationCallback;

		public constructor(callback: MutationCallback) {
			this.callback = callback;
			observers.push(this as unknown as FakeObserver);
		}

		public observe(target: object, options?: MutationObserverInit): void {
			this.target = target;
			this.options = options;
		}

		public disconnect(): void {
			this.disconnected = true;
		}

		public trigger(): void {
			if (this.disconnected) return;
			const target = document.getElementById('serverHolder') ?? document.body;
			this.callback([{ target } as unknown as MutationRecord], this as unknown as MutationObserver);
		}
	}

	installGlobal('document', document, descriptors);
	installGlobal('HTMLElement', FakeHTMLElement, descriptors);
	installGlobal('MutationObserver', TestMutationObserver, descriptors);

	return {
		document,
		observers,
		triggerMutations: () => {
			for (const observer of observers) (observer as TestMutationObserver).trigger();
		},
		restore: () => {
			for (const [key, descriptor] of descriptors) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	};
}

function appendText(element: FakeHTMLElement, text: string): FakeTextNode {
	const node = new FakeTextNode(text);
	element.append(node);
	return node;
}

function makeServerBlock(document: FakeDocument, label: string): ServerBlock {
	const slug = label.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
	const heading = document.createElement('div');
	heading.id = `heading-${slug}`;
	heading.className = 'setHed';
	appendText(heading, `  ${label}  `);

	const onlineCount = document.createElement('span');
	onlineCount.className = 'onlineCount';
	onlineCount.textContent = '42 online';
	const quickJoin = document.createElement('button');
	quickJoin.className = 'quickJoin';
	quickJoin.textContent = 'Quick Join';
	heading.append(onlineCount, quickJoin);

	const body = document.createElement('div');
	body.id = `body-${slug}`;
	body.className = 'serverBody';
	body.textContent = `body:${label}`;
	const footer = document.createElement('div');
	footer.id = `footer-${slug}`;
	footer.className = 'serverFooter';
	footer.textContent = `footer:${label}`;

	return { label, heading, nodes: [heading, body, footer] };
}

function appendServerBlocks(holder: FakeHTMLElement, ...blocks: readonly ServerBlock[]): void {
	holder.append(...blocks.flatMap(block => block.nodes));
}

function directChildIds(holder: FakeHTMLElement): string[] {
	return holder.children.map(child => child.id);
}

function headingLabels(holder: FakeHTMLElement): string[] {
	return holder.children
		.filter(child => child.matches('.setHed'))
		.map(child => child.childNodes
			.filter(node => node.nodeType === 3)
			.map(node => node.textContent?.trim() ?? '')
			.join(' '));
}

function generatedPingLabel(heading: FakeHTMLElement): FakeHTMLElement | null {
	return heading.querySelector(`.${PUBLIC_SERVER_PING_LABEL_CLASS}`);
}

async function flushRuntime(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve();
}

function enableRuntime(
	measure: (regions: readonly string[]) => Promise<unknown>
): void {
	applyPublicServerPingSortSettings({ wokPublicServerPingSort: true } as never, measure);
}

test('sorts the initial serverHolder, pins fixed categories, annotates numeric pings, and preserves blocks', async () => {
	const harness = createRuntimeHarness();
	const { document } = harness;
	const holder = document.createElement('div');
	holder.id = 'serverHolder';
	const blocks = [
		makeServerBlock(document, 'Sydney'),
		makeServerBlock(document, 'Custom Games'),
		makeServerBlock(document, 'Frankfurt'),
		makeServerBlock(document, 'Official Customs'),
		makeServerBlock(document, 'New York')
	];
	appendServerBlocks(holder, ...blocks);
	document.body.append(holder);

	try {
		enableRuntime(async () => ({ SYD: 212.4, FRA: 91.6, NY: 34.2 }));
		await flushRuntime();

		assert.deepEqual(headingLabels(holder), [
			'Custom Games',
			'Official Customs',
			'New York',
			'Frankfurt',
			'Sydney'
		]);
		assert.deepEqual(directChildIds(holder), [
			'heading-custom-games',
			'body-custom-games',
			'footer-custom-games',
			'heading-official-customs',
			'body-official-customs',
			'footer-official-customs',
			'heading-new-york',
			'body-new-york',
			'footer-new-york',
			'heading-frankfurt',
			'body-frankfurt',
			'footer-frankfurt',
			'heading-sydney',
			'body-sydney',
			'footer-sydney'
		]);
		assert.equal(generatedPingLabel(blocks[0].heading)?.textContent, '212 ms');
		assert.equal(generatedPingLabel(blocks[2].heading)?.textContent, '92 ms');
		assert.equal(generatedPingLabel(blocks[4].heading)?.textContent, '34 ms');
		assert.equal(generatedPingLabel(blocks[1].heading), null);
		assert.equal(generatedPingLabel(blocks[3].heading), null);
		assert.equal(blocks[2].nodes.every(node => node.parentElement === holder), true);
		assert.equal(blocks[2].heading.querySelector('.quickJoin')?.textContent, 'Quick Join');
	} finally {
		stopPublicServerPingSort();
		harness.restore();
	}
});

test('renders pings as aligned badges without changing heading controls', async () => {
	const harness = createRuntimeHarness();
	const { document } = harness;
	const holder = document.createElement('div');
	holder.id = 'serverHolder';
	const frankfurt = makeServerBlock(document, 'Frankfurt');
	appendServerBlocks(holder, frankfurt);
	document.body.append(holder);

	try {
		enableRuntime(async () => ({ FRA: 46 }));
		await flushRuntime();

		const pingLabel = generatedPingLabel(frankfurt.heading);
		assert.ok(pingLabel);
		assert.equal(pingLabel.textContent, '46 ms');
		assert.deepEqual(frankfurt.heading.children.map(child => child.className), [
			'onlineCount',
			PUBLIC_SERVER_PING_LABEL_CLASS,
			'quickJoin'
		]);

		const style = document.getElementById(PUBLIC_SERVER_PING_STYLE_ID);
		assert.ok(style);
		assert.match(style.textContent ?? '', /#serverHolder \.wok-public-region-ping/iu);
		assert.match(style.textContent ?? '', /display: inline-flex/iu);
		assert.match(style.textContent ?? '', /float: right/iu);
		assert.match(style.textContent ?? '', /min-width: 58px/iu);
		assert.match(style.textContent ?? '', /border-radius: 999px/iu);
		assert.match(style.textContent ?? '', /font-variant-numeric: tabular-nums/iu);
		assert.doesNotMatch(style.textContent ?? '', /margin-right: 116px/iu);
	} finally {
		stopPublicServerPingSort();
		harness.restore();
	}
});

test('keeps timed-out regions at the bottom in their original unresolved order', async () => {
	const harness = createRuntimeHarness();
	const { document } = harness;
	const holder = document.createElement('div');
	holder.id = 'serverHolder';
	const blocks = [
		makeServerBlock(document, 'Sydney'),
		makeServerBlock(document, 'Moon Base'),
		makeServerBlock(document, 'Tokyo'),
		makeServerBlock(document, 'Frankfurt')
	];
	appendServerBlocks(holder, ...blocks);
	document.body.append(holder);

	try {
		enableRuntime(async () => ({ FRA: 90 }));
		await flushRuntime();

		assert.deepEqual(headingLabels(holder), ['Frankfurt', 'Sydney', 'Moon Base', 'Tokyo']);
		// Observer callbacks caused by WOK's own first reorder must not redefine source order.
		harness.triggerMutations();
		await flushRuntime();
		assert.deepEqual(headingLabels(holder), ['Frankfurt', 'Sydney', 'Moon Base', 'Tokyo']);
		assert.equal(generatedPingLabel(blocks[0].heading)?.textContent, '—');
		assert.equal(generatedPingLabel(blocks[2].heading)?.textContent, '—');
		assert.equal(generatedPingLabel(blocks[3].heading)?.textContent, '90 ms');
	} finally {
		stopPublicServerPingSort();
		harness.restore();
	}
});

test('reconciles a late-added holder and then a replaced server DOM without recreating nodes', async () => {
	const harness = createRuntimeHarness();
	const { document } = harness;
	const measurements: string[][] = [];
	const pingByRegion: Readonly<Record<string, number>> = { FRA: 90, SYD: 40, NY: 20, TOK: 180 };

	try {
		enableRuntime(async regions => {
			measurements.push([...regions]);
			return Object.fromEntries(regions
				.filter(region => pingByRegion[region] !== undefined)
				.map(region => [region, pingByRegion[region]]));
		});
		const holder = document.createElement('div');
		holder.id = 'serverHolder';
		const frankfurt = makeServerBlock(document, 'Frankfurt');
		const sydney = makeServerBlock(document, 'Sydney');
		appendServerBlocks(holder, frankfurt, sydney);
		document.body.append(holder);
		harness.triggerMutations();
		await flushRuntime();
		assert.deepEqual(headingLabels(holder), ['Sydney', 'Frankfurt']);
		assert.deepEqual(measurements, [['FRA', 'SYD']]);

		const newYork = makeServerBlock(document, 'New York');
		appendServerBlocks(holder, newYork);
		harness.triggerMutations();
		await flushRuntime();
		assert.deepEqual(headingLabels(holder), ['New York', 'Sydney', 'Frankfurt']);
		assert.deepEqual(newYork.nodes.map(node => node.parentElement), [holder, holder, holder]);
		assert.equal(generatedPingLabel(newYork.heading)?.textContent, '20 ms');
		assert.deepEqual(measurements, [['FRA', 'SYD'], ['FRA', 'NY', 'SYD']]);

		const official = makeServerBlock(document, 'Official Customs');
		const tokyo = makeServerBlock(document, 'Tokyo');
		holder.replaceChildren(...official.nodes, ...tokyo.nodes);
		harness.triggerMutations();
		await flushRuntime();
		assert.deepEqual(headingLabels(holder), ['Official Customs', 'Tokyo']);
		assert.deepEqual(tokyo.nodes.map(node => node.parentElement), [holder, holder, holder]);
		assert.equal(generatedPingLabel(official.heading), null);
		assert.equal(generatedPingLabel(tokyo.heading)?.textContent, '180 ms');
		assert.deepEqual(measurements, [['FRA', 'SYD'], ['FRA', 'NY', 'SYD'], ['TOK']]);
	} finally {
		stopPublicServerPingSort();
		harness.restore();
	}
});

test('measures a replacement region batch that appears while the first batch is in flight', async () => {
	const harness = createRuntimeHarness();
	const { document } = harness;
	const holder = document.createElement('div');
	holder.id = 'serverHolder';
	appendServerBlocks(
		holder,
		makeServerBlock(document, 'Frankfurt'),
		makeServerBlock(document, 'Sydney')
	);
	document.body.append(holder);
	const measurements: string[][] = [];
	let resolveFirst: ((value: unknown) => void) | undefined;

	try {
		enableRuntime(async regions => {
			measurements.push([...regions]);
			if (measurements.length === 1) {
				return await new Promise(resolve => {
					resolveFirst = resolve;
				});
			}
			return { NY: 20, TOK: 180 };
		});

		const newYork = makeServerBlock(document, 'New York');
		const tokyo = makeServerBlock(document, 'Tokyo');
		holder.replaceChildren(...tokyo.nodes, ...newYork.nodes);
		harness.triggerMutations();
		await flushRuntime();
		assert.deepEqual(measurements, [['FRA', 'SYD']]);

		resolveFirst?.({ FRA: 90, SYD: 40 });
		await flushRuntime();
		assert.deepEqual(measurements, [['FRA', 'SYD'], ['NY', 'TOK']]);
		assert.deepEqual(headingLabels(holder), ['New York', 'Tokyo']);
		assert.equal(generatedPingLabel(newYork.heading)?.textContent, '20 ms');
		assert.equal(generatedPingLabel(tokyo.heading)?.textContent, '180 ms');
	} finally {
		stopPublicServerPingSort();
		harness.restore();
	}
});

test('does not touch nodes outside direct setHed blocks', async () => {
	const harness = createRuntimeHarness();
	const { document } = harness;
	const outsideBefore = document.createElement('aside');
	outsideBefore.id = 'outside-before';
	outsideBefore.className = 'untouched';
	outsideBefore.textContent = 'before';
	const outsideAfter = document.createElement('aside');
	outsideAfter.id = 'outside-after';
	outsideAfter.className = 'untouched';
	outsideAfter.textContent = 'after';
	const unrelatedHeading = document.createElement('div');
	unrelatedHeading.className = 'setHed';
	appendText(unrelatedHeading, 'Not in serverHolder');
	outsideAfter.append(unrelatedHeading);

	const holder = document.createElement('div');
	holder.id = 'serverHolder';
	const prefix = document.createElement('div');
	prefix.id = 'untouched-prefix';
	prefix.className = 'notAHeading';
	prefix.textContent = 'prefix';
	const frankfurt = makeServerBlock(document, 'Frankfurt');
	const sydney = makeServerBlock(document, 'Sydney');
	holder.append(prefix);
	appendServerBlocks(holder, sydney, frankfurt);
	document.body.append(outsideBefore, holder, outsideAfter);
	const bodyOrderBefore = [...document.body.children];

	try {
		enableRuntime(async () => ({ FRA: 90, SYD: 40 }));
		await flushRuntime();
		harness.triggerMutations();
		await flushRuntime();

		assert.deepEqual([...document.body.children], bodyOrderBefore);
		assert.equal(outsideBefore.textContent, 'before');
		assert.equal(outsideBefore.className, 'untouched');
		assert.equal(outsideAfter.textContent, 'after');
		assert.equal(outsideAfter.className, 'untouched');
		assert.equal(unrelatedHeading.querySelector(`.${PUBLIC_SERVER_PING_LABEL_CLASS}`), null);
		assert.equal(holder.children[0], prefix);
		assert.equal(prefix.textContent, 'prefix');
		assert.equal(prefix.className, 'notAHeading');
	} finally {
		stopPublicServerPingSort();
		harness.restore();
	}
});

test('disabling restores the original order and removes generated labels and styles', async () => {
	const harness = createRuntimeHarness();
	const { document } = harness;
	const holder = document.createElement('div');
	holder.id = 'serverHolder';
	const sydney = makeServerBlock(document, 'Sydney');
	const frankfurt = makeServerBlock(document, 'Frankfurt');
	const official = makeServerBlock(document, 'Official Customs');
	appendServerBlocks(holder, sydney, frankfurt, official);
	document.body.append(holder);
	const originalOrder = [...holder.children];
	const quickJoin = sydney.heading.querySelector('.quickJoin');

	try {
		enableRuntime(async () => ({ FRA: 90, SYD: 40 }));
		await flushRuntime();
		assert.notDeepEqual([...holder.children], originalOrder);
		assert.ok(generatedPingLabel(sydney.heading));
		assert.ok(generatedPingLabel(frankfurt.heading));
		assert.ok(document.getElementById(PUBLIC_SERVER_PING_STYLE_ID));

		stopPublicServerPingSort();

		assert.deepEqual([...holder.children], originalOrder);
		assert.equal(document.querySelectorAll(`.${PUBLIC_SERVER_PING_LABEL_CLASS}`).length, 0);
		assert.equal(document.getElementById(PUBLIC_SERVER_PING_STYLE_ID), null);
		assert.equal(generatedPingLabel(sydney.heading), null);
		assert.equal(sydney.heading.querySelector('.quickJoin'), quickJoin);
		assert.equal(harness.observers[0].disconnected, true);
	} finally {
		stopPublicServerPingSort();
		harness.restore();
	}
});
