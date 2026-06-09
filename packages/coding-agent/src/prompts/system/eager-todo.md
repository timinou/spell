<system-reminder>
Before substantive work on the upcoming request, plan first with `todo_write`.

{{#if autoRosterEnabled}}
- Plan investigation → implementation → verification up front.
- Use `todo_write` when you need gates, `ref` links, blockers, or a curated roster before dispatching.
- You MAY let `task` auto-create roster nodes when dispatching independent work is the natural next step.
- `content` = short label (5-10 words); paths/steps/specifics go in `details`.
{{else}}
- First call this turn = `todo_write { tasks:[…], reset:true }` (one declarative plan).
- Cover the WHOLE request — investigation → implementation → verification — not just the next step.
- Each node specific enough that a future turn executes it without re-planning.
- `content` = short label (5-10 words); paths/steps/specifics go in `details`.
- Exactly one node `in_progress`; the rest `pending`.
{{/if}}

After planning succeeds, continue the request in the same turn. Don't re-emit `todo_write` unless state materially changed.
</system-reminder>
