---kdl
name {{jsonStringify name}}
description {{jsonStringify description}}
{{#if tools}}tools{{#each tools}} {{jsonStringify this}}{{/each}}
{{/if}}{{#if spawns}}spawns {{jsonStringify spawns}}
{{/if}}{{#if model}}model {{jsonStringify model}}
{{/if}}{{#if thinkingLevel}}thinking-level {{jsonStringify thinkingLevel}}
{{/if}}{{#if blocking}}blocking
{{/if}}{{#if scopeRestricted}}scope-restricted #true
{{/if}}{{#when roster "===" false}}roster #false
{{/when}}---
{{body}}