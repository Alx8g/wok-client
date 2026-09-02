# Windows installer

`pnpm run make` builds the Windows installer with NSIS through `scripts/MakerNSIS.ts`. The wizard walks a welcome page, the GPL-3.0 license, a components page for the two shortcuts, the install location, a progress log that names each step, and a finish page that can launch the client.

## Install layout

The install is per-user. It goes to `%LOCALAPPDATA%\WOK Client`, writes only under `HKCU`, and never asks for administrator rights. Uninstalling removes the application, its shortcuts, its Add/Remove Programs entry, its `App Paths` and `Applications` registration, and any `wok:` or `crankshaft:` link handler still pointing at that installation. Settings in `%APPDATA%\WOK Client` are left alone.

## Switches

Command line switches, on both the installer and `Uninstall.exe`:

- `/S`: silent, with every default component
- `/D=<path>`: install location; must be the last argument and unquoted
- `/NODESKTOP`: skip the desktop shortcut
- `/NOSTARTMENU`: skip the Start Menu shortcut

A silent install that finds the application running exits with a non-zero code instead of waiting on a prompt. `QuietUninstallString` in Add/Remove Programs already carries `/S`.

## Artwork

The Modern UI bitmaps are committed under `build/installer/`:

- `wok-header.bmp`, 150x57, the header on every page after the welcome
- `wok-side.bmp`, 164x314, the welcome and finish panel

Both are generated from `assets/wok-mark.svg` and `assets/full_logo.svg` by `scripts/generate-installer-art.mjs`. The generator is dependency-free, deterministic, and needs no image tooling or installed fonts:

```sh
node scripts/generate-installer-art.mjs
node scripts/generate-installer-art.mjs --check
```

Edit a brand vector, rerun the generator, and commit the bitmaps. `pnpm test` fails when the committed bitmaps no longer match the generator output, and the maker regenerates them if a checkout is missing them.
