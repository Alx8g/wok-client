import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerAppImage } from "@reforged/maker-appimage";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerNSIS } from "./MakerNSIS.ts";
import { createHash } from 'node:crypto';
import {
    closeSync,
    copyFileSync,
    existsSync,
    linkSync,
    mkdirSync,
    openSync,
    readSync,
    readdirSync,
    renameSync,
    rmdirSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { renderLinuxLauncherScript } from './src/linux-session.ts';
import { verifyPackagedApplication } from './scripts/verify-package.mjs';
import { BUNDLED_THEMES, THEME_LAYER_ASSETS, themeAssetName } from './src/themes.ts';

// Assets are packaged by an explicit allowlist. The theme stylesheets come from the registry so a
// new bundled theme cannot be listed in settings but missing from the build.
const packagedAssetNames = [
    'blockFilters.txt', 'wok-mark.svg', 'hideAds.css',
    'intro-short-1080.webm', 'intro-short-1440.webm', 'intro-long-1080.webm', 'intro-long-1440.webm',
    'intro.html', 'intro.js', 'matchmaker.css', 'menuTimer.css', 'quickClassPicker.css',
    'settings.css', 'splash-frame.webp', 'splash.css',
    ...THEME_LAYER_ASSETS, ...BUNDLED_THEMES.map(theme => themeAssetName(theme.id))
];
const packagedAssetsPattern = new RegExp(
    `^/assets/(?!(?:${packagedAssetNames.map(name => name.replaceAll('.', '\\.')).join('|')})$)`
);

export const PATCHED_ELECTRON_VERSION = "44.0.0-nightly.20260522";
export const PATCHED_ELECTRON_RELEASE = `v${PATCHED_ELECTRON_VERSION}-patched-2`;
export const QUALIFIED_ELECTRON_ARCHIVE_NAME =
    `electron-v${PATCHED_ELECTRON_VERSION}-win32-x64.zip`;
export const QUALIFIED_ELECTRON_SHA256 =
    "20246da5d4b33316391b2dc70e538d6a300fc9c17e9e5563389895c614b7d9b0";

function sha256File(filePath: string): string {
    const descriptor = openSync(filePath, 'r');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        for (let bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
            bytesRead > 0;
            bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) {
            hash.update(buffer.subarray(0, bytesRead));
        }
    } finally {
        closeSync(descriptor);
    }
    return hash.digest('hex');
}

export function resolveQualifiedElectronZipDir(
    environment: NodeJS.ProcessEnv = process.env,
    expectedSha256 = QUALIFIED_ELECTRON_SHA256
): string | undefined {
    const configuredArchive = environment.WOK_QUALIFIED_ELECTRON_ZIP?.trim();
    if (!configuredArchive) return undefined;

    const sourceArchive = resolve(configuredArchive);
    if (!existsSync(sourceArchive)) {
        throw new Error(`Qualified Electron archive does not exist: ${sourceArchive}`);
    }
    const sourceHash = sha256File(sourceArchive);
    if (sourceHash !== expectedSha256) {
        throw new Error(
            `Qualified Electron archive checksum mismatch: expected ${expectedSha256}, got ${sourceHash}`
        );
    }

    const stagingRoot = resolve(
        environment.WOK_ELECTRON_STAGE_DIR?.trim()
            || join(dirname(sourceArchive), '.wok-packager', expectedSha256.slice(0, 16))
    );
    mkdirSync(stagingRoot, { recursive: true });
    const stagedArchive = join(stagingRoot, QUALIFIED_ELECTRON_ARCHIVE_NAME);
    if (existsSync(stagedArchive)) {
        const stagedHash = sha256File(stagedArchive);
        if (stagedHash !== expectedSha256) {
            throw new Error(
                `Staged Electron archive checksum mismatch: ${stagedArchive}. Remove or replace it before packaging.`
            );
        }
    } else {
        try {
            linkSync(sourceArchive, stagedArchive);
        } catch {
            copyFileSync(sourceArchive, stagedArchive);
        }
    }
    console.log(`Using qualified Electron archive ${sourceArchive} (${sourceHash}).`);
    return stagingRoot;
}

const qualifiedElectronZipDir = resolveQualifiedElectronZipDir();

function removeEmptyDirs(dir: string): boolean {
    let hasEntries = false;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && removeEmptyDirs(join(dir, entry.name))) continue;
        hasEntries = true;
    }

    if (hasEntries) return false;
    rmdirSync(dir);
    return true;
}

function pruneNodeModuleArtifacts(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            pruneNodeModuleArtifacts(fullPath);
        } else if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.js.map') || entry.name === 'README.md') {
            rmSync(fullPath, { force: true });
        }
    }
}

const retainedChromiumLocales = new Set(['en-US.pak', 'en-GB.pak']);
function pruneChromiumLocales(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const fullPath = join(dir, entry.name);
        if (entry.name === 'locales') {
            for (const locale of readdirSync(fullPath, { withFileTypes: true })) {
                if (locale.isFile() && locale.name.endsWith('.pak') && !retainedChromiumLocales.has(locale.name)) {
                    rmSync(join(fullPath, locale.name), { force: true });
                }
            }
            continue;
        }
        pruneChromiumLocales(fullPath);
    }
}

function copyWokNotices(buildPath: string, platform: string) {
    let resourcesPath = join(buildPath, 'resources');
    if (platform === 'darwin') {
        const appBundle = readdirSync(buildPath, { withFileTypes: true })
            .find(entry => entry.isDirectory() && entry.name.endsWith('.app'));
        if (!appBundle) throw new Error(`Could not find the packaged macOS app in ${buildPath}.`);
        resourcesPath = join(buildPath, appBundle.name, 'Contents', 'Resources');
    }
    copyFileSync(join(import.meta.dirname, 'LICENSE'), join(resourcesPath, 'WOK-CLIENT-GPL-3.0.txt'));
    copyFileSync(join(import.meta.dirname, 'THIRD_PARTY_NOTICES.txt'), join(resourcesPath, 'THIRD_PARTY_NOTICES.txt'));
    copyFileSync(join(import.meta.dirname, 'PATCHED_ELECTRON.txt'), join(resourcesPath, 'PATCHED_ELECTRON.txt'));
}

export default {
    packagerConfig: {
        name: "WOK Client",
        executableName: "wok-client",
        appBundleId: "social.wok.client",
        icon: "./build/icon",
        appCategoryType: "public.app-category.games",
        appCopyright: "Copyright © 2026 WOK contributors",
        ignore: [
            // The app ships the bundled runtime (scripts/bundle.mjs output), not src/.
            /^\/(?!(bundle|assets|node_modules|package\.json|LICENSE|THIRD_PARTY_NOTICES\.txt|PATCHED_ELECTRON\.txt))/,
            /^\/bundle\/metafile\.json$/,
            /^\/bundle\/.*\.mjs\.map$/,
            packagedAssetsPattern
        ],
        prune: true,
        asar: true,
        ...(qualifiedElectronZipDir
            ? { electronZipDir: qualifiedElectronZipDir }
            : {
                download: {
                    mirrorOptions: {
                        customDir: PATCHED_ELECTRON_RELEASE,
                        mirror: "https://github.com/thegu5/electron/releases/download/",
                        nightlyMirror: "https://github.com/thegu5/electron/releases/download/",
                    }
                }
            }),
        protocols: [
            {
                name: "WOK Client Link",
                schemes: ["wok", "crankshaft"]
            }
        ]
    },
    outDir: "dist",
    
    makers: [
        new MakerAppImage({
            options: {
                bin: "wok-client",
                icon: "./build/icon.png",
                name: "wok-client",
                // The maker writes its desktop entry to `${productName}.desktop` and names the
                // AppImage from it too, so the Forge app name ("WOK Client") produced a
                // "WOK Client.desktop" that is invalid under the desktop-entry file-naming spec and
                // can never match the `wok-client` XDG app id Electron reports (package.json
                // `desktopName`). Naming it after the executable fixes icon and window matching on
                // both Wayland (app_id) and X11 (WM_CLASS), and drops the space from the released
                // artifact name.
                productName: "wok-client",
                // Supplying the entry keeps the human-readable Name and adds StartupWMClass, which
                // the generated one cannot express once productName is the file name. It also owns
                // Categories, MimeType and Keywords now: the maker ignores those options whenever
                // desktopFile is set.
                desktopFile: "./build/wok-client.desktop"
            }
        }),
        new MakerDMG({
            icon: "./build/icon.icns",
            iconSize: 128 // ?
        }),
        new MakerNSIS()
    ],
    hooks: {
        packageAfterPrune: async (_, buildPath) => {
            const nodeModules = join(buildPath, "node_modules");
            if (!existsSync(nodeModules)) return;
            for (const metadataFile of ['.pnpm', '.modules.yaml', '.package-map.json', '.pnpm-workspace-state-v1.json']) {
                rmSync(join(nodeModules, metadataFile), { recursive: true, force: true });
            }
            pruneNodeModuleArtifacts(nodeModules);
            removeEmptyDirs(nodeModules);
        },
        postPackage: async (config, { platform, outputPaths }) => {
            for (const buildPath of outputPaths) {
                copyWokNotices(buildPath, platform);
                if (platform === "linux" || platform === "win32") pruneChromiumLocales(buildPath);
                if (platform === "linux") {
                    const exeName = config.packagerConfig.executableName;
                    if (!exeName) throw new Error("packagerConfig.executableName is required to build the Linux launcher.");
                    const realBin = join(buildPath, `${exeName}.bin`);
                    const wrapper = join(buildPath, exeName);

                    renameSync(wrapper, realBin);

                    // Chromium picks its ozone platform before any application code runs, so the
                    // session detection has to happen in this launcher. Generated from
                    // src/linux-session.ts so the shipped shell and the tested resolver agree.
                    writeFileSync(wrapper, renderLinuxLauncherScript(exeName), { mode: 0o755 });
                }

                const verification = verifyPackagedApplication({
                    buildPath,
                    platform,
                    repositoryRoot: import.meta.dirname
                });
                console.log(
                    `Verified packaged ASAR: ${verification.bundleOutputCount} bundle outputs, `
                    + `${verification.assetCount} assets.`
                );
            }
        },
        postMake: async (_, results) => {
            const { version } = (await import("./package.json", { with: { type: "json" }})).default;
            for (const result of results) {
                const newArtifacts: string[] = [];
                for (const artifact of result.artifacts) {
                    const newArtifact = artifact.replace(`-${version}`, '')
                    renameSync(artifact, newArtifact);
                    newArtifacts.push(newArtifact);
                }
                result.artifacts = newArtifacts;
            }
            return results;
        }
    }
} satisfies ForgeConfig
