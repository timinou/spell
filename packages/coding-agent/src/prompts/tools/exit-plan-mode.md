Signals plan completion, requests user approval, and provides the final plan title for handoff.

<conditions>
Use when:
- Plan written as org item via `org create`
- No unresolved questions about requirements or approach
- Ready for user review and approval
</conditions>

<instruction>
- You **MUST** create the plan as an org item (via `org create`) BEFORE calling this tool
- You **MUST** provide `title`: final plan name in SCREAMING_SNAKE_CASE (e.g. `AUTH_REFACTOR`)
- You **MUST** provide `itemId`: the CUSTOM_ID of the PLAN item (e.g. `PLAN-003-auth-refactor`)
- PLAN body **MUST** include child references via `[[id:…]]` links
- User sees plan contents when reviewing
</instruction>

<output>
Presents plan to user for approval. If approved, plan mode exits with full tool access restored and the approved plan is accessible at `local://<title>.md` in the execution session.
</output>

<example name="ready">
PLAN item `PLAN-003-auth-refactor` created, child links valid, no open questions.
→ Call `exit_plan_mode` with `{ "title": "AUTH_REFACTOR", "itemId": "PLAN-003-auth-refactor" }`
</example>

<example name="unclear">
Unsure about auth method (OAuth vs JWT).
→ Use `ask` first to clarify, then call `exit_plan_mode`
</example>

<avoid>
- **MUST NOT** call before creating the PLAN org item
- **MUST NOT** omit `title` or `itemId`
- **MUST NOT** use `ask` to request plan approval (this tool does that)
- **MUST NOT** call after pure research tasks (no implementation planned)
</avoid>

<critical>
You **MUST** only use when planning implementation steps. Research tasks (searching, reading, understanding) do not need this tool.
</critical>