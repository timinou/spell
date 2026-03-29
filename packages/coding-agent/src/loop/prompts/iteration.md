# Loop Iteration

Loop: {{name}} ({{loopId}})
Iteration: {{iteration}}
State: {{state}}

{{#if taskContent}}
## Task
{{taskContent}}
{{/if}}

{{#ifAny changedFiles openFindings pendingGates}}
## Current Context
{{#if changedFiles.length}}
Changed files:
{{#list changedFiles prefix="- " join="\n"}}{{this}}{{/list}}
{{/if}}
{{#if openFindings.length}}
Open findings:
{{#list openFindings prefix="- " join="\n"}}{{this}}{{/list}}
{{/if}}
{{#if pendingGates.length}}
Pending gates:
{{#list pendingGates prefix="- " join="\n"}}{{this}}{{/list}}
{{/if}}
{{/ifAny}}

Work the next iteration and update loop state truthfully.

{{#if manifestTickets}}

## Manifest Status

Progress: {{manifestProgress}}

### Ready Tickets
{{#each readyTickets}}
- `{{this}}`
{{/each}}
{{#unless readyTickets}}No tickets ready (check dependencies).{{/unless}}

### Active Tickets
{{#each activeTickets}}
- `{{this}}`
{{/each}}
{{#unless activeTickets}}No tickets currently active.{{/unless}}

### All Tickets
| ID | Title | State | Priority | Dependencies |
|---|---|---|---|---|
{{#each manifestTickets}}
| `{{id}}` | {{title}} | {{state}} | {{priority}} | {{#each dependencies}}`{{this}}` {{/each}} |
{{/each}}

Select tickets to work on based on:
1. Dependency order (work on items whose dependencies are DONE)
2. Priority (#A before #B before #C)
3. Effort (prefer smaller tickets early for momentum)

Use `loop_done` with `completedTickets` to report which tickets you completed this iteration.
{{/if}}