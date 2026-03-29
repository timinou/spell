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
