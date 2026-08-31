import { MakerAppImage } from '@reforged/maker-appimage';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import forgeConfig from '../forge.config.ts';
const repositoryRoot = join(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf-8')) as {
	desktopName?: string;
};
const appImageMaker = forgeConfig.makers.find((maker) => maker instanceof MakerAppImage);
assert.ok(appImageMaker, 'the AppImage maker is missing from forge.config.ts');
appImageMaker.prepareConfig('x64');
const makerOptions = appImageMaker.config.options ?? {};
const entryFileName = `${makerOptions.productName}.desktop`;
const entry = readFileSync(join(repositoryRoot, 'build', entryFileName), 'utf-8');
const fields = new Map<string, string>(
	entry
		.split('\n')
		.filter((line) => line.includes('=') && !line.startsWith('['))
		.map((line) => {
			const separator = line.indexOf('=');
			return [line.slice(0, separator), line.slice(separator + 1)] as [string, string];
		})
);
test('the entry file name is what the maker will write and what Electron will look up', () => {
	assert.equal(entryFileName, packageJson.desktopName);
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
	assert.equal(fields.get('StartupWMClass'), executableName);
	assert.equal(entryFileName, `${executableName}.desktop`);
});
test('Icon matches the name the maker stores icons under', () => {
	assert.equal(fields.get('Icon'), makerOptions.name);
});
test('every registered URL scheme has a handler in the entry', () => {
	const mimeTypes = (fields.get('MimeType') ?? '').split(';').filter((value) => value.length > 0);
	for (const protocol of forgeConfig.packagerConfig.protocols) {
		for (const scheme of protocol.schemes) {
			assert.ok(mimeTypes.includes(`x-scheme-handler/${scheme}`), `${entryFileName} does not handle ${scheme}://`);
		}
	}
});
