# three-quake-tui

A port of Quake to Three.js.

### Terminal Mode (OpenTUI + Three.js)

Run Quake directly in your terminal:

```bash
npm install
npm start
```

`npm start` launches `tui.js` via Bun and renders the Three.js scene with OpenTUI's terminal renderer.
Requires a machine/driver combo where Bun WebGPU is available.

Terminal controls:

- Keyboard: `WASD`, `Space`, etc.
- Mouse click: mapped to Quake mouse buttons (`MOUSE1/MOUSE2/MOUSE3`).
- Mouse wheel: mapped to `MWHEELUP/MWHEELDOWN`.
- Mouse look: enabled by default for terminal mouse move/drag.
- Raw relative mouse mode (pointer-lock style) is available on Linux via `/dev/input/*` (opt-in).
- Menus/HUD/console are composited from Quake's 2D canvas overlay each frame.
- Sound effects are played via a local audio backend (`ffplay` preferred, `aplay` fallback).

Optional tuning:

- `QUAKE_TUI_MOUSE_CELL_SCALE` (default `20`) controls look sensitivity per terminal cell.
- `QUAKE_TUI_MOUSE_LOOK=0` disables terminal mouse look while keeping clicks/wheel.
- `QUAKE_TUI_RAW_MOUSE=1` enables raw relative mouse input from a Linux input device.
- `QUAKE_TUI_RAW_MOUSE_DEVICE` sets the raw mouse device path (default `/dev/input/mice`).
- `QUAKE_TUI_RAW_MOUSE_SCALE` scales raw device deltas (default `1.4`).
- `QUAKE_TUI_TAP_RELEASE_MS` (default `28`) release delay for non-hold keys when key-release events are unavailable.
- `QUAKE_TUI_HOLD_INITIAL_MS` (default `240`) initial hold timeout for `+` bindings (e.g. movement) when key-release events are unavailable.
- `QUAKE_TUI_HOLD_REPEAT_MS` (default `70`) repeat hold timeout after repeat keypresses for `+` bindings.

Raw mouse permissions:

- Access to `/dev/input/mice` usually requires membership in the `input` group (or a matching udev rule).
- If raw-device access fails, terminal mouse input still works and the fallback is logged to `/tmp/quake-tui.log`.

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
