# Antigravity Nika Companion
[![License](https://img.shields.io/badge/License-MIT-lightgrey)](LICENSE)
[![Antigravity](https://img.shields.io/badge/Google-Antigravity%20plugin-4285F4)](#installation)
![Python](https://img.shields.io/badge/Python-3.9%2B-blue?)
![Three.js](https://img.shields.io/badge/Three.js-supported-black)
![VRM](https://img.shields.io/badge/VRM-supported-purple)

![Preview](preview.png)

A VRM avatar companion that lives in the Antigravity side panel. Nika reacts to agent activity by playing animations and changing states.

The relay monitors Antigravity conversation transcripts and broadcasts events over a local WebSocket connection. The Three.js viewer receives those events and plays the corresponding VRM animations.

## Features

- **VRM avatar viewer** powered by Three.js and `three-vrm`.
- **Agent activity tracking** through Antigravity transcript files.
- **Animation state system** that reacts to user input, tool calls, thinking, completion, and errors.
- **Procedural idle animation** with breathing, movement, and blinking.
- **VRMA animation support** with looping, crossfading, and one-shot playback.
- **Side panel integration** through an Antigravity UI sidecar.
- **Theme synchronization** with Antigravity's current theme.
- **Manual event injection** through an HTTP endpoint.

## Architecture

```
antigravity-nika-companion/
├── relay/
│   └── relay.py                 # Transcript watcher, WebSocket server and HTTP endpoints
│
├── sidecars/
│   └── nika-vrm/
│       ├── sidecar.json         # Antigravity sidecar configuration
│       └── main.mjs             # Starts relay and opens the viewer
│
├── vrm-viewer/
│   ├── index.html               # Viewer entry point and import map
│   ├── main.js                  # Three.js scene, VRM and animation system
│   └── config.json              # Model, animation and state configuration
│
├── assets/
│   ├── models/
│   │   └── <name>/
│   │       ├── model.vrm
│   │       ├── metadata.json    # Optional model metadata
│   │       └── README.md        # Optional model-specific information
│   ├── animations/              # VRMA animations
│   └── logo/
│
├── MODEL_LICENSE.md             # Model licensing information
└── requirements.txt
```

### Event flow

```
Antigravity
    │
    ▼
Transcript files
    │
    ▼
relay/relay.py
    │
    ├── Watches transcript.jsonl files
    ├── Detects agent activity
    └── Broadcasts events over WebSocket
            │
            ▼
       vrm-viewer
            │
            ▼
       Animation state
            │
            ▼
       VRM avatar
```

## How activity tracking works

Antigravity hooks were tested but did not fire reliably in the application. Instead, the relay watches Antigravity's generated transcript files.

The relay monitors:

```
~/.gemini/<antigravity|antigravity-ide|antigravity-cli>/brain/<conversation>/.system_generated/logs/transcript.jsonl
```

Each line contains a JSON record. The relay detects relevant records, converts them into events, and broadcasts them to the viewer.

### Event mapping

| Transcript activity                   | Viewer event                  | Result                                |
| ------------------------------------- | ----------------------------- | ------------------------------------- |
| `USER_INPUT`                          | `thinking`                    | Thinking animation                    |
| `PLANNER_RESPONSE` with tool calls    | `tool_start`                  | Configured tool-start animation       |
| `GENERIC` from `MODEL`                | `tool_end`, then `thinking`   | Tool completion, followed by thinking |
| `PLANNER_RESPONSE` without tool calls | `done`                        | Completion animation, then idle       |
| Failed `run_command`                  | `tool_end` with `error: true` | Error animation                       |

A non-zero exit code is detected for `run_command` results. Other failing tools are only treated as errors when their transcript record has an `ERROR` or `FAILED` status.

Additional behavior:

- Records are deduplicated using their path, step index, and type.
- Incomplete lines are buffered until a newline is received.
- Existing conversations are skipped when the relay starts. New conversations are read from the beginning.
- If a transcript stops growing during an active turn, the relay uses `IDLE_S` (12 seconds by default) as a completion safety net.

## Installation

### Requirements

- Google Antigravity Desktop 2.x
- Python 3.x
- `aiohttp`
- A modern browser environment supporting ES modules and WebSockets

The viewer loads its libraries from jsDelivr using pinned versions:

- Three.js `0.169.0`
- `three-vrm` `3.4.1`
- `three-vrm-animation` `3.4.1`

### Setup

1. Place the repository in Antigravity's plugin directory:
   ```
   ~/.gemini/config/plugins/antigravity-nika-companion/
   ```
2. Install the Python dependency:
   ```
   python -m pip install -r requirements.txt
   ```
3. Enable the sidecar in:
   ```
   ~/.gemini/config/config.json
   ```
   Add:
   ```
   {
     "sidecars": {
       "nika-vrm/nika-vrm": {
         "enabled": true
       }
     }
   }
   ```
4. Restart Antigravity.
5. Open **Nika** from the side panel menu or from **Overview → Plugins → Nika**.

The sidecar starts the relay automatically if nothing is listening on port `8765`. It checks every five seconds and does not start another relay instance if the port already responds.

## Manual launch

The relay can also be started manually:

```
python relay/relay.py
```

Then open:

```
http://127.0.0.1:8765/vrm-viewer/
```

The relay must be started from the repository root. The viewer uses absolute paths such as `/vrm-viewer/main.js`, so opening `index.html` directly through `file://` will not work.

The relay binds to `127.0.0.1:8765` only.

## Configuration

The viewer's configuration is stored in:

```
vrm-viewer/config.json
```

It controls:

- VRM model path
- Animation file paths
- Animation states
- Custom expressions
- Loop ranges and playback settings
- WebSocket URL overrides

Paths are resolved relative to the viewer, so keep them consistent with the existing configuration.

## Animations

Animations use the VRMA format.

Place active animation files in:

```
assets/animations/
```

### Animation states

The viewer maps relay events to configured animation states.

Looping states support configurable frame ranges:

```
{
  "start_frame": 0,
  "end_frame": 40,
  "fps": 60,
  "pingpong": false
}
```

Other animation behavior:

- Crossfades use `crossFadeFrom(..., false)`. Enabling time warping can interfere with ping-pong playback.
- `playVRMA()` resets the clip's time scale to `1`, since resetting an animation does not necessarily reset its time scale.
- If a looping clip is already playing, requesting the same state does not restart it.
- One-shot clips transition into procedural idle after playback.
- Animation clips are cached by file path.

## Model assets

VRM models belong in:

```
assets/models/<name>/
```

Expected structure:

```
assets/models/<name>/
├── model.vrm
├── metadata.json
└── README.md
```

`metadata.json` and `README.md` are optional.

Model licensing information is documented separately in the root `MODEL_LICENSE.md` file. Check individual model documentation for any additional terms.

## Manual events

The relay exposes an HTTP endpoint for injecting events manually:

```
POST http://127.0.0.1:8765/agent_event
Content-Type: application/json
```

Example:

```
{
  "event": "thinking"
}
```

The event must be listed in the relay's `VALID` event set.

This is useful for testing animations without having to trigger actual Antigravity activity.

## Theme synchronization

The sidecar sends Antigravity's current theme colors to the viewer, keeping Nika's environment visually consistent with the application.

## Development

The relay's only Python dependency is `aiohttp`.

The viewer uses native JavaScript modules and an import map. Keep the pinned library versions in `index.html` synchronized when changing dependencies.

### Code organization

- Keep viewer-related changes inside `vrm-viewer/`.
- Keep `sidecar.json` and `main.mjs` inside `sidecars/nika-vrm/`.
- `main.mjs` resolves the relay using `../../relay/relay.py`.
- `main.mjs` uses the Antigravity sidecar SDK and single quotes. The viewer uses double quotes. Match the style of the file being edited.

### Adding a new event

A new event generally requires changes in three places:

1. Add it to `VALID` in `relay/relay.py`.
2. Add the corresponding transcript handling in `events_from_record()` if it comes from transcript activity.
3. Add the matching state to `vrm-viewer/config.json`.

The viewer uses `window.setState(name)` as its state entry point. There are no keyboard shortcuts for changing states.

### Procedural idle

Idle movement is handled by `IDLE_POSE` and `idleTarget()`. The system includes procedural breathing, subtle body movement, and blinking.

## Troubleshooting

### The viewer is blank

- Make sure the relay is running.
- Open the viewer through `http://127.0.0.1:8765/vrm-viewer/`.
- Do not open `index.html` directly through `file://`.
- Check that the configured VRM model path exists.
- Check the browser console for loading errors.

### The side panel does not open

Check the sidecar logs:

```
~/.gemini/antigravity/sidecar_data/nika-vrm/nika-vrm/logs/
```

Verify that the sidecar is enabled in Antigravity's configuration and restart the application.

### Animations do not play

- Verify that the VRMA files are inside `assets/animations/`.
- Check that their paths match `vrm-viewer/config.json`.
- Make sure the animation is mapped to a valid state.

### The viewer does not receive events

- Verify that the relay is running on `127.0.0.1:8765`.
- Check the browser console for WebSocket errors.
- Confirm that the event exists in the relay's `VALID` set.
- Check that the viewer has a matching state configuration.

The relay rejects browser requests with an `Origin` other than:

```
http://127.0.0.1:8765
http://localhost:8765
```

Requests without an `Origin` header are allowed.

## License

- **Source code:** MIT License.
- **Nika VRM model and related assets:** All rights reserved.

See MODEL_LICENSE.md.

The MIT License does not grant permission to redistribute, modify for redistribution, or commercially use the Nika model.