Signals plan completion, requests user approval, and provides the final plan title for handoff.

<conditions>
Use when:
- Plan written as org item via `org create` (itemId required)
- No unresolved questions about requirements or approach
- Ready for user review and approval
</conditions>

<instruction>
- You **MUST** create the plan as an org item (via `org create`) BEFORE calling this tool
- You **MUST** provide `title`: final plan name in SCREAMING_SNAKE_CASE (e.g. `AUTH_REFACTOR`)
- You **MUST** provide `itemId`: the CUSTOM_ID returned from `org create` (e.g. `DRAFT-003-auth-refactor`)
- User sees plan contents when reviewing
</instruction>

<output>
Presents plan to user for approval. If approved, plan mode exits with full tool access restored and the approved plan is accessible at `local://<title>.md` in the execution session.
</output>

<example name="ready">
Plan item DRAFT-003-auth-refactor created, no open questions.
→ Call `exit_plan_mode` with `{ "title": "AUTH_REFACTOR", "itemId": "DRAFT-003-auth-refactor" }`
</example>

<example name="unclear">
Unsure about auth method (OAuth vs JWT).
→ Use `ask` first to clarify, then call `exit_plan_mode`
</example>

<avoid>
- **MUST NOT** call before creating the plan org item
- **MUST NOT** omit `title` or `itemId`
- **MUST NOT** use `ask` to request plan approval (this tool does that)
- **MUST NOT** call after pure research tasks (no implementation planned)
</avoid>

<critical>
You **MUST** only use when planning implementation steps. Research tasks (searching, reading, understanding) do not need this tool.
</critical>