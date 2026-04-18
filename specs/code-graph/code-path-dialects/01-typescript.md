# TypeScript / JavaScript / TSX Dialect

Applies to `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`. TSX and JSX share the dialect; the parser conditions on the file's tree-sitter grammar, not on the path syntax.

---

## A · NamePayload shape

```rust
pub struct TsName {
    segments: Vec<TsSegment>,
    overload: Option<TsOverloadSig>,
}

pub enum TsSegment {
    Ident(SmolStr),                 // Foo, bar, myVar
    PrivateField(SmolStr),          // #priv  (stored without the leading #)
    IndexSig(SmolStr),              // ["key"]  — computed-name member access
    TypeOnly(SmolStr),              // T in generic position (rarely needed as a step)
}

pub struct TsOverloadSig {
    params: Vec<TsParamShape>,      // positional type shape, not full type expr
    returns: Option<TsTypeShape>,
}
```

### Composition rules

```
Foo.bar.baz           dotted member chain                         — segments: 3
Foo.#priv             TS private-field syntax, kept literal       — segments: 2
Foo.bar(req, res)     overload disambiguated by param shape        — overload set
Foo["weird.key"]      computed-name member                         — IndexSig segment
`Foo.bar.baz`         backtick-quoted full payload when the whole
                      name contains an outer-grammar operator
```

JSX elements do **not** appear in the NamePayload. They are addressed via the structural axis `§jsx_element`, which keeps JSX-descent from bleeding into the name grammar (v2's mistake). The payload is identifier-shaped only.

Overload signature is matched structurally against declared overload parameter types:

```
Foo.bar(string, string)         matches (a: string, b: string)
Foo.bar(string, number?)        matches (a: string, b?: number)
Foo.bar(...string[])            matches rest of string
```

Generic overloads use type-parameter constraint, not turbofish — TS has no turbofish at call sites:

```
Foo.bar<T extends Base>         disambiguates by generic constraint
```

---

## B · Registries

### Qualifiers (`#name`)

```
#body                function/method body block
#name                the declaration's identifier node
#sig                 parameter list + return type, excludes body
#decorators          the set of decorators attached to the declaration
#type-params         `<T, U extends …>` clause
#return-type         the annotated or inferred return type
#jsx-children        children of a JSX element (for §jsx_element targets)
#jsx-attrs           the attribute list of a JSX element
#default-export      the exported expression of `export default …`
```

### Anchors (`¶name`)

```
¶return              every ReturnStatement in the current scope
¶guard               early-return / throw pattern at function entry
¶hook-deps           React hook dependency-array position (useEffect etc.)
¶default-export      `export default …` statement
¶first-import        the first top-level ImportDeclaration
¶last-import         the last top-level ImportDeclaration
¶module-side-effect  top-level statement that is not a declaration or import
```

### Edges (`→`)

```
ref→        identifier use → its declaration
def→        declaration → all references (set-valued)
call→       CallExpression → the resolved callee declaration
import→     ImportSpecifier → the source module's declaration
type→       type-position identifier → the type declaration
jsx-prop→   JSX attribute → the prop's declaration on the component type
```

---

## C · Worked examples

```ts
src/api.ts :: handleRequest#body
src/api.ts :: Controller.create(req: Request, res: Response)
src/api.ts :: Buffer.#internal
src/hooks.ts :: //useEffect[.¶hook-deps]
src/page.tsx :: Page/§jsx_element[0]//§jsx_element[attr=class=hero]
src/api.ts :: handleClick/§arrow_function[0]/§block
src/api.ts :: parseConfig/def→ - src/**/*.test.ts :: *
src/api.ts :: handleRequest/call→[name=fetch]/#body
src/lib.ts :: Foo.bar^^[§class_declaration]#name
src/app.ts :: //§export_statement/¶default-export/ref→
```

---

## D · Edge cases

```
D-1  Overloaded method: Foo.bar declared 3 times. Unqualified
     `Foo.bar` is ambiguous and MUST return AmbiguousName with all
     three rendered as Foo.bar(sig1), Foo.bar(sig2), Foo.bar(sig3).

D-2  `export default` without identifier: `export default function() {}`.
     NamePayload has no segment. Addressable only via anchor:
         src/mod.ts :: ¶default-export#body

D-3  Module augmentation: `declare module "x" { … }` opens a namespace
     that is NOT a file-local identifier. Render as quoted:
         src/types.ts :: `"x"`.SomeType

D-4  Computed member with non-string key: Foo[kSym] where kSym is a
     unique symbol. Payload uses IndexSig with the original source
     text: Foo["kSym"]. Resolver consults const-binding for the actual
     symbol node.

D-5  Const-enum member vs property: Foo.BAR where Foo is const enum.
     Resolver prefers the const-enum member; `§property_identifier`
     predicate can force the other read:
         Foo.BAR[§enum_member]

D-6  JSX member component <Foo.Bar />: addressed as JSX, not dot-name.
     src/page.tsx :: //§jsx_element[name=Foo.Bar]

D-7  Decorator call vs decorator identifier: @dec() vs @dec.
     #decorators returns the whole decorator node; to address the
     callee, chain: Foo.bar/#decorators[0]/call→

D-8  Private field shared across classes (all compile to separate slots)
     MUST resolve uniquely to the enclosing class's declaration.
     Buffer.#priv and Cache.#priv resolve to different nodes even if
     the field name is identical.

D-9  Re-export alias: `export { foo as bar }`. `bar` in the consuming
     file resolves via import→ to the source module's `foo`.
     Address explicitly:
         src/index.ts :: bar/import→

D-10 Declaration merging: `interface X` + `class X` in the same file.
     Both addressable via X; resolver returns the union (set-valued
     on Foo), and predicates narrow: X[§class_declaration] vs
     X[§interface_declaration].
```

---

## E · Test suite

```rust
mod tests_ts_dialect {
    // --- Round-trip: parse → render → parse equality
    #[test] fn rt_dotted_member() {}
    #[test] fn rt_private_field() {}
    #[test] fn rt_overload_signature() {}
    #[test] fn rt_index_sig_string_key() {}
    #[test] fn rt_backtick_quoted_payload() {}
    #[test] fn rt_unicode_identifier() {}

    // --- Resolver: fixture tree → expected byte range
    #[test] fn resolves_top_level_function() {}
    #[test] fn resolves_class_method() {}
    #[test] fn resolves_private_field_in_class() {}
    #[test] fn resolves_overload_by_param_types() {}
    #[test] fn resolves_overload_by_generic_constraint() {}
    #[test] fn resolves_index_sig_via_const_binding() {}
    #[test] fn resolves_export_default_via_anchor() {}
    #[test] fn resolves_module_augmentation_member() {}

    // --- Negative: diagnoses with longest-prefix + candidates
    #[test] fn diagnoses_ambiguous_overload() {}
    #[test] fn diagnoses_unknown_segment() {}
    #[test] fn diagnoses_private_field_wrong_class() {}

    // --- Differential: multiple dialect spellings of same node
    #[test] fn differential_dotted_vs_indexsig_same_property() {}
    #[test] fn differential_anchor_vs_structural_default_export() {}

    // --- Edges
    #[test] fn edge_ref_follows_local_import() {}
    #[test] fn edge_def_returns_all_references() {}
    #[test] fn edge_call_resolves_through_reassignment() {}
    #[test] fn edge_import_crosses_file_boundary() {}
    #[test] fn edge_jsx_prop_resolves_to_component_type() {}

    // --- Qualifiers
    #[test] fn qualifier_body_excludes_params() {}
    #[test] fn qualifier_sig_excludes_body() {}
    #[test] fn qualifier_decorators_returns_all_decorators() {}
    #[test] fn qualifier_jsx_children_returns_only_children() {}

    // --- Declaration merging
    #[test] fn merged_interface_class_returns_set() {}
    #[test] fn merged_narrowed_by_kind_predicate() {}

    // --- Cross-dialect smoke test (§4 of README)
    #[test] fn cross_dialect_todo_body_query() {}
}
```

Minimum corpus sizes: 100 round-trip strings, 50 resolver triples, 25 negative cases, all 5 edge-kind tests, all 9 qualifier tests, all 10 edge-case documents.
