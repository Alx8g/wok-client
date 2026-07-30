/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: nsis scripting language templating */
import path from 'node:path';
import fs from 'node:fs';
import { MakerBase } from '@electron-forge/maker-base';
import type { MakerOptions } from '@electron-forge/maker-base';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

function resolveIcon(iconPath: string | undefined): string | undefined {
  if (!iconPath) return undefined;

  const absolute = path.isAbsolute(iconPath) ? iconPath : path.resolve(process.cwd(), iconPath);
  const withIcoExt = path.extname(absolute).toLowerCase() === '.ico' ? absolute : `${absolute.replace(/\.[^/.]+$/, '')}.ico`;

  try {
    fs.accessSync(withIcoExt);
    return withIcoExt;
  } catch {
    return undefined;
  }
}

export class MakerNSIS extends MakerBase<{}> {
  name = 'nsis';

  defaultPlatforms: MakerOptions['targetPlatform'][] = ['win32'];

  requiredExternalBinaries = ["makensis"];

  isSupportedOnCurrentPlatform() {
    return true;
  }

  async make(opts: MakerOptions) {
    const { dir, makeDir, appName, packageJSON, targetArch, forgeConfig } = opts;
    const packagerConfig = forgeConfig?.packagerConfig ?? {};
    const win32metadata = packagerConfig.win32metadata ?? {};

    const appDisplayName = packagerConfig.name || appName;
    const version = packageJSON.version || '0.0.0';
    
    const rawAuthor = packageJSON.author as unknown;
    const authorName =
      typeof rawAuthor === 'object' && rawAuthor !== null && 'name' in rawAuthor
        ? (rawAuthor as { name?: string }).name
        : (rawAuthor as string | undefined);
    const publisher = win32metadata.CompanyName || authorName || appDisplayName;
    const copyright = packagerConfig.appCopyright || `Copyright \u00A9 ${new Date().getFullYear()} ${publisher}`;

    const outDir = path.resolve(makeDir, 'nsis', targetArch);
    await this.ensureDirectory(outDir);
    const iconPath = resolveIcon(Array.isArray(packagerConfig.icon) ? packagerConfig.icon?.[0] : packagerConfig.icon);
    const outFile = path.resolve(outDir, `${appDisplayName}-${version}-${targetArch}-setup.exe`);
    const temporaryDirectory = fs.mkdtempSync(path.join(tmpdir(), "nsis-"));
    const nsiPath = path.resolve(temporaryDirectory, 'installer.nsi');

    const APP_EXECUTABLE = `${packagerConfig.executableName || appName}.exe`;
    const UNINSTALL_KEY = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appDisplayName}`;

    const script = `
Unicode true
SetCompressor /SOLID lzma
ManifestDPIAware true

!include "MUI2.nsh"
!include "FileFunc.nsh"
!insertmacro GetSize

Name "${appDisplayName}"
OutFile "${outFile}"
BrandingText "${publisher}"

VIProductVersion "${this.normalizeWindowsVersion(version)}"
VIFileVersion "${this.normalizeWindowsVersion(version)}"
VIAddVersionKey "ProductName" "${appDisplayName}"
VIAddVersionKey "CompanyName" "${publisher}"
VIAddVersionKey "FileDescription" "${win32metadata.FileDescription || packageJSON.description || ''}"
VIAddVersionKey "FileVersion" "${version}"
VIAddVersionKey "ProductVersion" "${version}"
VIAddVersionKey "LegalCopyright" "${copyright}"

RequestExecutionLevel user

InstallDir "$LOCALAPPDATA\\${appDisplayName}"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"

ShowInstDetails show
ShowUnInstDetails show
!define MUI_ABORTWARNING

!if "${iconPath}" != "undefined"
  !define MUI_ICON "${iconPath}"
  !define MUI_UNICON "${iconPath}"
!endif

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\\${APP_EXECUTABLE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${appDisplayName}"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${dir}\\*.*"

  WriteUninstaller "$INSTDIR\\Uninstall.exe"

  ; Keep the app at the Start Menu root so Windows Search indexes it immediately.
  Delete "$SMPROGRAMS\\${appDisplayName}\\${appDisplayName}.lnk"
  Delete "$SMPROGRAMS\\${appDisplayName}\\Uninstall ${appDisplayName}.lnk"
  RMDir "$SMPROGRAMS\\${appDisplayName}"
  CreateShortCut "$SMPROGRAMS\\${appDisplayName}.lnk" "$INSTDIR\\${APP_EXECUTABLE}" "" "$INSTDIR\\${APP_EXECUTABLE}" 0 SW_SHOWNORMAL "" "${appDisplayName}"
  CreateShortCut "$DESKTOP\\${appDisplayName}.lnk" "$INSTDIR\\${APP_EXECUTABLE}" "" "$INSTDIR\\${APP_EXECUTABLE}" 0 SW_SHOWNORMAL "" "${appDisplayName}"

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${appDisplayName}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${version}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${publisher}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\\Uninstall.exe" /S'
  !if "${iconPath}" != "undefined"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\\${APP_EXECUTABLE}"
  !endif
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

  ; App Paths and Applications metadata improve Start search and Run discovery.
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${APP_EXECUTABLE}" "" "$INSTDIR\\${APP_EXECUTABLE}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${APP_EXECUTABLE}" "Path" "$INSTDIR"
  WriteRegStr HKCU "Software\\Classes\\Applications\\${APP_EXECUTABLE}" "FriendlyAppName" "${appDisplayName}"
  WriteRegStr HKCU "Software\\Classes\\Applications\\${APP_EXECUTABLE}" "ApplicationCompany" "${publisher}"
  WriteRegStr HKCU "Software\\Classes\\Applications\\${APP_EXECUTABLE}\\shell\\open\\command" "" '"$INSTDIR\\${APP_EXECUTABLE}" "%1"'

  \${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$INSTDIR\\Uninstall.exe"
  RMDir /r "$INSTDIR"

  Delete "$SMPROGRAMS\\${appDisplayName}.lnk"
  Delete "$SMPROGRAMS\\${appDisplayName}\\${appDisplayName}.lnk"
  Delete "$SMPROGRAMS\\${appDisplayName}\\Uninstall ${appDisplayName}.lnk"
  RMDir "$SMPROGRAMS\\${appDisplayName}"
  Delete "$DESKTOP\\${appDisplayName}.lnk"

  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${APP_EXECUTABLE}"
  DeleteRegKey HKCU "Software\\Classes\\Applications\\${APP_EXECUTABLE}"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
`;

    try {
      fs.writeFileSync(nsiPath, script);

      const execFile = promisify((await import("node:child_process")).execFile);
      try {
        await execFile("makensis", ["-NOCD", "-V2", "-WX", nsiPath]);
      } catch (error) {
        const compilerError = error as Error & { stderr?: string; stdout?: string };
        if (compilerError.stdout) console.error(compilerError.stdout);
        if (compilerError.stderr) console.error(compilerError.stderr);
        throw error;
      }
      return [outFile];
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
