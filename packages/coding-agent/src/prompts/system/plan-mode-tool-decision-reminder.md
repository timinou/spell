<system-reminder>
Plan mode turn ended without a required tool call.

You **MUST** take action — do not output plain text without a tool call.

If there are ANY unresolved questions, ambiguities, or decisions that could go multiple ways, you **MUST** call `{{askToolName}}` to gather clarification. Ask as many questions as necessary — keep asking until every decision in the plan is settled and no open questions remain.

Once all decisions are made and you have gathered enough information, call `{{exitToolName}}` to finish planning and request approval.
</system-reminder>