# URI Dialect

Applies to every `scheme://` locator. The URI dialect does not own a file extension; it is selected by the kernel when the Locator carries a scheme prefix. Resolution is two-phase: first the URI dialect resolves the locator to a `NodeRef`, then the `::Query` suffix delegates to a downstream dialect determined by the resolved resource type and the scheme's registration.

---

## A · NamePayload shape

```rust
pub struct UriLocator {
    pub scheme: UriScheme,
    pub path:   SmolStr,          // raw path after "://", uninterpreted by kernel
}

pub enum UriScheme {
    Artifact,
    Memory,
    Skill,
    Agent,
    Jobs,
    Local,
    Pi,
}

pub trait UriDialect: Send + Sync {
    fn resolve(&self, uri_path: &str) -> Result<NodeRef, Diagnostic>;
    fn delegate_dialect(&self, node: &NodeRef) -> &dyn LanguageDialect;
}
```

### Composition rules

```
artifact://session/agent/tool/N.ext       stored artifact handle
memory://root[/path]                      memory tree file
skill://name[/path]                       skill file or subdirectory
agent://id[/jq-path]                      agent JSON output
jobs://job-id                             job state document
local://filename.md                       completed plan artifact
pi://path                                 internal Spell documentation
```

Scheme parsing is prefix-driven: the kernel detects `foo://` and routes to the URI dialect. A bare `foo:bar` (no `//`) is **not** a URI; it is treated as an FS path and stays in the FS dialect. Backtick-quoted URIs in code-axis contexts are literal text and are not parsed as locators.

After URI resolution, structural queries delegate to the appropriate downstream dialect:

| Scheme        | Resolves to                    | Downstream dialect on `::Query`                |
|---------------|--------------------------------|------------------------------------------------|
| `artifact://` | Stored artifact bytes/text     | Text or Markdown (by extension)                |
| `memory://`   | Memory tree files              | Markdown / Org                                 |
| `skill://`    | Skill files                    | FS for arbitrary files; MD for `SKILL.md`      |
| `agent://`    | Agent JSON output              | JSON sub-dialect                               |
| `jobs://`     | Job state document             | Job sub-dialect                                |
| `local://`    | Plan artifact dir              | FS, then resolved file's dialect               |
| `pi://`       | Internal Spell docs            | FS, then code dialect for supported files      |

---

## B · Registries

The URI dialect does not expose traditional qualifiers, anchors, or edges at the top level; those belong to the downstream dialect selected after resolution. Instead, the registry is organised per scheme.

### `artifact://`

```
artifact://<session-id>/<agent>/<tool>/<N>.<ext>
```

- Resolves to an underlying file path, then delegates through the FS dialect and finally the text dialect.
- Node kinds: `§artifact` (root), then downstream kinds after delegation.
- Diagnostics: `ArtifactNotFound` (session expired, tool never emitted, or N out of range).
- Auth/permission: stale artifact handle surfaces a diagnostic; never crashes the resolver.

### `memory://`

```
memory://root[/path]
```

- `memory://root` resolves to `memory_summary.md`.
- `memory://root/skills/<name>/SKILL.md` resolves to the skill file.
- Structural queries delegate to Markdown or Org dialect.
- Diagnostics: `MemoryPathNotFound`.

### `skill://`

```
skill://<name>[/path]
```

- `skill://canvas` resolves to `SKILL.md` content via the Markdown dialect.
- `skill://canvas/scripts/init.py` resolves to the direct file via the FS dialect.
- Diagnostics: `SkillNotFound`.

### `agent://`

```
agent://<id>[/.jq-path]
```

- JSON sub-dialect for field extraction.
- Node kinds: `§object`, `§array`, `§field`, `§array-elem`, `§string`, `§number`, `§bool`, `§null`.
- Field axis: `:prop-name` acts as JSON property accessor.
- Predicate: `[N]` acts as array index.
- jq-style path `agent://id/.foo.bar[0]` reuses kernel combinators (`/`) and predicates (`[0]`).
- Leaf values carry `Content::Text`.
- Diagnostics: `AgentNotFound`.

### `jobs://`

```
jobs://<job-id>
```

- Job sub-dialect for job state documents.
- Node kinds: `§job` (root), `§status`, `§stdout`, `§stderr`, `§result`, `§error`, `§duration_ms`, `§started_at`, `§ended_at`.
- Each child resolves to a typed slot.
- Can chain: `§stdout/§line[last]` for the last line of stdout.
- Diagnostics: `JobNotFound`.

### `local://`

```
local://<filename>.md
```

- Completed plan artifacts live in `!tasks/plans/plan-artifacts/`.
- Delegates to the FS dialect, then Markdown for content.
- Diagnostics: suffix-fallback diagnostic if the file is not found.

### `pi://`

```
pi://<path>
```

- Internal Spell docs rooted in the `pi` tree.
- Delegates to the FS dialect, then to the code dialect for supported file extensions.
- Diagnostics: `PiPathNotFound`.

### Cross-cutting

- `UnknownLocatorScheme` diagnostic emitted when the prefix is not in the scheme table; the diagnostic carries an `available-schemes` hint.
- Backtick-quoted URIs in code-axis context are literal text, not parsed as locators.
- Stale artifact handles and permission failures surface diagnostics; they never crash the resolver.

---

## C · Worked examples

```
artifact://abc/main/bash/1.txt :: #raw
artifact://abc/main/bash/1.txt :: §line[10..50]
artifact://abc/main/bash/1.txt :: §line[text~="error"]

memory://root :: //§heading[text~="recall"]#body
memory://root/skills/canvas/SKILL.md :: §heading "Examples"#body

skill://canvas :: #raw
skill://canvas/scripts/init.py :: §line[1..20]

agent://xyz :: #raw
agent://xyz/.findings
agent://xyz/.findings.results[0].severity

jobs://j-123 :: §stdout/§line[last]

local://MY_PLAN.md :: #raw
local://MY_PLAN.md :: //§heading[text~="Verification"]

pi://docs/index.md :: #raw
pi://docs/architecture/* :: #listing
```

---

## D · Edge cases

```
D-1  Scheme parsing boundary: `foo://` is a URI locator; `foo:bar`
     (no `//`) is treated as an FS path and stays in the FS dialect.

D-2  Raw delivery: every scheme supports `:: #raw` as the trivial
     query, returning the resolved resource as opaque text.

D-3  Structural query delegation: after URI resolution, `§line`,
     `§chunk`, `§para`, and other structural axes are served by the
     downstream dialect, not the URI dialect itself.

D-4  Slice via combinator: `artifact://… :: §line[10..50]` delegates
     the line-axis to the text dialect; the URI dialect only supplies
     the initial file handle.

D-5  Auth/stale handles: an `artifact://` handle whose session has
     expired or whose artifact was garbage-collected surfaces an
     `ArtifactNotFound` diagnostic; the resolver never panics.

D-6  JSON jq path disambiguation: in `agent://` queries, numeric
     indices are predicates `[N]`; field access is the `:field` axis.
     `agent://id/.foo.bar[0]` is parsed as `:foo / :bar [0]`.

D-7  Job state slot independence: each slot under `§job` is resolvable
     independently. `§stdout` and `§stderr` delegate to the text
     dialect for line-level queries.

D-8  Memory relative paths: `memory://root/skills/…` resolves through
     the memory tree; a missing intermediate directory surfaces
     `MemoryPathNotFound` with the attempted absolute path.

D-9  Skill file vs skill directory: `skill://canvas` resolves to
     `SKILL.md`; `skill://canvas/scripts/init.py` resolves to the
     direct file. The resolver must not conflate the two.

D-10 Local fallback: if `local://MY_PLAN.md` does not exist, the
     resolver emits a suffix-fallback diagnostic suggesting the
     closest matching plan artifact.
```

---

## E · Test suite

```rust
mod tests_uri_dialect {
    // --- artifact:// (T1–T4)
    #[test] fn artifact_raw_returns_opaque_text() {}
    #[test] fn artifact_structural_delegates_to_text_dialect() {}
    #[test] fn artifact_regex_slice_matches_line_content() {}
    #[test] fn artifact_not_found_diagnostic_with_hint() {}

    // --- memory:// (T5–T8)
    #[test] fn memory_raw_returns_memory_summary() {}
    #[test] fn memory_structural_delegates_to_markdown() {}
    #[test] fn memory_relative_file_resolves_to_skill_md() {}
    #[test] fn memory_path_not_found_diagnostic() {}

    // --- skill:// (T9–T12)
    #[test] fn skill_raw_returns_skill_md_content() {}
    #[test] fn skill_structural_delegates_to_markdown() {}
    #[test] fn skill_relative_file_resolves_via_fs() {}
    #[test] fn skill_not_found_diagnostic() {}

    // --- agent:// (T13–T16)
    #[test] fn agent_raw_returns_json_string() {}
    #[test] fn agent_field_path_resolves_property() {}
    #[test] fn agent_jq_path_combinator_and_predicate() {}
    #[test] fn agent_not_found_diagnostic() {}

    // --- jobs:// (T17–T20)
    #[test] fn jobs_raw_returns_full_state_document() {}
    #[test] fn jobs_status_field_resolves_typed_slot() {}
    #[test] fn jobs_stdout_last_line_via_text_delegation() {}
    #[test] fn jobs_not_found_diagnostic() {}

    // --- local:// (T21–T24)
    #[test] fn local_raw_returns_plan_artifact_text() {}
    #[test] fn local_structural_delegates_to_markdown() {}
    #[test] fn local_text_slice_line_range() {}
    #[test] fn local_not_found_suffix_fallback_diagnostic() {}

    // --- pi:// (T25–T28)
    #[test] fn pi_raw_returns_internal_doc_text() {}
    #[test] fn pi_listing_glob_resolves_directory() {}
    #[test] fn pi_structural_delegates_to_code_dialect() {}
    #[test] fn pi_path_not_found_diagnostic() {}

    // --- Cross-cutting (T29–T32)
    #[test] fn unknown_scheme_diagnostic_with_available_schemes_hint() {}
    #[test] fn colon_only_path_treated_as_fs_not_uri() {}
    #[test] fn backtick_quoted_uri_not_parsed_as_locator() {}
    #[test] fn stale_artifact_handle_surfaces_diagnostic_not_panic() {}
}
```

Minimum corpus sizes: 50 round-trip URI strings, 30 resolver triples (one per scheme), 14 negative cases (two per scheme), all 8 cross-cutting tests.

Semantic follow-ups available here:
- `code symbols { file }` lists file-local symbols via outline machinery.
- `code symbols { query }` looks up workspace symbols via the native graph.
- `code symbols` with neither file nor query returns a concise workspace summary with refinement hints.
- If both `file` and `query` are present, file mode wins.
- `code context { symbol }` and `code impact { symbol }` explain cross-file connections once a symbol is known.

Markdown-specific code operations:
- Section headings are declarations: `symbol: "Installation"` targets that section.
- Nested sections use dotted symbols: `symbol: "Installation.Prerequisites"`.
- `operation: "promote"` shifts a section subtree up one heading level.
- `operation: "demote"` shifts a section subtree down one heading level.
- `operation: "replace-code-block"` replaces a fenced code block within a section by `index` or `language`.
- `operation: "replace-body"` replaces section content while keeping the heading.
- `read` at resolution 2 shows section content summaries and drill-in hints.


---

## F · Implementation notes

### `jobs://` fragment slots

The `jobs://<job-id>` root resolves to a `§job` summary node. Individual
slots are addressable via the fragment:

| Fragment    | Node kind  | Source file (relative to `.spell/jobs/<id>/`) |
|-------------|------------|-----------------------------------------------|
| (none)      | `§job`     | Summary assembled from `status.txt` + `result.txt` + `error.txt` |
| `#status`   | `§status`  | `status.txt`                                  |
| `#result`   | `§result`  | `result.txt`                                  |
| `#error`    | `§error`   | `error.txt`                                   |
| `#stderr`   | `§stderr`  | `stderr.log` (empty string if absent)         |
| `#progress` | `§progress`| `progress.txt`                                |

If the job directory does not exist, the resolver emits `JobNotFound`.
If the directory exists but a requested slot file is missing, the
resolver returns an empty text node (zombie-state tolerance).

### `mcp://` — not implemented

The `mcp://` scheme is **not implemented** in the current release.
Attempting to resolve an `mcp://` locator returns a
`SchemeNotImplemented` diagnostic with the message
`"mcp:// scheme not implemented in current release; use direct paths"`.

Rationale: MCP runtime integration requires an out-of-process server
registry and capability-negotiation protocol that is not yet wired into
the CodePath kernel. When MCP support lands, the handler will be swapped
in without changing the scheme registry shape.
