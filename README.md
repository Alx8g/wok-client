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
- CSS swapper, menu timer, quick class picker, and match-result export
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
- Matchmaker accept, cancel, and launch keys are configurable; the default launch key is `F1`

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
- [Iona](https://github.com/eeonaa) for the CSS swapper
- [wa/paintingofblue](https://github.com/hsyslm) for the original matchmaker
- [Commander/asger-finding](https://github.com/asger-finding) for resource-swapper work
- [Tae](https://github.com/whuuayu) for the original Crankshaft logo

The complete historical record remains in Git and [CHANGELOG.md](CHANGELOG.md).

## License

WOK Client and the modified Crankshaft source are distributed under GNU GPL version 3 only. See [LICENSE](LICENSE). Third-party components retain their own licenses as listed in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). Local packages copy the WOK GPL license, third-party notices, and patched-Electron provenance into the packaged resources directory without replacing Electron's own license files.
