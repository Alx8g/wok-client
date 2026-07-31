import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { migrateLegacyConfigsPhaseOne, migrateLegacyConfigsPhaseTwo } from '../src/config-migration.ts';

const MIGRATION_MARKER = '.wok-client-migration-v1.json';

function createTestRoot(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), 'wok-client-migration-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function writeTestFile(path: string, contents: string) {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, contents);
}

test('phase 1 copies top-level files synchronously, defers directory trees, and writes no marker', t => {
	const root = createTestRoot(t);
	const source = join(root, 'crankshaft', 'config');
	const destination = join(root, 'WOK Client', 'config');
	writeTestFile(join(source, 'settings.json'), '{"fpsUncap":true}');
	writeTestFile(join(source, 'filters.txt'), 'legacy filters');
	writeTestFile(join(source, 'swapper', 'textures', 'weapon.png'), 'texture');

	const result = migrateLegacyConfigsPhaseOne(destination, [{ label: 'Crankshaft AppData', path: source }]);

	assert.equal(result.completed, false);
	assert.equal(result.copiedFiles, 2);
	assert.equal(result.errors, 0);
	assert.deepEqual(result.deferredSources, [{ label: 'Crankshaft AppData', path: source }]);
	assert.equal(readFileSync(join(destination, 'settings.json'), 'utf-8'), '{"fpsUncap":true}');
	assert.equal(readFileSync(join(destination, 'filters.txt'), 'utf-8'), 'legacy filters');
	assert.equal(existsSync(join(destination, 'swapper')), false);
	assert.equal(existsSync(join(destination, MIGRATION_MARKER)), false);
	assert.equal(existsSync(join(source, 'settings.json')), true);
});

test('phase 2 copies directory trees recursively without deleting the source and writes the marker', async t => {
	const root = createTestRoot(t);
	const source = join(root, 'crankshaft', 'config');
	const destination = join(root, 'WOK Client', 'config');
	writeTestFile(join(source, 'settings.json'), '{"fpsUncap":true}');
	writeTestFile(join(source, 'swapper', 'textures', 'weapon.png'), 'texture');
	writeTestFile(join(source, 'scripts', 'tracker.json'), '{}');
	writeTestFile(join(source, 'css', 'custom.css'), 'body {}');

	const phaseOne = migrateLegacyConfigsPhaseOne(destination, [{ label: 'Crankshaft AppData', path: source }]);
	const phaseTwo = await migrateLegacyConfigsPhaseTwo(destination, phaseOne.deferredSources);

	assert.equal(phaseOne.copiedFiles, 1);
	assert.equal(phaseTwo.completed, true);
	assert.equal(phaseTwo.copiedFiles, 3);
	assert.equal(phaseTwo.errors, 0);
	assert.equal(readFileSync(join(destination, 'settings.json'), 'utf-8'), '{"fpsUncap":true}');
	assert.equal(readFileSync(join(destination, 'swapper', 'textures', 'weapon.png'), 'utf-8'), 'texture');
	assert.equal(readFileSync(join(destination, 'scripts', 'tracker.json'), 'utf-8'), '{}');
	assert.equal(readFileSync(join(destination, 'css', 'custom.css'), 'utf-8'), 'body {}');
	assert.equal(existsSync(join(destination, MIGRATION_MARKER)), true);
	assert.equal(existsSync(join(source, 'swapper', 'textures', 'weapon.png')), true);
});

test('preserves WOK Client files and copies only missing legacy files', t => {
	const root = createTestRoot(t);
	const source = join(root, 'legacy');
	const destination = join(root, 'current');
	writeTestFile(join(source, 'settings.json'), 'legacy');
	writeTestFile(join(source, 'filters.txt'), 'legacy filters');
	writeTestFile(join(destination, 'settings.json'), 'current');

	const result = migrateLegacyConfigsPhaseOne(destination, [{ label: 'Legacy', path: source }]);

	assert.equal(result.skippedConflicts, 1);
	assert.equal(result.copiedFiles, 1);
	assert.equal(readFileSync(join(destination, 'settings.json'), 'utf-8'), 'current');
	assert.equal(readFileSync(join(destination, 'filters.txt'), 'utf-8'), 'legacy filters');
});

test('phase 2 preserves WOK Client files inside deferred trees', async t => {
	const root = createTestRoot(t);
	const source = join(root, 'legacy');
	const destination = join(root, 'current');
	writeTestFile(join(source, 'css', 'example.css'), 'legacy example');
	writeTestFile(join(source, 'css', 'custom.css'), 'legacy custom');
	writeTestFile(join(destination, 'css', 'example.css'), 'wok example');

	const result = await migrateLegacyConfigsPhaseTwo(destination, [{ label: 'Legacy', path: source }]);

	assert.equal(result.completed, true);
	assert.equal(result.skippedConflicts, 1);
	assert.equal(result.copiedFiles, 1);
	assert.equal(readFileSync(join(destination, 'css', 'example.css'), 'utf-8'), 'wok example');
	assert.equal(readFileSync(join(destination, 'css', 'custom.css'), 'utf-8'), 'legacy custom');
	assert.equal(readFileSync(join(source, 'css', 'example.css'), 'utf-8'), 'legacy example');
});

test('an interrupted phase 2 resumes on the next launch without overwriting existing files', async t => {
	const root = createTestRoot(t);
	const source = join(root, 'legacy');
	const destination = join(root, 'current');
	writeTestFile(join(source, 'swapper', 'textures', 'a.png'), 'legacy-a');
	writeTestFile(join(source, 'swapper', 'textures', 'b.png'), 'legacy-b');
	writeTestFile(join(source, 'scripts', 's.js'), 'legacy-s');

	// Simulate an interrupted earlier phase 2: one file already arrived, no marker written.
	writeTestFile(join(destination, 'swapper', 'textures', 'a.png'), 'already-migrated');

	const resumed = await migrateLegacyConfigsPhaseTwo(destination, [{ label: 'Legacy', path: source }]);

	assert.equal(resumed.completed, true);
	assert.equal(resumed.copiedFiles, 2);
	assert.equal(resumed.skippedConflicts, 1);
	assert.equal(readFileSync(join(destination, 'swapper', 'textures', 'a.png'), 'utf-8'), 'already-migrated');
	assert.equal(readFileSync(join(destination, 'swapper', 'textures', 'b.png'), 'utf-8'), 'legacy-b');
	assert.equal(readFileSync(join(destination, 'scripts', 's.js'), 'utf-8'), 'legacy-s');
	assert.equal(existsSync(join(destination, MIGRATION_MARKER)), true);

	const rerun = await migrateLegacyConfigsPhaseTwo(destination, [{ label: 'Legacy', path: source }]);
	assert.equal(rerun.completed, true);
	assert.equal(rerun.copiedFiles, 0);
});

test('phase 2 copies large nested trees completely with bounded concurrency', async t => {
	const root = createTestRoot(t);
	const source = join(root, 'legacy');
	const destination = join(root, 'current');
	const expected: string[] = [];
	for (let directory = 0; directory < 6; directory++) {
		for (let file = 0; file < 10; file++) {
			const relativePath = join('swapper', `dir-${directory}`, 'nested', `file-${file}.png`);
			writeTestFile(join(source, relativePath), relativePath);
			expected.push(relativePath);
		}
	}

	const result = await migrateLegacyConfigsPhaseTwo(destination, [{ label: 'Legacy', path: source }], 4);

	assert.equal(result.completed, true);
	assert.equal(result.copiedFiles, expected.length);
	assert.equal(result.errors, 0);
	for (const relativePath of expected) {
		assert.equal(readFileSync(join(destination, relativePath), 'utf-8'), relativePath);
	}
});

test('uses source order for conflicts and does not repeat a completed migration', async t => {
	const root = createTestRoot(t);
	const appDataSource = join(root, 'appdata');
	const documentsSource = join(root, 'documents');
	const destination = join(root, 'destination');
	writeTestFile(join(appDataSource, 'settings.json'), 'appdata');
	writeTestFile(join(documentsSource, 'settings.json'), 'documents');

	const sources = [
		{ label: 'AppData', path: appDataSource },
		{ label: 'Documents', path: documentsSource }
	];
	const firstPhaseOne = migrateLegacyConfigsPhaseOne(destination, sources);
	const firstPhaseTwo = await migrateLegacyConfigsPhaseTwo(destination, firstPhaseOne.deferredSources);

	writeTestFile(join(appDataSource, 'added-later.txt'), 'later');
	const secondPhaseOne = migrateLegacyConfigsPhaseOne(destination, sources);
	const secondPhaseTwo = await migrateLegacyConfigsPhaseTwo(destination, sources);

	assert.equal(firstPhaseOne.skippedConflicts, 1);
	assert.equal(firstPhaseTwo.completed, true);
	assert.equal(readFileSync(join(destination, 'settings.json'), 'utf-8'), 'appdata');
	assert.equal(secondPhaseOne.completed, true);
	assert.equal(secondPhaseOne.copiedFiles, 0);
	assert.deepEqual(secondPhaseOne.deferredSources, []);
	assert.equal(secondPhaseTwo.completed, true);
	assert.equal(secondPhaseTwo.copiedFiles, 0);
	assert.equal(existsSync(join(destination, 'added-later.txt')), false);
});
