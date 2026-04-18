# Python Dialect

Applies to `.py`, `.pyi`, `.pyw`. Package structure resolved from `__init__.py` and namespace packages (PEP 420). `.pyi` stubs share addressing with their runtime counterpart; the resolver prefers stub definitions when both exist.

---

## A · NamePayload shape

```rust
pub struct PyName {
    segments: Vec<PySegment>,
    signature: Option<PySig>,
}

pub enum PySegment {
    Ident(SmolStr),             // module, Class, method
    Dunder(SmolStr),            // __init__, __enter__  (stored without underscores)
}

pub struct PySig {
    params: Vec<PyParamShape>,       // positional-or-keyword, keyword-only, etc.
    returns: Option<PyTypeShape>,    // from annotation, not runtime type
}
```

### Composition rules

```
pkg.module.Class.method       dotted, mirrors Python imports
Foo.__init__                   dunders are first-class idents
Foo.Bar                        nested class/method access
overload via PEP 484 @overload stubs: signatures matched structurally
`pkg.weird key`                backtick quoting for separator-in-name
```

Decorators are NOT in the NamePayload. They are addressed as an attribute on `§decorated_definition`:

```
//§decorated_definition[decorator=pytest.fixture]
//§decorated_definition[decorator~=staticmethod|classmethod]
```

Async functions share the name grammar with sync functions; the `§async_function_definition` kind predicate narrows when needed.

---

## B · Registries

### Qualifiers (`#name`)

```
#body                function/class body block
#name                the declaration's identifier
#sig                 parameter list + return annotation, no body
#docstring           the first expression-statement string in a body
#decorators          the list of @-decorators attached to a definition
#return-annotation   the `-> …` annotation only
#type-params         PEP 695 `def f[T, U](…)` or `class C[T]` params
#class-vars          class-level (non-method) assignments
#annotations         `__annotations__`-style attribute annotations
#module-docstring    top-level module docstring (module-scoped form)
```

### Anchors (`¶name`)

```
¶main-guard          `if __name__ == "__main__":` block
¶dataclass-fields    fields of a @dataclass-decorated class
¶abstract            abstractmethod-decorated members of an ABC
¶return              all return statements in scope
¶guard               early-return / raise pattern at function entry
¶first-import        first import statement at scope
¶last-import         last import statement at scope
¶pytest-fixture      functions decorated @pytest.fixture
¶context-manager     `with` statements in scope
```

### Edges (`→`)

```
ref→         name-use → binding site (honors LEGB scope)
def→         declaration → all references (project-scoped)
call→        Call node → callee's binding (after dispatch resolution)
import→      ImportFrom/Import → the imported symbol's declaration
type→        annotation identifier → type's declaration
inherits→    class → its base classes (set-valued; respects MRO order)
method-of→   method-in-class → the class it's defined on (single-valued)
override→    method → the parent-class method it overrides
```

---

## C · Worked examples

```python
src/app.py :: Server.start#body
src/app.py :: Server.__init__/#sig
src/app.py :: //§decorated_definition[decorator=pytest.fixture]
src/cli.py :: ¶main-guard#body
src/models.py :: User/^^[§class_definition]/inherits→
src/views.py :: render/§with_statement[0]:body
src/ :: //§function_definition[.//§call[name=eval]]
src/api.py :: handle_request/def→ - tests/**/*.py :: *
src/mixins.py :: LoggerMixin.log/override→
src/base.py :: Base.save/def→/method-of→#name
```

---

## D · Edge cases

```
D-1  Name mangling: Foo.__priv inside class Foo compiles to
     _Foo__priv. Payload uses the source form __priv; resolver
     applies mangling when matching.

D-2  Property triple: Foo.value has separate @property getter,
     @value.setter, @value.deleter. Unqualified `Foo.value`
     resolves to the property object (the @property-decorated fn);
     use qualifier to reach parts:
         Foo.value#body              — getter body
         Foo.value[decorator=setter] — the setter fn
         Foo.value[decorator=deleter]

D-3  Metaclass vs class: `class Foo(metaclass=Meta):`. Foo is a
     class instance of Meta. inherits→ returns only explicit bases,
     not Meta. To reach Meta: Foo/type→.

D-4  Dynamic class creation: `Bar = type("Bar", (Base,), {"x": 1})`.
     No static declaration; addressable only via the binding
     (`Bar`), not as a member-of-module class. StabilityClass
     flagged as Dynamic.

D-5  Star import `from m import *`: imported names have no explicit
     ImportFrom node. ref→ on such a name returns Unresolvable with
     a hint pointing at the star import.

D-6  Nested functions (closures): addressable via the enclosing
     function's scope:
         outer_fn/inner_fn#body
     Multiple nested with same name disambiguated by ordinal:
         outer_fn/inner_fn[1]

D-7  Comprehensions carry their own scope in Py3. Variables inside
     are not visible outside. def→ on a comprehension-local name
     returns refs only inside the comprehension.

D-8  Multiple inheritance with MRO conflicts: inherits→ returns
     bases in source order; #mro qualifier (stretch goal) returns
     linearized MRO.

D-9  Decorator chains: `@a` + `@b` + `def f`. #decorators returns
     [a, b]; to follow the outer decorator's call target:
         f/#decorators[0]/call→

D-10 Async vs sync same name: `def f` and `async def f` in same
     scope is a SyntaxError. If present in typeshed/stub shadowing,
     resolver returns the stub's kind; predicate narrows:
         f[§async_function_definition]

D-11 `__all__` exports: export→ edge (optional extension) walks the
     literal list and returns each entry's declaration. Entries
     that are dynamic (computed at runtime) flagged Unresolvable.

D-12 Class body with only a docstring: `class Foo: "..."`. Foo#body
     is non-empty (the string), Foo#docstring returns that string
     node.
```

---

## E · Test suite

```rust
mod tests_py_dialect {
    // --- Round-trip
    #[test] fn rt_dotted_module_class_method() {}
    #[test] fn rt_dunder_name() {}
    #[test] fn rt_backtick_for_weird_keys() {}
    #[test] fn rt_overload_signature_pep484() {}
    #[test] fn rt_pep695_type_params() {}

    // --- Resolver
    #[test] fn resolves_module_fn() {}
    #[test] fn resolves_class_method() {}
    #[test] fn resolves_dunder_init() {}
    #[test] fn resolves_name_mangled_priv() {}
    #[test] fn resolves_property_getter() {}
    #[test] fn resolves_property_setter_by_decorator() {}
    #[test] fn resolves_nested_function_by_ordinal() {}
    #[test] fn resolves_async_vs_sync_by_kind() {}
    #[test] fn resolves_through_namespace_package() {}

    // --- Negative
    #[test] fn diagnoses_star_import_unresolvable() {}
    #[test] fn diagnoses_dynamic_class_flagged() {}
    #[test] fn diagnoses_ambiguous_nested_without_ordinal() {}

    // --- Differential
    #[test] fn differential_decorator_predicate_vs_decorators_qualifier() {}
    #[test] fn differential_main_guard_anchor_vs_structural_if() {}

    // --- Edges
    #[test] fn edge_ref_respects_legb() {}
    #[test] fn edge_def_excludes_star_imports() {}
    #[test] fn edge_call_resolves_through_bound_method() {}
    #[test] fn edge_import_from_absolute() {}
    #[test] fn edge_import_from_relative_dot() {}
    #[test] fn edge_inherits_returns_mro_order() {}
    #[test] fn edge_override_finds_parent_method() {}
    #[test] fn edge_method_of_returns_class() {}

    // --- Qualifiers
    #[test] fn qualifier_body_excludes_decorators() {}
    #[test] fn qualifier_docstring_first_string_only() {}
    #[test] fn qualifier_decorators_preserves_order() {}
    #[test] fn qualifier_type_params_pep695() {}

    // --- Anchors
    #[test] fn anchor_main_guard_single_match() {}
    #[test] fn anchor_dataclass_fields_excludes_methods() {}
    #[test] fn anchor_abstract_matches_abstractmethod() {}
    #[test] fn anchor_pytest_fixture_decorator_variants() {}

    // --- Cross-dialect smoke
    #[test] fn cross_dialect_todo_body_query() {}
}
```

Minimum corpus: 100 round-trip, 60 resolver, 30 negative, full edge + qualifier + anchor coverage, 12 edge-case documents.
