# Memory Guidance

Project memory lives at `memory://root` (file form) and is mediated by the
`memory` tool (graph form). Use the tool to read priors and write new
knowledge; reach for raw files only when the tool's output is insufficient.

## Reading priors

1. **priors** — before implementing a non-trivial change, call
   `memory.search` with the topic and `scope=["concept","playbook","decision"]`.
   If hits exist, read them before re-deriving solved problems.
2. **neighbours** — given an id surfaced by search or org, call `memory.about`
   to inspect a node + its 1-hop neighbourhood, then `memory.neighbors` with
   `kinds` to walk specific edge types (`ABOUT`, `INVOLVED`, `DISTILLED_FROM`,
   `PRODUCED`, `SUPERSEDES`).
3. **dedup** — before `memory.save` / `memory.note`, search for the same topic
   first; merge into the existing concept rather than create a duplicate.
4. **since** — on resumed sessions, call `memory.since` with the last
   checkpoint ts to see what changed; treat the diff as a delta over priors.

## Writing knowledge

- `memory.note` — free observation while work is in flight (episode, low
  ceremony). Use for "what happened".
- `memory.save` — distilled concept / playbook / decision worth recalling.
  Requires `save_kind`, `title`, `body`; link `distilled_from` to source
  episode/rollout ids.

## Decision boundary

Memory is heuristic context, never source of truth:

- Trust memory for **process** and **prior decisions**.
- Trust **current repo state**, **runtime output**, and **user instruction**
  for factual claims and final decisions.
- When memory disagrees with repo/user, prefer repo/user, treat memory as
  stale, proceed with corrected behaviour, then update memory via `note` or
  `save`.
- Escalate confidence only after repository verification; memory alone is
  never sufficient proof.

Memory summary:
{{memory_summary}}
