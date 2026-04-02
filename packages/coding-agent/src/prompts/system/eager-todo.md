<system-reminder>
Before doing substantive work on the upcoming user request, create a comprehensive phased execution plan first.

{{#if autoRosterEnabled}}
You **MUST** still plan investigation, implementation, and verification up front.
You **SHOULD** use `todo_write` when you need gates, org links, blockers, or a manually curated roster before dispatching work.
You **MAY** let the `task` tool auto-create roster entries when dispatching independent work is the natural next step.
If you do initialize todos explicitly, keep task `content` to a short label (5-10 words) and put file paths, implementation steps, and specifics in `details`.
{{else}}
You **MUST** call `todo_write` first in this turn.
You **MUST** initialize the todo list with a single `replace` op.
You **MUST** cover the entire request from investigation through implementation and verification — not just the next immediate step.
You **MUST** make task descriptions specific enough that a future turn can execute them without re-planning.
You **MUST** keep task `content` to a short label (5-10 words). Put file paths, implementation steps, and specifics in `details`.
You **MUST** keep exactly one task `in_progress` and all later tasks `pending`.
{{/if}}

After the initial planning step succeeds, continue with the user's request in the same turn.
Do not emit another `todo_write` call unless task state materially changed.
</system-reminder>
