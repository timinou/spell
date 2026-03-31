# Mode Configuration Guide

## Quick Start

1. Create a directory: `.spell/modes/my-mode/`
2. Add a `MODE.md` file with YAML frontmatter and markdown body
3. Restart your session - the mode will be auto-discovered

## MODE.md Format

```yaml
---
name: my-mode
description: What this mode does
extends: plan          # Inherit from: plan, audit, or another mode
command: /mymode       # Slash command to activate
readOnly: false        # Restrict file modifications
tools:
  allow: [read, grep, find, ask]  # Only these tools available
  # OR
  deny: [bash, write]             # Remove these tools
gates:
  metis: true          # Enable/disable ultraplan phases
  daedalus: true
  momus: false
audit:
  focusAreas:          # Custom audit checklist
    - Item 1
    - Item 2
  maxDepth: 2          # Max audit cycles
  escalation: suggest  # auto | suggest | false
decomposition:
  requiredSections:    # Custom org item body sections
    - Scope
    - Tests
    - Implementation
afterComplete: audit   # Chain to another mode on exit
contextPolicy: fresh   # fresh | carry | { type: summarize, description: '...' }
model: claude-sonnet   # Override model for this mode
---

## Context

Background information injected into the mode's system prompt.

## Instructions

Specific instructions for the agent in this mode.

## Focus Areas

Key areas to prioritize (used by audit-extending modes).

## Examples

Example outputs or patterns to follow.

## Plan Phase

Instructions specific to the planning phase (loop integration).

## Code Phase

Instructions specific to the coding phase (loop integration).

## Review Phase

Instructions specific to the review phase (loop integration).
```

## Extends Chain

Modes can extend other modes:
- `extends: plan` - Inherit plan mode lifecycle (read-only, plan file, org items)
- `extends: audit` - Inherit audit lifecycle (pending/active/escalate)
- `extends: my-other-mode` - Inherit from user-defined mode

Child overrides parent:
- Scalars: child wins
- Arrays: child replaces
- Objects: deep merge
- Body sections: concatenated (parent then child)

## Discovery

Modes are discovered from:
1. `.spell/modes/<name>/MODE.md` (project level, highest priority)
2. `~/.spell/agent/modes/<name>/MODE.md` (user level)

Project modes override user modes with the same name.

## Settings Migration

If you have existing `planMode.allowedFolders` in settings.json, those still work alongside mode configs. Mode configs provide additional customization on top of existing settings.

To migrate SYSTEM.md customizations to a chat mode:
1. Create `.spell/modes/chat/MODE.md`
2. Move SYSTEM.md content to `## Context` and `## Instructions` sections
3. The mode context is injected into the system prompt when active
