# three-quake-tui

A port of Quake to Three.js.

### Terminal Mode (OpenTUI + Three.js)

This repo now includes a terminal runtime (`tui.js`) that runs Quake through:

- OpenTUI renderer (`@opentui/core`)
- Three.js scene rendering through OpenTUI's WebGPU path
- Bun runtime (for `npm start`)
- Browser/DOM shims for Quake subsystems (input/audio/canvas APIs)

It does **not** require Deno for terminal play.

#### Setup

1. Install dependencies:

```bash
npm install
```

2. Start terminal mode:

```bash
npm start
```

`npm start` runs `bun run tui.js`.

Requirements:

- Bun + Node.js available on `PATH`
- WebGPU support through Bun/OpenTUI on your machine
- `pak0.pak` in project root (shareware file is included here)

Terminal controls:

- Keyboard: `WASD`, `Space`, etc.
- Mouse click: mapped to Quake mouse buttons (`MOUSE1/MOUSE2/MOUSE3`).
- Mouse wheel: mapped to `MWHEELUP/MWHEELDOWN`.
- Mouse look: enabled by default for terminal mouse move/drag.
- Raw relative mouse mode (pointer-lock style) is available on Linux via `/dev/input/*` (opt-in).
- Menus/HUD/console are composited from Quake's 2D canvas overlay each frame.
- Sound effects are played via a local audio backend (`ffplay` preferred, `aplay` fallback).

Optional tuning:

- `QUAKE_TUI_TARGET_FPS` (default `30`) sets terminal frame budget.
- `QUAKE_TUI_MIN_RENDER_WIDTH` (default `320`) internal minimum render width in pixels.
- `QUAKE_TUI_MIN_RENDER_HEIGHT` (default `240`) internal minimum render height in pixels.
- `QUAKE_TUI_MAX_RENDER_WIDTH` (default `1024`) internal maximum render width in pixels.
- `QUAKE_TUI_MAX_RENDER_HEIGHT` (default `768`) internal maximum render height in pixels.
- `QUAKE_TUI_RENDER_SCALE` (default `1`) scales terminal-derived render size before min/max clamp.
- `QUAKE_TUI_MOUSE_CELL_SCALE` (default `20`) controls look sensitivity per terminal cell.
- `QUAKE_TUI_MOUSE_LOOK=0` disables terminal mouse look while keeping clicks/wheel.
- `QUAKE_TUI_RAW_MOUSE=1` enables raw relative mouse input from a Linux input device.
- `QUAKE_TUI_RAW_MOUSE_DEVICE` sets the raw mouse device path (default `/dev/input/mice`).
- `QUAKE_TUI_RAW_MOUSE_SCALE` scales raw device deltas (default `1.4`).
- `QUAKE_TUI_AUDIO_MAX_PROCS` (default `24`) caps concurrent raw-audio player processes to reduce audio pipe overload spikes.
- `QUAKE_TUI_TAP_RELEASE_MS` (default `28`) release delay for non-hold keys when key-release events are unavailable.
- `QUAKE_TUI_HOLD_INITIAL_MS` (default `240`) initial hold timeout for `+` bindings (e.g. movement) when key-release events are unavailable.
- `QUAKE_TUI_HOLD_REPEAT_MS` (default `70`) repeat hold timeout after repeat keypresses for `+` bindings.

Render behavior:

- The terminal game view scales with terminal size.
- Internal render resolution is clamped between min/max settings above.
- Defaults are `320x240` min and `1024x768` max.

Raw mouse permissions:

- Access to `/dev/input/mice` usually requires membership in the `input` group (or a udev rule).
- Recommended Linux setup:

```bash
sudo usermod -aG input "$USER"
# log out/in after this
```

- Optional udev approach (example):

```bash
sudo tee /etc/udev/rules.d/99-raw-mouse.rules >/dev/null <<'EOF'
KERNEL=="mice", MODE="0660", GROUP="input"
EOF
sudo udevadm control --reload-rules
sudo udevadm trigger
```

- Root fallback (not recommended for regular use):

```bash
sudo QUAKE_TUI_RAW_MOUSE=1 npm start
```

- If raw-device access fails, terminal mouse input still works and the fallback is logged to `/tmp/quake-tui.log`.
- Runtime logs are written to `/tmp/quake-tui.log`.

### Browser Mode

```bash
npm run browser
```

### Play

https://mrdoob.github.io/three-quake/

### Dev Log

https://x.com/mrdoob/status/2015076521531355583

### Assets

Shareware `pak0.pak` included (Episode 1).  
For the full game, replace with your own `pak0.pak` from a registered copy of Quake.

### License

Code: GPL v2

### Credits

- Original game by id Software ([source](https://github.com/id-Software/Quake))
- Three.js port by [@mrdoob](https://github.com/mrdoob) with [@claude](https://github.com/claude)
