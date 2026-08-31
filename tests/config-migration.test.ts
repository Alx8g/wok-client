import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
test('phase 1 copies only the startup-critical top-level allowlist and writes no marker', (t) => {
	const root = createTestRoot(t);
	const source = join(root, 'crankshaft', 'config');
	const destination = join(root, 'WOK Client', 'config');
	writeTestFile(join(source, 'settings.json'), '{"fpsUncap":true}');
	writeTestFile(join(source, 'filters.txt'), 'legacy filters');
	writeTestFile(join(source, 'future-config.json'), '{"future":true}');
	writeTestFile(join(source, 'notes.txt'), 'not required during startup');
	writeTestFile(join(source, 'swapper', 'textures', 'weapon.png'), 'texture');
	const result = migrateLegacyConfigsPhaseOne(destination, [{ label: 'Crankshaft AppData', path: source }]);
	assert.equal(result.completed, false);
	assert.equal(result.copiedFiles, 2);
	assert.equal(result.errors, 0);
	assert.deepEqual(result.deferredSources, [{ label: 'Crankshaft AppData', path: source }]);
	assert.equal(readFileSync(join(destination, 'settings.json'), 'utf-8'), '{"fpsUncap":true}');
	assert.equal(readFileSync(join(destination, 'filters.txt'), 'utf-8'), 'legacy filters');
	assert.equal(existsSync(join(destination, 'future-config.json')), false);
	assert.equal(existsSync(join(destination, 'notes.txt')), false);
	assert.equal(existsSync(join(destination, 'swapper')), false);
	assert.equal(existsSync(join(destination, MIGRATION_MARKER)), false);
	assert.equal(existsSync(join(source, 'settings.json')), true);
});
test('phase 2 copies deferred top-level files and directory trees without deleting the source', async (t) => {
	const root = createTestRoot(t);
	const source = join(root, 'crankshaft', 'config');
	const destination = join(root, 'WOK Client', 'config');
	writeTestFile(join(source, 'settings.json'), '{"fpsUncap":true}');
	writeTestFile(join(source, 'future-config.json'), '{"future":true}');
	writeTestFile(join(source, 'swapper', 'textures', 'weapon.png'), 'texture');
	writeTestFile(join(source, 'scripts', 'tracker.json'), '{}');
	writeTestFile(join(source, 'css', 'custom.css'), 'body {}');
	const phaseOne = migrateLegacyConfigsPhaseOne(destination, [{ label: 'Crankshaft AppData', path: source }]);
	const phaseTwo = await migrateLegacyConfigsPhaseTwo(destination, phaseOne.deferredSources);
	assert.equal(phaseOne.copiedFiles, 1);
	assert.equal(phaseTwo.completed, true);
	assert.equal(phaseTwo.copiedFiles, 4);
	assert.equal(phaseTwo.errors, 0);
	assert.equal(readFileSync(join(destination, 'settings.json'), 'utf-8'), '{"fpsUncap":true}');
	assert.equal(readFileSync(join(destination, 'future-config.json'), 'utf-8'), '{"future":true}');
	assert.equal(readFileSync(join(destination, 'swapper', 'textures', 'weapon.png'), 'utf-8'), 'texture');
	assert.equal(readFileSync(join(destination, 'scripts', 'tracker.json'), 'utf-8'), '{}');
	assert.equal(readFileSync(join(destination, 'css', 'custom.css'), 'utf-8'), 'body {}');
	assert.equal(existsSync(join(destination, MIGRATION_MARKER)), true);
	assert.equal(existsSync(join(source, 'swapper', 'textures', 'weapon.png')), true);
});
test('preserves WOK Client files and copies only missing startup-critical legacy files', (t) => {
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
test('phase 2 preserves WOK Client files inside deferred trees', async (t) => {
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
test('skips allowlisted and deferred symbolic links without following them', async (t) => {
	const root = createTestRoot(t);
	const source = join(root, 'legacy');
	const destination = join(root, 'current');
	const linkTarget = join(root, 'link-target');
	writeTestFile(join(linkTarget, 'must-not-copy.txt'), 'linked data');
	mkdirSync(join(source, 'tree'), { recursive: true });
	symlinkSync(linkTarget, join(source, 'settings.json'), 'junction');
	symlinkSync(linkTarget, join(source, 'linked-config'), 'junction');
	symlinkSync(linkTarget, join(source, 'tree', 'nested-link'), 'junction');
	const phaseOne = migrateLegacyConfigsPhaseOne(destination, [{ label: 'Legacy', path: source }]);
	const phaseTwo = await migrateLegacyConfigsPhaseTwo(destination, phaseOne.deferredSources);
	assert.equal(phaseOne.skippedLinks, 1);
	assert.equal(phaseTwo.completed, true);
	assert.equal(phaseTwo.skippedLinks, 2);
	assert.equal(existsSync(join(destination, 'settings.json')), false);
	assert.equal(existsSync(join(destination, 'linked-config')), false);
	assert.equal(existsSync(join(destination, 'tree', 'nested-link')), false);
});
test('an interrupted phase 2 resumes on the next launch without overwriting existing files', async (t) => {
	const root = createTestRoot(t);
	const source = join(root, 'legacy');
	const destination = join(root, 'current');
	writeTestFile(join(source, 'swapper', 'textures', 'a.png'), 'legacy-a');
	writeTestFile(join(source, 'swapper', 'textures', 'b.png'), 'legacy-b');
	writeTestFile(join(source, 'scripts', 's.js'), 'legacy-s');
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
test('phase 2 bounds active I/O and queued work for a large flat source', async (t) => {
	const root = createTestRoot(t);
	const source = join(root, 'legacy');
	const destination = join(root, 'current');
	const fileCount = 512;
	for (let file = 0; file < fileCount; file++) {
		writeTestFile(join(source, `top-level-${file}.json`), String(file));
	}
	const concurrency = 3;
	const result = await migrateLegacyConfigsPhaseTwo(destination, [{ label: 'Legacy', path: source }], concurrency);
	assert.equal(result.completed, true);
	assert.equal(result.copiedFiles, fileCount);
	assert.equal(result.errors, 0);
	assert.ok(result.peakActiveOperations >= 1);
	assert.ok(result.peakActiveOperations <= concurrency, `peak active I/O ${result.peakActiveOperations} exceeded ${concurrency}`);
	assert.ok(result.peakQueuedWork >= 1);
	assert.ok(result.peakQueuedWork <= concurrency, `peak queued work ${result.peakQueuedWork} exceeded ${concurrency}`);
	assert.equal(readFileSync(join(destination, 'top-level-0.json'), 'utf-8'), '0');
	assert.equal(readFileSync(join(destination, `top-level-${fileCount - 1}.json`), 'utf-8'), String(fileCount - 1));
});
test('phase 2 bounds active I/O and queued work for a large wide tree', async (t) => {
	const root = createTestRoot(t);
	const source = join(root, 'legacy');
	const destination = join(root, 'current');
	const directoryCount = 64;
	const filesPerDirectory = 8;
	for (let directory = 0; directory < directoryCount; directory++) {
		for (let file = 0; file < filesPerDirectory; file++) {
			const relativePath = join('swapper', `dir-${directory}`, `file-${file}.png`);
			writeTestFile(join(source, relativePath), relativePath);
		}
	}
	const concurrency = 4;
	const result = await migrateLegacyConfigsPhaseTwo(destination, [{ label: 'Legacy', path: source }], concurrency);
	assert.equal(result.completed, true);
	assert.equal(result.copiedFiles, directoryCount * filesPerDirectory);
	assert.equal(result.errors, 0);
	assert.ok(result.peakActiveOperations >= 1);
	assert.ok(result.peakActiveOperations <= concurrency, `peak active I/O ${result.peakActiveOperations} exceeded ${concurrency}`);
	assert.ok(result.peakQueuedWork >= 1);
	assert.ok(result.peakQueuedWork <= concurrency, `peak queued work ${result.peakQueuedWork} exceeded ${concurrency}`);
	assert.equal(readFileSync(join(destination, 'swapper', 'dir-0', 'file-0.png'), 'utf-8'), join('swapper', 'dir-0', 'file-0.png'));
	assert.equal(readFileSync(join(destination, 'swapper', `dir-${directoryCount - 1}`, `file-${filesPerDirectory - 1}.png`), 'utf-8'), join('swapper', `dir-${directoryCount - 1}`, `file-${filesPerDirectory - 1}.png`));
});
test('uses source order for conflicts and does not repeat a completed migration', async (t) => {
	const root = createTestRoot(t);
	const appDataSource = join(root, 'appdata');
	const documentsSource = join(root, 'documents');
	const destination = join(root, 'destination');
	writeTestFile(join(appDataSource, 'settings.json'), 'appdata');
	writeTestFile(join(documentsSource, 'settings.json'), 'documents');
	writeTestFile(join(appDataSource, 'future-config.json'), 'appdata future');
	writeTestFile(join(documentsSource, 'future-config.json'), 'documents future');
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
	assert.equal(firstPhaseTwo.skippedConflicts, 1);
	assert.equal(readFileSync(join(destination, 'settings.json'), 'utf-8'), 'appdata');
	assert.equal(readFileSync(join(destination, 'future-config.json'), 'utf-8'), 'appdata future');
	assert.equal(secondPhaseOne.completed, true);
	assert.equal(secondPhaseOne.copiedFiles, 0);
	assert.deepEqual(secondPhaseOne.deferredSources, []);
	assert.equal(secondPhaseTwo.completed, true);
	assert.equal(secondPhaseTwo.copiedFiles, 0);
	assert.equal(existsSync(join(destination, 'added-later.txt')), false);
});
