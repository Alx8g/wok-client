// Bundles the WOK Client runtime with esbuild: bundle/main.mjs, bundle/preload.mjs, and
// split chunks for the deliberate lazy boundaries (every dynamic import() in src/ stays a
// separate chunk), plus bundle/metafile.json for scripts/verify-bundle.mjs.
//
// Constraints that shape the options below:
// - No minification and no identifier mangling: calibration-window.ts embeds
//   calibration-workload.ts / calibration-benchmark.ts functions into the trial page via
//   Function.prototype.toString, so the bundled function bodies must stay plain JavaScript
//   whose free variables keep their exported names. verify-bundle.mjs proves this per build.
// - format esm / platform node: the app is "type": "module" and Electron >= 28 loads ESM
//   preloads from .mjs files (the preload runs unsandboxed, so its chunks may import
//   node builtins and electron exactly as the raw TypeScript modules do today).
// - The output directory sits at the app root like src/, so import.meta.dirname-relative
//   asset paths ($assets = ../assets) keep resolving in both dev and packaged layouts.

import { rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

const rootDirectory = join(import.meta.dirname, '..');
const outDirectory = join(rootDirectory, 'bundle');

// Chunk hashes change between builds; stale chunks must never linger into a package step.
rmSync(outDirectory, { force: true, recursive: true });

const result = await build({
	absWorkingDir: rootDirectory,
	bundle: true,
	charset: 'utf8',
	entryPoints: ['src/main.ts', 'src/preload.ts'],
	format: 'esm',
	logLevel: 'info',
	metafile: true,
	minify: false,
	outExtension: { '.js': '.mjs' },
	outdir: 'bundle',
	packages: 'external',
	platform: 'node',
	sourcemap: 'linked',
	splitting: true,
	target: 'node24'
});

await writeFile(join(outDirectory, 'metafile.json'), JSON.stringify(result.metafile, null, '\t'));
