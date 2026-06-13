Project memory — recall priors, save lessons, walk the knowledge graph.

One tool, seven `action`s. Memory lives under `.spell/memory/` (concepts, episodes, playbooks, decisions). Edges are typed (INVOLVED, ABOUT, PRODUCED, DISTILLED_FROM, SUPERSEDES, …).

<actions>
|action|does|key args|
|---|---|---|
|`search`|hybrid recall (FTS + graph) over tasks & memory|`text`, `scope[]`, `focus`, `hops`, `limit`, `profile`, `include_personal`, `scope_personal_only`|
|`about`|one node + its 1-hop neighbours, with distillation lineage|`id` → `{node, neighbors[], lineage[]}`|
|`neighbors`|typed subgraph walk from a focus node|`focus` (or `id`), `hops`, `kinds[]` → `{nodes, edges}`|
|`note`|append an episode (what happened, work-in-progress)|`text`, `about[]`, `involved[]`|
|`save`|persist a concept/playbook/decision (distilled)|`kind`, `title`, `body`, `distilled_from[]`, `relations[]`|
|`link`|add a typed edge between two items|`from`, `to`, `kind`|
|`since`|diff of memory state since a timestamp (ISO-8601 or epoch-ms)|`ts`|
</actions>

<archetypes>
1. **priors** — before implementing, `search` text + scope=["concept","playbook"]; if hits, read them before re-deriving
2. **neighbours** — given an id surfaced by search/org, `about` to see the node + its 1-hop attached set, then `neighbors` to walk further by edge `kinds[]`
3. **dedup** — before `save`/`note`, `search` first; merge into an existing concept rather than create a duplicate
4. **since** — resumed session? `since` with the last checkpoint ts to see what changed
5. **commit** — finished a task with a non-obvious lesson? `save` a concept or playbook, then `link` it to the source episode/task with `kind=DISTILLED_FROM`
</archetypes>

<rules>
- `search`: leave `text` empty + set `focus` for pure graph queries; combine both for hybrid. Code symbols / paths / error strings → use **find** / **lsp** / **bash**, not memory.
- `save`: `kind` ∈ {concept, playbook, decision, episode}; concepts/playbooks/decisions are slug-keyed (title → kebab-id), episodes day-grouped
- `link`: `kind` is a canonical edge token (INVOLVED, ABOUT, PRODUCED, DISTILLED_FROM, SUPERSEDES, MENTIONS, DERIVED_FROM, BLOCKS, …) — idempotent
- `note`: shorthand for save with kind=episode; use for in-flight observations (no explicit title needed)
- `include_personal` defaults to false; set true to union with your cross-repo personal store (W9+). `scope_personal_only` narrows to personal-only.
- ids: `CON-*`, `EP-*`, `PB-*`, `DEC-*`, or org task ids (`FEAT-*`, `PLAN-*`)
</rules>

<uri>
`memory://search?text=…&scope=…&limit=…&include_personal=true`  → JSON hits
`memory://item/<id>`                                              → `{node, neighbors[], lineage[]}`
`memory://since/<ISO8601>`                                        → diff payload
`memory://browse`                                                 → TUI panel hint
`memory://root` and `memory://root/<path>`                        → memory_summary.md / files
</uri>