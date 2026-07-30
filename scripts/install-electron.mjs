import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PATCHED_ELECTRON_RELEASE = 'v{{ version }}-patched-2';
const PATCHED_ELECTRON_MIRROR = 'https://github.com/thegu5/electron/releases/download/';
const PATCH_MARKER_CONTENT = 'v44.0.0-nightly.20260522-patched-2\n';

const electronPackagePath = fileURLToPath(import.meta.resolve('electron/package.json'));
const electronPackageDirectory = dirname(electronPackagePath);
const electronDistDirectory = join(electronPackageDirectory, 'dist');
const patchMarkerPath = join(electronPackageDirectory, '.wok-patched-electron');
const installScript = join(electronPackageDirectory, 'install.js');

let installedRelease = '';
try {
	installedRelease = readFileSync(patchMarkerPath, 'utf-8');
} catch (_error) {
	// A missing marker means the same-version official nightly may be installed.
}

if (installedRelease !== PATCH_MARKER_CONTENT) {
	rmSync(electronDistDirectory, { force: true, recursive: true });
	rmSync(join(electronPackageDirectory, 'path.txt'), { force: true });

	const result = spawnSync(process.execPath, [installScript], {
		env: {
			...process.env,
			ELECTRON_CUSTOM_DIR: PATCHED_ELECTRON_RELEASE,
			ELECTRON_NIGHTLY_MIRROR: PATCHED_ELECTRON_MIRROR,
			electron_use_remote_checksums: '1'
		},
		stdio: 'inherit'
	});

	if (result.error) throw result.error;
	if (result.signal) throw new Error(`Electron installer was terminated by ${result.signal}.`);
	if (result.status !== 0) process.exit(result.status ?? 1);
	writeFileSync(patchMarkerPath, PATCH_MARKER_CONTENT, 'utf-8');
}
