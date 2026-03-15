/**
 * Voice pipeline: captures microphone audio via sox, streams to Deepgram for
 * live transcription, detects the wake word "spell", accumulates the following
 * utterance, and writes state to /tmp/spell-voice-state.json for QML polling.
 *
 * State file shape:
 *   { status, transcript, partial, command, commandId, lastUpdate, error }
 *
 * Usage: bun run voice-pipeline.ts
 * Env:   DEEPGRAM_API_KEY (required)
 */

import * as fs from "node:fs/promises";

const STATE_FILE = "/tmp/spell-voice-state.json";
const TEMP_STATE_FILE = "/tmp/spell-voice-state.json.tmp";

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
if (!DEEPGRAM_API_KEY) {
  console.error("DEEPGRAM_API_KEY is not set");
  process.exit(1);
}

// ── State ────────────────────────────────────────────────────────────────────

type Status = "listening" | "accumulating" | "command_detected";

interface VoiceState {
  status: Status;
  transcript: string;
  partial: string;
  command: string | null;
  commandId: number;
  lastUpdate: number;
  error: string | null;
}

let state: VoiceState = {
  status: "listening",
  transcript: "",
  partial: "",
  command: null,
  commandId: 0,
  lastUpdate: Date.now(),
  error: null,
};

// Accumulated words after wake word until utterance_end
let accumBuffer = "";

// Serialize writes: concurrent void writeState() calls share one .tmp path,
// so a second rename would fail ENOENT after the first already moved the file.
let writeChain: Promise<void> = Promise.resolve();

function writeState(): void {
  state.lastUpdate = Date.now();
  const snap = JSON.stringify(state);
  writeChain = writeChain.then(async () => {
    await Bun.write(TEMP_STATE_FILE, snap);
    await fs.rename(TEMP_STATE_FILE, STATE_FILE);
  }).catch((err: unknown) => {
    console.error("writeState error", err);
  });
}

// ── ffmpeg capture process ───────────────────────────────────────────────────

// Raw PCM: 16kHz, signed 16-bit, mono via PulseAudio
const audioDevice = process.env.AUDIO_DEVICE ?? "default";
const capture = Bun.spawn(
  ["ffmpeg", "-f", "pulse", "-i", audioDevice,
   "-ar", "16000", "-ac", "1", "-f", "s16le",
   "-loglevel", "quiet", "-"],
  {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  },
);

capture.exited.then((code) => {
  console.error(`ffmpeg exited with code ${code}`);
  if (!shuttingDown) {
    state.error = `Audio capture failed (ffmpeg exited ${code})`;
    writeState();
    writeChain.then(() => process.exit(1));
  }
});

// Drain ffmpeg stderr so diagnostics appear in job output
(async () => {
  if (!capture.stderr) return;
  for await (const chunk of capture.stderr as ReadableStream<Uint8Array>) {
    console.error("[ffmpeg]", new TextDecoder().decode(chunk).trimEnd());
  }
})();

// ── Deepgram WebSocket ───────────────────────────────────────────────────────

const DG_URL =
  "wss://api.deepgram.com/v1/listen?" +
  "encoding=linear16&sample_rate=16000&channels=1" +
  "&interim_results=true&utterance_end_ms=1500&vad_events=true";

let ws: WebSocket | null = null;
let shuttingDown = false;

function connectDeepgram(): void {
  ws = new WebSocket(DG_URL, {
    // @ts-ignore — Bun WebSocket headers extension
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    console.error("Deepgram connected");
    state.error = null;
    void writeState();
    startAudioForward();
  });

  ws.addEventListener("message", (event) => {
    let msg: DeepgramEvent;
    try {
      msg = JSON.parse(event.data as string) as DeepgramEvent;
    } catch {
      return;
    }
    handleDeepgramEvent(msg);
  });

  ws.addEventListener("close", (event) => {
    console.error(`Deepgram closed: ${event.code} ${event.reason}`);
    if (!shuttingDown) {
      state.error = `Deepgram disconnected (${event.code}), reconnecting...`;
      void writeState();
      // Reconnect after 1s
      setTimeout(connectDeepgram, 1000);
    }
  });

  ws.addEventListener("error", (event) => {
    console.error("Deepgram error", event);
    state.error = "Deepgram connection error";
    void writeState();
  });
}

// ── Audio forwarding ─────────────────────────────────────────────────────────

let audioForwardRunning = false;

async function startAudioForward(): Promise<void> {
  if (audioForwardRunning) return;
  audioForwardRunning = true;
  try {
    for await (const chunk of capture.stdout as ReadableStream<Uint8Array>) {
      if (shuttingDown) break;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      }
    }
  } catch (err) {
    if (!shuttingDown) console.error("Audio forward error", err);
  } finally {
    audioForwardRunning = false;
  }
}

// ── Deepgram event handling ──────────────────────────────────────────────────

interface DeepgramTranscriptWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  punctuated_word?: string;
}

interface DeepgramTranscriptAlternative {
  transcript: string;
  confidence: number;
  words: DeepgramTranscriptWord[];
}

interface DeepgramTranscriptEvent {
  type: "Results";
  is_final: boolean;
  speech_final: boolean;
  channel: {
    alternatives: DeepgramTranscriptAlternative[];
  };
}

interface DeepgramUtteranceEndEvent {
  type: "UtteranceEnd";
}

interface DeepgramSpeechStartedEvent {
  type: "SpeechStarted";
}

interface DeepgramMetadataEvent {
  type: "Metadata";
}

type DeepgramEvent =
  | DeepgramTranscriptEvent
  | DeepgramUtteranceEndEvent
  | DeepgramSpeechStartedEvent
  | DeepgramMetadataEvent
  | { type: string };

function containsWakeWord(text: string): boolean {
  // Match "spell" as a standalone word (case-insensitive) at word boundary
  return /\bspell\b/i.test(text);
}

function textAfterWakeWord(text: string): string {
  // Return everything after the first "spell" word
  const match = text.match(/\bspell\b\s*(.*)/i);
  return match ? match[1].trim() : "";
}

function handleDeepgramEvent(event: DeepgramEvent): void {
  if (event.type === "Results") {
    const e = event as DeepgramTranscriptEvent;
    const alt = e.channel.alternatives[0];
    if (!alt) return;
    const text = alt.transcript.trim();

    if (e.is_final) {
      if (state.status === "listening") {
        // Append to running transcript
        if (text) {
          state.transcript = (state.transcript + " " + text).trim();
        }
        state.partial = "";

        // Check for wake word
        if (containsWakeWord(text)) {
          state.status = "accumulating";
          accumBuffer = textAfterWakeWord(text);
        }
      } else if (state.status === "accumulating") {
        // Accumulate into command buffer
        if (text) {
          accumBuffer = (accumBuffer + " " + text).trim();
        }
        state.partial = "";
      }
    } else {
      // Interim result — update partial display
      if (state.status === "accumulating") {
        state.partial = text;
      } else {
        state.partial = text;
      }
    }

    void writeState();
  } else if (event.type === "UtteranceEnd") {
    if (state.status === "accumulating" && accumBuffer.trim()) {
      // Flush accumulated command
      state.command = accumBuffer.trim();
      state.commandId += 1;
      state.status = "command_detected";
      state.partial = "";
      writeState();
    } else if (state.status === "listening") {
      state.partial = "";
      void writeState();
    }
  } else if (event.type === "SpeechStarted") {
    // If we just delivered a command, reset to listening on new speech
    if (state.status === "command_detected") {
      state.status = "listening";
      state.command = null;
      accumBuffer = "";
      void writeState();
    }
  }
}

// ── Shutdown ─────────────────────────────────────────────────────────────────

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error("Shutting down");
  try {
    ws?.close();
    capture.kill();
  } catch {}
  // Remove state file
  void fs.unlink(STATE_FILE).catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────

writeState();
await writeChain;
connectDeepgram();
