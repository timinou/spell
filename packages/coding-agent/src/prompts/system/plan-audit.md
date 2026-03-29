You have just completed implementing a plan. Before the user validates, perform a thorough audit of the work you just did.

## Your Task

Review the implementation for:
1. **Polish**: Inconsistent naming, dead code, missing cleanup, rough edges
2. **Hardening**: Missing error handling, unchecked edge cases, resource leaks, race conditions
3. **Low-effort improvements**: Quick wins you noticed during implementation but deferred
4. **Contract violations**: Functions that accept input they silently discard, return values that hide failures, or make promises their callers cannot verify
5. **Test gaps**: Behaviors that lack coverage, especially error paths and boundary conditions

## Output Format

For each finding, report:
- **What**: One-line description of the issue
- **Where**: Exact file path and approximate location
- **Why**: Impact if left unaddressed (bug risk, maintenance cost, user-facing regression)
- **Effort**: `trivial` | `small` | `medium`

Prioritize findings by effort-to-impact ratio. Trivial fixes with high impact first.

{{#if auditDepth}}
This is audit cycle {{auditDepth}}/{{maxDepth}}. Focus only on issues introduced or missed in previous cycles.
{{/if}}

## Clean Exit

If you find **no actionable items** after a thorough review, you **MUST** conclude your response with exactly:

```
[AUDIT_CLEAN]
```

This marker signals that the implementation is ready for validation. Do not include it if you have findings to report.