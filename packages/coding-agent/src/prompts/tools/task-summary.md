<task-summary>
<header>{{successCount}}/{{totalCount}} outcomes{{#if outcomeBreakdown}} {{outcomeBreakdown}}{{/if}} [{{duration}}]</header>

{{#each summaries}}
<agent id="{{id}}" agent="{{agent}}" outcome="{{outcome}}">
<status>{{status}}</status>
{{#if meta}}<meta lines="{{meta.lineCount}}" size="{{meta.charSize}}" />{{/if}}
{{#if spawnAudit}}<spawn-audit requested="{{spawnAudit.requestedAgent}}" policy="{{spawnAudit.parentSpawnPolicy}}" granted="{{spawnAudit.granted}}"{{#if spawnAudit.reason}} reason="{{spawnAudit.reason}}"{{/if}} />{{/if}}
{{#if structuredInline}}<structured>
{{structuredInline}}
</structured>
{{/if}}<structured-ref>{{resultUri}}</structured-ref>
{{#if preview}}<preview>
{{preview}}
</preview>
{{/if}}{{#if hasChildren}}<children count="{{children.length}}">
{{#each children}}
  <child id="{{id}}" outcome="{{outcome}}" uri="{{resultUri}}" />
{{/each}}
</children>
{{/if}}</agent>
{{#unless @last}}
---
{{/unless}}
{{/each}}

{{#if mergeSummary}}
<merge-summary>
{{mergeSummary}}
</merge-summary>
{{/if}}
</task-summary>