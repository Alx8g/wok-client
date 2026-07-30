import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { migrateLegacyConfigs } from '../src/config-migration.ts';

function createTestRoot(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), 'wok-client-migration-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function writeTestFile(path: string, contents: string) {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, contents);
}

test('copies legacy configuration recursively without deleting the source', t => {
	const root = createTestRoot(t);
	const source = join(root, 'crankshaft', 'config');
	const destination = join(root, 'WOK Client', 'config');
	writeTestFile(join(source, 'settings.json'), '{"fpsUncap":true}');
	writeTestFile(join(source, 'swapper', 'textures', 'weapon.png'), 'texture');
	writeTestFile(join(source, 'scripts', 'tracker.json'), '{}');

	const result = migrateLegacyConfigs(destination, [{ label: 'Crankshaft AppData', path: source }]);

	assert.equal(result.completed, true);
	assert.equal(result.copiedFiles, 3);
	assert.equal(readFileSync(join(destination, 'settings.json'), 'utf-8'), '{"fpsUncap":true}');
	assert.equal(readFileSync(join(destination, 'swapper', 'textures', 'weapon.png'), 'utf-8'), 'texture');
	assert.equal(existsSync(join(source, 'settings.json')), true);
});

test('preserves WOK Client files and copies only missing legacy files', t => {
	const root = createTestRoot(t);
	const source = join(root, 'legacy');
	const destination = join(root, 'current');
	writeTestFile(join(source, 'settings.json'), 'legacy');
	writeTestFile(join(source, 'filters.txt'), 'legacy filters');
	writeTestFile(join(destination, 'settings.json'), 'current');

	const result = migrateLegacyConfigs(destination, [{ label: 'Legacy', path: source }]);

	assert.equal(result.skippedConflicts, 1);
	assert.equal(result.copiedFiles, 1);
	assert.equal(readFileSync(join(destination, 'settings.json'), 'utf-8'), 'current');
	assert.equal(readFileSync(join(destination, 'filters.txt'), 'utf-8'), 'legacy filters');
});

test('uses source order for conflicts and does not repeat a completed migration', t => {
	const root = createTestRoot(t);
	const appDataSource = join(root, 'appdata');
	const documentsSource = join(root, 'documents');
	const destination = join(root, 'destination');
	writeTestFile(join(appDataSource, 'settings.json'), 'appdata');
	writeTestFile(join(documentsSource, 'settings.json'), 'documents');

	const firstResult = migrateLegacyConfigs(destination, [
		{ label: 'AppData', path: appDataSource },
		{ label: 'Documents', path: documentsSource }
	]);
	writeTestFile(join(appDataSource, 'added-later.txt'), 'later');
	const secondResult = migrateLegacyConfigs(destination, [{ label: 'AppData', path: appDataSource }]);

	assert.equal(firstResult.skippedConflicts, 1);
	assert.equal(readFileSync(join(destination, 'settings.json'), 'utf-8'), 'appdata');
	assert.equal(secondResult.completed, true);
	assert.equal(secondResult.copiedFiles, 0);
	assert.equal(existsSync(join(destination, 'added-later.txt')), false);
});
