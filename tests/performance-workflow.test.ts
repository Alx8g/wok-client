import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('observe-only performance checks reference existing tests and cover the optimised paths', () => {
	const workflow = readFileSync(new URL('.github/workflows/source-validation.yml', root), 'utf8');
	const command = workflow.match(/^\s+run: node --test (.+)$/mu)?.[1];
	assert.ok(command, 'the performance test command must exist');
	const paths = command.trim().split(/\s+/u);
	for (const path of paths) assert.ok(existsSync(new URL(path, root)), `missing performance test: ${path}`);
	assert.ok(paths.includes('tests/identity-rewrite.test.ts'));
	assert.ok(paths.includes('tests/mutation-relevance.test.ts'));
	assert.ok(paths.includes('tests/menu-declutter-mutations.test.ts'));
});
