# Haskell Dialect

Applies to `.hs`, `.lhs`, `.hs-boot`. Module name is authoritative — the Locator is the file path but the resolver also tracks `module X.Y.Z where` for qualified imports to work.

---

## A · NamePayload shape

```rust
pub struct HsName {
    module: Vec<SmolStr>,                  // e.g. [Data, Map, Strict]
    binding: Option<HsBinding>,
    class_ctx: Option<HsClassContext>,     // for instance methods
}

pub enum HsBinding {
    Ident(SmolStr),                        // parseExpr
    Operator(SmolStr),                     // <$>  (stored without parens)
    Constructor(SmolStr),                  // Just, Nothing
    TypeCon(SmolStr),                      // Maybe, Either
    RecordField(SmolStr),                  // the record-field selector function
}

pub struct HsClassContext {
    class_name: SmolStr,                   // Show
    ty: SmolStr,                           // Token
}
```

### Composition rules

```
Data.Map.Strict.insert      module-qualified, Haskell-native form
Map.insert                   aliased-import form (when `import … as Map`)
(<$>)                        operator binding — wrapped in parens, Haskell's own rule
instance Show Token::show    class-instance method — :: separator for the
                             method within the instance context, echoes Haskell
                             of the form `show :: Show a => a -> String`
'Foo                         promoted data constructor (DataKinds)
```

Operators stay wrapped `(<$>)` in the payload. This matches every authoritative Haskell source: GHC error messages, Haddock pages, `:info`, `ghci` prompts. The parens form a single lexical token the outer grammar parser recognizes atomically.

Infix-use addressing of an operator (as opposed to its declaration) is handled structurally:

```
//§infix_expression[op=<$>]           uses of <$> as infix
(<$>)                                  the declaration / prefix form
```

---

## B · Registries

### Qualifiers (`#name`)

```
#body                the right-hand side of a binding
#name                the bound identifier
#sig                 the type-signature declaration (separate top-level form)
#type-sig            alias for #sig (domain-friendly)
#guards              guard clauses of a function equation
#where-clause        the where-block of a function
#instance-method     a method within an instance declaration
#pragma[name]        a specific {-# ... #-} pragma on the declaration
#lang-ext            the LANGUAGE pragma list (module-scoped form)
#kind-sig            kind signature (PolyKinds)
#deriving            the deriving clause of a data declaration
#type-class-methods  methods declared in a class definition
```

### Anchors (`¶name`)

```
¶main                `main :: IO ()` at module top
¶io-action           any expression of type `IO a` (heuristic; marked approximate)
¶let-binding         every `let … in …` block
¶do-block            every `do { … }` block
¶pattern-match       every explicit pattern match (case, lambda-case, fn arg)
¶typeclass-default   default method bodies in class declarations
¶record-pattern      every record-syntax pattern match
¶guard               guard expressions (`| cond = …`)
¶foreign-import      FFI import declarations
¶template-haskell    TH splices `$(...)` and quasiquotes `[|...|]`
```

### Edges (`→`)

```
ref→         identifier → declaration (honoring local let/where scope)
def→         declaration → all references
call→        function application → callee's declaration
import→      ImportDecl → the source module's declaration
type→        type-position ident → type declaration
instance-of→ type → instances implemented for it (set-valued)
subclass-of→ class → its superclass constraints (set-valued)
derives→     data/newtype → derived class declarations
has-instance→ class → types that have an instance (set-valued)
```

---

## C · Worked examples

```haskell
src/Parser.hs :: Parser.parseExpr#body
src/Utils.hs :: (<$>)/#sig
src/Types.hs :: instance Show Token::show#body
src/Types.hs :: User/derives→
src/App.hs :: handleRequest/§case_expression[0]/§alt[pattern=Just _]
src/Parser.hs :: tokenize/#where-clause
src/Lib.hs :: //§function[.¶do-block/§bind_pattern[name=result]]
src/Types.hs :: Functor/has-instance→
src/Foreign.hs :: //¶foreign-import
src/Types.hs :: 'Red                              -- promoted constructor
```

---

## D · Edge cases

```
D-1  Multi-equation function: `f 0 = …`, `f n = …`. All equations
     share one NamePayload `f`; resolver returns the declaration
     as a set of equations. #body on bare `f` returns the full set;
     ordinal predicate selects:
         f[0]#body   — first equation's RHS
         f[1]#body

D-2  Function with separate type signature:
         parseExpr :: Parser Expr
         parseExpr = ...
     parseExpr#sig returns the signature declaration; parseExpr#body
     returns the value declaration's RHS. Two distinct nodes, same
     payload.

D-3  Operator sections and `infixl/infixr`: fixity declarations
     addressable via:
         (<$>)#pragma[name=infixl]
     The fixity is metadata on the binding, addressed through pragma.

D-4  Orphan instances: instance declared in a module that owns
     neither the class nor the type. Resolver flags StabilityClass =
     Orphan; has-instance→ and instance-of→ still return them.

D-5  Overlapping instances (with `{-# OVERLAPPING #-}`):
     instance-of→ returns the set; predicate narrows by type-param
     specificity. Diagnostic if resolution requires OverlappingInstances
     extension not active.

D-6  GADT constructors: `data T where T1 :: Int -> T`. Addressable
     as T.T1 (Constructor binding) — dotted even though not strictly
     module-qualified, because GADT syntax puts constructors in a
     where-block.

D-7  Type families:
         type family F a
         type instance F Int = Bool
     F and its instances are separate declarations. F/instance-of→
     returns instance-declarations; each instance addressable as
     `type instance F Int`.

D-8  Record field punning: `{name, age}`. The record-field selector
     function `name` is a TOP-LEVEL binding in Haskell; addressable
     as just `name`.

D-9  Template Haskell splices `$(genFoo)`: generated declarations
     are addressable post-splice-expansion; ¶template-haskell anchor
     locates the splice site itself.

D-10 Where-clause local bindings: `f x = y where y = x + 1`.
     The local `y` is addressable only via the enclosing scope:
         f/#where-clause/y
     def→ on that y returns only the enclosing-function uses.

D-11 Typeclass default method: class C where m = …. The default
     body is addressable as:
         C.m#instance-method
     when retrieved through ¶typeclass-default anchor.

D-12 `deriving via` and `deriving (via X)`: derives→ returns the
     representation type used for deriving; predicates narrow by
     strategy.

D-13 `PatternSynonyms`: `pattern Just' x = Just x`. Addressable as
     `Just'` with HsBinding::Constructor kind; resolver flags
     StabilityClass accordingly.
```

---

## E · Test suite

```rust
mod tests_hs_dialect {
    // --- Round-trip
    #[test] fn rt_module_qualified() {}
    #[test] fn rt_operator_wrapped() {}
    #[test] fn rt_instance_method_scope() {}
    #[test] fn rt_promoted_data_constructor() {}
    #[test] fn rt_record_field_binding() {}

    // --- Resolver
    #[test] fn resolves_top_level_binding() {}
    #[test] fn resolves_operator_declaration() {}
    #[test] fn resolves_instance_method() {}
    #[test] fn resolves_multi_equation_as_set() {}
    #[test] fn resolves_signature_vs_body() {}
    #[test] fn resolves_gadt_constructor() {}
    #[test] fn resolves_type_family_instance() {}
    #[test] fn resolves_where_local_binding() {}

    // --- Negative
    #[test] fn diagnoses_ambiguous_overlapping_instances() {}
    #[test] fn diagnoses_orphan_instance_flag() {}
    #[test] fn diagnoses_unknown_operator() {}

    // --- Differential
    #[test] fn differential_operator_decl_vs_infix_use() {}

    // --- Edges
    #[test] fn edge_ref_respects_let_scope() {}
    #[test] fn edge_ref_respects_where_scope() {}
    #[test] fn edge_def_returns_all_equations_and_uses() {}
    #[test] fn edge_instance_of_returns_set() {}
    #[test] fn edge_subclass_of_walks_superclass_chain() {}
    #[test] fn edge_derives_returns_deriving_strategy() {}
    #[test] fn edge_has_instance_reverse_of_instance_of() {}

    // --- Qualifiers
    #[test] fn qualifier_body_of_multi_equation() {}
    #[test] fn qualifier_sig_is_separate_decl() {}
    #[test] fn qualifier_guards_extracted() {}
    #[test] fn qualifier_where_clause_isolated() {}
    #[test] fn qualifier_pragma_by_name() {}

    // --- Anchors
    #[test] fn anchor_main_module_entry() {}
    #[test] fn anchor_do_block_nested() {}
    #[test] fn anchor_pattern_match_in_case() {}
    #[test] fn anchor_template_haskell_splice_site() {}
    #[test] fn anchor_foreign_import_matches_ffi() {}

    // --- Extensions
    #[test] fn pattern_synonym_addressable() {}
    #[test] fn type_family_instance_distinct_from_family() {}

    // --- Cross-dialect smoke
    #[test] fn cross_dialect_todo_body_query() {}
}
```

Minimum corpus: 100 round-trip, 60 resolver, 30 negative, full edge + qualifier + anchor coverage, 13 edge-case documents.
