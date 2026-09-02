# Why WOK Client runs natively on Wayland

The evidence behind the Linux display-server default. Read this before changing it, and re-check the last section when Electron is bumped.

Gathered 2026-08-04 against the exact runtime WOK ships: `electron-nightly 44.0.0-nightly.20260522` (patched mirror, see [PATCHED_ELECTRON.txt](PATCHED_ELECTRON.txt)), which pins Chromium 150.0.7847.0, verified from Electron's `DEPS` at that tag. Read from primary sources: Electron release notes and issue threads, Chromium source at the exact shipped tag, Chromium's tracker, GNOME/mutter's tracker, and the freedesktop protocol tables. File names below are Chromium files at tag `150.0.7847.0`, byte-identical to `main` at the time.

## The default, and what WOK adds

Electron has run as a native Wayland app by default in Wayland sessions since Electron 38 (2025-09-09); `ELECTRON_OZONE_PLATFORM_HINT` was removed, and Wayland gained a CI test job. CSD is fully supported since Electron 41, rounded frameless corners and native WCO title bars since 43. WOK ships Electron 44, so a forced `--ozone-platform=x11` is an explicit override of upstream's own default, and it forces XWayland.

The detection lives in `ui/linux/display_server_utils.cc` (`SetOzonePlatformForLinuxIfNeeded`). Three properties matter:

1. `auto` keys off `XDG_SESSION_TYPE` only and ignores `WAYLAND_DISPLAY`, even though the same file has a `HasWaylandDisplay()` helper. When `XDG_SESSION_TYPE` is unset or something else (TTY launch, some display managers, some container/Flatpak/Steam contexts) a real Wayland session silently falls through to X11.
2. The fallback is unconditional X11. With no X server either, the app dies (electron/electron#48001: "Missing X server or $DISPLAY" then segfault).
3. An explicit `--ozone-platform` short-circuits everything, so passing our own resolved value is well-defined and always wins.

WOK's detection in `src/linux-session.ts` is a strict superset: session is Wayland when `WAYLAND_DISPLAY` is set, or when `XDG_SESSION_TYPE` is exactly `wayland`; otherwise X11 (XWayland inside a Wayland session). That closes gap 1. The escape hatch is `WOK_OZONE_PLATFORM=wayland|x11|auto`, an environment variable because Chromium resolves the display server in `PreEarlyInitialization`, long before any of WOK's JavaScript runs; a stored preference cannot be read in time. Values are matched exactly in lower case; anything else is ignored with a warning on standard error and session detection runs as usual. `auto` means omit the flag and let Electron decide.

## Why native Wayland wins for WOK

1. It is what upstream Electron already does; the forced X11 was inherited from a pre-Electron-38 era ended six major versions ago.
2. Pointer lock, the make-or-break for an FPS client, is implemented in the shipped Chromium via `pointer-constraints-unstable-v1` + `relative-pointer-unstable-v1` (`wayland_zwp_pointer_constraints.cc`, `LIFETIME_ONESHOT` lock then relative deltas, gated on `WaylandToplevelWindow::SupportsPointerLock`). Per the freedesktop tables at wayland.app, both protocols are supported by every compositor listed (Cage, COSMIC, GameScope, Hyprland, Jay, KWin, Labwc, Louvre, Mir, Muffin, Mutter, niri, phoc, river, Sway, Treeland, Wayfire, Weston). Historic Chromium pointer-lock bugs are closed obsolete/duplicate; a 2024/2025 Vivaldi thread reporting broken lock confirms Chromium itself works.
3. The pointer-lock bug that actually bites users today is XWayland + fractional scaling (mutter#3765, cursor escapes the window in Minetest, Minecraft, Valheim, Fallout 4, No Man's Sky; fixes in GNOME 50, backported to mutter 49.3). Forcing X11 on fractional-scaling GNOME puts WOK in exactly that configuration. Native Wayland does not go through XWayland.
4. XWayland adds a composition and pacing layer and is upscaled by the compositor on fractional scaling (blurry output); native Wayland avoids both. Fractional scale (`kWaylandFractionalScaleV1`), text-input-v3 (`kWaylandTextInputV3`), and toplevel drag are enabled by default in Chromium; CSD needs no flag since Electron 41 (`WaylandWindowDecorations` no longer exists as a flag).

## Compositor-side restrictions that touch WOK's code

`ozone_platform_wayland.cc` sets `supports_global_screen_coordinates = false`, so on Wayland: the compositor places windows (`win.setPosition` unsupported; WOK's borderless `x`/`y` and `moveTop()` are no-ops), `win.focus()` is advisory activation (Mutter notification, KWin taskbar flash), `skipTaskbar` is unsupported since Electron 20, and `desktopCapturer`/`globalShortcut` are portal-mediated. WOK's actual exposure: borderless positioning no-ops, `introWindow.setAlwaysOnTop` best-effort, game window focus advisory. Electron 43 made frameless Linux windows default `roundedCorners: true`; for a screen-covering borderless game window that means rounded corners at the display edges, so borderless sets `roundedCorners: false` explicitly.

IME uses `text-input-v3` by default; `--enable-wayland-ime` remains available as an opt-in for older input methods, and WOK does not set it (a game client has no IME requirement and the flag has a regression history).

## App id and icon on Wayland

electron/electron#48391/#49988 (in Electron 44): the default XDG app id derives from the executable name, not `productName`, and `desktopName` in package.json pins it. The `@reforged/maker-appimage` maker writes `${productName}.desktop` ("WOK Client.desktop", invalid as a desktop-entry file name and unmatchable against the `wok-client` app id, hence generic icons), and names the AppImage from `productName` (a space in the download filename). WOK pins `desktopName` and uses `build/wok-client.desktop`.

## What to re-check when Electron is bumped

1. `SetOzonePlatformForLinuxIfNeeded` still ignores `WAYLAND_DISPLAY`. If upstream starts honouring it, `src/linux-session.ts` adds nothing and the launcher could go back to passing no switch at all.
2. `WaylandToplevelWindow::SupportsPointerLock` still gates on the two pointer-constraint protocols, and `LockPointer` still uses `LIFETIME_ONESHOT` with relative pointer motion.
3. `--ozone-platform` still rejects `auto` as a value (`ui/ozone/platform_selection.cc` aborts with `LOG(FATAL)`, because the value is looked up in the generated platform-name table). "Let Chromium decide" means omit the flag, never pass `auto`. `--ozone-platform-hint` no longer exists at all (removed with Chromium 140 / Electron 38).
4. Electron's default XDG app id is still the executable name; `desktopName` in package.json pins it either way.

## Primary sources for re-verification

Chromium at `https://raw.githubusercontent.com/chromium/chromium/<tag>/<path>` (tag `150.0.7847.0` unless noted): `ui/linux/display_server_utils.cc`, `ui/ozone/platform_selection.cc`, `ui/ozone/generate_ozone_platform_list.py`, `ui/ozone/public/ozone_switches.cc`, `ui/ozone/common/features.cc`, `ui/base/ui_base_features.cc`, `ui/ozone/platform/wayland/host/wayland_zwp_pointer_constraints.cc`, `wayland_zwp_relative_pointer_manager.cc`, `wayland_toplevel_window.cc`, `wayland_event_source.cc`, `ui/ozone/platform/wayland/ozone_platform_wayland.cc`.

Electron at `https://raw.githubusercontent.com/electron/electron/v44.0.0-nightly.20260522/`: `DEPS` (pinned Chromium version), `shell/app/electron_main_delegate.cc` (where detection is called). Third-party packaging: `@reforged/maker-appimage`, `makers/appimage/src/main.ts` and `makers/types/index.d.ts` in `SpacingBat3/ReForged`.

Key upstream links: [electron 38 release notes](https://www.electronjs.org/blog/electron-38-0), [breaking changes](https://www.electronjs.org/docs/latest/breaking-changes), [Wayland tech talk](https://electronjs.org/blog/tech-talk-wayland), electron/electron#48001, #48391, #49988, #51786, [mutter#3765](https://gitlab.gnome.org/GNOME/mutter/-/issues/3765), [mutter#4575](https://gitlab.gnome.org/GNOME/mutter/-/issues/4575), [pointer-constraints-unstable-v1](https://wayland.app/protocols/pointer-constraints-unstable-v1), [relative-pointer-unstable-v1](https://wayland.app/protocols/relative-pointer-unstable-v1), Chromium commit `3cf2a1826b002326a2d2994a489e98eebc340054` (default flip), CL 6775426/6819616.
