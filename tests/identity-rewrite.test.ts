import assert from 'node:assert/strict';
import test from 'node:test';
import { createIdentityTextRewriter, type IdentityMutationRecord, type IdentityRewriteCallback, type IdentityRewriteNode, NO_REWRITE_ATTRIBUTE, startIdentityRewriteEngine } from '../src/identity-rewrite.ts';
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
interface FakeNode extends IdentityRewriteNode {
	childNodes: FakeNode[];
	parent?: FakeNode;
}
function text(value: string): FakeNode {
	return { childNodes: [], data: value, isConnected: true, nodeType: TEXT_NODE };
}
function element(tagName: string, children: FakeNode[] = [], attributes: Record<string, string> = {}): FakeNode {
	const node: FakeNode = {
		childNodes: children,
		hasAttribute: (name) => Object.hasOwn(attributes, name),
		isConnected: true,
		nodeType: ELEMENT_NODE,
		tagName
	};
	for (const child of children) child.parent = node;
	return node;
}
function textNodesOf(node: FakeNode): FakeNode[] {
	if (node.nodeType === TEXT_NODE) return [node];
	return node.childNodes.flatMap(textNodesOf);
}
function allText(node: FakeNode): string[] {
	return textNodesOf(node).map((child) => child.data ?? '');
}
interface Harness {
	characterDataChanged(node: FakeNode, value: string): void;
	childAdded(parent: FakeNode, child: FakeNode): void;
	readonly disconnectCount: number;
	readonly frameCount: number;
	readonly observedOptions: unknown;
	runFrames(count?: number): void;
}
function createHarness(
	root: FakeNode,
	rewrite: (value: string) => string | undefined,
	engineOptions: {
		maxNodesPerFlush?: number;
		pruneThreshold?: number;
	} = {}
) {
	let callback: IdentityRewriteCallback = () => {};
	let disconnectCount = 0;
	let frameCount = 0;
	let cancelledFrames = 0;
	let observedOptions: unknown;
	const frames: (() => void)[] = [];
	const engine = startIdentityRewriteEngine({
		createObserver: (next) => {
			callback = next;
			return {
				disconnect: () => {
					disconnectCount += 1;
				},
				observe: (_target, options) => {
					observedOptions = options;
				}
			};
		},
		maxNodesPerFlush: engineOptions.maxNodesPerFlush,
		pruneThreshold: engineOptions.pruneThreshold,
		rewrite,
		root,
		schedule: (frame) => {
			frames.push(frame);
			return frames.length;
		},
		unschedule: () => {
			cancelledFrames += 1;
		}
	});
	const emit = (records: IdentityMutationRecord[]) => {
		callback(records);
	};
	const harness: Harness & {
		engine: typeof engine;
		readonly cancelledFrames: number;
	} = {
		get cancelledFrames() {
			return cancelledFrames;
		},
		characterDataChanged(node, value) {
			node.data = value;
			emit([{ type: 'characterData', target: node }]);
		},
		childAdded(parent, child) {
			parent.childNodes.push(child);
			child.parent = parent;
			emit([{ addedNodes: [child], type: 'childList' }]);
		},
		get disconnectCount() {
			return disconnectCount;
		},
		engine,
		get frameCount() {
			return frameCount;
		},
		get observedOptions() {
			return observedOptions;
		},
		runFrames(count = 1) {
			for (let index = 0; index < count; index += 1) {
				const frame = frames.shift();
				if (!frame) return;
				frameCount += 1;
				frame();
			}
		}
	};
	return harness;
}
const swapRocketeer = createIdentityTextRewriter({
	clans: ['OLD'],
	displayClan: 'WOK',
	displayName: 'Nightfall',
	names: ['Rocketeer']
});
test('replaces whole-token names and leaves lookalikes alone', () => {
	assert.ok(swapRocketeer);
	assert.equal(swapRocketeer('Rocketeer: gg'), 'Nightfall: gg');
	assert.equal(swapRocketeer('Rocketeer killed Bandit'), 'Nightfall killed Bandit');
	assert.equal(swapRocketeer('Bandit killed Rocketeer'), 'Bandit killed Nightfall');
	assert.equal(swapRocketeer('nice shot Rocketeer!'), 'nice shot Nightfall!');
	assert.equal(swapRocketeer('Rocketeer2'), undefined);
	assert.equal(swapRocketeer('xRocketeer'), undefined);
	assert.equal(swapRocketeer('Rocketeer_alt'), undefined);
	assert.equal(swapRocketeer('Rocketeer-alt'), undefined);
	assert.equal(swapRocketeer('rocketeer'), undefined);
	assert.equal(swapRocketeer('Bandit killed Sniper'), undefined);
});
test('replaces the clan tag only where it is unambiguously a clan tag', () => {
	assert.ok(swapRocketeer);
	assert.equal(swapRocketeer('[OLD] Rocketeer'), '[WOK] Nightfall');
	assert.equal(swapRocketeer('[OLD]Rocketeer: hello'), '[WOK]Nightfall: hello');
	assert.equal(swapRocketeer('OLD'), 'WOK');
	assert.equal(swapRocketeer('  OLD  '), '  WOK  ');
	assert.equal(swapRocketeer('OLD Rocketeer'), 'WOK Nightfall');
	assert.equal(swapRocketeer('that OLD map again'), undefined);
	assert.equal(swapRocketeer('[OLD] Bandit'), '[WOK] Bandit');
});
test('each half works on its own', () => {
	const clanOnly = createIdentityTextRewriter({ clans: ['OLD'], displayClan: 'WOK', displayName: '', names: ['Rocketeer'] });
	assert.ok(clanOnly);
	assert.equal(clanOnly('[OLD] Rocketeer'), '[WOK] Rocketeer');
	assert.equal(clanOnly('OLD Rocketeer'), 'WOK Rocketeer');
	assert.equal(clanOnly('Rocketeer: gg'), undefined);
	const nameOnly = createIdentityTextRewriter({ clans: ['OLD'], displayClan: '', displayName: 'Nightfall', names: ['Rocketeer'] });
	assert.ok(nameOnly);
	assert.equal(nameOnly('[OLD] Rocketeer'), '[OLD] Nightfall');
	assert.equal(nameOnly('OLD'), undefined);
});
test('matches any of several candidate names, longest first', () => {
	const rewriter = createIdentityTextRewriter({
		clans: [],
		displayClan: '',
		displayName: 'Nightfall',
		names: ['Rocket', 'RocketeerPro']
	});
	assert.ok(rewriter);
	assert.equal(rewriter('RocketeerPro wins'), 'Nightfall wins');
	assert.equal(rewriter('Rocket wins'), 'Nightfall wins');
});
test('there is nothing to build when nothing would change', () => {
	assert.equal(createIdentityTextRewriter({ clans: [], displayClan: '', displayName: '', names: [] }), undefined);
	assert.equal(createIdentityTextRewriter({ clans: [], displayClan: 'WOK', displayName: 'Nightfall', names: [] }), undefined);
	assert.equal(createIdentityTextRewriter({ clans: [], displayClan: '', displayName: 'Rocketeer', names: ['Rocketeer'] }), undefined);
	assert.equal(createIdentityTextRewriter({ clans: [''], displayClan: 'WOK', displayName: '', names: [''] }), undefined);
});
test('names carrying regex syntax are matched literally', () => {
	const rewriter = createIdentityTextRewriter({ clans: [], displayClan: '', displayName: 'Nightfall', names: ['a.b*c'] });
	assert.ok(rewriter);
	assert.equal(rewriter('a.b*c: gg'), 'Nightfall: gg');
	assert.equal(rewriter('axbxc: gg'), undefined);
});
test('sweeps the existing tree on the first frame and reports what it holds', () => {
	const chat = text('Rocketeer: gg');
	const root = element('BODY', [element('DIV', [chat]), element('DIV', [text('Bandit: gg')])]);
	const harness = createHarness(root, swapRocketeer);
	assert.deepEqual(harness.observedOptions, { characterData: true, childList: true, subtree: true });
	assert.equal(chat.data, 'Rocketeer: gg');
	harness.runFrames();
	assert.deepEqual(allText(root), ['Nightfall: gg', 'Bandit: gg']);
	assert.equal(harness.engine.rewrittenNodeCount, 1);
});
test('a burst of mutations costs one frame, and only the mutated subtrees are walked', () => {
	const root = element('BODY');
	const harness = createHarness(root, swapRocketeer);
	harness.runFrames();
	const killFeed = element('DIV', [text('Rocketeer killed Bandit')]);
	const chat = element('DIV', [text('Rocketeer: nice')]);
	harness.childAdded(root, killFeed);
	harness.childAdded(root, chat);
	const untouched = element('DIV', [text('Rocketeer elsewhere')]);
	root.childNodes.push(untouched);
	const before = harness.frameCount;
	harness.runFrames(4);
	assert.equal(harness.frameCount - before, 1, 'two mutations, one frame');
	assert.deepEqual(allText(killFeed), ['Nightfall killed Bandit']);
	assert.deepEqual(allText(chat), ['Nightfall: nice']);
	assert.deepEqual(allText(untouched), ['Rocketeer elsewhere']);
});
test('the engine ignores the mutations its own writes produce', () => {
	const chat = text('Rocketeer: gg');
	const root = element('BODY', [chat]);
	let rewriteCalls = 0;
	const harness = createHarness(root, (value) => {
		rewriteCalls += 1;
		return swapRocketeer?.(value);
	});
	harness.runFrames();
	assert.equal(chat.data, 'Nightfall: gg');
	const callsAfterFirstPass = rewriteCalls;
	harness.characterDataChanged(chat, 'Nightfall: gg');
	harness.runFrames(4);
	assert.equal(chat.data, 'Nightfall: gg');
	assert.equal(rewriteCalls, callsAfterFirstPass, 'an echo of our own write is recognised, not re-rewritten');
	harness.characterDataChanged(chat, 'Rocketeer: wp');
	harness.runFrames();
	assert.equal(chat.data, 'Nightfall: wp');
});
test('never rewrites what the user types, code, or anything opted out', () => {
	const chatInput = element('INPUT', [text('Rocketeer')]);
	const nameField = element('TEXTAREA', [text('Rocketeer')]);
	const option = element('OPTION', [text('Rocketeer')]);
	const script = element('SCRIPT', [text('Rocketeer')]);
	const style = element('STYLE', [text('Rocketeer')]);
	const editable = element('DIV', [text('Rocketeer')], { contenteditable: 'true' });
	const ownSurface = element('PRE', [text('Rocketeer')], { [NO_REWRITE_ATTRIBUTE]: '' });
	const chat = element('DIV', [text('Rocketeer: gg')]);
	const root = element('BODY', [chatInput, nameField, option, script, style, editable, ownSurface, chat]);
	const harness = createHarness(root, swapRocketeer);
	harness.runFrames(4);
	for (const excluded of [chatInput, nameField, option, script, style, editable, ownSurface]) {
		assert.deepEqual(allText(excluded), ['Rocketeer']);
	}
	assert.deepEqual(allText(chat), ['Nightfall: gg']);
	assert.equal(harness.engine.rewrittenNodeCount, 1);
});
test('an extra exclusion rule composes with the built-in ones', () => {
	const skipped = element('DIV', [text('Rocketeer')]);
	const kept = element('SPAN', [text('Rocketeer')]);
	const root = element('BODY', [skipped, kept]);
	startIdentityRewriteEngine({
		createObserver: () => ({ disconnect: () => {}, observe: () => {} }),
		isExcluded: (node) => node === skipped,
		rewrite: (value) => swapRocketeer?.(value),
		root,
		schedule: (frame) => {
			frame();
		}
	});
	assert.deepEqual(allText(skipped), ['Rocketeer']);
	assert.deepEqual(allText(kept), ['Nightfall']);
});
test('non-element, non-text nodes are stepped over', () => {
	const comment: FakeNode = { childNodes: [], isConnected: true, nodeType: COMMENT_NODE };
	const root = element('BODY', [comment, element('DIV', [text('Rocketeer')])]);
	const harness = createHarness(root, swapRocketeer);
	harness.runFrames(4);
	assert.deepEqual(allText(root), ['Nightfall']);
});
test('a walk that exceeds its budget finishes on later frames instead of blowing one', () => {
	const rows = Array.from({ length: 12 }, (_value, index) => element('DIV', [text(`Rocketeer ${index}`)]));
	const root = element('BODY', rows);
	const harness = createHarness(root, swapRocketeer, { maxNodesPerFlush: 5 });
	harness.runFrames();
	const doneAfterOneFrame = allText(root).filter((value) => value.startsWith('Nightfall')).length;
	assert.ok(doneAfterOneFrame > 0 && doneAfterOneFrame < 12, `partial progress, got ${doneAfterOneFrame}`);
	harness.runFrames(20);
	assert.equal(allText(root).filter((value) => value.startsWith('Nightfall')).length, 12);
});
test('detached nodes are swept out so the tracking map cannot grow forever', () => {
	const root = element('BODY');
	const harness = createHarness(root, swapRocketeer, { pruneThreshold: 4 });
	harness.runFrames();
	const lines = Array.from({ length: 6 }, (_value, index) => text(`Rocketeer ${index}`));
	for (const line of lines) harness.childAdded(root, line);
	harness.runFrames(4);
	assert.equal(harness.engine.rewrittenNodeCount, 6);
	for (const line of lines.slice(0, 5)) line.isConnected = false;
	harness.childAdded(root, text('Rocketeer again'));
	harness.runFrames(4);
	assert.equal(harness.engine.rewrittenNodeCount, 2);
});
test('restoreAll hands back exactly what the game wrote, and only that', () => {
	const mine = text('Rocketeer: gg');
	const theirs = text('Bandit: gg');
	const overwritten = text('Rocketeer: wp');
	const root = element('BODY', [mine, theirs, overwritten]);
	const harness = createHarness(root, swapRocketeer);
	harness.runFrames();
	assert.equal(mine.data, 'Nightfall: gg');
	overwritten.data = 'Bandit: wp';
	harness.engine.restoreAll();
	assert.equal(mine.data, 'Rocketeer: gg');
	assert.equal(theirs.data, 'Bandit: gg');
	assert.equal(overwritten.data, 'Bandit: wp');
	assert.equal(harness.engine.rewrittenNodeCount, 0);
	harness.engine.refresh();
	harness.runFrames(4);
	assert.equal(mine.data, 'Nightfall: gg');
});
test('stopping detaches the observer, drops queued work and cancels the pending frame', () => {
	const root = element('BODY', [text('Rocketeer: gg')]);
	const harness = createHarness(root, swapRocketeer);
	harness.engine.stop();
	assert.equal(harness.disconnectCount, 1);
	assert.equal(harness.cancelledFrames, 1);
	harness.runFrames(4);
	assert.deepEqual(allText(root), ['Rocketeer: gg'], 'a frame that still fires after stop does nothing');
	harness.childAdded(root, text('Rocketeer: again'));
	harness.engine.refresh();
	harness.engine.flush();
	harness.runFrames(4);
	assert.deepEqual(allText(root), ['Rocketeer: gg', 'Rocketeer: again']);
	harness.engine.stop();
	assert.equal(harness.disconnectCount, 1);
});
test('flush runs the queue without waiting for a frame', () => {
	const root = element('BODY', [text('Rocketeer: gg')]);
	const harness = createHarness(root, swapRocketeer);
	harness.engine.flush();
	assert.deepEqual(allText(root), ['Nightfall: gg']);
});
