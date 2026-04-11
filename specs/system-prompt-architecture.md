# System Prompt Architecture

The system prompt is three things: a mirror (what the agent is), a compass (what it values), and a handbook (how it operates). This document records the design principles that govern its structure.

## Information Hierarchy

The prompt is ordered by decreasing behavioral weight. When the agent faces a choice, it reaches for its values first, its procedures second, its tools third. The prompt mirrors this:

```
1. Preamble          structural scaffolding (RFC 2119, XML tags)
2. Workspace         where the agent is (environment, project context)
3. Identity          who the agent is + what it must never violate
4. Environment       what the agent has (tools, skills, rules, URIs)
5. Procedure         how the agent works (7 phases)
6. --- CACHE ---
7. Now               what is happening right now (CWD, date, mode overlays)
```

Identity absorbs Contract and Design Integrity because they are behavioral foundations, not operational rules. They define what the agent is accountable for. Procedure is extracted from the old "Rules" section and renamed — it contains the operational protocol only.

## Design Principles

1. **Values before tools.** The agent's character (Identity) must be fully established before reference material (Environment) appears. Contract at position ~25% instead of ~75%.

2. **Critical at edges.** The most important behavioral content is at the START (Identity) and END (final `<critical>` block). Tool documentation fills the middle where retention degrades 20%+ — acceptable because it's lookup material, not behavioral shaping.

3. **Documents at top, instructions after.** AGENTS.md (project context) sits in Workspace, before Identity. This follows the empirical finding that document context should precede instructional content.

4. **Stable content cached, dynamic content per-turn.** The CACHE_BOUNDARY sits at ~96% of the template. Everything before it (Identity through Procedure) is hashed into a cross-session cache key. Only "Now" + appendPrompt (mode overlays like compressed output, plan-mode, memory instructions) is dynamic.

5. **One section, one concern.** Identity = who. Environment = what tools. Procedure = how to work. No mixing.

## Identity Section Layout

```
<role>           staff engineer, agency, expertise, judgment
<communication>  style: correctness > brevity > politeness
<behavior>       completion reflex guard, pre-action checklist
[<thinking-mode>] compressed notation (conditional on terse thinking)
<code-integrity> outside-in framework (callers, system, time, failure)
<stakes>         urgency, accountability ("pages at 3am")
# Contract       5 inviolable rules
# Design Integrity  5 engineering principles
```

Stakes before Contract is deliberate: urgency primes absolute constraints. The staccato ending of stakes ("Tests you didn't write: bugs shipped.") is EmotionPrompt — measured +8-115% improvement on task performance.

## Caching Model

`buildSystemPrompt()` renders the template and splits at `CACHE_BOUNDARY_MARKER`. The stable prefix becomes a `SystemPromptBlock` with `stable: true`. The dynamic suffix becomes `stable: false`.

For Anthropic: stable blocks get `cache_control: { type: "ephemeral" }` (or `ttl: "1h"` for long retention). For OpenAI-compatible: stable text is hashed into `prompt_cache_key` for cross-session reuse.

**What's stable (cached):** Template content from Preamble through Procedure. This includes AGENTS.md (injected as context file), tool descriptions, skills, rules, Identity sections, Contract, Design Integrity, and the full Procedure.

**What's dynamic (per-turn):** "Now" section (CWD, date), final `<critical>`, and `appendPrompt` which contains:
- Compressed output instructions (when terse mode active) ~443 tokens
- Memory instructions (when memory system active)
- MCP server instructions (when MCP servers connected)
- Domain system prompt (when domain manifest configured)
- Plan-mode overlay (when in plan mode) ~5519 tokens

The compressed thinking-mode block IS in the stable section (Identity), because it defines how the agent reasons — a stable characteristic, not a per-turn mode.

## Boundary: system-prompt.md vs AGENTS.md

| Concern | Owner | Examples |
|---------|-------|---------|
| Agent identity, values, judgment | system-prompt.md | completion reflex, outside-in thinking, stakes |
| Engineering principles (universal) | system-prompt.md | DRY at 2, earn every line, one concept one representation |
| Operational procedure | system-prompt.md | 7 phases, parallelization, verification |
| Tool guidance | system-prompt.md | LSP vs grep, code tool workflow, AST patterns |
| Project coding conventions | AGENTS.md | Bun APIs, node:fs imports, file I/O patterns |
| Project-specific testing rules | AGENTS.md | contract tests, no mocks, no placeholders |
| Project tooling (commands) | AGENTS.md | bun check, bun lint, bun fmt |
| Project style | AGENTS.md | no emojis, changelog format, commit style |

No meaningful content overlap exists between the two files. The boundary is: system-prompt.md encodes who the agent IS across all projects; AGENTS.md encodes how THIS project works.

## Token Budget (approximate, rendered with typical config)

| Component | Tokens | Cached? |
|-----------|--------|---------|
| Template static content | ~4600 | Yes |
| AGENTS.md context file | ~5500 | Yes |
| Tool descriptions (dynamic count) | ~1000-2000 | Yes |
| Skills list | ~200-500 | Yes |
| **Stable total** | **~11000-12600** | **Yes** |
| Now section | ~180 | No |
| appendPrompt (varies by mode) | ~200-5500 | No |
| **Dynamic total** | **~380-5700** | **No** |

The stable section is the cache investment. Changes to it invalidate cached prompts — a one-time cost per deployment, amortized across all sessions.
