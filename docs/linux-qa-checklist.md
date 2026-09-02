# Linux smoke-test checklist

Linux packages are built and source-validated in CI but have not had a gameplay smoke test. If you run WOK on Linux, check these things in order and [report](https://github.com/nzalexgarciagil-ctrl/wok-client/issues) what breaks.

The client prints the display server it ended up on at startup, which is the first thing to check in a bug report. If pointer lock, window placement, or fullscreen misbehave, `WOK_OZONE_PLATFORM=x11` restores the previous behavior. See [docs/linux-wayland.md](linux-wayland.md) for the full display-server story.

1. **Pointer lock.** Click into a match and turn continuously in one direction. The cursor must stay captured and must not hit an invisible edge or reappear over another window. Press Escape and confirm it releases, then click back in and confirm it recaptures. Check it windowed, fullscreen and borderless, and on a fractionally scaled display if you have one.
2. Fullscreen and borderless actually cover the monitor, with square corners and no gap.
3. The window carries the WOK icon in the dock, the window switcher, and the window itself.
4. `wok://` and `crankshaft://` links open the client, and F7 or Ctrl+F7 round-trips a game link.
5. Multi-monitor and mixed-DPI setups: the client opens on the expected display and is not blurry.
6. The launch animation window appears above the game and hands over without leaving a stray window.
