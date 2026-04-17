# Elixir Outline and Declaration Support in pi-code-engine

## Problem

The Elixir language profile in `pi-code-engine` has an empty `class_like` vector and a single `DeclarationPattern` that matches all `call` nodes. This causes `code outline` on Elixir files to show only a single `defmodule` entry (named "defmodule") with no nested functions. The outline is useless for navigation, symbol lookup, and structural editing.

Root causes:
1. tree-sitter-elixir represents ALL constructs (defmodule, def, defp, defmacro, use, import) as generic `call` nodes -- no semantic node types
2. The single `DeclarationPattern` matches every `call` node and extracts the macro name ("defmodule", "def") from the `target` field instead of the actual symbol name
3. `do_block` is a positional (unnamed) child in tree-sitter-elixir, not a field -- `child_by_field_name("do_block")` returns `None`, breaking body extraction
4. Empty `class_like` means `defmodule` is never treated as a container with nested members

## Design Decisions

1. Add `filter_names: Option<Vec<String>>` to `DeclarationPattern` (serde default None). When set, `declaration_for()` only matches nodes whose `name_field` text is in this list.
2. Add `name_from_arg: bool` to `DeclarationPattern` (serde default false). When true, `declaration_name()` extracts the display name from the first argument child instead of `name_field`.
3. Add `filter_field: Option<String>` and `filter_names: Option<Vec<String>>` to `ClassLikePattern` (serde defaults). When both set, only treat nodes as class-like if `filter_field` text is in `filter_names`.
4. Add `child_by_field_or_kind()` helper in outline.rs: tries `child_by_field_name(name)` first, falls back to first named child with `kind() == name`. This enables `do_block` and `arguments` lookup where tree-sitter-elixir uses positional children.
5. Add `source: &str` parameter to `declaration_for()` and update all call sites (outline.rs, navigate.rs, resolve.rs).
6. Separate `DeclarationPattern` entries for defmodule (kind: "module"), def (kind: "def"), defp (kind: "defp"), defmacro (kind: "macro"), defmacrop (kind: "macrop").
7. `ClassLikePattern` for defmodule: filter_field "target", filter_names ["defmodule"], body_field "do_block", member_types ["call"].
8. **Deferred to followup**: exported/private visibility (`def` = public, `defp` = private), defstruct/defimpl/defprotocol/defguard/defdelegate, navigate.rs `name_text` unification with `declaration_name`.

## Implementation Steps

### 1. Update DeclarationPattern in profile.rs

**File**: `crates/pi-code-engine/src/language/profile.rs`

Add two fields to `DeclarationPattern`:
```rust
#[serde(default)]
pub filter_names: Option<Vec<String>>,
#[serde(default)]
pub name_from_arg: bool,
```

Add two fields to `ClassLikePattern`:
```rust
#[serde(default)]
pub filter_field: Option<String>,
#[serde(default)]
pub filter_names: Option<Vec<String>>,
```

Also add both new fields (with serde defaults) to the `ProfileYaml` structs at the bottom of the file.

### 2. Add child_by_field_or_kind() helper in outline.rs

**File**: `crates/pi-code-engine/src/outline.rs`

```rust
/// Try field-name lookup first; fall back to first named child matching the kind.
pub(crate) fn child_by_field_or_kind<'a>(node: Node<'a>, name: &str) -> Option<Node<'a>> {
    if let Some(child) = node.child_by_field_name(name) {
        return Some(child);
    }
    let mut cursor = node.walk();
    node.named_children(&mut cursor).find(|child| child.kind() == name)
}
```

Make it `pub(crate)` so resolve.rs and navigate.rs can use it.

### 3. Update declaration_for() signature and logic

**File**: `crates/pi-code-engine/src/outline.rs`

Add `source: &str` parameter. When `filter_names` is set, check the `name_field` text against the list:

```rust
pub(crate) fn declaration_for<'a>(
    profile: &'a LanguageProfile,
    source: &str,
    node: Node<'_>,
) -> Option<&'a DeclarationPattern> {
    profile.declarations.iter().find(|decl| {
        decl.node_types.iter().any(|kind| kind == node.kind())
            && decl.filter_names.as_ref().map_or(true, |names| {
                node.child_by_field_name(&decl.name_field)
                    .and_then(|n| source.get(n.start_byte()..n.end_byte()))
                    .is_some_and(|text| names.iter().any(|n| n == text.trim()))
            })
    })
}
```

Update call site in `entry_for_node` (same file, has `source` available).

### 4. Update declaration_name() for name_from_arg

**File**: `crates/pi-code-engine/src/outline.rs`

Add early return at top of `declaration_name()`:

```rust
if decl.name_from_arg {
    let args = child_by_field_or_kind(node, "arguments")?;
    let mut cursor = args.walk();
    let first_arg = args.named_children(&mut cursor).next()?;
    // If it's a function def, the first arg is a call node whose target is the fn name
    if let Some(target) = first_arg.child_by_field_name("target") {
        return text(source, target).map(|v| v.trim().to_string());
    }
    // For defmodule, the first arg is the module name directly (alias or dot node)
    return text(source, first_arg).map(|v| v.trim().to_string());
}
```

This handles:
- `def start_link(opts)` -> first arg is a `call` node -> extract `target` -> "start_link"
- `def init do` -> first arg is `identifier` "init" -> no target field -> full text -> "init"
- `defmodule MyApp.Server` -> first arg is `dot` or `alias` -> no target field -> full text -> "MyApp.Server"

### 5. Update class_children() for filter and body fallback

**File**: `crates/pi-code-engine/src/outline.rs`

Update the class_like lookup to check `filter_field`/`filter_names`:

```rust
let Some(class_like) = profile.class_like.iter().find(|cl| {
    cl.node_type == node.kind()
        && cl.filter_names.as_ref().map_or(true, |names| {
            cl.filter_field.as_ref()
                .and_then(|field| child_by_field_or_kind(node, field))
                .and_then(|n| source.get(n.start_byte()..n.end_byte()))
                .is_some_and(|text| names.iter().any(|n| n == text.trim()))
        })
}) else {
    return Vec::new();
};
```

Update body lookup to use `child_by_field_or_kind`:
```rust
let Some(body) = child_by_field_or_kind(node, &class_like.body_field) else {
    return Vec::new();
};
```

### 6. Update signature_text() body fallback

**File**: `crates/pi-code-engine/src/outline.rs`

Replace `node.child_by_field_name(field)` with `child_by_field_or_kind(node, field)` in the body lookup within `signature_text()`.

### 7. Update call sites in navigate.rs and resolve.rs

**File**: `crates/pi-code-engine/src/navigate.rs`
- Add `source: &str` to `declaration_node()` (current L122: `if declaration_for(profile, node).is_some()`)
- Update `defun_at()` (L110: `declaration_for(profile, target)`) to pass source
- Propagate source through `declaration_node` — add `source: &str` parameter; caller has `buffer` → `buffer.source()`

**File**: `crates/pi-code-engine/src/resolve.rs`
- `match_declaration()` L99: already has `source` — just pass to `declaration_for`
- `build_resolved()` L134: already has `source` — just pass to `declaration_for`
- `resolve_member()` L191: already has `source` — pass to `declaration_for`
- `collect_top_level_names()` L231: already has `source` — pass to `declaration_for`
- `collect_member_names()` L253: already has `source` — pass to `declaration_for`
- Also in `resolve_member()`: update the `class_like` find to use `child_by_field_or_kind` for body lookup and add the filter check (same pattern as `class_children`)

### 8. Update elixir_profile() in mod.rs

**File**: `crates/pi-code-engine/src/language/mod.rs`

Replace the current `elixir_profile()` function. Key structure:

```rust
fn elixir_profile() -> LanguageProfile {
    let gd = generated::elixir::grammar();
    LanguageProfile {
        id: LanguageId::new("elixir"),
        extensions: vec!["ex".into(), "exs".into()],
        declarations: vec![
            DeclarationPattern {
                node_types: vec!["call".into()],
                name_field: "target".into(),
                kind: "module".into(),
                body_field: Some("do_block".into()),
                visibility: None,
                filter_names: Some(vec!["defmodule".into()]),
                name_from_arg: true,
            },
            DeclarationPattern {
                node_types: vec!["call".into()],
                name_field: "target".into(),
                kind: "def".into(),
                body_field: Some("do_block".into()),
                visibility: None,
                filter_names: Some(vec!["def".into()]),
                name_from_arg: true,
            },
            DeclarationPattern {
                node_types: vec!["call".into()],
                name_field: "target".into(),
                kind: "defp".into(),
                body_field: Some("do_block".into()),
                visibility: None,
                filter_names: Some(vec!["defp".into()]),
                name_from_arg: true,
            },
            DeclarationPattern {
                node_types: vec!["call".into()],
                name_field: "target".into(),
                kind: "macro".into(),
                body_field: Some("do_block".into()),
                visibility: None,
                filter_names: Some(vec!["defmacro".into()]),
                name_from_arg: true,
            },
            DeclarationPattern {
                node_types: vec!["call".into()],
                name_field: "target".into(),
                kind: "macrop".into(),
                body_field: Some("do_block".into()),
                visibility: None,
                filter_names: Some(vec!["defmacrop".into()]),
                name_from_arg: true,
            },
        ],
        class_like: vec![ClassLikePattern {
            node_type: "call".into(),
            body_field: "do_block".into(),
            member_types: vec!["call".into()],
            filter_field: Some("target".into()),
            filter_names: Some(vec!["defmodule".into()]),
        }],
        imports: vec![ImportPattern {
            node_type: "call".into(),
            specifier_field: "arguments".into(),
            is_type_only: false,
        }],
        exports: vec![],
        references: vec![ReferencePattern {
            node_type: "identifier".into(),
            exclude_parent_types: vec!["comment".into(), "string".into()],
        }],
        separators: vec![",".into()],
        production_rules: gd.production_rules,
        inverse_rules: gd.inverse_rules,
        all_types: gd.all_types,
        supertypes: gd.supertypes,
        ts_language: tree_sitter_elixir::LANGUAGE.into(),
    }
}
```

### 9. Add test fixture

**File**: `crates/pi-code-engine/tests/fixtures/sources/hello.ex` (NEW)

```elixir
defmodule MyApp.Greeter do
  use GenServer

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  def greet(name) do
    "Hello, " <> name
  end

  defp internal_helper(x) do
    process(x)
  end

  defmacro my_macro(expr) do
    quote do: unquote(expr)
  end
end
```

### 10. Add tests

**File**: `crates/pi-code-engine/src/outline.rs` (in `mod tests`)

```rust
#[test]
fn test_outline_elixir() {
    let buffer = buffer("hello.ex", "elixir");
    let profile = profile("elixir");
    let entries = outline(&buffer, &profile);
    // Should have one top-level entry: MyApp.Greeter (module)
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "MyApp.Greeter");
    assert_eq!(entries[0].kind, "module");
}

#[test]
fn test_outline_elixir_children() {
    let buffer = buffer("hello.ex", "elixir");
    let profile = profile("elixir");
    let entries = outline(&buffer, &profile);
    let children = &entries[0].children;
    // Should find: start_link, greet, internal_helper, my_macro
    let names: Vec<&str> = children.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["start_link", "greet", "internal_helper", "my_macro"]);
    // Check kinds
    let kinds: Vec<&str> = children.iter().map(|e| e.kind.as_str()).collect();
    assert_eq!(kinds, vec!["def", "def", "defp", "macro"]);
}

#[test]
fn test_read_resolution_0_elixir() {
    let buffer = buffer("hello.ex", "elixir");
    let profile = profile("elixir");
    let out = read(&buffer, &profile, 0, None, None);
    assert!(out.contains("MyApp.Greeter (module)"));
}
```

## Edge Cases

- **Zero-arity functions** (`def init do`): first arg is `identifier`, no `target` field -> `name_from_arg` falls back to full text -> correct name
- **Inline syntax** (`def foo, do: :ok`): no `do_block` child -> body_field lookup returns None -> signature includes full text -> acceptable
- **use/import/alias/require calls**: not in any `filter_names` list -> `declaration_for` returns None -> filtered out of outline
- **Nested modules**: inner `defmodule` found as `call` member of outer `do_block` -> matches module DeclarationPattern -> gets own `class_children` -> recursion works naturally
- **Module attributes** (`@doc`, `@moduledoc`): these are `unary_operator` nodes, not `call` -> filtered by `member_types: ["call"]` at `class_children` level
- **Qualified module names** (`Foo.Bar.Baz`): first arg is nested `dot` node -> full text extraction gives correct dotted name

## Verification

```sh
cd crates/pi-code-engine && cargo test outline::tests::test_outline_elixir
cd crates/pi-code-engine && cargo test outline::tests::test_outline_elixir_children
cd crates/pi-code-engine && cargo test outline::tests::test_read_resolution_0_elixir
cd crates/pi-code-engine && cargo test  # all tests pass, no regressions
cd crates/pi-code-engine && cargo clippy -- -D warnings
```

Existing tests that must not regress:
- `test_outline_typescript`, `test_outline_children`, `test_outline_typst_code_wrappers`
- `test_read_resolution_0`, `test_read_resolution_0_typst`, `test_read_resolution_3_range`
- All `resolve::tests::*`

## Deferred (followup)

- Exported/private visibility: `def` = public, `defp` = private (add `exported_default: Option<bool>` to DeclarationPattern)
- Additional keywords: defstruct, defimpl, defprotocol, defguard, defguardp, defdelegate
- navigate.rs `name_text` unification with `declaration_name` from outline.rs
