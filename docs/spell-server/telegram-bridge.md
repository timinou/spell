# Telegram Bridge

The Telegram bridge turns a standard Telegram bot into an interactive agent interface. Each chat gets its own RPC session backed by a Spell agent process. Users send messages; the agent responds with streamed text, files, or voice.

## Overview

spell-server connects to Telegram using a bot token and routes each authorized chat to a dedicated RPC subprocess. Sessions persist across restarts and are killed after an idle timeout. Owners configure which users can interact, what projects they can access, and which tool modes are available.

Configuration lives in `channels.kdl` alongside `server.kdl`. See [KDL Schema Reference](kdl-schema-reference.md) for the full config reference.

---

## Bot Commands

Commands registered with the Telegram bot:

| Command | Description | Notes |
|---------|-------------|-------|
| `/start` | Start or authorize | Owners see "Authorized"; invited users see "Temporary access granted" |
| `/help` | Show available commands | Lists all commands from this table |
| `/unlock` | Switch to full tool access | Owner only. Shows inline confirm/cancel keyboard before switching |
| `/lock` | Switch back to read-only mode | Available to all authorized users |
| `/project` | Switch project | Presents inline keyboard of allowed projects; respawns session |
| `/mode` | Switch tool mode | Presents inline keyboard of allowed modes; respawns session |
| `/think` | Toggle thinking visibility | Shows or hides extended-thinking blocks in responses |
| `/clear` | Start new session | Sends `new_session` to the running RPC process; clears voice override |
| `/status` | Show session status | Reports project, mode, uptime, thinking visibility, voice mode |
| `/sessions` | List active sessions | Shows all sessions across all chats (owner view) |
| `/btw` | One-off question without session context | Spawns a separate ephemeral RPC process; does not affect the chat session |
| `/voice` | Toggle voice reply mode | Accepts `on`, `off`, `mirror`, or no argument to cycle. `/voice status` reports current mode and source |
| `/invite` | Generate a one-time invite link | Owner only. Works in private chats only. Sends a QR code image with the link |

> `/invite` is not included in the Telegram bot command list (not shown by `/help`) but is registered and functional.

---

## Tool Modes

The bridge passes a `--tools` flag to each spawned RPC process. Two built-in modes are defined:

### `telegram-readonly`

Read-only access. Default for all users unless overridden.

Tools: `read`, `grep`, `find`, `lsp`, `ast_grep`, `web_search`, `fetch`, `org`, `calc`, `code_search`, `send_file`

### `telegram-full`

Full access including file writes and code execution. Typically restricted to owners via `/unlock`.

Tools: `read`, `grep`, `find`, `lsp`, `ast_grep`, `web_search`, `fetch`, `org`, `calc`, `code_search`, `edit`, `write`, `bash`, `task`, `todo_write`, `emacs_code`, `notebook`, `generate_image`, `send_file`

`/unlock` respawns the session in `telegram-full` mode. `/lock` respawns it back to `telegram-readonly`.

Custom modes can be defined in `.spell/modes/` and listed in a user's `modes` block. If a requested mode has no entry in `MODE_TOOLS`, the bridge falls back to `telegram-readonly`.

---

## Session Management

### Lifecycle

Each chat ID maps to exactly one RPC session at a time. When a message arrives:

1. If a session exists and the RPC process is alive, it is reused.
2. If the session is dead or missing, a new one is spawned — unless `max-sessions` is reached.
3. On spawn, session state (project, mode, transcript path) is restored from the persisted bridge state if available.

### Idle Timeout

Sessions are killed after a period of inactivity. The default is 300 seconds (5 minutes).

- Channel-level default set with `idle-timeout`.
- Per-user override set inside a `user` block.
- Setting `idle-timeout #null` for a user disables the timeout (suitable for owners).

### Max Sessions

The maximum number of concurrent sessions is controlled by `max-sessions`. Default: 10. When the limit is reached, new sessions are rejected with an error message.

### /clear Behavior

`/clear` does **not** kill or respawn the RPC process. It sends a `new_session` signal to the running process, which resets the conversation context while keeping the same project, mode, and tool configuration. The per-session voice override is also cleared.

### State Persistence

Session state (project, mode, transcript path, thinking visibility, voice override) is persisted to disk. On restart, sessions are restored to their previous configuration when a new message arrives. The RPC process itself is not kept alive across restarts.

---

## Voice Setup

Voice requires STT (speech-to-text) and optionally TTS (text-to-speech) providers configured in `channels.kdl`.

### Providers

| Direction | Provider | Notes |
|-----------|----------|-------|
| STT | `deepgram` | Requires Deepgram API key |
| STT | `openai` | Uses OpenAI Whisper API |
| TTS | `elevenlabs` | Requires ElevenLabs API key; supports voice selection |
| TTS | `deepgram` | Requires Deepgram API key |

### Reply Modes

| Mode | Behavior |
|------|----------|
| `mirror` | Reply with voice only when the incoming message was a voice message (default) |
| `always` | Always reply with voice |
| `never` | Always reply with text |

The per-session override set by `/voice` takes precedence over the user config, which takes precedence over the channel-level config.

### KDL Configuration Example

```kdl
telegram {
    // ... other fields ...

    voice {
        stt-provider "deepgram"
        stt-api-key "env(DEEPGRAM_API_KEY)"
        stt-model "nova-2"
        stt-language "en"

        tts-provider "elevenlabs"
        tts-api-key "env(ELEVENLABS_API_KEY)"
        tts-voice "Rachel"

        reply-mode "mirror"
    }

    user 123456789 {
        voice {
            reply-mode "always"
            tts-voice "Bella"
        }
    }
}
```

`stt-provider` and `stt-api-key` must be set together. Same for `tts-provider` and `tts-api-key`. They are independently optional — you can configure STT without TTS and vice versa.

`stt-language` accepts BCP-47 language codes. Default: `"en"`.

Per-user `voice` blocks override only the fields they specify (`reply-mode`, `tts-voice`). Provider and API key always come from the channel-level config.

---

## File and Image Delivery

### Outbound: `send_file` Tool

When an agent calls `send_file`, the result is delivered to the chat as a Telegram document attachment. The file is sent immediately when the tool execution ends.

### Outbound: `generate_image` Auto-Send

When an agent calls `generate_image`, the generated image is automatically sent to the chat as a photo attachment — unless `auto-send-images` is set to `false`.

```kdl
telegram {
    auto-send-images #false
}
```

Default: `true`.

### Inbound: Accepted Media Types

See [Inbound Media Handling](#inbound-media-handling) for details on what the bridge accepts and how it converts media to agent prompts.

---

## Session Notifications

The bridge can forward blocking session events from the desktop/socket layer to Telegram chats. This is useful when an agent running in a connected CLI session needs approval or input from the operator via Telegram.

Supported event kinds:

| Event Kind | Description |
|------------|-------------|
| `plan_approval` | Agent is awaiting plan approval |
| `ask` | Agent is asking a question with options |
| `hook_selector` | Hook requires a selection |
| `pending_action` | An action is awaiting operator approval |
| `hook_input` | Hook requires text input |

Notifications are sent as Telegram messages with inline keyboards for responding. A "Dismiss" button is always included.

### KDL Configuration Example

```kdl
telegram {
    // ... other fields ...

    session-notifications {
        events "plan_approval" "ask" "pending_action"
        notify-owners #true
        notify-chat-id 987654321
    }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `events` | string list | — | Event kinds to forward (see table above) |
| `notify-owners` | boolean | `true` | Send notifications to all owner chat IDs |
| `notify-chat-id` | number | — | Additional chat ID to notify (may appear multiple times) |

If `notify-owners` is `false` and no `notify-chat-id` entries are configured, the `session-notifications` block has no effect.

---

## Log Viewer

An optional HTTP server provides browser-accessible session transcripts for active chats.

Enable it with `log-viewer-port`:

```kdl
telegram {
    log-viewer-port 9090
}
```

When enabled:

| Route | Response |
|-------|----------|
| `GET /` | HTML list of active sessions |
| `GET /session/:chatId` | HTML-rendered transcript for that chat |
| `GET /session/:chatId/raw` | Raw JSONL transcript |

### Authentication

Requests from loopback addresses (`127.0.0.1`, `::1`, `localhost`) are allowed without credentials. Remote requests require a `Bearer` token matching the bot token:

```
Authorization: Bearer <bot-token>
```

---

## Inbound Media Handling

All inbound message types are accepted. The bridge converts them to text and/or image content before forwarding to the RPC process.

### Text

Plain text is forwarded as-is. Caption text on photo or document messages is included.

### Photos

The largest available size is selected and downloaded. Accepted image types: JPEG, PNG, GIF, WebP. Image type is detected from file bytes (magic bytes), with the MIME header as fallback.

### Documents

Text documents are inlined into the prompt. A file is treated as text if:

- Its MIME type is a text type (`text/*`, `application/json`, `application/xml`, `application/yaml`)
- Or its extension matches a known set: `.txt`, `.md`, `.json`, `.yaml`, `.yml`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.rs`, `.go`, `.java`, `.c`, `.cc`, `.cpp`, `.h`, `.hpp`, `.css`, `.html`, `.xml`, `.toml`, `.ini`, `.log`

Size limit: 512 KB. Files exceeding this limit produce a summary message instead of inline content. Files that fail UTF-8 decoding produce a summary message.

Documents with audio MIME types (`audio/*`) are routed to STT instead of text extraction.

### Voice Messages

Requires STT configuration. The audio is downloaded and transcribed. The transcript is included in the prompt.

If STT is not configured, the bot replies with an error message explaining the missing configuration.

### Video Notes (Round Videos)

Requires ffmpeg installed on the server. Audio is extracted from the video and transcribed via STT. If ffmpeg is not available, the bot replies with an error.

### Audio Messages

Downloaded and transcribed via STT. MIME type is preserved for the transcription API.

---

## Multi-Project Setup

A complete `channels.kdl` example with multiple projects and per-user access control:

```kdl
telegram {
    bot-token "env(TELEGRAM_BOT_TOKEN)"
    owners 111111111 222222222

    default-model "claude-opus-4-5"
    default-project "main"

    idle-timeout 300
    max-sessions 20

    upload-dir "/var/spell/uploads"
    log-viewer-port 9090

    auto-send-images #true

    project "main" "/home/user/code/my-app"
    project "infra" "/home/user/code/infra"
    project "docs" "/home/user/code/docs"

    voice {
        stt-provider "deepgram"
        stt-api-key "env(DEEPGRAM_API_KEY)"
        stt-language "en"
        tts-provider "elevenlabs"
        tts-api-key "env(ELEVENLABS_API_KEY)"
        reply-mode "mirror"
    }

    session-notifications {
        events "plan_approval" "ask"
        notify-owners #true
    }

    // Owner with full access, no idle timeout
    user 111111111 {
        modes "telegram-readonly" "telegram-full"
        default-mode "telegram-readonly"
        idle-timeout #null
    }

    // Contractor limited to one project and read-only
    user 333333333 {
        modes "telegram-readonly"
        default-mode "telegram-readonly"
        idle-timeout 600
        projects "docs"
        voice {
            reply-mode "never"
        }
    }
}
```

### Key Points

- `project` entries map a name to an absolute path. Relative paths are resolved against the `channels.kdl` directory.
- `default-project` must match a declared `project` name. If omitted, the first declared project is used.
- A user's `projects` list restricts which projects they can switch to with `/project`. An empty or absent list grants access to all projects.
- A user's `modes` list controls which modes appear in the `/mode` inline keyboard.
- `bot-token` and `bot-token-file` are mutually exclusive. Use `bot-token-file` to load the token from a file at runtime.
- `default-model` is required.
- `owners` receive session notifications and can use `/unlock` and `/invite`.
