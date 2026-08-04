import { MakerAppImage } from '@reforged/maker-appimage';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import forgeConfig from '../forge.config.ts';

/**
 * The Linux desktop entry only works if four files agree: the committed entry, the AppImage maker
 * options that decide its file name, `packagerConfig` which decides the executable name and the
 * URL schemes, and `desktopName` in package.json which pins the XDG app id Electron reports.
 *
 * A mismatch is invisible in CI and shows up on a user's machine as a generic icon, a window that
 * will not group with its launcher, or a dead wok:// link. So it is asserted rather than reviewed.
 */

const repositoryRoot = join(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf-8')) as {
	desktopName?: string;
};

const appImageMaker = forgeConfig.makers.find(maker => maker instanceof MakerAppImage);
assert.ok(appImageMaker, 'the AppImage maker is missing from forge.config.ts');
appImageMaker.prepareConfig('x64');
const makerOptions = appImageMaker.config.options ?? {};

const entryFileName = `${makerOptions.productName}.desktop`;
const entry = readFileSync(join(repositoryRoot, 'build', entryFileName), 'utf-8');

const fields = new Map<string, string>(
	entry
		.split('\n')
		.filter(line => line.includes('=') && !line.startsWith('['))
		.map(line => {
			const separator = line.indexOf('=');
			return [line.slice(0, separator), line.slice(separator + 1)] as [string, string];
		})
);

test('the entry file name is what the maker will write and what Electron will look up', () => {
	assert.equal(entryFileName, packageJson.desktopName);
	// Desktop-entry file names may only contain [A-Za-z0-9-_] and dots; "WOK Client.desktop" did not.
	assert.match(entryFileName, /^[A-Za-z0-9][A-Za-z0-9._-]*\.desktop$/u);
});

test('the entry is a valid application entry', () => {
	assert.ok(entry.startsWith('[Desktop Entry]\n'));
	assert.equal(fields.get('Type'), 'Application');
	assert.equal(fields.get('Terminal'), 'false');
	assert.ok((fields.get('Name') ?? '').length > 0);
});

test('Exec and StartupWMClass follow the packaged executable', () => {
	const executableName = forgeConfig.packagerConfig.executableName;

	assert.equal(makerOptions.bin, executableName);
	assert.equal(fields.get('Exec'), `${executableName} %U`);
	// X11 WM_CLASS matching. On Wayland the equivalent is the app id, which comes from desktopName.
	assert.equal(fields.get('StartupWMClass'), executableName);
	assert.equal(entryFileName, `${executableName}.desktop`);
});

test('Icon matches the name the maker stores icons under', () => {
	assert.equal(fields.get('Icon'), makerOptions.name);
});

test('every registered URL scheme has a handler in the entry', () => {
	const mimeTypes = (fields.get('MimeType') ?? '').split(';').filter(value => value.length > 0);

	for (const protocol of forgeConfig.packagerConfig.protocols) {
		for (const scheme of protocol.schemes) {
			assert.ok(
				mimeTypes.includes(`x-scheme-handler/${scheme}`),
				`${entryFileName} does not handle ${scheme}://`
			);
		}
	}
});
