import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerAppImage } from "@reforged/maker-appimage";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerNSIS } from "./MakerNSIS.ts";
import { copyFileSync, existsSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
        appCopyright: "Copyright © 2026 WOK contributors; based on Crankshaft contributors",
        ignore: [
            // The app ships the bundled runtime (scripts/bundle.mjs output), not src/.
            /^\/(?!(bundle|assets|node_modules|package\.json|LICENSE|THIRD_PARTY_NOTICES\.txt|PATCHED_ELECTRON\.txt))/,
            /^\/bundle\/metafile\.json$/,
            /^\/bundle\/.*\.mjs\.map$/,
            packagedAssetsPattern
        ],
        prune: true,
        asar: true,
        download: {
            mirrorOptions: {
                customDir: PATCHED_ELECTRON_RELEASE,
                mirror: "https://github.com/thegu5/electron/releases/download/",
                nightlyMirror: "https://github.com/thegu5/electron/releases/download/",
            }
        },
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
                categories: ["Game"],
                icon: "./build/icon.png",
                mimeType: ["x-scheme-handler/wok", "x-scheme-handler/crankshaft"]
            },
            
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
                    const realBin = join(buildPath, `${exeName}.bin`);
                    const wrapper = join(buildPath, exeName);

                    renameSync(wrapper, realBin);

                    writeFileSync(
                        wrapper,
                        `#!/bin/sh\nDIR="$(dirname "$(readlink -f "$0")")"\nexec "$DIR/${exeName}.bin" --ozone-platform=x11 "$@"\n`,
                        { mode: 0o755 }
                    );
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
