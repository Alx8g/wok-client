import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { buildInstallerScript } from '../MakerNSIS.ts';
import type { InstallerScriptOptions } from '../MakerNSIS.ts';
import { INSTALLER_ART_DIR, INSTALLER_ART_FILES, INSTALLER_ART_SIZES, renderInstallerArt } from '../scripts/generate-installer-art.mjs';
const headerBitmapPath = join(INSTALLER_ART_DIR, INSTALLER_ART_FILES.header);
const sideBitmapPath = join(INSTALLER_ART_DIR, INSTALLER_ART_FILES.side);
const baseOptions: InstallerScriptOptions = {
	appDisplayName: 'WOK Client',
	executableName: 'wok-client.exe',
	version: '1.1.0-rc.4',
	windowsVersion: '1.1.0.0',
	publisher: 'WOK contributors',
	copyright: 'Copyright 2026 WOK contributors',
	description: 'The fastest Krunker client. Ever.',
	sourceDir: 'C:\\build\\WOK Client-win32-x64',
	outFile: 'C:\\dist\\make\\nsis\\x64\\WOK Client-1.1.0-rc.4-x64-setup.exe',
	uninstallKey: 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WOK Client',
	iconPath: 'C:\\repo\\build\\icon.ico',
	licensePath: 'C:\\temp\\license.txt',
	headerBitmapPath,
	sideBitmapPath,
	homepageUrl: 'https://wok.social',
	supportUrl: 'https://github.com/nzalexgarciagil-ctrl/wok-client/issues',
	updatesUrl: 'https://github.com/nzalexgarciagil-ctrl/wok-client',
	protocolSchemes: ['wok', 'crankshaft']
};
const script = buildInstallerScript(baseOptions);
function definedNames(source: string): string[] {
	return [...source.matchAll(/^!define\s+(\S+)/gm)].map((match) => match[1]);
}
test('the wizard walks a full product flow instead of a bare directory prompt', () => {
	const pages = [...script.matchAll(/^!insertmacro\s+(MUI_(?:UN)?PAGE_\w+)/gm)].map((match) => match[1]);
	assert.deepEqual(pages, [
		'MUI_PAGE_WELCOME',
		'MUI_PAGE_LICENSE',
		'MUI_PAGE_COMPONENTS',
		'MUI_PAGE_DIRECTORY',
		'MUI_PAGE_INSTFILES',
		'MUI_PAGE_FINISH',
		'MUI_UNPAGE_WELCOME',
		'MUI_UNPAGE_CONFIRM',
		'MUI_UNPAGE_INSTFILES',
		'MUI_UNPAGE_FINISH'
	]);
});
test('every branded page points at the committed bitmaps and the app icon', () => {
	assert.match(script, /^!define MUI_HEADERIMAGE$/m);
	for (const define of ['MUI_HEADERIMAGE_BITMAP', 'MUI_HEADERIMAGE_UNBITMAP']) {
		assert.ok(script.includes(`!define ${define} "${headerBitmapPath}"`), `${define} is not the header bitmap`);
	}
	for (const define of ['MUI_WELCOMEFINISHPAGE_BITMAP', 'MUI_UNWELCOMEFINISHPAGE_BITMAP']) {
		assert.ok(script.includes(`!define ${define} "${sideBitmapPath}"`), `${define} is not the side bitmap`);
	}
	assert.ok(script.includes('!define MUI_ICON "C:\\repo\\build\\icon.ico"'));
	assert.ok(script.includes('!define MUI_UNICON "C:\\repo\\build\\icon.ico"'));
	assert.ok(script.includes('!define MUI_INSTFILESPAGE_COLORS "FBC02D 101014"'));
});
test('branding is skipped rather than emitted half-configured when the bitmaps are missing', () => {
	const unbranded = buildInstallerScript({ ...baseOptions, headerBitmapPath: undefined, sideBitmapPath: undefined });
	assert.ok(!unbranded.includes('MUI_HEADERIMAGE'));
	assert.ok(!unbranded.includes('WELCOMEFINISHPAGE_BITMAP'));
	assert.ok(unbranded.includes('!insertmacro MUI_PAGE_WELCOME'));
});
test('the licence page is dropped when there is no licence to show', () => {
	const withoutLicense = buildInstallerScript({ ...baseOptions, licensePath: undefined });
	assert.ok(!withoutLicense.includes('MUI_PAGE_LICENSE'));
	assert.ok(!withoutLicense.includes('MUI_LICENSEPAGE_BUTTON'));
});
test('silent installs stay unattended: no message box can block /S', () => {
	const messageBoxes = [...script.matchAll(/^\s*MessageBox\s+.*$/gm)].map((match) => match[0]);
	assert.ok(messageBoxes.length > 0, 'expected the running-app guard to use a message box');
	for (const messageBox of messageBoxes) {
		assert.match(messageBox, /\/SD\s+ID\w+/, `MessageBox without a silent default: ${messageBox.trim()}`);
	}
});
test('silent installs get the same payload, with switches to drop the optional shortcuts', () => {
	assert.ok(!/^Section\s+\/o\b/m.test(script), 'optional sections must stay selected by default');
	assert.match(script, /^Section "!\$\{WOK_NAME\}" SecCore$/m);
	assert.match(script, /^\s*SectionIn RO$/m);
	assert.ok(script.includes('${GetOptions} $R0 "/NODESKTOP" $R1'));
	assert.ok(script.includes('${GetOptions} $R0 "/NOSTARTMENU" $R1'));
	assert.ok(script.includes('!insertmacro UnselectSection ${SecDesktop}'));
	assert.ok(script.includes('!insertmacro UnselectSection ${SecStartMenu}'));
});
test('the progress log names each install step', () => {
	const details = [...script.matchAll(/^\s*DetailPrint "([^"]+)"/gm)].map((match) => match[1]);
	for (const step of ['Checking whether ${WOK_NAME} is running...', 'Copying ${WOK_NAME} to $INSTDIR...', 'Writing the uninstaller...', 'Registering ${WOK_NAME} with Windows...', 'Recording the installed size...']) {
		assert.ok(details.includes(step), `missing install progress step: ${step}`);
	}
	for (const step of ['Removing shortcuts...', 'Removing the Windows registration...', 'Removing application files from $INSTDIR...']) {
		assert.ok(details.includes(step), `missing uninstall progress step: ${step}`);
	}
});
test('Add/Remove Programs gets a complete record', () => {
	const written = [...script.matchAll(/WriteReg(?:Str|DWORD) HKCU "\$\{WOK_UNINSTALL_KEY\}" "(\w+)"/g)].map((match) => match[1]);
	for (const value of [
		'DisplayName',
		'DisplayVersion',
		'DisplayIcon',
		'Publisher',
		'Comments',
		'InstallLocation',
		'InstallDate',
		'UninstallString',
		'QuietUninstallString',
		'EstimatedSize',
		'HelpLink',
		'URLInfoAbout',
		'URLUpdateInfo',
		'NoModify',
		'NoRepair'
	]) {
		assert.ok(written.includes(value), `missing Add/Remove Programs value: ${value}`);
	}
	assert.ok(script.includes('${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2'), 'EstimatedSize must be measured, not guessed');
});
test('the uninstaller removes what the installer created and keeps user settings', () => {
	const uninstall = script.slice(script.indexOf('Section "Uninstall"'));
	assert.ok(uninstall.includes('Delete "$SMPROGRAMS\\${WOK_NAME}.lnk"'));
	assert.ok(uninstall.includes('Delete "$DESKTOP\\${WOK_NAME}.lnk"'));
	assert.ok(uninstall.includes('DeleteRegKey HKCU "${WOK_UNINSTALL_KEY}"'));
	assert.ok(uninstall.includes('!insertmacro RemoveProtocolHandler "wok"'));
	assert.ok(uninstall.includes('!insertmacro RemoveProtocolHandler "crankshaft"'));
	assert.match(uninstall, /\$\{If\} \$\{FileExists\} "\$INSTDIR\\\$\{WOK_EXE\}"\s*\n\s*RMDir \/r "\$INSTDIR"/);
	assert.ok(uninstall.includes('DetailPrint "Settings in $APPDATA\\${WOK_NAME} were left in place."'));
});
test('the uninstaller cannot inherit the installer finish page controls', () => {
	const uninstallPages = script.slice(script.indexOf('; Uninstaller pages'), script.indexOf('MUI_LANGUAGE'));
	for (const define of ['MUI_FINISHPAGE_RUN', 'MUI_FINISHPAGE_RUN_TEXT', 'MUI_FINISHPAGE_LINK', 'MUI_FINISHPAGE_LINK_LOCATION']) {
		assert.ok(uninstallPages.includes(`  !undef ${define}`), `${define} is not released before the uninstall finish page`);
	}
});
test('redefined MUI settings are released first, so -WX cannot fail the build', () => {
	const names = definedNames(script);
	const redefined = names.filter((name, index) => names.indexOf(name) !== index);
	assert.ok(redefined.length > 0, 'expected the welcome and finish defines to be reused by the uninstaller');
	for (const name of new Set(redefined)) {
		assert.ok(script.includes(`!ifdef ${name}\n  !undef ${name}\n!endif`), `redefinition of ${name} is not guarded`);
	}
});
test('interpolated values are escaped for the NSIS string syntax', () => {
	const hostile = buildInstallerScript({
		...baseOptions,
		appDisplayName: 'WOK $Client',
		description: 'A "quoted" description\nwith a newline'
	});
	assert.ok(hostile.includes('!define WOK_NAME "WOK $$Client"'));
	assert.ok(hostile.includes('A $\\"quoted$\\" description with a newline'));
});
test('the installer stays per-user and self-describing', () => {
	assert.match(script, /^RequestExecutionLevel user$/m);
	assert.match(script, /^InstallDir "\$LOCALAPPDATA\\\$\{WOK_NAME\}"$/m);
	assert.match(script, /^BrandingText "\$\{WOK_NAME\} \$\{WOK_VERSION\}"$/m);
	assert.match(script, /^VIProductVersion "1\.1\.0\.0"$/m);
	assert.ok(script.includes('VIAddVersionKey "OriginalFilename" "WOK Client-1.1.0-rc.4-x64-setup.exe"'));
	assert.ok(script.includes('WriteRegDWORD HKCU "${WOK_UNINSTALL_KEY}" "VersionMajor" 1'));
	assert.ok(script.includes('WriteRegDWORD HKCU "${WOK_UNINSTALL_KEY}" "VersionMinor" 1'));
});
test('the committed installer bitmaps match the generator output byte for byte', () => {
	for (const [name, bytes] of renderInstallerArt()) {
		const committed = readFileSync(join(INSTALLER_ART_DIR, name));
		assert.ok(committed.equals(bytes), `${name} is stale. Run: node scripts/generate-installer-art.mjs`);
	}
});
test('artwork generation is deterministic', () => {
	const first = renderInstallerArt();
	const second = renderInstallerArt();
	for (const [name, bytes] of first) {
		assert.ok(second.get(name)?.equals(bytes), `${name} is not reproducible`);
	}
});
test('the bitmaps are the uncompressed 24-bit BMPs the Modern UI expects', () => {
	const expectations = [
		[INSTALLER_ART_FILES.header, INSTALLER_ART_SIZES.header],
		[INSTALLER_ART_FILES.side, INSTALLER_ART_SIZES.side]
	] as const;
	for (const [name, size] of expectations) {
		const bytes = readFileSync(join(INSTALLER_ART_DIR, name));
		assert.equal(bytes.toString('ascii', 0, 2), 'BM', `${name} is not a BMP`);
		assert.equal(bytes.readUInt32LE(14), 40, `${name} must use a BITMAPINFOHEADER`);
		assert.equal(bytes.readInt32LE(18), size.width, `${name} has the wrong width`);
		assert.equal(bytes.readInt32LE(22), size.height, `${name} has the wrong height`);
		assert.equal(bytes.readUInt16LE(26), 1, `${name} must have a single colour plane`);
		assert.equal(bytes.readUInt16LE(28), 24, `${name} must be 24-bit`);
		assert.equal(bytes.readUInt32LE(30), 0, `${name} must be uncompressed BI_RGB`);
		assert.equal(bytes.readUInt32LE(10), 54, `${name} must store pixels straight after the header`);
		assert.equal(bytes.readUInt32LE(2), bytes.length, `${name} declares the wrong file size`);
		assert.equal(bytes.length, 54 + ((size.width * 3 + 3) & ~3) * size.height, `${name} has an unexpected pixel payload`);
	}
});
