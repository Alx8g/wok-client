# Why WOK Client runs natively on Wayland

The evidence behind the Linux display-server default. Read this before changing
it, and re-check the last section when Electron is bumped.

Gathered 2026-08-04 against the exact runtime WOK ships:
`electron-nightly 44.0.0-nightly.20260522` (patched mirror, see
`PATCHED_ELECTRON.txt`), which pins **Chromium 150.0.7847.0**, verified from
Electron's `DEPS` at that tag.

Everything below was read from primary sources: Electron release notes and issue
threads, Chromium source at the exact shipped version tag, Chromium's issue
tracker, GNOME/mutter's tracker, and the freedesktop protocol support tables.

---

## 1. Native Wayland is the upstream default, and has been since Electron 38

Electron 38.0.0 release notes (2025-09-09), "Breaking Changes → Removed:
`ELECTRON_OZONE_PLATFORM_HINT` environment variable":

> The default value of the `--ozone-platform` flag changed to `auto`.
> Electron now runs as a native Wayland app by default when launched in a
> Wayland session on Linux. [...] You can force Electron to run in X11
> compatibility mode (Xwayland), like it did in older versions, by appending the
> flag `--ozone-platform=x11`.

Source: https://www.electronjs.org/blog/electron-38-0

Electron's "Breaking Changes" doc restates it and names the trigger:

> Electron now defaults to running as a native Wayland app when launched in a
> Wayland session (when `XDG_SESSION_TYPE=wayland`). Users can force XWayland by
> passing `--ozone-platform=x11`.

Source: https://www.electronjs.org/docs/latest/breaking-changes

Electron blog, "Tech Talk: How Electron went Wayland-native" (2026-03-17):

- "Wayland is supported out of the box in Electron 38.2 and newer."
- Chromium turned Wayland on by default in August 2025 (CL 6819616).
- **Electron 41 supports CSD on Wayland in all window configurations**, including
  frameless windows with Window Controls Overlay.
- Electron gained a **Wayland test job in CI** (electron/electron#49908).

Source: https://electronjs.org/blog/tech-talk-wayland

Electron 43 breaking changes add rounded corners for frameless Linux windows and
native title-bar layout for WCO on Linux.

**WOK ships Electron 44.** Every one of those milestones is behind it. The
`--ozone-platform=x11` that WOK passes today is not a neutral default, it is an
explicit override of upstream's own default, and it forces XWayland.

---

## 2. What `auto` actually does (and its gap)

The detection lives in `ui/linux/display_server_utils.cc`. Read at tag
`150.0.7847.0`; byte-identical to Chromium `main` today (saved as
`display_server_utils.cc` / `display_server_utils_150.cc`):

```c++
void SetOzonePlatformForLinuxIfNeeded(base::CommandLine& command_line) {
  if (command_line.HasSwitch(switches::kOzonePlatform)) {
    return;                                    // an explicit flag always wins
  }
#if BUILDFLAG(SUPPORTS_OZONE_WAYLAND)
  auto env = base::Environment::Create();
  std::optional<std::string> xdg_session_type =
      env->GetVar(base::nix::kXdgSessionTypeEnvVar);
  if (xdg_session_type.has_value() && *xdg_session_type == "wayland") {
    command_line.AppendSwitchASCII(switches::kOzonePlatform, "wayland");
    return;
  }
#endif
#if BUILDFLAG(SUPPORTS_OZONE_X11)
  command_line.AppendSwitchASCII(switches::kOzonePlatform, "x11");
#endif
}
```

Electron calls it directly: `shell/app/electron_main_delegate.cc:326` at tag
`v44.0.0-nightly.20260522` (saved as `electron_main_delegate_44nightly.cc`).

Three consequences:

1. **`auto` keys off `XDG_SESSION_TYPE` only.** It ignores `WAYLAND_DISPLAY`,
   even though the same file has a `HasWaylandDisplay()` helper that checks
   `WAYLAND_DISPLAY` and the `wayland-0` socket. When `XDG_SESSION_TYPE` is unset
   or is something else (launching from a TTY, some display managers, some
   container/Flatpak/Steam launch contexts) a real Wayland session silently
   falls through to X11.
2. **The fallback is unconditional X11.** If there is no X server either, the app
   dies. Reported in electron/electron#48001 by a user on Electron 39:
   `ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc:249] Missing X server or
   $DISPLAY` followed by `Segmentation fault (core dumped)`.
3. **An explicit `--ozone-platform` short-circuits the whole thing**, so passing
   our own resolved value is well-defined and always wins.

### `--ozone-platform-hint` no longer exists

electron/electron#48001 (closed, by the maintainer who did the Electron 39
Chromium roll):

> While working on the main upgrade roll for Electron 39, this change
> (CL 6819616) that removes the `--ozone-platform-hint` flag was causing an
> error. [...] the flag was being removed because the default value became
> `auto` (CL 6775426). That change landed in Chromium 140 which is part of
> Electron 38.
> [...] `auto` works by inspecting the `XDG_SESSION_TYPE` env var, meaning ours
> now acts like an alias for that one.

Verified directly: `ui/ozone/public/ozone_switches.cc` at `150.0.7847.0` declares
only `ozone-platform`; there is no `ozone-platform-hint` (saved as
`ozone_switches_150.cc`). Passing it now only produces Electron's
"'ozone-platform-hint' is not in the list of known options" warning and does
nothing. **The brief's suggestion to prefer `--ozone-platform-hint=auto` is no
longer viable on this Electron.**

### `--ozone-platform=auto` is fatal, do not emit it

"The default value changed to `auto`" describes behaviour, not an accepted value.
`ui/ozone/platform_selection.cc` (identical at `150.0.7847.0` and `main`) looks
the switch value up in the generated `kPlatformNames` table and, on a miss:

```c++
  LOG(FATAL) << "Invalid ozone platform: " << platform_name;
```

`generate_ozone_platform_list.py` only ever emits real platform names
(`wayland`, `x11`, ...) into that table, so `--ozone-platform=auto` would abort
at startup. "Let Chromium decide" means **omit the flag**, never pass `auto`.

The Chromium commit that flipped the default is
`3cf2a1826b002326a2d2994a489e98eebc340054` — a one-line change in
`ui/base/ui_base_features.cc` turning `kOverrideDefaultOzonePlatformHintToAuto`
from `FEATURE_DISABLED_BY_DEFAULT` to `FEATURE_ENABLED_BY_DEFAULT` under
`BUILDFLAG(IS_LINUX)` (raw diff saved as `cl6775426.b64`). That feature has since
been removed entirely; the behaviour is now unconditional.

---

## 3. Pointer lock: the make-or-break question

**Verdict: implemented, and universally supported by compositors.**

Chromium's Ozone/Wayland backend implements pointer lock with the standard
`pointer-constraints-unstable-v1` + `relative-pointer-unstable-v1` pair.
`ui/ozone/platform/wayland/host/wayland_zwp_pointer_constraints.cc`, read at tag
`150.0.7847.0` and byte-identical to `main`:

```c++
void WaylandZwpPointerConstraints::LockPointer(WaylandSurface* surface) {
  locked_pointer_.reset(zwp_pointer_constraints_v1_lock_pointer(
      obj_.get(), surface->surface(),
      connection_->seat()->pointer()->wl_object(), nullptr,
      ZWP_POINTER_CONSTRAINTS_V1_LIFETIME_ONESHOT));
  ...
}
// static
void WaylandZwpPointerConstraints::OnLocked(void* data, ...) {
  auto* self = static_cast<WaylandZwpPointerConstraints*>(data);
  self->connection_->zwp_relative_pointer_manager()->EnableRelativePointer();
}
```

That is the correct FPS shape: lock the pointer in place, then switch to relative
motion deltas. `WaylandEventSource::OnRelativePointerMotion` accumulates the
deltas and feeds them into the normal pointer-event path
(`wayland_event_source.cc:940-953`).

The capability gate, `wayland_toplevel_window.cc:734` at `150.0.7847.0`:

```c++
bool WaylandToplevelWindow::SupportsPointerLock() {
  return !!connection()->zwp_pointer_constraints() &&
         !!connection()->zwp_relative_pointer_manager();
}
```

So pointer lock works iff the compositor advertises both globals. Per the
freedesktop protocol support tables at wayland.app, **both** protocols are
supported by every compositor listed: Cage, COSMIC, GameScope, Hyprland, Jay,
KWin, Labwc, Louvre, Mir, Muffin, Mutter, niri, phoc, river, Sway, Treeland,
Wayfire, Weston.

- https://wayland.app/protocols/pointer-constraints-unstable-v1
- https://wayland.app/protocols/relative-pointer-unstable-v1

Historic Chromium bugs are stale, not open regressions. crbug 40853317
"[Wayland] mouse lock broken on linux" (filed 2022 against Chrome 104) was closed
**Won't Fix (Obsolete)** in May 2024; crbug 40861042 "Pointer lock gets stuck on
Wayland" is a duplicate of it.

Contemporary user reports point the same way. A 2024/2025 Vivaldi forum thread
reporting broken pointer lock on Wayland says explicitly:

> This works fine on Brave and Chromium using Wayland, so I don't think this is
> upstream.

https://forum.vivaldi.net/topic/101735/pointer-lock-is-broken-on-wayland

### The pointer-lock bug that is real today is an XWayland bug

GNOME/mutter#3765, "Mouse cursor not constrained in Xwayland window when using
fractional scaling" — cursor escapes the window in Minetest, Minecraft, Valheim,
Fallout 4, No Man's Sky, all of which go through XWayland. Related:
mutter#4238 "XWayland Fractional Scaling breaks pointer grabbing/warping in GW2".
Fixes landed for GNOME 50 (MR !4989 "wayland/pointer-constraints: Scale cursor
position hint for Xwayland") and were backported (mutter 49.3, then Fedora 43).

- https://gitlab.gnome.org/GNOME/mutter/-/issues/3765
- https://gitlab.gnome.org/GNOME/mutter/-/issues/4575

This is decisive for WOK's choice. Forcing `--ozone-platform=x11` on a
fractional-scaling GNOME Wayland desktop puts the client into *precisely* the
configuration with a known, long-lived pointer-constraint bug. Native Wayland
does not go through XWayland at all and is not exposed to it.

---

## 4. Fractional scaling, decorations, IME

From `ui/ozone/common/features.cc` at `150.0.7847.0`:

- `kWaylandFractionalScaleV1` — **`FEATURE_ENABLED_BY_DEFAULT`**. Native
  `wp_fractional_scale_v1` support, no flag needed. (Chromium's wayland host dir
  also carries `fractional_scale_manager.{cc,h}`.) The XWayland path, by
  contrast, is upscaled by the compositor and is the classic source of blurry
  output on fractional scaling.
- `kWaylandXdgToplevelDrag` — enabled by default.
- `kWaylandOverlayDelegation` — disabled by default (unchanged, not our concern).

From `ui/base/ui_base_features.cc` at `150.0.7847.0`:

- `kWaylandTextInputV3` — **`FEATURE_ENABLED_BY_DEFAULT`**. The old
  `--enable-wayland-ime --wayland-text-input-version=3` incantation is no longer
  needed. `--enable-wayland-ime` still exists in `ozone_switches.cc` as an
  opt-in; WOK should not set it (a game client has no IME requirement and it has
  a history of regressions), but it is worth documenting as an escape hatch.
- `kWaylandSessionManagement` — disabled by default. Compositor-side window
  position restore; not relevant to us.

**`WaylandWindowDecorations` no longer exists** as a feature flag anywhere in
`ui/base/ui_base_features.cc` or `ui/ozone/common/features.cc` at this version.
It was the old opt-in for client-side decorations; per the Electron tech talk,
CSD is handled natively and completely as of Electron 41. Nothing to pass.

---

## 5. Wayland API restrictions that touch WOK's code

`ozone_platform_wayland.cc` sets, in `GetPlatformProperties()`:

```c++
  properties->supports_global_screen_coordinates = false;
```

Per the Electron tech talk, the developer-visible consequences are:

- `win.setPosition(x, y)` is **not supported** — the compositor places windows.
- `screen.getCursorScreenPoint()` is **not supported**.
- `win.focus()` is advisory: Mutter shows a notification, KWin flashes the task
  bar entry. Both are valid readings of `xdg-activation-v1`.
- `desktopCapturer` and `globalShortcut` are portal-mediated and depend on the
  desktop environment and portal version.
- `skipTaskbar` has been unsupported on Linux since Electron 20.
- Electron 51 docs add a note that there is no minimized state on Wayland
  (electron/electron#51786).

WOK's exposure, from a grep of `src/`:

- `mainWindow.moveTop()` for `fullscreen: 'borderless'` — a no-op on Wayland.
- `resolveGameplayWindowGeometry` returns `x`/`y` for borderless — ignored on
  Wayland; the compositor places the window.
- `introWindow.setAlwaysOnTop(true, 'screen-saver')` — best-effort on Wayland.
- `gameWindow.show()` / `.focus()` — advisory activation, as above.
- No `screen.getCursorScreenPoint()`, no `globalShortcut`, no `desktopCapturer`.

Electron 43 made frameless Linux windows default to `roundedCorners: true`. For a
screen-covering borderless game window that means rounded corners at the display
edges, so borderless should set `roundedCorners: false` explicitly.

---

## 6. Desktop entry / app id / icon

electron/electron#48391 "Wayland app_id should be normalized to match wm_class"
(closed, fixed by PR #49988, merged before 2026-03, so present in Electron 44).
PR #49988, "fix: better shortcut registration and app icon matching on Wayland":

> Notes: Global shortcuts can now be registered more reliably on Wayland using
> the `globalShortcut` API. Fixed an issue where some apps had generic "W" icons
> on Wayland. This change impacts the default XDG application identifier. If you
> need this ID to have a stable value, set `desktopName` in package.json.

The new default XDG app id is derived from the **executable name**, not
`productName`. Electron's `app.setDesktopName` docs:

> This value is used to determine the default XDG application ID on Wayland and
> `WM_CLASS` on X11. If it is not set, Electron will attempt to infer a name, but
> it may not match the packaged app's actual `.desktop` file. This could result
> in the app showing a generic icon or failing to respond to global keyboard
> shortcuts. [...] The value can also be set using `desktopName` in
> `package.json`.

https://www.electronjs.org/docs/latest/api/app

WOK's AppImage was shipping a mismatched entry. `@reforged/maker-appimage`
(`makers/appimage/src/main.ts`) writes the desktop entry to
`` `${productName}.desktop` `` and defaults `productName` to Forge's `appName`:

```ts
    productName ??= appName;                      // -> "WOK Client"
    ...
      resolve(workDir, productName+'.desktop')    // -> "WOK Client.desktop"
```

`WOK Client.desktop` is not a valid desktop-entry file name (the spec allows only
`[A-Za-z0-9-_]` plus dots) and cannot match the `wok-client` app id Electron
reports, so GNOME/KDE cannot resolve the icon on Wayland. The maker also names
the AppImage from `productName`, so the release artifact was
`WOK Client-x64.AppImage`, with a space in a download filename.

---

## 7. Verdict

Default to **native Wayland when a Wayland session is detected**, X11 otherwise.

1. It is what upstream Electron already does. WOK's `--ozone-platform=x11` is an
   override of the framework default, inherited from an era (pre-Electron 38)
   that ended six major versions ago.
2. Pointer lock, the make-or-break for an FPS client, is implemented in the
   shipped Chromium and supported by every mainstream compositor.
3. The pointer-lock bug that actually bites users right now is an XWayland +
   fractional-scaling bug, i.e. a bug in the path WOK forces today.
4. Fractional scaling, CSD, and IME all work natively with no extra switches.

The detection WOK ships is a strict superset of Chromium's: it also honours
`WAYLAND_DISPLAY`, closing the gap in §2. The escape hatch is
`WOK_OZONE_PLATFORM=wayland|x11|auto`, because the ozone platform is chosen in
`PreEarlyInitialization`, long before the app's JavaScript runs — this is why
`src/switches.ts` already carried the note that `--ozone-platform` "works as a
cli flag, but not w/ appendSwitch". A stored preference cannot be read early
enough; an environment variable can.

## Sources, so this can be re-checked on the next Electron bump

Every Chromium file below was read at tag `150.0.7847.0` and compared against
`main`. Fetch them from
`https://raw.githubusercontent.com/chromium/chromium/<tag>/<path>`:

- `ui/linux/display_server_utils.cc` — the session detection itself
- `ui/ozone/platform_selection.cc`, `ui/ozone/generate_ozone_platform_list.py` —
  why `--ozone-platform=auto` is fatal
- `ui/ozone/public/ozone_switches.cc` — the surviving ozone switches
- `ui/ozone/common/features.cc`, `ui/base/ui_base_features.cc` — fractional
  scaling, text-input-v3, and what is on by default
- `ui/ozone/platform/wayland/host/wayland_zwp_pointer_constraints.cc`,
  `wayland_zwp_relative_pointer_manager.cc`, `wayland_toplevel_window.cc`,
  `wayland_event_source.cc` — pointer lock
- `ui/ozone/platform/wayland/ozone_platform_wayland.cc` — platform properties

Electron, from
`https://raw.githubusercontent.com/electron/electron/v44.0.0-nightly.20260522/`:

- `DEPS` — the pinned Chromium version
- `shell/app/electron_main_delegate.cc` — where the detection is called

Third-party packaging: `@reforged/maker-appimage`, `makers/appimage/src/main.ts`
and `makers/types/index.d.ts` in `SpacingBat3/ReForged`.

### What to re-check when Electron is bumped

1. `SetOzonePlatformForLinuxIfNeeded` still ignores `WAYLAND_DISPLAY`. If
   upstream starts honouring it, `src/linux-session.ts` adds nothing and the
   launcher could go back to passing no switch at all.
2. `WaylandToplevelWindow::SupportsPointerLock` still gates on the two protocols,
   and `LockPointer` still uses `LIFETIME_ONESHOT` with relative pointer motion.
3. `--ozone-platform` still rejects `auto`.
4. Electron's default XDG app id is still the executable name; `desktopName` in
   package.json pins it either way.
