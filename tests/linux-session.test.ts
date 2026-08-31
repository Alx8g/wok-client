import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OZONE_OVERRIDE_ENV_VAR, describeLinuxDisplaySession, linuxLauncherArguments, ozoneSwitchArguments, renderLinuxLauncherScript, resolveOzonePlatform } from '../src/linux-session.ts';
const linux = (env: Record<string, string | undefined>) => resolveOzonePlatform(env, 'linux');
test('a Wayland session picks native Wayland', () => {
	const decision = linux({ WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' });
	assert.equal(decision.platform, 'wayland');
	assert.equal(decision.source, 'session');
	assert.equal(decision.signal, 'WAYLAND_DISPLAY');
	assert.equal(decision.warning, undefined);
});
test("WAYLAND_DISPLAY alone is enough, which is the gap in Electron's own detection", () => {
	const decision = linux({ WAYLAND_DISPLAY: 'wayland-1' });
	assert.equal(decision.platform, 'wayland');
	assert.equal(decision.signal, 'WAYLAND_DISPLAY');
});
test('XDG_SESSION_TYPE alone is enough', () => {
	const decision = linux({ XDG_SESSION_TYPE: 'wayland' });
	assert.equal(decision.platform, 'wayland');
	assert.equal(decision.signal, 'XDG_SESSION_TYPE');
});
test('an empty WAYLAND_DISPLAY is not a Wayland session', () => {
	assert.equal(linux({ DISPLAY: ':0', WAYLAND_DISPLAY: '' }).platform, 'x11');
});
test('an X11 session falls back to X11', () => {
	const decision = linux({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' });
	assert.equal(decision.platform, 'x11');
	assert.equal(decision.source, 'fallback');
});
test('an unknown session type falls back to X11 rather than guessing', () => {
	assert.equal(linux({ XDG_SESSION_TYPE: 'tty' }).platform, 'x11');
	assert.equal(linux({}).platform, 'x11');
});
test('XDG_SESSION_TYPE must match exactly; a prefix is not a Wayland session', () => {
	assert.equal(linux({ XDG_SESSION_TYPE: 'wayland-ish' }).platform, 'x11');
});
test('the override forces a platform against the detected session', () => {
	const forcedX11 = linux({ WAYLAND_DISPLAY: 'wayland-0', [OZONE_OVERRIDE_ENV_VAR]: 'x11' });
	assert.equal(forcedX11.platform, 'x11');
	assert.equal(forcedX11.source, 'override');
	const forcedWayland = linux({ XDG_SESSION_TYPE: 'x11', [OZONE_OVERRIDE_ENV_VAR]: 'wayland' });
	assert.equal(forcedWayland.platform, 'wayland');
	assert.equal(forcedWayland.source, 'override');
});
test('the override is matched exactly, the same way the generated launcher matches it', () => {
	for (const value of ['WAYLAND', 'Wayland', ' wayland', 'wayland ']) {
		const decision = linux({ [OZONE_OVERRIDE_ENV_VAR]: value, XDG_SESSION_TYPE: 'x11' });
		assert.equal(decision.platform, 'x11');
		assert.equal(decision.source, 'fallback');
		assert.match(decision.warning ?? '', /expected wayland, x11 or auto/u);
	}
});
test('override=auto emits no switch, because --ozone-platform=auto is fatal in Chromium', () => {
	const decision = linux({ WAYLAND_DISPLAY: 'wayland-0', [OZONE_OVERRIDE_ENV_VAR]: 'auto' });
	assert.equal(decision.platform, null);
	assert.equal(decision.source, 'override');
	assert.deepEqual(ozoneSwitchArguments(decision), []);
});
test('an unusable override warns and falls back to detection instead of failing to launch', () => {
	const decision = linux({ WAYLAND_DISPLAY: 'wayland-0', [OZONE_OVERRIDE_ENV_VAR]: 'mir' });
	assert.equal(decision.platform, 'wayland');
	assert.equal(decision.source, 'session');
	assert.match(decision.warning ?? '', /mir/);
});
test("an empty override is not an override, matching the launcher's ?* pattern", () => {
	const decision = linux({ [OZONE_OVERRIDE_ENV_VAR]: '', XDG_SESSION_TYPE: 'wayland' });
	assert.equal(decision.platform, 'wayland');
	assert.equal(decision.warning, undefined);
});
test('non-Linux platforms get no ozone switch at all', () => {
	for (const platform of ['win32', 'darwin'] as const) {
		const decision = resolveOzonePlatform({ WAYLAND_DISPLAY: 'wayland-0' }, platform);
		assert.equal(decision.platform, null);
		assert.equal(decision.source, 'not-linux');
		assert.deepEqual(ozoneSwitchArguments(decision), []);
	}
});
test('launcher arguments carry the resolved platform', () => {
	assert.deepEqual(linuxLauncherArguments({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), ['--ozone-platform=wayland']);
	assert.deepEqual(linuxLauncherArguments({}, 'linux'), ['--ozone-platform=x11']);
	assert.deepEqual(linuxLauncherArguments({}, 'win32'), []);
});
test('the generated launcher never emits the fatal --ozone-platform=auto', () => {
	assert.doesNotMatch(renderLinuxLauncherScript('wok-client'), /--ozone-platform=auto/u);
	assert.doesNotMatch(renderLinuxLauncherScript('wok-client'), /--ozone-platform="?auto/u);
});
test('the generated launcher execs the real binary and forwards its arguments', () => {
	const script = renderLinuxLauncherScript('wok-client');
	assert.match(script, /^#!\/bin\/sh\n/u);
	assert.match(script, /BIN="\$DIR\/wok-client\.bin"/u);
	for (const line of script.split('\n').filter((candidate) => candidate.includes('exec "$BIN"'))) {
		assert.ok(line.trimEnd().endsWith('"$@"'), `exec line does not forward arguments: ${line}`);
	}
});
test('the generated launcher tests exactly the documented session signals', () => {
	const script = renderLinuxLauncherScript('wok-client');
	assert.match(script, /if \[ -n "\$WAYLAND_DISPLAY" \] \|\| \[ "\$XDG_SESSION_TYPE" = "wayland" \]; then/u);
});
test('launcher generation refuses an executable name that is unsafe in shell', () => {
	for (const name of ['wok client', 'wok;rm -rf /', '$(id)', '', '-wok']) {
		assert.throws(() => renderLinuxLauncherScript(name), /unsafe executable name/u);
	}
});
test('the startup line reports the platform that actually reached the process', () => {
	const line = describeLinuxDisplaySession('linux', ['wok-client', '--ozone-platform=wayland'], {
		WAYLAND_DISPLAY: 'wayland-0'
	});
	assert.match(line ?? '', /^Display server: wayland /u);
});
test('the startup line calls out XWayland running inside a Wayland session', () => {
	const line = describeLinuxDisplaySession('linux', ['wok-client', '--ozone-platform=x11'], {
		WAYLAND_DISPLAY: 'wayland-0',
		[OZONE_OVERRIDE_ENV_VAR]: 'x11'
	});
	assert.match(line ?? '', /XWayland/u);
	assert.match(line ?? '', new RegExp(OZONE_OVERRIDE_ENV_VAR, 'u'));
});
test('the startup line says so when nobody passed a platform', () => {
	const line = describeLinuxDisplaySession('linux', ['wok-client'], { XDG_SESSION_TYPE: 'wayland' });
	assert.match(line ?? '', /chosen by Electron/u);
});
test('the startup line honours the last --ozone-platform, as Chromium does', () => {
	const line = describeLinuxDisplaySession('linux', ['wok-client', '--ozone-platform=wayland', '--ozone-platform=x11'], { XDG_SESSION_TYPE: 'x11' });
	assert.match(line ?? '', /^Display server: x11 /u);
});
test('there is no display-server line off Linux', () => {
	assert.equal(describeLinuxDisplaySession('win32', ['wok-client.exe'], {}), null);
	assert.equal(describeLinuxDisplaySession('darwin', ['wok-client'], {}), null);
});
const shellAvailable = (() => {
	try {
		return spawnSync('sh', ['-c', 'exit 0']).status === 0;
	} catch {
		return false;
	}
})();
test('the generated launcher agrees with the resolver', { skip: shellAvailable ? false : 'no POSIX sh' }, () => {
	const directory = mkdtempSync(join(tmpdir(), 'wok-launcher-'));
	try {
		const launcher = join(directory, 'wok-client');
		writeFileSync(launcher, renderLinuxLauncherScript('wok-client'), { mode: 0o755 });
		writeFileSync(join(directory, 'wok-client.bin'), '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n', { mode: 0o755 });
		chmodSync(launcher, 0o755);
		const environments: Record<string, string | undefined>[] = [
			{ WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' },
			{ WAYLAND_DISPLAY: 'wayland-0' },
			{ XDG_SESSION_TYPE: 'wayland' },
			{ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' },
			{},
			{ WAYLAND_DISPLAY: '' },
			{ XDG_SESSION_TYPE: 'wayland-ish' },
			{ [OZONE_OVERRIDE_ENV_VAR]: 'x11', WAYLAND_DISPLAY: 'wayland-0' },
			{ [OZONE_OVERRIDE_ENV_VAR]: 'wayland', XDG_SESSION_TYPE: 'x11' },
			{ [OZONE_OVERRIDE_ENV_VAR]: 'auto', WAYLAND_DISPLAY: 'wayland-0' },
			{ [OZONE_OVERRIDE_ENV_VAR]: 'mir', WAYLAND_DISPLAY: 'wayland-0' },
			{ [OZONE_OVERRIDE_ENV_VAR]: 'WAYLAND', XDG_SESSION_TYPE: 'x11' },
			{ [OZONE_OVERRIDE_ENV_VAR]: 'wayland ', XDG_SESSION_TYPE: 'x11' },
			{ [OZONE_OVERRIDE_ENV_VAR]: '', WAYLAND_DISPLAY: 'wayland-0' }
		];
		for (const environment of environments) {
			const result = spawnSync('sh', [launcher, '--passthrough'], {
				encoding: 'utf8',
				env: { PATH: process.env.PATH, ...environment }
			});
			assert.equal(result.status, 0, `launcher failed for ${JSON.stringify(environment)}: ${result.stderr}`);
			const argv = result.stdout.split('\n').filter((line) => line.length > 0);
			assert.deepEqual(argv, [...linuxLauncherArguments(environment, 'linux'), '--passthrough'], `launcher disagreed with the resolver for ${JSON.stringify(environment)}`);
		}
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
