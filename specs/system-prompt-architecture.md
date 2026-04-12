# System Prompt Architecture

The system prompt is three things: a mirror (what the agent is), a compass (what it values), and a handbook (how it operates). This document records the design principles that govern its structure.

## Information Hierarchy

The prompt is ordered by decreasing behavioral weight. When the agent faces a choice, it reaches for its values first, its tools second. The prompt mirrors this:

```
1. Preamble          structural scaffolding (RFC 2119, XML tags)
2. Workspace         where the agent is (environment, project context)
3. Identity          who the agent is + what it must never violate
4. Environment       what the agent has (tools, skills, rules, URIs)
5. --- CACHE ---
6. Now               what is happening right now (CWD, date, mode overlays)
```

Procedure no longer exists as a separate section. Its genuine insights (parallelization, existing patterns, external verification) merged into Principles within the Identity section. Process compliance items were redundant with tool descriptions.

## Design Principles

1. **Values before tools.** The agent's character (Identity) must be fully established before reference material (Environment) appears. Contract at position ~25% instead of ~75%.

2. **Permission and shape, not instruction and costume.** The model doesn't need a title, a persona, or a process manual. It needs honest self-knowledge (strength, weakness) and permission to exercise judgment. This insight from PLAN-181 drives every structural decision.

3. **Critical at edges.** The most important behavioral content is at the START (Identity) and END (final `<critical>` block). Tool documentation fills the middle where retention degrades — acceptable because it's lookup material, not behavioral shaping. The CACHE_BOUNDARY now sits between Principles and Now, maximizing the stable cached portion.

4. **Documents at top, instructions after.** AGENTS.md (project context) sits in Workspace, before Identity. This follows the empirical finding that document context should precede instructional content.

5. **Stable content cached, dynamic content per-turn.** The CACHE_BOUNDARY sits after Principles. Everything before it (Identity through Environment) is hashed into a cross-session cache key. Only "Now" + appendPrompt is dynamic.

6. **One section, one concern.** Identity = who. Environment = what tools. No mixing.

7. **Less content, better placed.** Tools are self-documenting via their descriptions. The system prompt teaches philosophy (LSP knows; grep guesses), not syntax tutorials. ~1,000 words of tool manual compressed to ~80 words of philosophy.

## Identity Section Layout

```
<role>           self-knowledge: strength, weakness, operating posture
<thinking-mode>  compressed notation (always present, unconditional)
<communication>  style: correctness > brevity > politeness
<discipline>     completion reflex guard, adversarial questions, outside-in framework
<stakes>         urgency, accountability ("pages at 3am")
# Contract       5 inviolable rules
# Principles     10 engineering principles (absorbs Design Integrity + dissolved Procedure)
```

Key changes from prior architecture:
- **Role**: From "staff engineer" title to honest self-knowledge ("your strength is holding complexity; your weakness is generating inside-out"). Identity anchor removed from template, kept only in `claudeCodeSystemInstruction` for stealth mode.
- **Thinking-mode**: Now unconditional (always rendered), moved from after behavior to right after role. Reasoning style is foundational, not a conditional feature.
- **Discipline merge**: `<behavior>` + `<code-integrity>` merged into `<discipline>`. They are the same cognitive pattern at different scales — one guards against the completion reflex, the other teaches outside-in thinking.
- **Principles expansion**: "Design Integrity" renamed to "Principles", expanded from 8 to 10. Old #7 (inhabit call site) and #8 (optimize for next edit) merged. Four new principles from dissolved Procedure: parallelize by default, existing patterns before new, verify externally. The preamble shifted from verbose explanation to a single sentence: "Code tells the truth about what the system currently is."

Stakes before Contract remains deliberate: urgency primes absolute constraints.

## Caching Model

`buildSystemPrompt()` renders the template and splits at `CACHE_BOUNDARY_MARKER`. The stable prefix becomes a `SystemPromptBlock` with `stable: true`. The dynamic suffix becomes `stable: false`.

For Anthropic: stable blocks get `cache_control: { type: "ephemeral" }` (or `ttl: "1h"` for long retention). For OpenAI-compatible: stable text is hashed into `prompt_cache_key` for cross-session reuse.

**What's stable (cached):** Template content from Preamble through Principles and the full Environment section. This includes AGENTS.md (injected as context file), tool descriptions, skills, rules, Identity sections, Contract, and Principles.

**What's dynamic (per-turn):** "Now" section (CWD, date), final `<critical>`, and `appendPrompt` which contains:
- Compressed output instructions (when terse mode active) ~443 tokens
- Memory instructions (when memory system active)
- MCP server instructions (when MCP servers connected)
- Domain system prompt (when domain manifest configured)
- Plan-mode overlay (when in plan mode) ~3500-4500 tokens

The thinking-mode block is unconditional and always present in the stable section (Identity). It defines how the agent reasons — a stable characteristic.

## Boundary: system-prompt.md vs AGENTS.md

| Concern | Owner | Examples |
|---------|-------|---------|
| Agent identity, values, judgment | system-prompt.md | discipline, outside-in thinking, stakes |
| Engineering principles (universal) | system-prompt.md | DRY at 2, earn every line, one concept one representation |
| Tool philosophy | system-prompt.md | LSP knows; grep guesses, search before you read |
| Project coding conventions | AGENTS.md | Bun APIs, node:fs imports, file I/O patterns |
| Project-specific testing rules | AGENTS.md | contract tests, no mocks, no placeholders |
| Project tooling (commands) | AGENTS.md | bun check, bun lint, bun fmt |
| Project style | AGENTS.md | no emojis, changelog format, commit style |

No meaningful content overlap exists between the two files. The boundary is: system-prompt.md encodes who the agent IS across all projects; AGENTS.md encodes how THIS project works.

## Token Budget (approximate, rendered with typical config)

| Component | Tokens | Cached? |
|-----------|--------|---------|
| Template static content | ~4200 | Yes |
| AGENTS.md context file | ~1400 | Yes |
| Tool descriptions (dynamic count) | ~600-1200 | Yes |
| Skills list | ~200-500 | Yes |
| **Stable total** | **~6400-7300** | **Yes** |
| Now section | ~180 | No |
| appendPrompt (varies by mode) | ~200-3500 | No |
| **Dynamic total** | **~380-3700** | **No** |

The stable section is the cache investment. Changes to it invalidate cached prompts — a one-time cost per deployment, amortized across all sessions.

## Plan-Mode Overlay Architecture

Plan-mode overlays declare what the system handles automatically and what the agent is responsible for, rather than teaching manual processes.

**System capabilities declared in overlays:**
- **DAG scheduling**: `todo_write` auto-promotes the next ready task on completion. Blockers are enforced — starting a blocked task is rejected.
- **Gate verification**: Tasks with `gateCmd`, `gateArtifact`, or `gateCommit` require two-phase completion (mark complete → rejected with checklist → verify → mark complete with `verified: true`).
- **Org lifecycle hooks**: Tasks with `orgItemId` auto-transition linked org items to DOING on `in_progress`. Tasks with `orgItemClosingId` auto-transition to DONE on verified completion.
- **Auto-roster**: The `task` tool auto-creates todo items for dispatched subtasks.
- **Wave computation**: `org wave` computes parallel execution waves from the sub-outline dependency graph.

**Agent responsibility:** Execute work, mark status truthfully, satisfy verification gates.

**Compression results (PLAN-214, cumulative with PLAN-209):**
- AGENTS.md: 2,961 → 1,392 words (53% reduction)
- Tool descriptions: 12,554 → 7,664 words (39% reduction)
- plan-mode-active.md: 2,504 → 1,653 words (34% reduction)
- plan-mode-approved.md: 1,287 → 1,135 words (12% reduction)
- plan-mode-uiux.md: 654 words (unchanged from PLAN-209)
- agent-creation-architect.md: 729 → 301 words (59% reduction)
- Total prompt surface: ~23,000 → ~15,600 words (~32% reduction)

## Lineage

- **PLAN-181** (terse mode rewrite): Found the principle: "the model doesn't need a costume. It needs permission and shape."
- **PLAN-188** (architecture restructure): Named the architecture: "mirror, compass, handbook" and moved values before tools.
- **PLAN-191** (declaration of being): Expanded the creative voice of the Identity section.
- **PLAN-207** (prompt declaration of being): Attempted to extend declaration-of-being to all prompts. Superseded by PLAN-209 — the philosophy shifted from "normalize all prompts into a consistent voice" to "less content, better placed."
- **PLAN-209** (essence rewrite): Returned to the core insight. Merged behavior+code-integrity into discipline, dissolved Procedure into Principles, compressed tool manual to philosophy, compressed plan-mode overlays.
- **PLAN-214** (terse input surface compression): Extended the compression principle to the entire input surface. AGENTS.md compressed to constraint notation, 41 tool descriptions compressed, plan-mode overlays further compressed, agent prompts audited. Contract: `specs/prompt-surface-compression.md`.
