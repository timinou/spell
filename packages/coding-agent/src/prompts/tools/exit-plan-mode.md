Signals plan completion, requests user approval, and provides the final plan title for handoff.

<conditions>
Use when the plan is already an org item, requirements are settled, and the user is ready to review.
</conditions>

<instruction>
- Create the plan as an org item before calling this tool
- Provide `title` as the final plan name in SCREAMING_SNAKE_CASE
- Provide `itemId` as the PLAN item CUSTOM_ID
- Call `org validate-plan <itemId>` first; resolve all issues before invoking this tool
- PLAN body must include child references via `[[id:…]]` links
</instruction>

<output>
Presents the plan for approval; if approved, plan mode exits and the approved plan is available at `local://<title>.md`.
</output>

<avoid>
- Do not call before creating the PLAN org item
- Do not omit `title` or `itemId`
- Do not call more than once per plan; the first successful call closes plan mode and a second call is a no-op
- Do not use `ask` to request approval
- Do not call after pure research tasks
</avoid>

<critical>
Use only when planning implementation steps.
</critical>