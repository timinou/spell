---
name: spell-server-setup
description: Interactive wizard to bootstrap a .spell/ directory with spell-server configuration, Telegram bridge, autonomy goals, state stores, and optional memory system. Run in any project directory.
version: 1.0.0
---

# Spell Server Setup Wizard

You are running an interactive setup wizard that bootstraps a complete `.spell/` directory for spell-server. The target user may be non-technical (e.g., a founder who wants Telegram access to an AI agent on their project). Guide them through the process step by step.

## Prerequisites

Before starting, confirm:
- The user is in the project directory where `.spell/` should be created
- spell-server is available (either via `spell server start` or `bun run packages/spell-server/src/main.ts`)

If the user is unsure, point them to `pi://spell-server/getting-started.md`.

## Phase 1: Project Discovery

Use the `ask` tool to gather information. Ask these questions:

### Question 1: Project description
Ask: "What does this project do? (A sentence or two — this helps me tailor the agent's goals and prompts to your project.)"

This answer is used to generate meaningful goal prompts instead of generic placeholders.

### Question 2: Preset selection
Ask with options:

| Preset | Description |
|--------|-------------|
| **Assistant** | Autonomous agent with memory, context tracking, and scheduled intelligence. Two-tier episodic/semantic memory with confidence decay, context database (people, decisions, commitments), scheduled consolidation, morning briefs, weekly synthesis. Best for: founder sidekick, research assistant, relationship tracker. |
| **Workflow** | Content or data pipeline with approval states, operator actions, scheduled processing, and export targets. Approval state machine, operator actions via Telegram, artifact export, checkpoint gates, audit logging. Best for: content curation, data processing, review pipelines. |
| **Minimal** | Spell-server with Telegram interactive sessions and a simple scheduled goal. No modular imports, no state stores. Best for: trying spell-server, simple automation, chat-only usage. |
| **Other** | Describe what you want. The agent combines features from the presets based on your description. |

### Feature Matrix (for adaptive "Other" mode)

When the user selects "Other", use this matrix to decide which features to include based on their description:

| Feature | Assistant | Workflow | Minimal | When to include |
|---------|-----------|----------|---------|-----------------|
| server.kdl (HTTP + auth) | yes | yes | yes | Always |
| channels.kdl (Telegram) | yes | yes | yes | Always |
| autonomy.kdl (goals) | yes | yes | yes | Always |
| Modular imports | yes | yes | no | When >1 goal or state stores needed |
| workflows/*.kdl (setup) | yes | yes | no | When goals share execution policy |
| states/*.kdl (schemas) | yes | yes | no | When persistent state needed |
| memory.kdl (two-tier decay) | yes | no | no | When long-term knowledge retention matters |
| Consolidation goals | yes | no | no | When memory.kdl is included |
| Approval state machine | no | yes | no | When human review gates exist |
| Operator actions | no | yes | no | When Telegram-driven approvals needed |
| Export targets | no | yes | no | When output goes to external systems |
| Audit logging | no | yes | no | When action traceability matters |
| Voice config | optional | optional | optional | When user wants voice interaction |
| Session notifications | yes | yes | no | When local CLI sessions exist alongside Telegram |

### Question 3: Configuration details
Ask (can be combined into one `ask` call with multiple questions):
- Port number (default: 8787)
- Telegram bot token (or "I'll add it later")
- Your Telegram user ID (or "I'll add it later"). Explain: "Send /start to @userinfobot on Telegram to find your ID."
- Default model (default: claude-sonnet-4-20250514)
- Do you want voice interaction? If yes: which STT provider (deepgram or openai) and TTS provider (elevenlabs or deepgram)?

## Phase 2: File Generation

Generate all files into `.spell/` under the current working directory using the `write` tool. Use `env()` references for all secrets — never inline tokens or passwords.

### Always Generated

#### `.spell/server.kdl`

```kdl
http port=<port> {
    auth {
        username "spell"
        password "env(SPELL_AUTH_PASSWORD)"
    }
    webhook-secret "env(SPELL_WEBHOOK_SECRET)"
}

socket
```

Notes:
- `socket` with no arguments uses the default path `~/.spell/server.sock`
- Add `goal-token` entries if the preset includes webhook-triggered goals:
  ```kdl
  goal-token "<goal-name>" "env(SPELL_<GOAL>_TOKEN)"
  ```

#### `.spell/channels.kdl`

```kdl
telegram {
    bot-token "env(TELEGRAM_BOT_TOKEN)"
    owners env(TELEGRAM_OWNER_ID)
    default-model "<model>"
    upload-dir ".spell/data/telegram-uploads"
    idle-timeout 300
    max-sessions 5

    project "<project-name>" "."
    default-project "<project-name>"

    user env(TELEGRAM_OWNER_ID) {
        modes "telegram-readonly" "telegram-full"
        default-mode "telegram-readonly"
        idle-timeout #null
    }

    session-notifications {
        events "plan_approval" "ask" "pending_action"
        notify-owners #true
    }
}
```

If voice was requested, add inside the `telegram` block:
```kdl
    voice {
        stt-provider "<provider>"
        stt-api-key "env(<STT_PROVIDER>_API_KEY)"
        tts-provider "<provider>"
        tts-api-key "env(<TTS_PROVIDER>_API_KEY)"
        tts-model "<model>"
        reply-mode "mirror"
    }
```

STT provider defaults: deepgram model "nova-2", openai model "whisper-1".
TTS provider defaults: elevenlabs model "eleven_turbo_v2_5" voice "Rachel", deepgram model "aura-asteria-en".

#### `.env.example`

Template with all needed variables. Always include:
```
SPELL_AUTH_PASSWORD=change-me
SPELL_WEBHOOK_SECRET=generate-a-long-random-string
TELEGRAM_BOT_TOKEN=your-bot-token-from-botfather
TELEGRAM_OWNER_ID=your-telegram-user-id
TELEGRAM_CHAT_ID=your-chat-id-for-notifications
```

Add preset-specific variables as comments or values depending on what was configured.

#### `.env`

Populated with values the user provided. Leave placeholders for "I'll add it later" answers.

#### `.gitignore` update

Append these lines if not already present:
```
.env
.spell/data/
```

#### `.spell/AGENTS.md`

Brief project description plus basic context. Example:
```markdown
# Development Rules

This project uses spell-server for autonomous agent execution and Telegram interaction.

## Commands
- `spell server start` — Start the server
- Check server health: `curl -u spell:$SPELL_AUTH_PASSWORD http://localhost:<port>/api/goals`
```

### Assistant Preset

Generate these additional files:

#### `.spell/workflows/base-assistant.kdl`

```kdl
setup "base-assistant" {
    domain "assistant"
    mode "sidekick"
    timeout "15m"
    tools {
        allow "read" "grep" "find" "fetch" "web_search"
    }
    sandbox {
        paths-write ".spell/data" "./artifacts"
    }
    state-store "memory" backend="sqlite" path=".spell/data/memory.sqlite" schema="memory.memory-db"
    state-store "context" backend="sqlite" path=".spell/data/context.sqlite" schema="context.context-db"
}
```

#### `.spell/memory.kdl`

Two-tier memory system with episodic and semantic tiers. This is the core intelligence layer.

```kdl
// Two-tier memory: episodic (context-rich events, fast decay) and
// semantic (decontextualized patterns, slow decay).
// Decay function: new_confidence = confidence * decay_factor
// Applied per consolidation cycle for unreferenced memories.
// Referenced memories get boosted (spaced repetition).

memory-tier "episodic" {
    decay-factor 0.85
    boost-on-retrieval 0.10
    review-threshold 0.50
    archive-threshold 0.20
    max-input-age-days 90
    consolidation-interval "daily"
}

memory-tier "semantic" {
    decay-factor 0.97
    boost-on-retrieval 0.05
    review-threshold 0.40
    archive-threshold 0.15
    max-input-age-days #null
    consolidation-interval "weekly"
}

memory-significance "landmark" {
    exempt-from-age-gate #true
    initial-confidence 0.95
    min-decay-floor 0.60
}

memory-significance "inflection" {
    exempt-from-age-gate #false
    initial-confidence 0.85
    min-decay-floor 0.40
}

memory-significance "routine" {
    exempt-from-age-gate #false
    initial-confidence 0.70
    min-decay-floor #null
}

memory-org {
    file "MEMORY.org"
    section "Semantic"
    section "Episodic"
    section "Archive"
    section "Contradictions"
    property "CONFIDENCE" type="number"
    property "TIER" type="string"
    property "SCOPE" type="string"
    property "LAST_VALIDATED" type="timestamp"
    property "LAST_RETRIEVED" type="timestamp"
    property "RETRIEVAL_COUNT" type="number"
    property "SOURCE_GOAL" type="string"
    property "SIGNIFICANCE" type="string"
    property "DECAY_FLOOR" type="number"
    auto-tags-from-scope #true
}

state-schema "memory-db" backend="sqlite" {
    table "memories" {
        column "id" type="string" primary=#true
        column "tier" type="string"
        column "title" type="string"
        column "body" type="string"
        column "scope" type="string"
        column "confidence" type="number"
        column "significance" type="string"
        column "decay_floor" type="number"
        column "source_goal" type="string"
        column "source_session" type="string"
        column "tags_json" type="json"
        column "created_at" type="string"
        column "last_validated" type="string"
        column "last_retrieved" type="string"
        column "retrieval_count" type="number"
        column "archived_at" type="string"
    }
    table "memories_fts" {
        column "title" type="string"
        column "body" type="string"
        column "scope" type="string"
        column "tags_json" type="string"
    }
    table "retrievals" {
        column "id" type="string" primary=#true
        column "memory_id" type="string"
        column "goal_name" type="string"
        column "session_id" type="string"
        column "retrieved_at" type="string"
        column "context" type="string"
    }
    table "consolidation_runs" {
        column "id" type="string" primary=#true
        column "tier" type="string"
        column "started_at" type="string"
        column "completed_at" type="string"
        column "memories_processed" type="number"
        column "memories_decayed" type="number"
        column "memories_boosted" type="number"
        column "memories_archived" type="number"
        column "memories_promoted" type="number"
        column "semantic_extracted" type="number"
        column "contradictions_found" type="number"
    }
    table "reviews" {
        column "id" type="string" primary=#true
        column "memory_id" type="string"
        column "reason" type="string"
        column "queued_at" type="string"
        column "reviewed_at" type="string"
        column "action" type="string"
        column "operator_note" type="string"
    }
}

memory-consolidation {
    schedule type="cron" expression="0 3 * * *" timezone="UTC"
    cross-goal-patterns #true
    semantic-extraction #true
    contradiction-detection #true
    max-input-tokens 100000
    context-store "context"
}

memory-review {
    channel "telegram"
    chat-id "env(TELEGRAM_CHAT_ID)"
    schedule type="cron" expression="0 9 * * 0" timezone="UTC"
    batch-size 5
    on-confirm {
        reset-confidence 0.90
        update-last-validated #true
    }
    on-revise {
        reset-confidence 0.80
        update-last-validated #true
        allow-content-edit #true
    }
    on-dismiss {
        archive #true
    }
}
```

#### `.spell/states/context-db.kdl`

Tailor the tables to the user's project description. The base pattern:

```kdl
state-schema "context-db" backend="sqlite" {
    // Adapt these tables to the project domain.
    // The memory system READS from context during consolidation.
    // Goals WRITE to context during execution.

    table "people" {
        column "id" type="string" primary=#true
        column "name" type="string"
        column "organization" type="string"
        column "role" type="string"
        column "relationship" type="string"
        column "context" type="string"
        column "last_contact" type="string"
        column "contact_frequency_days" type="number"
        column "health" type="string"
        column "tags_json" type="json"
        column "created_at" type="string"
        column "updated_at" type="string"
    }

    table "decisions" {
        column "id" type="string" primary=#true
        column "title" type="string"
        column "domain" type="string"
        column "decision" type="string"
        column "rationale" type="string"
        column "alternatives_json" type="json"
        column "assumptions_json" type="json"
        column "stakeholders_json" type="json"
        column "reversibility" type="string"
        column "decided_at" type="string"
        column "review_at" type="string"
        column "status" type="string"
    }

    table "commitments" {
        column "id" type="string" primary=#true
        column "description" type="string"
        column "to_person_id" type="string"
        column "domain" type="string"
        column "deadline" type="string"
        column "status" type="string"
        column "created_at" type="string"
        column "completed_at" type="string"
    }

    table "open_questions" {
        column "id" type="string" primary=#true
        column "question" type="string"
        column "domain" type="string"
        column "context" type="string"
        column "priority" type="string"
        column "raised_at" type="string"
        column "resolved_at" type="string"
        column "resolution" type="string"
    }
}
```

Adapt these tables based on the project description. For example:
- A startup founder gets people, decisions, commitments, open_questions
- A research project might replace people with papers/authors, commitments with hypotheses
- A product manager might add features, roadmap_items, customer_feedback tables

#### `.spell/autonomy.kdl`

```kdl
name "<project-name>"
version "1.0.0"

import "./workflows/base-assistant.kdl" as="assistant"
import "./states/context-db.kdl" as="context"
import "./memory.kdl" as="memory"

// Tailor these goals to the project:

goal "morning-context" {
    setup "base-assistant"
    schedule type="cron" expression="0 7 * * *" timezone="UTC"
    prompt "<Generate a prompt tailored to the project description>"
    hooks {
        on-failure {
            telegram chat-id="env(TELEGRAM_CHAT_ID)"
        }
    }
}

goal "memory-maintenance" {
    setup "base-assistant"
    schedule type="cron" expression="0 3 * * *" timezone="UTC"
    prompt "You are the memory maintenance agent. For each tier (episodic, semantic): compute new confidence for every active memory using tier decay/boost rules. Archive entries below archive-threshold. Queue entries below review-threshold for human review. Log the consolidation run. Sync updated confidence values to MEMORY.org. Do NOT delete any memories."
    hooks {
        on-failure {
            telegram chat-id="env(TELEGRAM_CHAT_ID)"
        }
    }
}

goal "weekly-synthesis" {
    setup "base-assistant"
    schedule type="cron" expression="0 22 * * 0" timezone="UTC"
    prompt "<Generate a synthesis prompt tailored to the project>"
    hooks {
        on-complete {
            telegram chat-id="env(TELEGRAM_CHAT_ID)"
        }
    }
}
```

The morning-context and weekly-synthesis prompts MUST be tailored to the user's project description. Use the project description to generate specific, actionable prompts — not generic "summarize everything" prompts.

### Workflow Preset

Generate these additional files:

#### `.spell/workflows/base-worker.kdl`

```kdl
setup "base-worker" {
    domain "coding"
    mode "worker"
    timeout "20m"
    tools {
        allow "read" "grep" "find" "fetch" "web_search" "autonomy_state"
    }
    sandbox {
        paths-write ".spell/data" "./artifacts" "./outbox"
    }
    state-store "workflow" backend="sqlite" path=".spell/data/workflow.sqlite" schema="workflowState.workflow-db"
    state-store "audit" backend="sqlite" path=".spell/data/audit.sqlite" schema="auditState.audit-db"
    state-store "artifacts" backend="artifact-store" path="./artifacts"
}
```

#### `.spell/workflows/review-policy.kdl`

```kdl
// Approval state machine. Tailor states and transitions to the project.
review-policy "<domain>-approval" {
    state "pending" initial=#true
    state "approved" terminal=#true
    state "rejected" terminal=#true
    state "needs-revision"
    transition from="pending" to="approved" action="approve"
    transition from="pending" to="rejected" action="reject"
    transition from="pending" to="needs-revision" action="request-revision"
    transition from="needs-revision" to="approved" action="approve"
    transition from="needs-revision" to="rejected" action="reject"
}
```

#### `.spell/workflows/notifications.kdl`

```kdl
notification-route "all-completions" channel="telegram" on="complete" chat-id="env(TELEGRAM_CHAT_ID)"
notification-route "all-failures" channel="telegram" on="failure" chat-id="env(TELEGRAM_CHAT_ID)"
```

#### `.spell/workflows/exports.kdl`

```kdl
// Export targets: where processed artifacts go.
// Tailor to the project's output destinations.
export-target "outbox" path="./outbox" format="markdown"
```

#### `.spell/states/workflow-db.kdl`

Tailor to the project. Base pattern:
```kdl
state-schema "workflow-db" backend="sqlite" {
    // Adapt tables to the project's workflow domain.
    table "items" {
        column "id" type="string" primary=#true
        column "title" type="string"
        column "status" type="string"
        column "source" type="string"
        column "metadata_json" type="json"
        column "created_at" type="string"
        column "updated_at" type="string"
    }
    table "approvals" {
        column "id" type="string" primary=#true
        column "item_id" type="string"
        column "action" type="string"
        column "operator" type="string"
        column "surface" type="string"
        column "decided_at" type="string"
    }
    table "exports" {
        column "id" type="string" primary=#true
        column "item_id" type="string"
        column "target" type="string"
        column "status" type="string"
        column "artifact_path" type="string"
        column "exported_at" type="string"
    }
}
```

#### `.spell/states/audit-db.kdl`

```kdl
state-schema "audit-db" backend="sqlite" {
    table "audit_log" {
        column "id" type="string" primary=#true
        column "action" type="string"
        column "entity_type" type="string"
        column "entity_id" type="string"
        column "operator" type="string"
        column "surface" type="string"
        column "details_json" type="json"
        column "timestamp" type="string"
    }
}
```

#### `.spell/autonomy.kdl`

```kdl
name "<project-name>"
version "1.0.0"

import "./workflows/base-worker.kdl" as="workflow"
import "./workflows/review-policy.kdl" as="review"
import "./workflows/notifications.kdl" as="notifications"
import "./workflows/exports.kdl" as="exports"
import "./states/workflow-db.kdl" as="workflowState"
import "./states/audit-db.kdl" as="auditState"

override "setup" "worker" from="workflow.base-worker" strategy="merge" {
    sandbox {
        paths-write ".spell/data" "./outbox" "./artifacts"
    }
    tools {
        allow "autonomy_state"
    }
    state-store "workflow" backend="sqlite" path=".spell/data/workflow.sqlite" schema="workflowState.workflow-db"
    state-store "audit" backend="sqlite" path=".spell/data/audit.sqlite" schema="auditState.audit-db"
}

// Operator actions: Telegram-driven approval workflow
operator-action "approve" {
    transition from="pending" to="approved"
}
operator-action "reject" {
    transition from="pending" to="rejected"
}

// Tailor goals to the project:

goal "<discovery-goal>" {
    setup "worker"
    schedule type="cron" expression="0 6 * * *" timezone="UTC"
    prompt "<Generate discovery prompt based on project description>"
    hooks {
        on-failure {
            telegram chat-id="env(TELEGRAM_CHAT_ID)"
        }
    }
}

goal "<processing-goal>" {
    setup "worker"
    schedule type="cron" expression="0 8 * * *" timezone="UTC"
    prompt "<Generate processing prompt based on project description>"
    hooks {
        on-failure {
            telegram chat-id="env(TELEGRAM_CHAT_ID)"
        }
    }
}

goal "<export-goal>" {
    setup "worker"
    schedule type="webhook" path="<project>/export" auth="bearer"
    prompt "<Generate export prompt based on project description>"
    hooks {
        on-complete {
            telegram chat-id="env(TELEGRAM_CHAT_ID)"
        }
    }
}
```

### Minimal Preset

Generate only the always-generated files plus a single-file autonomy.kdl with inline setup:

#### `.spell/autonomy.kdl`

```kdl
name "<project-name>"
version "1.0.0"

setup "basic" {
    domain "coding"
    mode "worker"
    timeout "15m"
    tools {
        allow "read" "grep" "find" "bash" "web_search"
    }
}

goal "daily-check" {
    setup "basic"
    schedule type="cron" expression="0 9 * * *" timezone="UTC"
    prompt "<Generate a simple daily check prompt based on project description>"
    hooks {
        on-failure {
            telegram chat-id="env(TELEGRAM_CHAT_ID)"
        }
    }
}
```

## Phase 3: Verification Summary

After generating all files, produce a summary using this template:

### For operators (non-technical)

```
## Getting Started

1. Start the server:
   spell server start

2. Open Telegram and search for your bot (@YourBotName)
3. Send /start to authorize
4. Send a message — the bot should respond
5. Try /help to see available commands
6. Try /status to check your session
7. Try /unlock for full tool access (write, edit, bash)
```

### For developers

```
## Verification Commands

# Check server is running
curl -u spell:$SPELL_AUTH_PASSWORD http://localhost:<port>/api/goals

# Check manifest loaded
curl -u spell:$SPELL_AUTH_PASSWORD http://localhost:<port>/api/manifest

# Open dashboard
open http://localhost:<port>/

# Trigger a goal manually (if webhook goals exist)
curl -X POST -H "Authorization: Bearer $SPELL_<GOAL>_TOKEN" http://localhost:<port>/trigger/<goal-name>
```

### Further reading

```
## Documentation

- pi://spell-server/getting-started.md — Full setup and deployment guide
- pi://spell-server/telegram-bridge.md — Telegram bot commands, voice, sessions
- pi://spell-server/kdl-schema-reference.md — Complete KDL configuration reference
- pi://spell-server/architecture.md — System architecture and design
```

### Files generated

List every file created with a one-line description. Note which preset was used. Highlight any TODOs or placeholders left for the user to fill in.
