---
name: voice-agent
description: Voice-to-agent flow: start recording, see live transcript, speak the wake word "spell" followed by a command, and the agent processes it automatically.
version: 1.0.0
---

# Voice Agent

Live voice transcription with wake-word detection. Say **"spell"** followed by your command — the agent processes it as if you typed it.

## Prerequisites

1. **sox** installed: `which sox` (Linux: `sudo pacman -S sox` or `sudo apt install sox`)
2. **DEEPGRAM_API_KEY** set in your environment or `.env` file
3. Display available (X11 or Wayland)

## Activation

When the user asks to start voice mode, use voice recording, or activate the voice agent:

### 1. Check prerequisites

```typescript
import { isDisplayAvailable } from "@oh-my-pi/pi-qml";
import { $ } from "bun";

const hasSox = !!(await $`which sox`.nothrow().quiet().text()).trim();
if (!hasSox) {
  // Tell the user to install sox and stop
}

if (!process.env.DEEPGRAM_API_KEY) {
  // Tell the user to set DEEPGRAM_API_KEY and stop
}

if (!isDisplayAvailable()) {
  // Tell the user display is unavailable and stop
}
```

### 2. Launch the QML window

```
canvas launch path=".spell/skills/voice-agent/voice-ui.qml" title="Voice Agent" width=520 height=360
```

Note the window id from the response.

### 3. Start the voice pipeline (async)

```bash
bun run .spell/skills/voice-agent/voice-pipeline.ts
```

Run this as an **async bash job** — it runs indefinitely. Store the job id so you can kill it later.

### 4. Handle canvas events

The QML window emits two events via `bridge.send()`:

#### `voice_command`

```json
{ "type": "voice_command", "text": "create a file called foo.ts" }
```

Process `text` as if the user typed it — relay it as the next user message for the agent to act on. The user spoke "spell create a file called foo.ts" and wants it executed.

#### `voice_stop`

```json
{ "type": "voice_stop" }
```

User clicked Stop. Clean up:
1. Kill the async pipeline job (cancel the bash job id)
2. Close the QML window with `canvas close id=<window-id>`
3. Confirm to the user that voice mode has stopped

## How it works

- `voice-pipeline.ts` captures mic audio via ffmpeg (raw PCM 16kHz/16-bit/mono via PulseAudio)
- Audio streams to Deepgram's WebSocket API for live transcription
- Deepgram returns interim (speculative) + final (confirmed) transcript segments
- Wake word detection runs only on **final** segments to avoid false positives from interim revisions
- When "spell" is detected, subsequent speech is accumulated until Deepgram signals `UtteranceEnd` (~1.5s silence)
- The accumulated text is written to `/tmp/spell-voice-state.json` with `status: "command_detected"`
- The QML window polls that file every 400ms via armed `read` tool
- On new `commandId`, the QML fires a `bridge.send` canvas event that triggers an agent turn

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No audio captured | Wrong audio device | Set `AUDIO_DEVICE` env var; check `pactl list sources short` |
| Deepgram auth error | Bad API key | Verify `DEEPGRAM_API_KEY` |
| Pipeline exits immediately | ffmpeg missing or ALSA error | `sudo pacman -S ffmpeg` |
| QML shows "Pipeline disconnected" | Pipeline process died | Check job output: `read jobs://<id>` for ffmpeg/Deepgram errors |
| QML shows error in red | Deepgram disconnect or audio fail | Pipeline auto-reconnects; if persistent, check API key and mic |
| QML shows nothing | State file not created yet | Pipeline needs a second to connect |
| Commands not firing | Wake word not recognized | Speak clearly; "spell" must be a full word |

### Diagnosing async job failures

The pipeline runs as an async bash job. If the transcript stays empty:

```
read jobs://          # list all jobs
read jobs://<id>      # show stdout/stderr for the pipeline job
```

ffmpeg stderr is piped and printed to the job's stderr output, so device errors,
permission issues, and format errors are visible there.
