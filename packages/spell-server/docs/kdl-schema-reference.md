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
  user 123456789 {
    modes "telegram-readonly" "coding"
    default-mode "coding"
    projects "spell"
  }
}
```

Important rules:

- Omit the whole `telegram` node to disable Telegram.
- `default-model`, `owners`, and either `bot-token` or `bot-token-file` are required when `telegram` is present.
- Use `#null`, not bare `null`, for nullable values such as `idle-timeout #null`.

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
