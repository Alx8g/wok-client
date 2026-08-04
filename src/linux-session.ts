/**
 * Linux display-server session detection and the Chromium ozone platform it implies.
 *
 * This cannot live behind `app.commandLine.appendSwitch`. Chromium resolves its ozone platform in
 * `PreEarlyInitialization`, before the app's JavaScript exists, which is why the old code carried
 * the note that `--ozone-platform` "works as a cli flag, but not w/ appendSwitch". The value has to
 * reach the process as a real argv entry, so the decision is made by the launcher: the packaged
 * `wok-client` wrapper script on Linux, and `scripts/start-electron.mjs` in development. Both are
 * thin callers of this module, which stays pure and Electron-free so the whole matrix is testable.
 *
 * Electron 38 changed the framework default to native Wayland when `XDG_SESSION_TYPE=wayland`
 * (Chromium's `ui/linux/display_server_utils.cc`, unchanged through the Chromium 150 this build
 * ships). WOK's previous `--ozone-platform=x11` was an override of that default, forcing XWayland.
 * What this module adds over Chromium's own detection is `WAYLAND_DISPLAY`: Chromium reads only
 * `XDG_SESSION_TYPE`, so a real Wayland session with that variable unset - a TTY launch, some
 * display managers, some container and Flatpak launch contexts - silently lands on X11, or on
 * nothing at all when there is no X server to fall back to.
 */

/** The ozone platforms WOK will select. Chromium supports others; none of them are desktop paths. */
export type OzonePlatform = 'wayland' | 'x11';

/** Which rule produced the decision. Surfaced in startup logs so a bug report identifies the path. */
export type OzoneDecisionSource = 'not-linux' | 'override' | 'session' | 'fallback';

export interface OzoneDecision {
	/** `null` means "pass no switch": Chromium's own detection runs, which is never fatal. */
	platform: OzonePlatform | null;
	source: OzoneDecisionSource;
	/** Which environment variable decided, when one did. */
	signal?: string;
	/** One line, safe to print at startup. */
	reason: string;
	/** Set when an override was present but unusable; the decision falls back to detection. */
	warning?: string;
}

/** Documented escape hatch. A stored preference cannot work: the platform is chosen before we run. */
export const OZONE_OVERRIDE_ENV_VAR = 'WOK_OZONE_PLATFORM';

export interface WaylandSessionSignal {
	/** Environment variable to inspect. */
	variable: string;
	/** When set, the variable must equal this exactly. When absent, any non-empty value counts. */
	equals?: string;
	/** Printed when this signal decides. */
	description: string;
}

/**
 * Ordered Wayland signals, first match wins. `WAYLAND_DISPLAY` leads because it is set by the
 * compositor itself and names a live socket, whereas `XDG_SESSION_TYPE` is set by whatever started
 * the session and is routinely missing or stale. This table is the single source of truth: both
 * `resolveOzonePlatform` and the generated launcher script are derived from it.
 */
export const WAYLAND_SESSION_SIGNALS: readonly WaylandSessionSignal[] = [
	{ description: 'a Wayland compositor socket is exported', variable: 'WAYLAND_DISPLAY' },
	{ description: 'the session declares itself as Wayland', equals: 'wayland', variable: 'XDG_SESSION_TYPE' }
];

/**
 * Accepted `WOK_OZONE_PLATFORM` values. `auto` means "defer to Electron", not a literal switch
 * value. Matching is exact and case-sensitive on purpose: the generated launcher compares with a
 * POSIX `case`, which has no portable way to fold case, and a documented escape hatch that behaves
 * differently in the packaged app and in development would be worse than a strict one.
 */
const OVERRIDE_VALUES = new Set(['auto', 'wayland', 'x11']);

function matchesSignal(signal: WaylandSessionSignal, value: string | undefined): boolean {
	if (value === undefined || value === '') return false;
	return signal.equals === undefined ? true : value === signal.equals;
}

/** The first Wayland signal present in the environment, ignoring any override. */
export function detectWaylandSessionSignal(
	env: Record<string, string | undefined>
): WaylandSessionSignal | undefined {
	return WAYLAND_SESSION_SIGNALS.find(signal => matchesSignal(signal, env[signal.variable]));
}

/**
 * Resolves the ozone platform for the current process environment.
 *
 * Non-Linux platforms get `null`: `--ozone-platform` is meaningless on Windows and macOS, and the
 * previous dev script passed it there anyway.
 */
export function resolveOzonePlatform(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform = process.platform
): OzoneDecision {
	if (platform !== 'linux') {
		return { platform: null, reason: 'not Linux; the ozone platform switch does not apply', source: 'not-linux' };
	}

	const rawOverride = env[OZONE_OVERRIDE_ENV_VAR];
	let warning: string | undefined;
	if (rawOverride !== undefined && rawOverride !== '') {
		if (OVERRIDE_VALUES.has(rawOverride)) {
			// `--ozone-platform=auto` is not a value Chromium accepts: `ui/ozone/platform_selection.cc`
			// looks the string up in its generated platform table and LOG(FATAL)s on a miss. Deferring
			// to Electron means emitting no switch at all.
			if (rawOverride === 'auto') {
				return {
					platform: null,
					reason: `${OZONE_OVERRIDE_ENV_VAR}=auto; deferring to Electron's own session detection`,
					source: 'override'
				};
			}
			return {
				platform: rawOverride as OzonePlatform,
				reason: `${OZONE_OVERRIDE_ENV_VAR}=${rawOverride}`,
				signal: OZONE_OVERRIDE_ENV_VAR,
				source: 'override'
			};
		}
		warning = `Ignoring ${OZONE_OVERRIDE_ENV_VAR}=${rawOverride}; expected wayland, x11 or auto.`;
	}

	const waylandSignal = detectWaylandSessionSignal(env);
	if (waylandSignal) {
		return {
			platform: 'wayland',
			reason: `${waylandSignal.variable} says ${waylandSignal.description}`,
			signal: waylandSignal.variable,
			source: 'session',
			warning
		};
	}

	return {
		platform: 'x11',
		reason: 'no Wayland session detected; using X11 (XWayland inside a Wayland session)',
		source: 'fallback',
		warning
	};
}

/** The argv entries a launcher must append for a decision. Empty when Chromium should decide. */
export function ozoneSwitchArguments(decision: OzoneDecision): string[] {
	return decision.platform === null ? [] : [`--ozone-platform=${decision.platform}`];
}

/** Convenience for launchers: environment in, argv out. */
export function linuxLauncherArguments(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform = process.platform
): string[] {
	return ozoneSwitchArguments(resolveOzonePlatform(env, platform));
}

/**
 * Reads back the ozone platform that actually reached the process, for the startup log.
 *
 * The launcher's argv is the ground truth: a user who ran the binary directly, or through a
 * distro wrapper, or with their own flag, gets a line that says so. Returns `null` off Linux.
 */
export function describeLinuxDisplaySession(
	platform: NodeJS.Platform,
	argv: readonly string[],
	env: Record<string, string | undefined>
): string | null {
	if (platform !== 'linux') return null;

	const decision = resolveOzonePlatform(env, platform);
	// Last flag wins, matching Chromium's own command-line handling.
	let applied: string | undefined;
	for (const argument of argv) {
		if (argument.startsWith('--ozone-platform=')) applied = argument.slice('--ozone-platform='.length);
	}

	if (applied === undefined) {
		return `Display server: chosen by Electron, no --ozone-platform was passed (detected: ${decision.reason})`;
	}
	// Worth calling out loudly: this is the old forced-XWayland path, and it is the one exposed to
	// the compositor-side pointer-constraint bugs that fractional scaling triggers.
	const waylandSignal = detectWaylandSessionSignal(env);
	if (applied === 'x11' && waylandSignal) {
		return `Display server: x11 through XWayland, but ${waylandSignal.variable} says ${waylandSignal.description}.`
			+ ` Unset or change ${OZONE_OVERRIDE_ENV_VAR} to run natively on Wayland.`;
	}
	return `Display server: ${applied} (${decision.reason})`;
}

/** Only names that are safe unquoted in the generated `sh` and valid as an executable file name. */
const SAFE_EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function renderSignalCondition(signal: WaylandSessionSignal): string {
	return signal.equals === undefined
		? `[ -n "$${signal.variable}" ]`
		: `[ "$${signal.variable}" = "${signal.equals}" ]`;
}

/**
 * Renders the POSIX `sh` launcher that Electron Forge installs in place of the packaged binary.
 *
 * The rules are generated from `WAYLAND_SESSION_SIGNALS` rather than restated, so the packaged
 * launcher and `resolveOzonePlatform` cannot drift apart.
 */
export function renderLinuxLauncherScript(executableName: string): string {
	if (!SAFE_EXECUTABLE_NAME.test(executableName)) {
		throw new Error(`Refusing to generate a launcher for unsafe executable name: ${executableName}`);
	}

	const waylandTest = WAYLAND_SESSION_SIGNALS.map(renderSignalCondition).join(' || ');

	return [
		'#!/bin/sh',
		`# Generated by forge.config.ts from src/linux-session.ts for ${executableName}. Do not edit.`,
		'#',
		'# Chromium resolves its ozone platform before any application code runs, so the X11 or',
		'# Wayland decision has to be made here, in argv.',
		'#',
		`#   ${OZONE_OVERRIDE_ENV_VAR}=wayland  force native Wayland`,
		`#   ${OZONE_OVERRIDE_ENV_VAR}=x11      force X11 (XWayland inside a Wayland session)`,
		`#   ${OZONE_OVERRIDE_ENV_VAR}=auto     pass no switch and let Electron decide`,
		'',
		'DIR="$(dirname "$(readlink -f "$0")")"',
		`BIN="$DIR/${executableName}.bin"`,
		'',
		`case "$${OZONE_OVERRIDE_ENV_VAR}" in`,
		'  wayland|x11)',
		`    exec "$BIN" --ozone-platform="$${OZONE_OVERRIDE_ENV_VAR}" "$@"`,
		'    ;;',
		'  auto)',
		'    exec "$BIN" "$@"',
		'    ;;',
		'  ?*)',
		`    echo "${executableName}: ignoring ${OZONE_OVERRIDE_ENV_VAR}=$${OZONE_OVERRIDE_ENV_VAR}; expected wayland, x11 or auto" >&2`,
		'    ;;',
		'esac',
		'',
		`if ${waylandTest}; then`,
		'  exec "$BIN" --ozone-platform=wayland "$@"',
		'fi',
		'',
		'exec "$BIN" --ozone-platform=x11 "$@"',
		''
	].join('\n');
}
