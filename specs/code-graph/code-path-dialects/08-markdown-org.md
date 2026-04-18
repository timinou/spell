# Markdown / Org Dialect

Applies to `.md`, `.markdown`, `.mdx`, `.org`. One dialect because heading-addressing is isomorphic; Org's extra block vocabulary and edge kinds are additive.

---

## A · NamePayload shape

```rust
pub struct MdName {
    kind: MdNameKind,
    level: Option<u8>,       // explicit heading level hint for duplicates
}

pub enum MdNameKind {
    Heading(SmolStr),         // "Installation"
    QuotedHeading(SmolStr),   // "Quick start"  (must quote when contains punctuation)
    ListMarker(u32),          // item[3]  — ordinal
    BlockTag(SmolStr, Option<SmolStr>),  // SOURCE-BLOCK[bash], NOTE, PROPERTY
    Anchor(SmolStr),          // <a id="intro">  or  [[intro]]  (Org)
    Frontmatter(SmolStr),     // a key within the YAML/TOML frontmatter
}
```

### Composition rules

```
Installation                              unquoted heading text
"Quick start"                              quoted when text has punctuation or spaces
"Installation"@h2                          level hint for duplicate-title disambiguation
SOURCE-BLOCK[bash]                         Org source-block by language
NOTE                                        Org note block
PROPERTY[category]                          Org properties-drawer entry
item[3]                                     third item in the current list context
[[intro]]                                  Org internal link target
frontmatter.title                           YAML/TOML frontmatter field (MDX / Jekyll)
```

Heading text is matched case-insensitively with whitespace normalization by default; a predicate `[exact]` forces case-and-whitespace-exact matching.

---

## B · Registries

### Qualifiers (`#name`)

```
#body                content between this heading and the next of same-or-higher level
#intro               content between this heading and its first sub-heading
#first-para          the first paragraph of the body
#toc                 generated table-of-contents for the section
#frontmatter         YAML/TOML frontmatter block (document-scoped form)
#title               the heading's text only, no body
#level               the heading's level (as a scalar)

# Org-specific
#logbook             Org :LOGBOOK: drawer contents
#properties          Org :PROPERTIES: drawer contents
#clock               CLOCK entries in the section
#scheduled           SCHEDULED timestamp
#deadline            DEADLINE timestamp
#tags                Org headline tags (`:work:urgent:`)
#todo-state          Org TODO keyword (TODO, DONE, custom)
#priority            Org priority cookie (#A, #B, #C)
```

### Anchors (`¶name`)

```
¶first-link          first link in the section
¶first-code          first fenced code block in the section
¶abstract            content before the first heading (lede)
¶references          section titled "References" or "Bibliography" (heuristic)
¶table-of-contents   an existing TOC block, if hand-authored

# Org-specific
¶agenda-item         entries with TODO state not in {DONE, CANCELLED}
¶scheduled-today     entries SCHEDULED for current date (query-time)
¶clocked-in          entries with active CLOCK entry (no end time)
```

### Edges (`→`)

```
xref→                [text](#anchor) or [[target]] → target section
cite→                Org citation `[cite:@ref]` or Markdown `[@ref]` (Pandoc)
                     → bibliography entry
include→             Org `#+INCLUDE:` or MDX `<Include src="…" />`
                     → target file's content
link→                inline link `[text](url)` → external URL (not traversable,
                     but addressable for link-check tooling)
footnote→            `[^note]` or Org `[fn:note]` → footnote definition
transclude→          Org `#+INCLUDE:` with :only-contents t
                     → the included content's declarations
```

---

## C · Worked examples

```markdown
README.md :: Installation > Prerequisites#body
README.md :: API > "Configuration options"#first-para
README.md :: Installation > item[3]#body
docs.org :: Setup > Install > SOURCE-BLOCK[bash][0]
README.md :: //§link[@href^="#"]/xref→
docs.org :: //cite→#body
README.md :: Installation#toc
README.md :: "Quick start"@h2 - README.md :: "Quick start"@h3
README.md :: #frontmatter.title
docs.org :: //¶agenda-item#todo-state
docs.org :: Project A > Tasks > ¶scheduled-today#body
posts/2026-04-18.md :: #frontmatter.tags
```

---

## D · Edge cases

```
D-1  Duplicate headings: "Installation" appears twice at h2.
     Unqualified resolves to the first in document order and emits
     AmbiguousName with both candidates. Level hint `@h2` does NOT
     disambiguate (same level); ordinal does:
         "Installation"[0]   — first occurrence
         "Installation"[1]   — second occurrence

D-2  Setext vs ATX headings: `# Foo` and `Foo\n===` are equivalent.
     Resolver normalizes; either form addressable uniformly.

D-3  Markdown inside HTML: <div>... markdown ...</div> blocks in
     GFM are raw HTML, not markdown. Addressable only via HTML
     dialect — but the Locator is still .md, so the dialect routes
     inner HTML queries to the HTML dialect internally.

D-4  MDX component calls: <Alert type="info">...</Alert> is JSX.
     The dialect handles MDX by routing JSX payloads to the TS
     dialect; heading addressing stays unchanged.

D-5  Reference-style links: `[text][ref]` + `[ref]: url` as a
     separate definition. xref→ follows the reference to the
     definition, then to the URL fragment or anchor.

D-6  Footnote placement: footnote definitions can be anywhere in
     the document. footnote→ resolves across the whole document,
     not just the current section.

D-7  Code fence language hints: ```python vs ```py. Dialect
     normalizes to a canonical language name; SOURCE-BLOCK[python]
     matches both. Unknown languages match by exact string only.

D-8  Org nested lists vs Markdown: Org indentation semantics differ
     (hard-tab and two-space rules). Dialect handles both; ordinals
     address the current level, not flattened.

D-9  Org property inheritance: properties declared at an outer
     heading propagate to descendants unless overridden.
     #properties returns the merged view by default;
     #properties[own-only] returns only the heading's direct drawer.

D-10 Org TODO keywords are configurable per-file via #+TODO:.
     Dialect reads this header and makes ¶agenda-item respect the
     file-local active-states set.

D-11 CommonMark tight vs loose lists: body qualifier respects
     blank-line grouping; tight-list items have no <p> wrapper,
     loose-list items do.

D-12 Frontmatter formats: YAML (---), TOML (+++), JSON (;;). Dialect
     detects and parses; `#frontmatter.key` works uniformly.

D-13 Heading text with Markdown formatting: `## *Important* notice`.
     Addressable by rendered plaintext "Important notice" OR by
     source form "*Important* notice" with a `[source]` predicate.

D-14 Org inline tasks and drawers nested under plain-list items
     (Org 9+): addressable through the list-item parent as
     `list-parent/§inlinetask`.
```

---

## E · Test suite

```rust
mod tests_md_org_dialect {
    // --- Round-trip
    #[test] fn rt_simple_heading() {}
    #[test] fn rt_quoted_heading_with_punctuation() {}
    #[test] fn rt_level_hint_for_duplicate() {}
    #[test] fn rt_org_source_block_with_language() {}
    #[test] fn rt_frontmatter_path() {}

    // --- Resolver
    #[test] fn resolves_heading_case_insensitive() {}
    #[test] fn resolves_heading_exact_with_predicate() {}
    #[test] fn resolves_nested_heading() {}
    #[test] fn resolves_list_item_by_ordinal() {}
    #[test] fn resolves_org_block_by_language() {}
    #[test] fn resolves_setext_equivalent_to_atx() {}
    #[test] fn resolves_org_property_with_inheritance() {}
    #[test] fn resolves_frontmatter_nested_key() {}

    // --- Negative
    #[test] fn diagnoses_duplicate_heading_without_ordinal() {}
    #[test] fn diagnoses_nonexistent_anchor_for_xref() {}
    #[test] fn diagnoses_unknown_frontmatter_key() {}

    // --- Differential
    #[test] fn differential_rendered_vs_source_heading_text() {}
    #[test] fn differential_tight_vs_loose_list_body() {}

    // --- Edges
    #[test] fn edge_xref_follows_markdown_anchor() {}
    #[test] fn edge_xref_follows_org_internal_link() {}
    #[test] fn edge_cite_pandoc_citation() {}
    #[test] fn edge_cite_org_citation() {}
    #[test] fn edge_include_org_directive() {}
    #[test] fn edge_footnote_cross_section() {}
    #[test] fn edge_transclude_only_contents() {}

    // --- Qualifiers
    #[test] fn qualifier_body_same_or_higher_level_boundary() {}
    #[test] fn qualifier_intro_ends_at_first_subheading() {}
    #[test] fn qualifier_first_para_single_node() {}
    #[test] fn qualifier_toc_generated_matches_headings() {}
    #[test] fn qualifier_org_properties_own_only() {}
    #[test] fn qualifier_org_properties_inherited_default() {}
    #[test] fn qualifier_org_tags_include_inherited() {}

    // --- Anchors
    #[test] fn anchor_first_link_scoped_to_section() {}
    #[test] fn anchor_abstract_before_first_heading() {}
    #[test] fn anchor_references_heuristic_matches_titles() {}
    #[test] fn anchor_org_agenda_respects_file_todo_keywords() {}
    #[test] fn anchor_org_clocked_in_active_only() {}

    // --- Mixed content
    #[test] fn mdx_component_routes_to_ts_dialect() {}
    #[test] fn gfm_raw_html_routes_to_html_dialect() {}

    // --- Cross-dialect smoke
    #[test] fn cross_dialect_todo_body_query() {}
}
```

Minimum corpus: 100 round-trip (including Markdown + Org mix), 60 resolver triples, 30 negative cases, full edge + qualifier + anchor coverage, 14 edge-case documents.
