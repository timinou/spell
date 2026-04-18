# CSS Dialect (vendored cssparser)

Applies to `.css`, `.scss`, `.sass`, `.less`. The dialect uses Servo's `cssparser` + `selectors` crates for selector and at-rule parsing. For SCSS/LESS/Sass, a dialect-local preprocessor layer produces a CSS-ish tree the dialect then operates on; source-map back to original is preserved via a `SourceMap` attached to each resolved range.

---

## A · NamePayload shape

```rust
pub struct CssName {
    kind: CssNameKind,
}

pub enum CssNameKind {
    Selector(SelectorList),      // .hero > h1, h2, .a + .b
    AtRule(AtRule),               // @media (…), @keyframes name, @layer …
    Pseudo(PseudoRoot),           // :root, :host
}

pub struct AtRule {
    name: SmolStr,                // "media", "keyframes", "layer", "supports"
    prelude: Option<SmolStr>,     // raw prelude text, parsed by cssparser
    ident: Option<SmolStr>,       // for @keyframes name, @layer name, @scope name
}
```

### Composition rules

```
.hero > h1                      CSS selector as payload (full Selectors-4)
@media (max-width: 600px)       at-rule with prelude, no identifier
@keyframes fade-in               at-rule with identifier
@layer utilities                 cascade layer
@supports (display: grid)        feature query
:root                            pseudo-class root for custom-prop scope
`@media (weird'quote)`           backtick wrap if outer grammar would split
```

At-rule preludes are parsed by `cssparser` so conditions like `@media (min-width: 600px) and (prefers-reduced-motion)` or `@container (inline-size > 40em)` work verbatim.

Nested at-rules compose via the kernel's `::` separator (repurposed here to chain dialect-internal scopes, distinct from the kernel's locator `::`):

```
styles/app.css :: @layer utilities :: @media (prefers-color-scheme: dark) :: .card
```

The first `::` is kernel (Locator separator). Subsequent `::` between at-rules inside one query are dialect tokens the NameLexer recognizes within a single step head. Alternative spelling without collision: use the kernel `/` combinator and let the resolver chain at-rule scopes structurally:

```
styles/app.css :: @layer utilities/@media (prefers-color-scheme: dark)/.card
```

Both spellings resolve identically; dialect renderer prefers `/` to avoid overloading `::`. Documented both because real users will write both.

---

## B · Registries

### Qualifiers (`#name`)

```
#block                the rule's declaration block (everything in `{ … }`)
#declaration[prop]    value of a specific CSS property
#value                property value only (when head targets a declaration)
#selector             the selector(s) of the rule (when head targets a rule)
#specificity          computed specificity triple (a, b, c)
#keyframe[percent]    a specific keyframe step (0%, 50%, from, to)
#layer-chain          the cascade-layer path of the rule
#media-query          the @media prelude text
#supports-condition   the @supports prelude condition
#custom-properties    all --* declarations in the block
```

### Anchors (`¶name`)

```
¶dark-mode           rules inside @media (prefers-color-scheme: dark)
¶light-mode          rules inside @media (prefers-color-scheme: light)
¶reduced-motion      rules inside @media (prefers-reduced-motion: reduce)
¶print-styles        rules inside @media print
¶rtl                 rules targeting [dir=rtl] or :dir(rtl)
¶root-custom-props   declarations inside :root
¶reset-styles        heuristic: rules matching * or html selectors at top
¶container-query[n]  specific @container rule by name
```

### Edges (`→`)

```
css-var→             `var(--name)` use → declaration in :root or scope
extends→             (SCSS) @extend → the extended selector's rule
imports→             @import / @use (SCSS) → target file's declarations
mixin→               (SCSS) @include → @mixin declaration
applies-to→          (reverse selector→element, cross to HTML) selector →
                     matching elements in a companion HTML file
```

`applies-to→` crosses from CSS into HTML dialect files — the target Locator changes from `.css` to `.html`. This is a legitimate cross-dialect edge because CSS is meaningful only against HTML.

---

## C · Worked examples

```css
styles/app.css :: .hero > h1#declaration[color]
styles/app.css :: @media (max-width: 600px)/.hero
styles/app.css :: @keyframes fade-in#keyframe[50%]
styles/app.css :: ¶dark-mode//.card#block
styles/app.css :: :root#declaration[--brand-primary]
styles/app.css :: .button/css-var→
styles/app.css :: //§rule_set[.¶root-custom-props]
styles/app.css :: @layer utilities/.flex-center
styles/app.css :: .hero/applies-to→       (→ page.html :: …matching elements)
styles/app.scss :: %error-placeholder/extends→     (SCSS)
```

---

## D · Edge cases

```
D-1  Selector lists as a single rule: `.a, .b, .c { color: red }`.
     The rule is one declaration block; addressed by any of the
     three selectors produces the same block. Rendering canonicalizes
     to the first selector; differential tests assert equivalence.

D-2  :is() / :where() / :has(): vendored `selectors` crate
     supports all three. Specificity of `:where(…)` is zero;
     #specificity qualifier respects this.

D-3  CSS nesting (2023+): `.card { & .title { … } }`. Dialect
     unwraps nesting during resolution; the nested rule is
     addressable at both the nested form and the desugared form.

D-4  @scope (Chrome 118+): `@scope (.card) { :scope > .title { … } }`.
     Addressable via the at-rule payload; #selector returns
     `:scope > .title` as declared.

D-5  Custom property cascade: `--brand: blue` in `:root` vs `.card`.
     css-var→ from `var(--brand)` returns the nearest declaring
     ancestor's declaration; set-valued if unresolvable at parse time.

D-6  !important declarations: addressable; #value includes the
     !important token. A separate predicate `[important]` narrows
     to only !important rules.

D-7  Duplicate property declarations in the same block:
     `.card { color: red; color: blue; }`. #declaration[color]
     returns the last (cascade wins); #declaration[color][all]
     returns both as a set.

D-8  @import / @use chains: imports→ follows one hop; transitive
     closure requires iteration (kernel set ops suffice).

D-9  SCSS placeholders `%foo`: selector-like but not emitted in
     output CSS. Dialect addresses them only under extends→ or
     explicit `%foo` payload.

D-10 Sass-indented syntax (.sass): whitespace-significant. Dialect
     preprocessor converts to SCSS form before addressing; source
     map preserved.

D-11 Media query comma list: `@media (min-width: 600px), print`.
     Prelude parsed as a list; #media-query returns the whole list;
     predicate `[part=0]` narrows to the first query.

D-12 Cascade layer ordering: @layer declarations without blocks
     declare ordering:  `@layer reset, theme, utilities;`.
     Addressable via anchor `¶layer-order` returning the declaration.

D-13 Container queries with containment context:
     `@container sidebar (min-width: 30em)`. The name `sidebar`
     references a `container-name` declaration elsewhere. A
     container-name→ edge (optional) resolves back to the context.
```

---

## E · Test suite

```rust
mod tests_css_dialect {
    // --- Round-trip
    #[test] fn rt_simple_selector() {}
    #[test] fn rt_at_rule_with_prelude() {}
    #[test] fn rt_nested_at_rules_slash_spelling() {}
    #[test] fn rt_nested_at_rules_colon_spelling_normalizes_to_slash() {}
    #[test] fn rt_custom_property_name() {}
    #[test] fn rt_keyframe_percent() {}

    // --- Resolver
    #[test] fn resolves_rule_by_selector() {}
    #[test] fn resolves_declaration_by_property() {}
    #[test] fn resolves_at_media_rule() {}
    #[test] fn resolves_at_keyframes_step() {}
    #[test] fn resolves_layer_chain_order() {}
    #[test] fn resolves_nested_rule_desugared() {}
    #[test] fn resolves_scope_at_rule() {}
    #[test] fn resolves_scss_placeholder_via_extends() {}
    #[test] fn resolves_sass_indented_after_preprocess() {}

    // --- Negative
    #[test] fn diagnoses_invalid_selector() {}
    #[test] fn diagnoses_unknown_at_rule() {}
    #[test] fn diagnoses_malformed_prelude() {}
    #[test] fn diagnoses_undefined_css_var_at_parse_time() {}

    // --- Differential
    #[test] fn differential_selector_list_any_selector_same_rule() {}
    #[test] fn differential_nested_vs_desugared_same_rule() {}

    // --- Edges
    #[test] fn edge_css_var_resolves_to_root() {}
    #[test] fn edge_css_var_resolves_to_nearest_scope() {}
    #[test] fn edge_extends_resolves_scss_placeholder() {}
    #[test] fn edge_imports_one_hop() {}
    #[test] fn edge_mixin_scss_include() {}
    #[test] fn edge_applies_to_crosses_to_html() {}

    // --- Qualifiers
    #[test] fn qualifier_block_excludes_selector() {}
    #[test] fn qualifier_declaration_single_value() {}
    #[test] fn qualifier_declaration_all_duplicates() {}
    #[test] fn qualifier_specificity_respects_where() {}
    #[test] fn qualifier_layer_chain_ordered() {}
    #[test] fn qualifier_custom_properties_subset() {}

    // --- Anchors
    #[test] fn anchor_dark_mode_scoped_rules() {}
    #[test] fn anchor_root_custom_props_only_root() {}
    #[test] fn anchor_container_query_parameterized() {}
    #[test] fn anchor_reduced_motion_query_variants() {}

    // --- Cross-dialect smoke
    #[test] fn cross_dialect_todo_body_query() {}
}
```

Minimum corpus: 100 round-trip (including SCSS/Sass variants), 60 resolver triples, 30 negative cases, full edge + qualifier + anchor coverage, 13 edge-case documents.
