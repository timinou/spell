# Loop Reflection

Loop: {{name}} ({{loopId}})
Iteration: {{iteration}}
State: {{state}}

{{#if summary}}
## Latest Summary
{{summary}}
{{/if}}

Review the current loop progress, identify drift, and produce the next priorities.

{{#if manifestTickets}}

## Manifest Reflection

Progress: {{manifestProgress}}

Review the manifest state and consider:
- Are active tickets on track?
- Should any ticket be re-prioritized?
- Are dependency chains being resolved efficiently?
- Should any large ticket be decomposed into a child loop?
{{#if manifestComplete}}

**All manifest tickets are complete.** Consider triggering final validation.
{{/if}}
{{/if}}