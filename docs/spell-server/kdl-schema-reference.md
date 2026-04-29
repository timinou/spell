# Spell Server KDL Schema Reference

This reference documents the three KDL files Spell Server loads from `.spell/`:

- `server.kdl` for daemon/runtime HTTP settings
- `channels.kdl` for transport integrations such as Telegram
- `autonomy.kdl` for workflow manifest structure

The manifest layer now supports multi-file imports, explicit overrides, `env(...)` resolution, typed `action` blocks, and named state stores.

## `server.kdl`

`server.kdl` remains deployment-scoped runtime config.

```kdl
http port=8787 webhook-secret="replace-with-a-long-random-secret" { // pragma: allowlist secret
  auth username="admin" password="change-me-now" // pragma: allowlist secret
  goal-token "incoming" "trigger-token" // pragma: allowlist secret
}
```

### `http` node

Properties and children:

- `port <number>` required
- `webhook-secret "<string>"` optional
- `goal-token "<goal>" "<token>"` optional, repeatable
- `auth { username "<string>"; password "<string>" }` required

### `socket` node

Enable the local JSON-lines session bridge socket by adding a top-level sibling node to `http`. Omit the node entirely to disable the socket server.

```kdl
socket path="~/.spell/server.sock"
socket path="env(SPELL_SOCKET_PATH)"
```

| Property | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `path` | string | No | `~/.spell/server.sock` | Supports `env(...)` resolution. |

Notes:

- The socket node is a document-root sibling of `http`, not a child of it.
- The bridge protocol is newline-delimited JSON; the configured socket path is where the daemon listens for local clients.

#### `event_log` bridge messages (opt-in)

External CLI sessions may push low-fi summary lines to the daemon for the web dashboard's autodiscovery feed. The emitter is gated by `SPELL_BRIDGE_EVENT_LOG=1` (or the constructor flag on `SessionBridgeClient`). Wire format:

```json
{
  "type": "event_log",
  "timestamp": 1714305000000,
  "entry": {
    "kind": "tool_call",
    "ts": 1714305000000,
    "toolName": "bash"
  }
}
```

Kinds: `turn_start | turn_end | tool_call | assistant_text | plan_decision | error`. `entry.text` is truncated to 256 chars on the client.

### `web` node

Declare the web subsystem with at least one named bearer token. Omit to disable `/web/*` entirely.

```kdl
web {
    token "alice" "env(SPELL_TOKEN_ALICE)"
    token "bob"   "env(SPELL_TOKEN_BOB, optional)"
}
```

| Child | Args | Notes |
| --- | --- | --- |
| `token "<name>" "<secret-or-env(...)>"` | name + secret | Repeatable. `env(...)` resolution is required for the secret. `env(VAR, optional)` whose variable is unset drops the slot at startup with a warning. Empty post-resolution secrets throw. |

Notes:
- Tokens authenticate `/web/*` requests via `Authorization: Bearer <secret>` (REST) or `?token=<secret>` (WebSocket upgrade).
- The token name becomes the `WebIdentity` (also propagated to spawned sessions as `ownedBy`).

## `channels.kdl`

`channels.kdl` remains transport-focused. It does not carry workflow definitions.

```kdl
telegram {
  bot-token-file "secrets/bot-token.txt"
  owners 123456789 987654321
  default-model "claude-sonnet-4-5"
  upload-dir "/tmp/spell-telegram-uploads"
  idle-timeout 300
  max-sessions 10
  log-viewer-port 4312
  project "spell" "../spell"
  default-project "spell"
  auto-send-images #true
  user 123456789 {
    modes "telegram-readonly" "coding"
    default-mode "coding"
    projects "spell"
    voice {
      reply-mode "always"
      tts-voice "Rachel"
    }
  }
}
```

Important rules:

- Omit the whole `telegram` node to disable Telegram.
- `default-model`, `owners`, and either `bot-token` or `bot-token-file` are required when `telegram` is present.
- `bot-token` supports `env(...)` resolution (e.g. `bot-token "env(TELEGRAM_BOT_TOKEN)"`). `bot-token` and `bot-token-file` are mutually exclusive.
- `auto-send-images` is an optional boolean (default `#true`). When `#true`, images generated during a session are automatically sent to the chat.
- Use `#null` (canonical KDL null) for nullable values such as `idle-timeout #null`. Bare `null` is also accepted by the parser but `#null` is canonical.

### `session-notifications`

Forward selected local session bridge events to Telegram chats.

```kdl
telegram {
  session-notifications {
    events "plan_approval" "ask" "pending_action"
    notify-owners #true
    notify-chat-id 123456789
    notify-chat-id 987654321
  }
}
```

| Child node | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `events` | string list | No | empty list | Known blocking kinds: `plan_approval`, `ask`, `pending_action`, `hook_selector`, `hook_input`. Unknown values are ignored with a warning for forward compatibility. |
| `notify-owners` | boolean | No | `#true` | When true, send notifications to configured Telegram owners. |
| `notify-chat-id` | number | No | none | Repeatable; each occurrence appends one additional target chat ID. |

Notes:

- Omit the block to disable Telegram notifications for local session events.
- `notify-chat-id` may appear multiple times and all values are collected.


### `voice`

Configure speech-to-text (STT) and text-to-speech (TTS) for voice interactions. All fields are flat children of the `voice` block.

```kdl
telegram {
  // ...other fields...
  voice {
    stt-provider "deepgram"
    stt-api-key "env(DEEPGRAM_API_KEY)"
    stt-model "nova-2"
    stt-language "en"
    tts-provider "elevenlabs"
    tts-api-key "env(ELEVENLABS_API_KEY)"
    tts-model "eleven_turbo_v2"
    tts-voice "Rachel"
    reply-mode "mirror"
  }
}
```

| Child node | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `stt-provider` | string | No | none | One of `deepgram`, `openai`. Required when `stt-api-key` is set. |
| `stt-api-key` | string | No | none | Supports `env(...)` resolution. Required when `stt-provider` is set. |
| `stt-model` | string | No | provider default | Model identifier passed to the STT provider. |
| `stt-language` | string | No | `en` | BCP-47 language code. |
| `tts-provider` | string | No | none | One of `elevenlabs`, `deepgram`. Required when `tts-api-key` is set. |
| `tts-api-key` | string | No | none | Supports `env(...)` resolution. Required when `tts-provider` is set. |
| `tts-model` | string | No | provider default | Model identifier passed to the TTS provider. |
| `tts-voice` | string | No | provider default | Voice ID or name. |
| `reply-mode` | string | No | `mirror` | One of `mirror`, `always`, `never`. `mirror` replies with voice when the user sent a voice message. |

Notes:

- `stt-provider` and `stt-api-key` must both be present or both absent.
- `tts-provider` and `tts-api-key` must both be present or both absent.
- Omitting the entire `voice` block disables voice for the channel.

### Per-user `voice` overrides

Per-user voice settings override channel-level voice defaults.

```kdl
user 123456789 {
  modes "coding"
  voice {
    reply-mode "always"
    tts-voice "Rachel"
  }
}
```

| Child node | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `reply-mode` | string | No | inherits channel | One of `mirror`, `always`, `never`. |
| `tts-voice` | string | No | inherits channel | Overrides the channel-level `tts-voice` for this user. |
## `autonomy.kdl`

`autonomy.kdl` is the canonical workflow manifest. It may import other KDL files.

### Top-level nodes

- `name "<string>"` required in the root manifest only
- `version "<string>"` required in the root manifest only
- `import "<relative-path>" as="<alias>"` optional, repeatable
- `setup "<name>" { ... }` optional, repeatable
- `goal "<name>" { ... }` optional, repeatable
- `override "setup"|"goal" "<name>" from="<ref>" strategy="replace"|"merge" { ... }` optional, repeatable
- `action-descriptor "<id>" source="project"` optional, repeatable

Local symbol names must not contain `.`. Dotted names are reserved for imported aliases such as `workflow.worker`.

### Action Descriptors

Declare project-specific action descriptors directly in KDL instead of requiring TypeScript registration.

```kdl
action-descriptor "growth.discovery" source="project"
action-descriptor "growth.feed.send" source="project" {
  param "maxItems" type="number"
  param "dryRun" type="boolean"
  prompt-slot "context" required=#true
}
```

Properties:

- First argument: action ID string (required)
- `source` property: `"project"` (default) or `"first-party"`

Child nodes:

- `param "<name>" type="<type>"` — declare a typed parameter
  - `type`: one of `string`, `number`, `boolean`, `string[]`, `number[]`, `boolean[]`, `json`
  - `required=#true` — mark as required
- `prompt-slot "<name>"` — declare a prompt slot
  - `required=#true` — mark as required

Action descriptors declared in imported modules are automatically registered and available to goals in the importing module.

### Imports

Imports resolve relative to the file that declares them.

```kdl
name "growth"
version "1.0.0"
import "./workflow/base.kdl" as="workflow"

goal "dispatch" {
  setup "workflow.worker"
  schedule type="cron" expression="0 6 * * *" timezone="UTC"
  action "spell.noop"
}
```

Imported symbols are available under the alias namespace:

- `workflow.worker`
- `workflow.scan`
- `workflow.inner.goal` for nested imports

Import cycles fail with the full chain.

### Overrides

Overrides materialize a new local symbol from an existing local or imported symbol reference.

#### Whole-symbol replace

Use `strategy="replace"` when you want to restate the full symbol explicitly.

```kdl
override "setup" "worker" from="workflow.worker" strategy="replace" {
  domain "coding"
  mode "worker"
  tools {
    allow "read" "grep"
  }
}
```

#### Field-level merge

Use `strategy="merge"` when you want schema-aware merging.

```kdl
override "setup" "worker" from="workflow.worker" strategy="merge" {
  tools {
    allow "read"
  }
  sandbox {
    paths-write "outbox/"
  }
  timeout "15m"
}
```

Merge rules are schema-driven:

- scalar fields such as `timeout` replace
- filter collections such as `tools.allow` append uniquely
- sandbox collections append uniquely
- named state stores merge by store name
- non-mergeable goal fields such as `schedule` and `action` must use whole-symbol replace

### `env(...)` references

String-valued fields may use `env(...)` for load-time resolution.

Supported forms:

- `env(NAME)` — required
- `env(NAME, type=number)`
- `env(NAME, type=boolean)`
- `env(NAME, default=cache-db)`
- `env(NAME, default="./data/cache.db")`
- `env(NAME, optional)`

Examples:

```kdl
max-cost-usd "env(MAX_COST_USD, type=number)"
state-store "workflow" backend="sqlite" path="env(WORKFLOW_DB)"
param "enabled" "env(DRY_RUN, type=boolean)"
```

Rules:

- missing required env values fail manifest load
- empty strings do not silently satisfy required values
- defaults are applied before type coercion
- coercion happens at the config boundary, not lazily during execution

### `setup "<name>" { ... }`

A setup defines reusable execution policy.

Supported children:

- `domain "<string>"` required
- `mode "<string>"` optional
- `skills { allow ...; deny ... }` optional
- `tools { allow ...; deny ... }` optional
- `sandbox { paths-write ...; bash-allow ...; bash-deny ... }` optional
- `timeout "<duration>"` optional
- `max-cost-usd <number>|"env(...)"` optional
- `state-store "<name>" backend="sqlite"|"artifact-store" path="<path>|env(...)" schema="<schema>"` optional, repeatable

Example:

```kdl
setup "worker" {
  domain "coding"
  mode "worker"
  tools {
    allow "read" "grep" "find"
    deny "bash"
  }
  sandbox {
    paths-write "data/" "artifacts/"
  }
  timeout "20m"
  state-store "workflow" backend="sqlite" path="env(WORKFLOW_DB)" schema="workflow"
  state-store "artifacts" backend="artifact-store" path="./artifacts"
}
```

### `goal "<name>" { ... }`

A goal defines scheduled or webhook-triggered work.

Supported children:

- `setup "<setup-name>"` required
- `schedule ...` required
- `prompt "<text>"` optional legacy path
- `action "<id>" { ... }` optional typed path
- at least one of `prompt` or `action` is required
- `hooks { ... }` optional
- `state persist=#true|#false { schema ... }` optional legacy persisted state declaration
- `state-store ...` optional, repeatable — goal-local additions/overrides on top of the referenced setup
- `retry max-retries=<n> initial-delay-ms=<n> multiplier=<n>` optional

Example:

```kdl
goal "daily-discovery" {
  setup "worker"
  schedule type="cron" expression="0 6 * * *" timezone="UTC"
  action "spell.noop"
  state-store "workflow" backend="sqlite" path="./data/discovery.db" schema="discovery"
  retry max-retries=2 initial-delay-ms=300000 multiplier=2
}
```

### `template "<name>" { ... }`

A `template` is a schedule-less, ad-hoc-runnable preset surfaced by the web dashboard's command bar. The runner instantiates a fresh RPC session, renders the prompt with Handlebars, and tags the spawned session with the caller's `WebIdentity.name` (`ownedBy`).

```kdl
template "document" {
    description "Generate a typst PDF report"
    setup "writer"
    mode "rpc"
    prompt "Generate a typst PDF report on {{topic}}."
    param "topic" type="string" required=#true
    param "depth" type="number"
    artifact-watch ".pdf" ".png"
}
```

| Child | Purpose |
| --- | --- |
| `setup "<setup-name>"` | Required. Resolves to a `setup` (or imported `<alias>.<name>`). |
| `description "..."` | Optional. Surfaced in the command palette. |
| `mode "rpc"` | Optional. v1 only allows `"rpc"`. |
| `prompt "<handlebars-text>"` | Required. Rendered with the coerced parameter map. Missing variables become the empty string with a warning logged once. |
| `param "<name>" type="<string\|number\|boolean>" required=#true` | Repeatable. Names must be unique inside the template. |
| `artifact-watch ".pdf" ".png" ...` | Optional. Lower-cased extension hints; the spawned session's `watchExtensions` drives the frontend's "ready" badge filter. |

Validation rules:

- Setup must resolve, prompt must be non-empty, parameter names unique, mode in `{ rpc }`.
- `artifact-watch` extensions must match `^\.[a-z0-9]+$` (case-insensitive accepted; lower-cased on parse).
- Two `template` nodes with the same name throw with the file path in the error.

### Typed `action` blocks

An action block is validated against the action registry available at load time, including built-in first-party actions and project action descriptors declared in KDL.

Children:

- `param "<name>" <scalar>`
- `param-list "<name>" <value>...`
- `prompt "<slot-name>" "<inline-text>"`
- `prompt-file "<slot-name>" "<relative-or-absolute-path>"`

Example:

```kdl
action "test.review" {
  param "limit" 5
  param "dryRun" #true
  prompt "review" "Review the staged digest."
}
```

Rules:

- unknown action ids fail validation
- unknown params fail validation
- missing required params or prompt slots fail validation
- prompt-file paths resolve relative to the file that declares them
- action descriptors may come from first-party registration or project KDL declarations
### Schedule node

#### Cron schedule

```kdl
schedule type="cron" expression="0 2 * * *" timezone="UTC" jitter="5m"
```

Fields:

- `type="cron"`
- `expression="<cron expression>"` required
- `timezone="<iana zone>"` optional
- `jitter="<duration>"` optional

#### Webhook schedule

```kdl
schedule type="webhook" path="growth/export-approved" auth="bearer"
```

Fields:

- `type="webhook"`
- `path="<trigger-path>"` optional
- `auth="hmac"|"bearer"` optional

### Hooks

Hooks remain event-group based.

```kdl
hooks {
  on-success {
    webhook "https://hooks.example.invalid/spell/success" method="POST"
  }
  on-failure {
    telegram chat-id=123456789
  }
  on-complete {
    org category="engineering"
  }
}
```

Supported targets:

- `webhook "<url>" method="POST"|"GET"`
- `telegram chat-id=<number>`
- `org category="<string>"`

### Legacy `state` node

Legacy goal-scoped persisted state remains supported for backward compatibility.

```kdl
state persist=#true {
  schema "last_result" type="string"
  schema "metrics" type="json"
}
```

### Full config-native example

```kdl
name "growth"
version "1.0.0"
import "./workflow/base.kdl" as="workflow"

override "setup" "worker" from="workflow.worker" strategy="merge" {
  timeout "20m"
  tools {
    allow "read"
  }
  state-store "audit" backend="artifact-store" path="./artifacts/audit"
}

goal "dispatch" {
  setup "worker"
  schedule type="cron" expression="0 6 * * *" timezone="UTC"
  action "spell.noop"
}
```
