# HTML Dialect (vendored XPath)

Applies to `.html`, `.htm`, `.xhtml`, `.svg`, `.xml`, `.atom`, `.rss`. The dialect delegates step-parsing and predicate evaluation to a vendored XPath engine (`sxd-xpath` for XPath 1.0, `xrust` for XPath 3.1 once we need regex predicates, namespace axes, or sequence-typed functions).

---

## A · NamePayload shape — it's XPath

```rust
pub struct HtmlName {
    xpath: XPathExpr,                // parsed by sxd-xpath (or xrust)
    namespaces: NamespaceBindings,   // prefix → URI mapping
}
```

The entire step head, plus its predicates, is a single XPath *LocationPath* (or in XPath 3.1, a *PathExpr*). The outer CodePath combinators still apply between steps; the XPath runs *within* a step.

### Axis rebinding for this dialect

The kernel reserves `§` for node-kind and `¶` for anchors. The HTML dialect **rebinds** them inside its NameLexer to XPath semantics, since XPath's `@` is universal HTML/XML attribute notation and any dev addressing HTML expects it:

```
kernel sigil    HTML dialect meaning
────────────   ────────────────────────────────────
§              NOT USED inside HTML payloads. Element names
               appear bare (`div`, `p`) — no node-kind prefix.
               Used only in kernel-level predicates if ever needed.
@              native XPath attribute axis — `@class`, `@href`
¶              anchor axis, reserved for ¶landmark-style lookups
               (handled by the resolver AFTER XPath returns a nodeset)
→              kernel edge axis, unchanged
#              kernel qualifier, unchanged
```

One deliberate axis-overload per dialect, documented.

### Composition rules

```
//div[@class='hero']                    full XPath step
html/body/main[@id='app']               chained XPath children
//a[starts-with(@href, '/api')]          XPath function in predicate
//*[@role='button']                      wildcard element with attribute
//svg:rect                               namespace-qualified element
//text()[contains(., 'TODO')]            XPath text() node test
//comment()                              XPath comment-node test
`//label[@for='weird/name']`             backtick wrapping if outer
                                        grammar would split
```

Element-names with dots or slashes in custom-element names (rare but legal: `<a-b>`, `<my-c-d>`) parse cleanly inside XPath element-name tokens.

---

## B · Registries

### Qualifiers (`#name`)

```
#text                concatenated text content (XPath `string(.)`)
#inner-html          serialized HTML of children
#outer-html          serialized HTML including the element itself
#attr[name]          single attribute value
#attrs               attribute map (all attributes as (name, value) pairs)
#children            ordered child element nodes (not text)
#data-attrs          data-* attributes only
#aria                aria-* + role attributes only
#tag-name            the element's local name
#namespace           the element's namespace URI
```

### Anchors (`¶name`)

```
¶main                <main> landmark
¶nav                 <nav> landmark
¶banner              role="banner" or <header> at document root
¶content-info        role="contentinfo" or <footer> at document root
¶head-meta           all <meta> children of <head>
¶first-form          first <form> in document order
¶live-region         elements with aria-live
¶landmark[name]      parameterized landmark by ARIA role
¶above-the-fold      heuristic: elements before first <section> break
¶slot[name]          <slot name="…"> elements (Shadow DOM)
```

Individual anchors for the five common landmarks (`¶main`, `¶nav`, `¶banner`, `¶content-info`, plus `¶head-meta`) because they're the daily-use set; the long tail uses `¶landmark[name]`.

### Edges (`→`)

```
id-ref→          href="#id"  → element with matching id
for-ref→         label[for]  → input with matching id
aria-ref→        aria-labelledby / aria-controls / aria-describedby
                 → referenced element
include→         iframe[src] / object[data] → target document
use-ref→         svg <use href="#id"> → target <symbol> or element
form-for→        input[form] → form with matching id (cross-tree)
```

---

## C · Worked examples

```html
page.html :: html/body/main[@id='app']#outer-html
page.html :: //form[@id='login']/input[@name='email']#attr[value]
page.html :: ¶main//button[contains(@class, 'save')]#text
page.html :: //a[starts-with(@href, '#')]/id-ref→
page.html :: //label[@for]/for-ref→
page.html :: //*[@aria-labelledby]/aria-ref→#text
page.html :: //img[not(ancestor::picture)]
page.html :: //header/¶landmark[name=navigation]
page.html :: //text()[contains(., 'TODO')]
docs/index.xhtml :: //h:section[@data-lang='en']        -- namespaced
```

The last example uses namespace-prefix binding declared in the dialect's `namespaces` map; `h:` is bound to the XHTML URI.

---

## D · Edge cases

```
D-1  Self-closing tags: <br>, <img>, <input>. XPath treats them as
     elements with no children; #children returns empty; #text is
     empty string.

D-2  <template> contents: content lives in a separate document
     fragment, not in the normal tree. Resolver walks the template's
     content for predicates; predicate `//template//*` addresses
     items inside.

D-3  Case-sensitivity: HTML parsers normalize element and attribute
     names to lowercase; XML preserves case. Dialect distinguishes
     by file extension:
         .html/.htm  → case-insensitive match for element/attr names
         .xml/.xhtml/.svg → case-sensitive

D-4  Namespace handling: XML requires prefix binding.
     Dialect accepts a namespaces map at query time; default ns
     applies to unprefixed elements in XML mode.

D-5  CDATA sections in XML: addressable via `§cdata_section` node
     kind (rare; the kernel-level § still works for fallbacks
     since the dialect hasn't claimed it for element naming).

D-6  Custom elements with hyphens: `<my-widget>`. XPath element-name
     tokens accept hyphens; no special handling.

D-7  Void elements vs empty elements: XPath doesn't distinguish.
     Dialect treats `<br>` and `<br></br>` identically.

D-8  Duplicate id attributes (invalid HTML but common):
     id-ref→ returns the first in document order and flags
     DuplicateId diagnostic with all candidates.

D-9  Shadow DOM: `<slot>` projections are addressable in the
     light-tree only. Projection resolution is out of scope for
     the static dialect (flagged as runtime-only).

D-10 Entity references: XPath `text()` returns resolved text;
     `//*[text()='©']` matches text containing a resolved copyright
     entity.

D-11 Whitespace-only text nodes: XPath `text()` includes them.
     Use `normalize-space(.)` in predicates to skip whitespace.

D-12 HTML5 parser error recovery: malformed input may produce
     unexpected tree shapes (implicit <tbody>, reordered <head>
     contents). Dialect documents which parser it uses
     (html5ever preferred) so users can reason about tree shape.

D-13 XPath 1.0 vs 3.1 feature gate: regex in predicates (`matches()`),
     string functions, sequence types need 3.1. Dialect declares
     which version is active; attempts to use 3.1 features in 1.0
     mode diagnose with a feature-gate error.
```

---

## E · Test suite

```rust
mod tests_html_dialect {
    // --- XPath round-trip (via vendored engine)
    #[test] fn rt_simple_step() {}
    #[test] fn rt_predicate_with_function() {}
    #[test] fn rt_namespace_prefixed() {}
    #[test] fn rt_text_node_test() {}
    #[test] fn rt_backtick_wrapped_full_xpath() {}

    // --- Resolver
    #[test] fn resolves_element_by_id() {}
    #[test] fn resolves_element_by_class_substring() {}
    #[test] fn resolves_attr_via_qualifier() {}
    #[test] fn resolves_inner_html_serialization() {}
    #[test] fn resolves_namespace_qualified_xml() {}
    #[test] fn resolves_template_content_fragment() {}
    #[test] fn resolves_cdata_via_node_kind_axis() {}

    // --- Negative
    #[test] fn diagnoses_invalid_xpath_syntax() {}
    #[test] fn diagnoses_unknown_namespace_prefix() {}
    #[test] fn diagnoses_xpath31_feature_in_v1_mode() {}
    #[test] fn diagnoses_duplicate_id_with_candidates() {}

    // --- Differential
    #[test] fn differential_css_class_vs_xpath_class_predicate() {}
    #[test] fn differential_id_ref_vs_xpath_id_function() {}

    // --- Edges
    #[test] fn edge_id_ref_resolves_href_hash() {}
    #[test] fn edge_for_ref_label_to_input() {}
    #[test] fn edge_aria_ref_multi_attribute_forms() {}
    #[test] fn edge_include_follows_iframe_src() {}
    #[test] fn edge_use_ref_svg_symbol() {}
    #[test] fn edge_form_for_cross_tree() {}

    // --- Qualifiers
    #[test] fn qualifier_text_concatenates() {}
    #[test] fn qualifier_inner_vs_outer_html() {}
    #[test] fn qualifier_data_attrs_filtered() {}
    #[test] fn qualifier_aria_only_aria_plus_role() {}
    #[test] fn qualifier_attr_single_value() {}

    // --- Anchors
    #[test] fn anchor_main_landmark() {}
    #[test] fn anchor_parameterized_landmark() {}
    #[test] fn anchor_head_meta_excludes_link() {}
    #[test] fn anchor_live_region_matches_aria_live() {}
    #[test] fn anchor_slot_by_name() {}

    // --- Parser behavior
    #[test] fn html5_implicit_tbody_insertion() {}
    #[test] fn html5_case_insensitive_match() {}
    #[test] fn xml_case_sensitive_strict() {}
    #[test] fn entity_references_resolved() {}
    #[test] fn whitespace_text_nodes_present() {}

    // --- Cross-dialect smoke
    #[test] fn cross_dialect_todo_body_query() {}
}
```

Minimum corpus: 100 round-trip (XPath-valid strings), 60 resolver triples against HTML fixtures, 30 negative cases, full edge + qualifier + anchor coverage, 13 edge-case documents.
