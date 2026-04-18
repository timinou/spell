# Rust Dialect

Applies to `.rs`. Crate root is determined from `Cargo.toml`; module tree resolves per `mod` declarations and `#[path]` attributes.

---

## A · NamePayload shape

```rust
pub struct RustName {
    segments: Vec<RustSegment>,
    turbofish: Option<Vec<RustTypeShape>>,
    impl_for: Option<ImplForClause>,
}

pub enum RustSegment {
    Ident(SmolStr),             // util, Buffer, from_str
    Keyword(RustPathKw),        // crate | self | super | Self
    Raw(SmolStr),               // r#type, r#match
}

pub struct ImplForClause {
    trait_path: Vec<RustSegment>,   // Write
    type_path:  Vec<RustSegment>,   // Buffer
    generics:   Option<GenericsShape>,
}
```

### Composition rules

```
crate::util::parse              path segments, Rust's own :: separator
Buffer::from_str                 associated item
parse::<&str>                    turbofish on generic fn
impl Write for Buffer::write_all impl-block container — impl_for filled, final
                                 segment is the item within the block
r#type                           raw identifier (Rust 2018+)
`crate::weird::name`             backtick quoting if outer grammar would consume
```

`impl Write for Buffer::write_all` is parsed as a single NamePayload where `impl_for = Some({trait: Write, type: Buffer})` and `segments = [write_all]`. The kernel's outer `/` then applies to children of `write_all`.

Multiple impls for the same type are disambiguated by trait path; inherent methods have `impl_for = None`.

---

## B · Registries

### Qualifiers (`#name`)

```
#body                fn/method/impl body block
#name                declaration identifier node
#sig                 params + return type, no body, no where-clause
#generics            <…> generic parameter list
#where               where-clause
#attrs               all outer attributes on the declaration
#visibility          pub / pub(crate) / pub(super) / pub(in …) clause
#match-arm           a single arm of a match expression (used on match-arm nodes)
#unsafe-block        the unsafe { … } block if the declaration contains one
```

### Anchors (`¶name`)

```
¶test-body           body of a #[test] fn
¶bench-body          body of a #[bench] fn (or criterion equivalent)
¶unsafe              every `unsafe { … }` block in scope
¶return              every return-expression
¶guard               early-return pattern (`if let Err(_) = … { return … }`)
¶error-path          `?` propagations and explicit Err returns
¶first-use           first `use` statement at the current scope
¶last-use            last `use` statement at the current scope
¶mod-side-effect     top-level non-declaration item (statics, const, init macro)
¶doc-comment         outer doc-comment attached to the declaration
```

### Edges (`→`)

```
ref→         name-use → declaration
def→         declaration → all references
call→        call-expression → callee declaration
import→      `use` item → the imported declaration
type→        type-position ident → type declaration
trait→       trait declaration → all impl blocks (set-valued)
impl-of→     impl block → the trait it implements (single-valued if inherent: None)
mod→         `mod foo;` → foo's file declaration
macro→       macro invocation → macro_rules! or proc-macro declaration
```

---

## C · Worked examples

```rust
src/buffer.rs :: Buffer::from_str::<&str>#body
src/buffer.rs :: impl Write for Buffer::write_all
src/lib.rs :: run/§match_expression[0]/§match_arm[pattern=Some(_)]#body
src/lib.rs :: compute/^^[§function_item]#sig
src/lib.rs :: //§function_item[.¶test-body]
src/parse.rs :: tokenize/ref→/impl-of→#name
src/io.rs :: Writer/trait→
src/app.rs :: //§macro_invocation[name=println]
src/lib.rs :: //§fn[.¶unsafe]
crates/core/src/lib.rs :: Config/def→ - crates/core/src/**/*_test.rs :: *
```

---

## D · Edge cases

```
D-1  Multiple inherent impl blocks: `impl Buffer { fn a() {} }` and
     `impl Buffer { fn b() {} }` in the same file. Both addressable
     as Buffer::a and Buffer::b respectively; impl_for stays None.

D-2  Method with same name in inherent impl AND trait impl:
         impl Buffer { fn write(&self) {} }
         impl Write for Buffer { fn write(&self, buf: &[u8]) -> io::Result<usize> {} }
     Ambiguous as `Buffer::write`; resolve via:
         Buffer::write                            (inherent, because bare name)
         impl Write for Buffer::write             (trait impl)

D-3  Associated const vs associated fn sharing a name across traits:
     disambiguate via #sig kind or trait-path qualification.

D-4  Raw identifiers: `r#type` is a valid Rust ident. Payload stores
     Raw(type); renderer emits the r# prefix:
         crate::lexer::r#type

D-5  `#[path = "other.rs"] mod foo;`: foo's declarations live in
     other.rs but address as crate::foo::*. Resolver consults
     #[path] attributes during module-tree build.

D-6  Closures bound to let: `let f = |x| x + 1;` has no stable name
     for the closure. Addressable only structurally:
         outer_fn/§let_declaration[name=f]/§closure_expression

D-7  `impl<T: Bound>` blocks: generics on the impl, not the method.
     Render with generics clause:
         impl<T: Write> Buffer<T>::write_all

D-8  Macro-generated items (e.g. `#[derive(Debug)]`): addressable
     post-expansion only through the macro→ edge:
         User/macro→[name=derive_Debug]

D-9  `use foo::bar as baz`: `baz` in the local scope resolves via
     import→ to `bar` in the source module. `baz/def→` returns only
     the local aliased uses, not uses of `bar` in other modules.

D-10 Extern blocks: `extern "C" { fn malloc(...) -> *mut u8; }`.
     Addressable as `malloc` in the file scope; resolver flags the
     declaration as extern via a StabilityClass note.

D-11 `Self` in impl context: `impl Foo { fn new() -> Self {} }`.
     `new/#return-type` returns a Self node; `type→` on it resolves
     to Foo.

D-12 Same module name in lib.rs and main.rs (bin target): both
     addressable via the crate's target-specific root. The Locator
     (file path) disambiguates.
```

---

## E · Test suite

```rust
mod tests_rust_dialect {
    // --- Round-trip
    #[test] fn rt_path_segments() {}
    #[test] fn rt_turbofish() {}
    #[test] fn rt_impl_for_clause() {}
    #[test] fn rt_raw_identifier() {}
    #[test] fn rt_nested_generics_shape() {}

    // --- Resolver
    #[test] fn resolves_fn_in_module() {}
    #[test] fn resolves_assoc_fn() {}
    #[test] fn resolves_trait_method_via_impl_for() {}
    #[test] fn resolves_inherent_over_trait_for_bare_name() {}
    #[test] fn resolves_turbofish_overload() {}
    #[test] fn resolves_match_arm_by_pattern_text() {}
    #[test] fn resolves_macro_invocation() {}
    #[test] fn resolves_path_attributed_module() {}
    #[test] fn resolves_raw_ident() {}

    // --- Negative
    #[test] fn diagnoses_ambiguous_inherent_vs_trait() {}
    #[test] fn diagnoses_nonexistent_impl_for_pair() {}
    #[test] fn diagnoses_turbofish_no_matching_overload() {}

    // --- Differential
    #[test] fn differential_bare_name_vs_impl_for_quoted() {}

    // --- Edges
    #[test] fn edge_ref_in_same_file() {}
    #[test] fn edge_def_crosses_modules() {}
    #[test] fn edge_import_follows_use_alias() {}
    #[test] fn edge_trait_returns_all_impls() {}
    #[test] fn edge_impl_of_returns_trait() {}
    #[test] fn edge_macro_resolves_proc_macro() {}
    #[test] fn edge_mod_resolves_path_attribute() {}

    // --- Qualifiers
    #[test] fn qualifier_body_excludes_generics_and_where() {}
    #[test] fn qualifier_sig_excludes_body() {}
    #[test] fn qualifier_where_isolated() {}
    #[test] fn qualifier_attrs_on_fn_vs_module() {}

    // --- Anchors
    #[test] fn anchor_test_body_finds_all_test_fns() {}
    #[test] fn anchor_unsafe_nested_and_shallow() {}
    #[test] fn anchor_first_use_stable_across_edits() {}

    // --- Cross-dialect smoke
    #[test] fn cross_dialect_todo_body_query() {}
}
```

Minimum corpus: 100 round-trip strings, 60 resolver triples, 30 negative cases, full edge + qualifier + anchor suites, 12 edge-case documents.
