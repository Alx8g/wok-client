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
		closest: () => options.closest ? {} : null,
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
