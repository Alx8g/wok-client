import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    QUALIFIED_ELECTRON_ARCHIVE_NAME,
    resolveQualifiedElectronZipDir
} from '../forge.config.ts';

test('qualified Electron staging is opt-in', () => {
    assert.equal(resolveQualifiedElectronZipDir({}), undefined);
});

test('qualified Electron staging rejects missing and unqualified archives', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wok-electron-runtime-'));
    try {
        const missingArchive = join(directory, 'missing.zip');
        assert.throws(
            () => resolveQualifiedElectronZipDir({ WOK_QUALIFIED_ELECTRON_ZIP: missingArchive }),
            /does not exist/
        );

        const archive = join(directory, 'electron-custom.zip');
        writeFileSync(archive, 'not-the-qualified-runtime');
        assert.throws(
            () => resolveQualifiedElectronZipDir({ WOK_QUALIFIED_ELECTRON_ZIP: archive }),
            /checksum mismatch/
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('qualified Electron staging gives Packager a standard archive name', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wok-electron-runtime-'));
    try {
        const archive = join(directory, 'electron-wok-chromium152.zip');
        const contents = Buffer.from('qualified-electron-fixture');
        const expectedSha256 = createHash('sha256').update(contents).digest('hex');
        writeFileSync(archive, contents);
        const stageDirectory = join(directory, 'stage');

        const result = resolveQualifiedElectronZipDir({
            WOK_QUALIFIED_ELECTRON_ZIP: archive,
            WOK_ELECTRON_STAGE_DIR: stageDirectory
        }, expectedSha256);

        assert.equal(result, stageDirectory);
        assert.deepEqual(
            readFileSync(join(stageDirectory, QUALIFIED_ELECTRON_ARCHIVE_NAME)),
            contents
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
