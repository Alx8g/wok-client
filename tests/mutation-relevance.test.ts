import assert from 'node:assert/strict';
import test from 'node:test';
import { mutationRecordsTouchSelector, type MutationElementLike } from '../src/mutation-relevance.ts';

function element(options: {
	closest?: boolean;
	contains?: boolean;
	matches?: boolean;
	parentElement?: MutationElementLike | null;
} = {}): MutationElementLike {
	return {
		closest: () => options.closest || options.matches ? {} : null,
		matches: () => options.matches === true,
		parentElement: options.parentElement,
		querySelector: () => options.contains ? {} : null
	};
}

test('accepts mutations inside, adding, or removing the owned surface', () => {
	assert.equal(mutationRecordsTouchSelector([{ target: element({ closest: true }) }], '#owned'), true);
	assert.equal(mutationRecordsTouchSelector([{
		target: element(),
		addedNodes: [element({ contains: true })]
	}], '#owned'), true);
	assert.equal(mutationRecordsTouchSelector([{
		target: element(),
		removedNodes: [element({ matches: true })]
	}], '#owned'), true);
});

test('closest includes the element itself without a second selector match', () => {
	let closestCalls = 0;
	const owned = {
		closest: () => { closestCalls++; return {}; },
		matches: () => { assert.fail('closest already tests the element itself'); }
	};
	assert.equal(mutationRecordsTouchSelector([{ target: owned }], '#owned'), true);
	assert.equal(closestCalls, 1);
	assert.equal(mutationRecordsTouchSelector([{ target: { matches: () => true } }], '#owned'), true,
		'element-like adapters without closest retain direct matching');
});

test('text mutations do not search the parent subtree for unrelated owned siblings', () => {
	let ancestorChecks = 0;
	const parent = {
		closest: (): null => { ancestorChecks++; return null; },
		matches: () => false,
		querySelector: () => { assert.fail('a text node cannot contain an owned surface'); }
	};
	assert.equal(mutationRecordsTouchSelector([{
		target: parent,
		addedNodes: [{ parentElement: parent }],
		removedNodes: [{}]
	}], '#owned'), false);
	assert.equal(ancestorChecks, 2);
});

test('added element subtrees still discover nested owned surfaces', () => {
	let subtreeChecks = 0;
	const added = {
		closest: (): null => null,
		matches: () => false,
		querySelector: () => { subtreeChecks++; return {}; }
	};
	assert.equal(mutationRecordsTouchSelector([{ target: element(), addedNodes: [added] }], '#owned'), true);
	assert.equal(mutationRecordsTouchSelector([{ target: element(), removedNodes: [added] }], '#owned'), true);
	assert.equal(subtreeChecks, 2);
});

test('rejects unrelated gameplay mutations and supports text-node parents', () => {
	assert.equal(mutationRecordsTouchSelector([{
		target: element(),
		addedNodes: [element()],
		removedNodes: [element()]
	}], '#owned'), false);
	assert.equal(mutationRecordsTouchSelector([{
		target: element({ contains: true })
	}], '#owned'), false, 'an unchanged owned descendant does not make a broad parent mutation relevant');
	assert.equal(mutationRecordsTouchSelector([{
		target: { parentElement: element({ closest: true }) }
	}], '#owned'), true);
});
