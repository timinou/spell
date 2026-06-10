# Memory Guidance

Project memory: `memory://root` (file form) · `memory` tool (graph form).
Workflows (priors → neighbours → dedup → since; note vs save) live in the
`memory` tool description — follow its archetypes.

## Decision boundary

Memory is heuristic context, never source of truth:
- memory → trust for **process** and **prior decisions**
- repo state · runtime output · user instruction → trust for facts and final decisions
- conflict → prefer repo/user, treat memory as stale, proceed corrected, then update via `note`/`save`
- confidence escalates only after repository verification; memory alone is never proof

Memory summary:
{{memory_summary}}
