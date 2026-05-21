# YAML/JSON → KDL Migrator

**This directory is a one-shot migration. Delete it when you're done.**

## What it does

On `Settings.init()`, scans for legacy Spell config in known locations,
translates them to KDL, writes them to the new canonical paths, and renames
the originals to `*.migrated-YYYY-MM-DD.bak`.

| from                              | to                                |
| --------------------------------- | --------------------------------- |
| `~/.spell/spell.kdl`              | `~/.config/spell/spell.kdl`       |
| `~/.spell/agent/config.yml`       | `~/.config/spell/spell.kdl`       |
| `~/.spell/agent/settings.json`    | `~/.config/spell/spell.kdl`       |
| `<cwd>/.spell/spell.kdl`          | `<cwd>/spell.kdl`                 |
| `<cwd>/.spell/settings.json`      | `<cwd>/spell.kdl`                 |
| `<cwd>/.spell/agent/config.yml`   | `<cwd>/spell.kdl`                 |

It is **idempotent**: once a source file has a sibling `.migrated-*.bak`, it
is skipped on subsequent runs.

## How to remove

Once you've run Spell on every machine you care about and confirmed clean
state via `spell config doctor` (see FEAT-756):

```bash
# 1. Delete this directory
rm -rf packages/coding-agent/src/migration

# 2. Remove the integration in src/config/settings.ts:
#    - `import { maybeRunMigration } from "../migration";`
#    - the `await maybeRunMigration({...})` block inside `Settings.#load()`
#    - the `#migrateOptions` field and its assignment in the constructor
#    - the `migrate?: { yes?: boolean; no?: boolean; interactive?: boolean }`
#      entry in the `SettingsOptions` interface

# 3. Drop the integration test:
rm packages/coding-agent/test/settings-migration.test.ts

# 4. Commit
git add -A
git commit -m "chore: remove one-shot yaml/json → kdl migration"
```

The migrator has **no other coupling** to the rest of the codebase:
- No public `exports` entry in `package.json` (verified by reviewer; do NOT
  add one).
- No file outside `src/migration/` imports from it except the single line in
  `settings.ts`.
- The integration test (`test/settings-migration.test.ts`) drives the
  migrator solely through `Settings.init({ migrate: { yes: true } })`, so
  removing the test plus that option restores the pre-migration surface
  exactly.

## Design

- `detect.ts` scans known locations and returns `Finding[]` with metadata
- `translate.ts` parses YAML/JSON → `RawSettings` → KDL via `writeKdlSettings`
- `dialog.ts` renders the interactive prompt and reads input
- `index.ts` orchestrates the above, exports a single `maybeRunMigration()`

Tests live under `test/` inside this directory and disappear with it.

## Non-goals

- Migrating `secrets.yml` / `mcp.json` / `ssh.json` / `domain.json` — those
  are handled in WAVE 2 of PLAN-311. This migrator covers settings only.
- Migrating foreign-tool configs (`.claude/`, `.codex/`, `.gemini/`, etc.)
  — they stay native by design.
