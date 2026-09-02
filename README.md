# WOK Client

The fastest Krunker client. Ever. WOK Client is an independent, open-source (GPLv3) desktop client for Krunker on Windows, Linux, and macOS.

[Website](https://wok.social) · [Releases](https://github.com/nzalexgarciagil-ctrl/wok-client/releases) · [Source](https://github.com/nzalexgarciagil-ctrl/wok-client)

![WOK Client](assets/full_logo.svg)

WOK Client is not affiliated with, endorsed by, or approved by FRVR. An optimized browser wrapper is not automatically exempt from a game's terms, so review the current Krunker rules. Optional legacy features are disabled by default and used at your own risk.

## Install

Download a package from the [releases page](https://github.com/nzalexgarciagil-ctrl/wok-client/releases). Tagged builds are unsigned prereleases with SHA-256 checksums; Windows x64 has had real gameplay testing, Linux and macOS are built and source-validated but still need native smoke testing. See [docs/linux-qa-checklist.md](docs/linux-qa-checklist.md) for what to verify on Linux. Unsigned macOS builds may need `xattr -c "/Applications/WOK Client.app"` to clear quarantine.

## Features

- Hardware-aware graphics selection with recovery and calibration safeguards
- Performance diagnostics for frame pacing, graphics backend, and WebGL state
- Bundled themes plus your own CSS files, switchable without a restart
- Menu timer, quick class picker, and match-result export
- Configurable matchmaker and competition-room helper
- Optional Discord Rich Presence
- Ad requests blocked by default

Legacy and early WOK profiles are migrated once without deleting the original profile files.

## Security

Electron web security stays enabled, renderer Node integration is disabled, privileged IPC senders and payloads are validated, and main-window navigation is restricted to HTTPS Krunker origins; other HTTPS links open in the system browser. The game preload needs the page's main JavaScript world, so `contextIsolation` and the renderer sandbox are not enabled for the game window. Do not load arbitrary sites through development overrides; the override setting accepts only HTTPS URLs on `krunker.io` or its subdomains.

## Hotkeys

Press `Alt` on Windows or Linux to reveal the application menu.

| Key | Action |
| --- | --- |
| `F5` | Reload the game |
| `F7` | Copy the current game link |
| `Ctrl+F7` / `Cmd+F7` | Join the game link from the clipboard |
| `F12` or `Ctrl+Shift+I` | Toggle Developer Tools |
| `Ctrl+Shift+F9` | Capture a 10-second renderer CPU profile |
| `F1` (configurable) | Matchmaker launch |

Matchmaker accept, cancel, and launch keys are configurable. A second launch with `--capture-runtime-profile` captures the same profile without a keyboard shortcut.

## Diagnostics

Analyze a captured renderer profile or Chromium trace from a source checkout:

```sh
node scripts/analyze-runtime-profile.mjs "/path/to/renderer.cpuprofile"
node scripts/analyze-frame-trace.mjs "/path/to/chromium-trace.json" "/path/to/report.json"
```

The frame-trace report separates callback, commit, present-call, and presentation-feedback rates and includes queue depth and p50/p95/p99 stage durations. Trace throughput is diagnostic only because tracing can reduce frame cadence.

## Build

Requirements: Git, Node.js 24.13.0+, pnpm 11.15.1+, and platform packaging tools for a local executable (NSIS additionally for the Windows installer).

```sh
pnpm install --frozen-lockfile
pnpm run validate   # lint + typecheck + tests
pnpm start          # run from source
pnpm run make       # local platform package
```

`pnpm install` downloads the documented patched Electron build and verifies it against the release checksum manifest recorded in [docs/PATCHED_ELECTRON.txt](docs/PATCHED_ELECTRON.txt). There is no registry publish command; pushing a reviewed version tag runs the pinned GitHub Actions release workflow. Release provenance and modification notices are in [docs/THIRD_PARTY_NOTICES.txt](docs/THIRD_PARTY_NOTICES.txt) and [CHANGELOG.md](CHANGELOG.md).

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/windows-installer.md](docs/windows-installer.md) | Installer behavior, switches, artwork |
| [docs/qualified-electron.md](docs/qualified-electron.md) | Diagnostic Chromium 152 runtime override |
| [docs/THIRD_PARTY_NOTICES.txt](docs/THIRD_PARTY_NOTICES.txt) | Third-party licenses and modification notices |
| [docs/PATCHED_ELECTRON.txt](docs/PATCHED_ELECTRON.txt) | Patched Electron runtime provenance and checksums |
| [docs/linux-wayland.md](docs/linux-wayland.md) | Wayland/X11 selection, overrides, limitations |
| [docs/linux-qa-checklist.md](docs/linux-qa-checklist.md) | What to smoke-test on a Linux desktop |

## License

WOK Client is distributed under GNU GPL version 3 only. See [LICENSE](LICENSE). Third-party components retain their own licenses as listed in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
