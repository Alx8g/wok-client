import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { linuxLauncherArguments, resolveOzonePlatform } from '../src/linux-session.ts';
const require = createRequire(import.meta.url);
const forgeCli = join(dirname(require.resolve('@electron-forge/cli/package.json')), 'dist', 'electron-forge.js');
const decision = resolveOzonePlatform(process.env);
if (decision.warning) console.warn(decision.warning);
if (process.platform === 'linux') {
	console.log(`Ozone platform: ${decision.platform ?? 'chosen by Electron'} (${decision.reason})`);
}
const appArguments = linuxLauncherArguments(process.env);
const forgeArguments = ['start', ...process.argv.slice(2)];
if (appArguments.length > 0) forgeArguments.push('--', ...appArguments);
const child = spawn(process.execPath, [forgeCli, ...forgeArguments], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 0);
});
