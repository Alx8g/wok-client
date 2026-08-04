import assert from 'node:assert/strict';
import test from 'node:test';
import {
	applyCustomIdentity,
	CUSTOM_IDENTITY_ELEMENT_ID,
	CUSTOM_IDENTITY_STYLE_ID,
	getCustomIdentity,
	getCustomIdentityLabel,
	mountCustomIdentityNameplate,
	stopCustomIdentityDisplay
} from '../src/custom-identity-display.ts';

interface FakeElement {
	attributes: Map<string, string>;
	children: FakeElement[];
	className: string;
	id: string;
	parent: FakeElement | undefined;
	tagName: string;
	textContent: string;
	appendChild(child: FakeElement): FakeElement;
	remove(): void;
	setAttribute(name: string, value: string): void;
}

function createFakeElement(tagName: string): FakeElement {
	const element: FakeElement = {
		attributes: new Map(),
		children: [],
		className: '',
		id: '',
		parent: undefined,
		tagName,
		textContent: '',
		appendChild(child) {
			child.parent = element;
			element.children.push(child);
			return child;
		},
		remove() {
			const parent = element.parent;
			if (!parent) return;
			parent.children = parent.children.filter(child => child !== element);
			element.parent = undefined;
		},
		setAttribute(name, value) {
			element.attributes.set(name, value);
		}
	};
	return element;
}

function createFakeDocument(options: { body?: boolean } = {}) {
	const body = options.body === false ? undefined : createFakeElement('body');
	const head = createFakeElement('head');
	return {
		document: { body, createElement: createFakeElement, head } as unknown as Document,
		body,
		head
	};
}

function findById(root: FakeElement | undefined, id: string): FakeElement | undefined {
	if (!root) return undefined;
	for (const child of root.children) {
		if (child.id === id) return child;
		const found = findById(child, id);
		if (found) return found;
	}
	return undefined;
}

test('mounts a client-owned nameplate and nothing else', () => {
	const { document, body, head } = createFakeDocument();
	const nameplate = mountCustomIdentityNameplate({ clan: 'WOK', name: 'Rocketeer' }, { document });
	assert.ok(nameplate);

	const container = findById(body, CUSTOM_IDENTITY_ELEMENT_ID);
	assert.ok(container, 'the nameplate is mounted on <body>, beside the splash and the overlay');
	assert.equal(container.children[0].textContent, '[WOK] Rocketeer');
	assert.equal(container.attributes.get('data-wok-identity'), 'set');
	// The badge says out loud that this is local, so nobody reads it as an account rename.
	assert.equal(container.children[1].textContent, 'Local display only');
	assert.match(container.attributes.get('aria-label') ?? '', /local display only/u);

	const style = findById(head, CUSTOM_IDENTITY_STYLE_ID);
	assert.ok(style, 'menu-only visibility is a stylesheet rule, not an observer');
	assert.match(style.textContent, /#uiBase\.onMenu/u);
	assert.equal(body?.children.length, 1);
});

test('updates in place and clears itself when both settings are emptied', () => {
	const { document, body } = createFakeDocument();
	const nameplate = mountCustomIdentityNameplate({ clan: '', name: 'Rocketeer' }, { document });
	assert.ok(nameplate);
	const container = findById(body, CUSTOM_IDENTITY_ELEMENT_ID);
	assert.ok(container);
	assert.equal(container.children[0].textContent, 'Rocketeer');

	nameplate.update({ clan: 'WOK', name: '' });
	assert.equal(container.children[0].textContent, '[WOK]');
	assert.equal(container.attributes.get('data-wok-identity'), 'set');

	nameplate.update({ clan: '', name: '' });
	assert.equal(container.children[0].textContent, '');
	assert.equal(container.attributes.get('data-wok-identity'), 'unset');
	// The element stays mounted but hidden by the stylesheet; no relayout churn either way.
	assert.equal(body?.children.length, 1);
});

test('teardown removes every node it added and is repeatable', () => {
	const { document, body, head } = createFakeDocument();
	const nameplate = mountCustomIdentityNameplate({ clan: 'WOK', name: 'Rocketeer' }, { document });
	assert.ok(nameplate);

	nameplate.destroy();
	assert.equal(findById(body, CUSTOM_IDENTITY_ELEMENT_ID), undefined);
	assert.equal(findById(head, CUSTOM_IDENTITY_STYLE_ID), undefined);
	assert.equal(body?.children.length, 0);
	assert.equal(head.children.length, 0);

	nameplate.destroy();
	nameplate.update({ clan: 'X', name: 'Y' });
	assert.equal(body?.children.length, 0);
});

test('declines to mount before there is a document body', () => {
	const { document } = createFakeDocument({ body: false });
	assert.equal(mountCustomIdentityNameplate({ clan: 'WOK', name: 'Rocketeer' }, { document }), undefined);
});

test('shared state feeds the other client surfaces and resets on teardown', () => {
	try {
		assert.equal(getCustomIdentityLabel(), '');

		// No document in this process: the nameplate cannot mount, but the label the performance
		// overlay reads is still maintained from the preferences.
		applyCustomIdentity({ customClan: 'WOK', customName: 'Rocketeer' });
		assert.equal(getCustomIdentityLabel(), '[WOK] Rocketeer');
		assert.deepEqual(getCustomIdentity(), { clan: 'WOK', name: 'Rocketeer' });

		applyCustomIdentity({ customClan: '  ', customName: 'a'.repeat(64) });
		assert.equal(getCustomIdentityLabel(), 'a'.repeat(16));

		applyCustomIdentity({});
		assert.equal(getCustomIdentityLabel(), '');
	} finally {
		stopCustomIdentityDisplay();
	}
	assert.equal(getCustomIdentityLabel(), '');
	assert.deepEqual(getCustomIdentity(), { clan: '', name: '' });
});
