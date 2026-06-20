# spell_agent — Agent Notes

Node-free coding agent on the BEAM. See `README.md` for architecture and
`docs/` for the freeform-TUI design + philosophy.

# Principles

## Homoiconic dissolution

The defining bet of this codebase: **tools, keybindings, and (soon) the TUI
layout are all PTC-Lisp values** — code-as-data in the one language the agent
writes. When the things a system is made of are the same stuff as the mind using
it, boundaries that look fundamental turn out to be accidents of representation.

> **Every layer dissolves a boundary that currently looks fundamental.**

Each capability we add takes a distinction that feels like a law of how software
works and shows it was only ever a consequence of state trapped in the wrong
shape. Free the representation (make it homoiconic data) and the wall was drawn in
chalk:

| boundary | dissolved by | why it wasn't a law |
|---|---|---|
| interface vs. its state | layout tree (tags-on-tree) | state was in a side-struct |
| output vs. workspace | agent renders for itself | output couldn't be read back |
| present vs. history | layouts as history spans | the past wasn't stored as values |
| taught vs. learned | self-distilled prelude idioms | knowledge flowed one way |
| looking vs. acting | reactive data-dependencies | effects were welded to display |
| mine vs. ours | shared tree, per-mind gaze | gaze and artifact were one object |

Full derivation: `docs/freeform-tui-philosophy.md`. Tracking: `PLAN-009`
(ground + folded recording seam), `PROJ-001..005` (research-track layers).

### Working consequences

- **Reach for data, not code.** A new tool, keybinding, view, or query should be
  a PTC value the agent can author at runtime — not a compiled Elixir special
  case. The compiled layer materializes and validates; PTC transforms and
  policies live as data. ("Elixir materializes, PTC transforms" — see
  `lib/spell_agent/hist/lens.ex`.)
- **No drift: reflect, don't hand-list.** Surfaces derived from external shape
  (widgets, theme slots, struct fields) are built by reflection so upstream
  changes propagate automatically. Hand-maintained mirrors rot.
- **One source of truth per concern.** If two things must stay in sync, they are
  one thing wearing two shapes — collapse them (the gaze/layout unification is the
  archetype: navigation re-tags the render tree; there is nothing to sync).
- **Never brick the surface.** Agent-authored data is untrusted *for correctness*:
  every live-data path has a failure ladder (last-good → native default → surfaced
  error). The screen, the loop, and the store degrade; they never crash.
- **Security is secondary while experimenting — but never invisible.** We are the
  only users; move fast. Every specific security concern (atom-table growth,
  effects-in-render, write-attach) is filed as an FUP the moment it's noticed, so
  imagination is never gated and hardening is never forgotten.
