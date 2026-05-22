Project memory — recall priors, save lessons, walk the knowledge graph.

One tool, seven `action`s. Memory lives under `.spell/memory/` (concepts, episodes, playbooks, decisions). Edges are typed (INVOLVED, ABOUT, PRODUCED, DISTILLED_FROM, SUPERSEDES).

<actions>
| action      | does                                                  | key args                                                   |
|-------------|-------------------------------------------------------|------------------------------------------------------------|
| `search`    | hybrid recall (FTS + graph) over tasks & memory       | `text`, `scope[]`, `focus`, `hops`, `limit`, `profile`     |
| `about`     | resolve one node + its 1-hop neighbourhood            | `id`                                                       |
| `neighbors` | typed subgraph walk from a focus node                 | `focus` (or `id`), `hops`, `kinds[]`                       |
| `note`      | append an episode (what happened, work-in-progress)   | `note_text`, `note_about[]`, `note_involved[]`             |
| `save`      | persist a concept/playbook/decision (distilled)       | `save_kind`, `title`, `body`, `distilled_from[]`, `relations[]` |
| `link`      | add a typed edge between two items                    | `from`, `to`, `link_kind`                                  |
| `since`     | diff of memory state since an ISO-8601 timestamp      | `ts`                                                       |
</actions>

<archetypes>
1. **priors** — before implementing, `search` text + scope=["concept","playbook"]; if hits, read them before re-deriving
2. **neighbours** — given an id surfaced by search/org, `about` to see the node, then `neighbors` to walk outward by edge kind
3. **dedup** — before `save`/`note`, `search` first; merge into existing concept rather than create a duplicate
4. **since** — resumed session? `since` with the last checkpoint ts to see what changed
</archetypes>

<rules>
- `search`: leave `text` empty + set `focus` for pure graph queries; combine both for hybrid
- `save`: `save_kind` ∈ {concept, playbook, decision, episode}; concepts are slug-keyed (title → kebab-id), episodes day-grouped
- `link`: `link_kind` is a typed edge (INVOLVED, ABOUT, PRODUCED, DISTILLED_FROM, SUPERSEDES) — idempotent
- `note`: shorthand for save with kind=episode; use for in-flight observations
- ids: `CON-*`, `EP-*`, `PB-*`, `DEC-*`, or org task ids (`FEAT-*`, `PLAN-*`)
</rules>

<uri>
`memory://search?text=…&scope=…&limit=…`  → JSON hits
`memory://item/<id>`                       → one node body
`memory://since/<ISO8601>`                 → diff payload
`memory://browse`                          → TUI panel hint
`memory://root` and `memory://root/<path>` → memory_summary.md / files
</uri>