# WOK Client

WOK Client is a hardware-adaptive, performance-focused Krunker desktop client written in TypeScript.

Website: [client.wok.social](https://client.wok.social)

Source: [github.com/nzalexgarciagil-ctrl/wok-client](https://github.com/nzalexgarciagil-ctrl/wok-client)

Releases: [WOK Client releases](https://github.com/nzalexgarciagil-ctrl/wok-client/releases)

![WOK Client](assets/full_logo.svg)

## Project status

WOK Client `1.0.0` is the first WOK release and is a modified version of GPL-licensed [Crankshaft 2.0.1](https://github.com/KraXen72/crankshaft/tree/c1f1ce39e49296735ac73737b1cb6f2b5e5482b2). Crankshaft attribution, license terms, and contributor history are preserved. See [CHANGELOG.md](CHANGELOG.md), [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt), and [PATCHED_ELECTRON.txt](PATCHED_ELECTRON.txt) for the modification and dependency record.

Pull requests and branch pushes run source validation on Windows, Linux, and macOS. Version tags build unsigned platform packages and publish them as GitHub prereleases with checksums and explicit testing limitations.

WOK Client is an independent project. It is not affiliated with, endorsed by, or approved by FRVR. An optimized browser wrapper is not automatically exempt from a game's terms, so users should review the current Krunker rules and use optional legacy features at their own risk.

## Features

- Hardware-aware graphics selection with recovery and calibration safeguards
- Optional Competitive mode with reversible Krunker setting changes
- Performance diagnostics for FPS, frame pacing, graphics backend, and WebGL state
- Bundled themes for the client's own UI, plus your own CSS files, switchable without a restart
- Menu timer, quick class picker, and match-result export
- Configurable matchmaker and competition-room helper
- Optional Discord Rich Presence using an in-tree IPC client
- Legacy resource swapping, ad controls, custom filters, matchmaker, and competition automation remain disabled by default

Terms-sensitive features require an explicit user choice. Existing Crankshaft or early WOK profiles are migrated once to the safe defaults without deleting the original profile files.

## Security boundaries

WOK Client keeps Electron web security enabled, disables renderer Node integration, validates privileged IPC senders and payloads, restricts main-window navigation to HTTPS Krunker origins, and opens other HTTPS links in the system browser.

The game preload still requires the page's main JavaScript world, so `contextIsolation` and the renderer sandbox are not currently enabled for the game window. Do not load arbitrary sites through development overrides. The override setting accepts only HTTPS URLs on `krunker.io` or its subdomains.

## Hotkeys

Press `Alt` on Windows or Linux to reveal the application menu.

- `F5`: reload the game
- `F7`: copy the current game link
- `Ctrl+F7` or `Cmd+F7`: join the game link from the clipboard
- `F12` or `Ctrl+Shift+I`/`Cmd+Shift+I`: toggle Developer Tools
- `Alt+F8`: toggle performance diagnostics when enabled
- `Ctrl+Shift+F9` or `Cmd+Shift+F9`: capture a 10-second renderer CPU profile and Chromium trace
- Matchmaker accept, cancel, and launch keys are configurable; the default launch key is `F1`

Runtime profiles are written beneath the app's `config/runtime-profiles/` directory. Rank renderer self-time from a source checkout with:

```sh
node scripts/analyze-runtime-profile.mjs "/path/to/renderer.cpuprofile"
```

## Build and validation

Requirements:

- Git
- Node.js 24.13.0 or newer
- pnpm 11.15.1 or newer
- Platform packaging tools when making a local executable; Windows installer creation also requires NSIS

The documented patched-Electron release currently provides archives for macOS arm64, Linux x64, and Windows x64. Other architectures require a separately reviewed Electron build and checksum record. Windows x64 has received local gameplay testing. Linux x64 and macOS arm64 retain Crankshaft's packaging paths and are covered by source validation, but still require native package and gameplay smoke tests before they are described as verified releases.

From a source checkout:

```sh
pnpm install --frozen-lockfile
pnpm run validate
```

`pnpm install` downloads the documented patched Electron build and verifies it against the release checksum manifest. The mirror, source commit, and SHA-256 values are recorded in [PATCHED_ELECTRON.txt](PATCHED_ELECTRON.txt).

Development commands:

```sh
pnpm start
pnpm run lint
pnpm run typecheck
pnpm test
```

To make a local platform package after reviewing the provenance and platform prerequisites:

```sh
pnpm run make
```

There is intentionally no registry publish command in the package metadata. Pushing a reviewed version tag invokes the pinned GitHub Actions release workflow, which publishes unsigned GitHub prerelease artifacts and SHA-256 checksums.

## Windows installer

`pnpm run make` builds the Windows installer with NSIS through `MakerNSIS.ts`. The wizard walks a welcome page, the GPL-3.0 license, a components page for the two shortcuts, the install location, a progress log that names each step, and a finish page that can launch the client.

The install is per-user. It goes to `%LOCALAPPDATA%\WOK Client`, writes only under `HKCU`, and never asks for administrator rights. Uninstalling removes the application, its shortcuts, its Add/Remove Programs entry, its `App Paths` and `Applications` registration, and any `wok:` or `crankshaft:` link handler still pointing at that installation. Settings in `%APPDATA%\WOK Client` are left alone.

Command line switches, on both the installer and `Uninstall.exe`:

- `/S`: silent, with every default component
- `/D=<path>`: install location; must be the last argument and unquoted
- `/NODESKTOP`: skip the desktop shortcut
- `/NOSTARTMENU`: skip the Start Menu shortcut

A silent install that finds the application running exits with a non-zero code instead of waiting on a prompt. `QuietUninstallString` in Add/Remove Programs already carries `/S`.

### Installer artwork

The Modern UI bitmaps are committed under `build/installer/`:

- `wok-header.bmp`, 150x57, the header on every page after the welcome
- `wok-side.bmp`, 164x314, the welcome and finish panel

Both are generated from `assets/wok-mark.svg` and `assets/full_logo.svg` by `scripts/generate-installer-art.mjs`. The generator is dependency-free, deterministic, and needs no image tooling or installed fonts:

```sh
node scripts/generate-installer-art.mjs
node scripts/generate-installer-art.mjs --check
```

Edit a brand vector, rerun the generator, and commit the bitmaps. `pnpm test` fails when the committed bitmaps no longer match the generator output, and the maker regenerates them if a checkout is missing them.

## Linux: Wayland and X11

WOK Client picks its display server at launch. If the session looks like Wayland it runs as a
native Wayland application; otherwise it runs on X11, which inside a Wayland session means
XWayland. The session is Wayland when `WAYLAND_DISPLAY` is set, or when `XDG_SESSION_TYPE` is
exactly `wayland`.

This is a deliberate change from earlier versions, which always passed `--ozone-platform=x11`.
Electron has defaulted to native Wayland since Electron 38; WOK ships Electron 44, so the forced
X11 was an override of the framework's own default. XWayland adds a composition and pacing layer,
is upscaled by the compositor on fractional-scaling desktops, and is the path affected by
[mutter#3765](https://gitlab.gnome.org/GNOME/mutter/-/issues/3765), where the pointer escapes a
window that has locked it. Native Wayland avoids all three.

Detecting `WAYLAND_DISPLAY` is what WOK adds over Electron's own detection, which reads only
`XDG_SESSION_TYPE`. Sessions started from a TTY, from some display managers, or inside some
containers leave that variable unset and would otherwise silently fall back to X11.

The full evidence behind this default, including what to re-check on the next Electron bump, is in
[docs/linux-wayland.md](docs/linux-wayland.md).

To override, set `WOK_OZONE_PLATFORM` before launching:

| Value | Effect |
| --- | --- |
| `wayland` | Force native Wayland |
| `x11` | Force X11, which is XWayland inside a Wayland session |
| `auto` | Pass no flag and let Electron choose |

```sh
WOK_OZONE_PLATFORM=x11 ./wok-client-x64.AppImage
```

The value is matched exactly, in lower case. Anything else is ignored with a message on standard
error and the session detection runs as usual, so a typo cannot leave the client unable to start.

An environment variable rather than a setting, because Chromium resolves the display server before
any of the client's own code runs, so a stored preference cannot be read in time.

The client prints the display server it ended up on at startup, which is the first thing to check
in a bug report. If pointer lock, window placement, or fullscreen misbehave on your desktop,
`WOK_OZONE_PLATFORM=x11` restores the previous behaviour; please report what broke.

Some Wayland behaviour is set by the compositor, not by the client, and differs from X11: the
compositor decides where windows are placed, so borderless mode cannot position itself on a chosen
monitor, and requests to raise or focus a window are advisory. Input-method (IME) support uses
`text-input-v3`; `--enable-wayland-ime` can be appended if your input method needs the older path.

### Not yet verified on a Linux desktop

Linux packages are built and source-validated in CI but have not had a gameplay smoke test. If you
run WOK on Linux, these are the things worth checking, in order:

1. **Pointer lock.** Click into a match and turn continuously in one direction. The cursor must
   stay captured and must not hit an invisible edge or reappear over another window. Press Escape
   and confirm it releases, then click back in and confirm it recaptures. Check it windowed,
   fullscreen and borderless, and on a fractionally scaled display if you have one.
2. Fullscreen and borderless actually cover the monitor, with square corners and no gap.
3. The window carries the WOK icon in the dock, the window switcher, and the window itself.
4. `wok://` and `crankshaft://` links open the client, and F7 or Ctrl+F7 round-trips a game link.
5. Multi-monitor and mixed-DPI setups: the client opens on the expected display and is not blurry.
6. The launch animation window appears above the game and hands over without leaving a stray window.

## macOS quarantine

Locally built or unsigned applications may be quarantined by macOS. Review the source and build provenance before clearing quarantine. If appropriate for your own build:

```sh
xattr -c "/Applications/WOK Client.app"
```

## Credits

WOK Client is based on [Crankshaft](https://github.com/KraXen72/crankshaft). See the [full Crankshaft contributor history](https://github.com/KraXen72/crankshaft/graphs/contributors).

Crankshaft was built from earlier work in Gatoclient, idkr, and Gatoclient Lite. Upstream acknowledgements include:

- [Creepycats](https://github.com/creepycats) and [Gatoclient](https://github.com/Gatohost/gatoclient)
- [LukeTheDuke](https://github.com/LukeTheDuke240) and Gatoclient Lite
- [bigjakk](https://github.com/bigjakk) for Electron build work and parallel work on [KCC](https://github.com/bigjakk/Krunker-Civilian-Client)
- [AspectQuote](https://github.com/AspectQuote) for matchmaker and UI work
- [Iona](https://github.com/eeonaa) for the CSS swapper the theme system grew out of
- [wa/paintingofblue](https://github.com/hsyslm) for the original matchmaker
- [Commander/asger-finding](https://github.com/asger-finding) for resource-swapper work
- [Tae](https://github.com/whuuayu) for the original Crankshaft logo

The complete historical record remains in Git and [CHANGELOG.md](CHANGELOG.md).

## License

WOK Client and the modified Crankshaft source are distributed under GNU GPL version 3 only. See [LICENSE](LICENSE). Third-party components retain their own licenses as listed in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). Local packages copy the WOK GPL license, third-party notices, and patched-Electron provenance into the packaged resources directory without replacing Electron's own license files.
