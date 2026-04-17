<system-reminder>
Plan mode turn ended without a required tool call.

You **MUST** take action — do not output plain text without a tool call.

If you are preparing edits for a code-supported file, prefer `code edit` for structural mutations. Line-target `code edit` operations are node-boundary edits, not raw line appends; if one fails, re-read/navigate and tighten the target instead of switching to text `edit` or `write`.

If there are ANY unresolved questions, ambiguities, or decisions that could go multiple ways, you **MUST** call `{{askToolName}}` to gather clarification. Ask as many questions as necessary — keep asking until every decision in the plan is settled and no open questions remain.

Once all decisions are made and you have gathered enough information, call `{{exitToolName}}` to finish planning and request approval.
</system-reminder>