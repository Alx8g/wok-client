import { rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
const rootDirectory = join(import.meta.dirname, '..');
const outDirectory = join(rootDirectory, 'bundle');
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
