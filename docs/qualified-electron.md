# Qualified Chromium 152 runtime (diagnostic override)

Tagged releases use the default patched Electron 44 nightly runtime documented in [PATCHED_ELECTRON.txt](PATCHED_ELECTRON.txt). The optimized qualified Chromium 152 archive is an explicit local diagnostic override, not the production runtime: real-play A/B testing found a user-reported network-latency regression in that runtime and not in the default patched nightly payload, whose 17 compared Chromium files matched the no-regression isolated build byte-for-byte.

## Measurements

The qualified archive passed ZIP integrity, extracted launch, synthetic 2560x1440, and 13x10-second real-game qualification. Against official Electron 44 stable on the same machine and workload:

- Synthetic paired geometric mean rAF callback-rate gain: 6.69%
- Real-game average rAF callback-rate mean gain: 7.46%
- Real-game rAF callback-rate 1% low mean gain: 9.56%
- Real-game p95 rAF callback-interval reduction: 11.45%

These callback measurements do not establish submitted, GPU-completed, or presented frame rates. Frame-provenance instrumentation is required before using them as rendered-frame results.

## Archive

Archive: `electron-v44.0.0-nightly.20260522-wok-chromium152-win32-x64.zip`

- Release: https://github.com/nzalexgarciagil-ctrl/wok-client/releases/tag/wok-electron-v44.0.0-nightly.20260522-chromium152.0.7977.54
- SHA-256: `20246da5d4b33316391b2dc70e538d6a300fc9c17e9e5563389895c614b7d9b0`
- Electron: 44.0.0-nightly.20260522
- Chromium: 152
- Electron patch commits: `8c5f55ba7` (preserve IPC under uncapped mouse input), `d62cccc07` (bound uncapped compositor submissions)
- Chromium source commit: `68bf21f4e1edf`
- Build configuration: official static release build, PGO phase 2, ThinLTO, V8 builtins PGO, stripped Chromium, Blink, and V8 symbols

## Reproducing locally

Point Forge at the pinned archive before packaging:

```powershell
$env:WOK_QUALIFIED_ELECTRON_ZIP = 'T:/wok-electron-build/package/electron-v44.0.0-nightly.20260522-wok-chromium152-win32-x64.zip'
pnpm run make -- --arch=x64
```

Forge rejects any archive whose SHA-256 is not `20246da5d4b33316391b2dc70e538d6a300fc9c17e9e5563389895c614b7d9b0` and gives Electron Packager the verified local ZIP through `electronZipDir`.
