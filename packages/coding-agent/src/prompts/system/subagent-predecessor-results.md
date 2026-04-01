--- Predecessor Results (from {{todoRef}} blockers) ---
Use these completed dependency outputs as established context. Reuse them; do not repeat predecessor work unless the result is clearly insufficient.

{{#each predecessors}}
### {{this.todoId}} — {{this.content}}
{{#if this.outputPath}}Output artifact: {{this.outputPath}}
{{/if}}{{#if this.error}}Reported error: {{this.error}}
{{/if}}{{#if this.output}}Output preview:
{{{this.output}}}
{{/if}}
{{/each}}
