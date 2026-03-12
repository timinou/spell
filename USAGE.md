# spell — additions over upstream

This is a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). The following features are specific to this fork:

- **Emacs code intelligence** (`packages/emacs/`) — tree-sitter outline, definitions, and references via a long-lived Emacs daemon. Supports TypeScript, Rust, Python, Go, Elm, and more.
- **Niri window manager integration** (`packages/niri/`) — status overlay and input-needed indicator for the niri compositor.
- **Org-mode task tracking** (`packages/org/`) — persistent task management with plan-mode integration; the agent creates and updates org items during multi-step work.
- **QML Android remote bridge** (`packages/qml-remote/`, `apps/spell/`) — render the agent's QML panels on an Android device over WebSocket instead of a local Qt desktop process. First-time setup is automatic: plug in your phone and the agent handles APK install, port-forwarding, and connection.

---

## QML Android remote bridge

The standard QML tool (`qml` action) spawns a local Qt process and renders windows on the dev machine. The remote bridge replaces that subprocess with a WebSocket connection to an Android app (Spell), so panels appear on a phone or tablet.

### How it works

```
Dev machine                          Android device
─────────────────────                ─────────────────────────────
coding-agent
  └─ QmlTool
       └─ QmlRemoteServer  ←──WS──→  Spell (Qt app)
            └─ RemoteQmlBridge            ├─ RemoteClient (QWebSocket)
                                          ├─ PanelManager (QML engine per panel)
                                          └─ Bridge QObject (same as desktop)
```

One WebSocket connection carries three channels:

| Channel | Direction | Purpose |
|---|---|---|
| `panel` | both | push QML source, messages, close; receive events |
| `rpc_event` | server → client | streaming agent responses (chat UI) |
| `rpc` | client → server | commands from the Android chat input |

### First-time setup (automatic)

Plug your Android phone in via USB and trigger any `qml launch` call. The agent detects the device, installs Spell, sets up port-forwarding, and launches the app automatically — no manual steps.

Press Escape during the setup modal to cancel and fall back to local rendering.

### Manual setup (non-interactive / RPC mode)

**Android device:**
- Android 7.0+ (API 24)
- USB cable

**Dev machine:**
- Bun >= 1.1
- `adb` in PATH

The agent downloads `spell.apk` from GitHub Releases and caches it in `~/.spell/tools/spell.apk` on first use.
To build from source instead:

```bash
export ANDROID_SDK_ROOT=~/Android/Sdk
export ANDROID_NDK_ROOT=~/Android/Sdk/ndk/25.x.x
export QT_DIR=~/Qt/6.5.x/android_arm64_v8a

cmake -S apps/spell \
      -B build/spell-android \
      -DCMAKE_TOOLCHAIN_FILE=$ANDROID_NDK_ROOT/build/cmake/android.toolchain.cmake \
      -DANDROID_ABI=arm64-v8a \
      -DANDROID_PLATFORM=android-24 \
      -DCMAKE_PREFIX_PATH=$QT_DIR \
      -DCMAKE_BUILD_TYPE=Release

cmake --build build/spell-android --target apk
```

Copy the built APK to `~/.spell/tools/spell.apk` so the agent uses it instead of downloading.

For RPC mode (headless), set up port-forwarding manually:

```bash
./scripts/spell-adb.sh        # default port 9473
```

```typescript
import { QmlRemoteServer } from "@oh-my-pi/pi-qml-remote";

const remoteServer = new QmlRemoteServer({
    port: 9473,
    // Forward RPC commands from the Android chat UI to the agent session:
    onRpcCommand: (cmd) => rpcMode.dispatch(cmd),
});

remoteServer.start(); // begins listening on ws://0.0.0.0:9473/ws

// Attach to the session so QmlTool routes panels to Android:
session.qmlRemoteServer = remoteServer;

// Forward agent RPC events (streaming responses) to the Android chat UI:
rpcMode.on("event", (event) => remoteServer.sendRpcEvent(event));
```

When `session.qmlRemoteServer` is set, every `qml launch` call reads the local QML file the agent wrote and pushes its source to the Android device instead of spawning a local window.

### Step 3 — Connect the device

**USB (recommended):**

```bash
./scripts/spell-adb.sh        # default port 9473
# or
./scripts/spell-adb.sh 9473
```

This runs `adb reverse tcp:9473 tcp:9473` so the app can reach `ws://localhost:9473/ws` on the device, tunnelled over USB.

Launch Spell. It connects automatically. The green dot in the top-right corner turns solid when the WebSocket handshake succeeds.

**WiFi (no USB):**

Find your machine's LAN IP (`ip addr` or `ifconfig`), then either:

- Start the app and type the URL in the server field, or
- Pass it as a launch argument via adb:

```bash
adb shell am start -a android.intent.action.MAIN \
    -n io.ohmypi.spell/.MainActivity \
    --es url ws://192.168.1.x:9473/ws
```

Make sure port 9473 is reachable (firewall, etc.).
### Reconnection

The app reconnects automatically with exponential backoff (2 s → 4 s → … → 30 s) if the connection drops. Stop the agent or call `remoteServer.stop()` to shut down the server; the app will keep retrying until you close it or call `disconnect()`.

### Dynamic panels

When the agent uses the `qml` tool, it typically:

1. Calls `qml write` to write a `.qml` file locally.
2. Calls `qml launch` with the file path.

In remote mode step 2 reads the file content and pushes it to the device. The app writes it to local app storage and loads it into a dedicated QML engine with the `bridge` context object injected — identical to the desktop bridge. QML can call `bridge.send({...})` and the events flow back to the agent via `qml listen`.

Multiple panels can be open at once. The left drawer in the app lists active panels; tap one to bring it to focus.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Red dot / "Disconnected" | Server not started or wrong port | Check server is running; verify `adb reverse` output |
| Panel loads blank | QML syntax error | Check adb logcat for Qt error output |
| Panel never appears | `session.qmlRemoteServer` not set | Confirm the server is assigned to the session before the agent runs |
| `push_qml` but no engine | App killed panel cache | Restart app; cache is re-created on next `push_qml` |

```bash
# Watch Qt/app logs in real time:
adb logcat -s Qt
```
