# Additional Language Profiles (FUP)

**Status**: Follow-up — add after pi-code-engine's profile system is proven with TS/Rust/Python/Elixir.

## Priority Order

1. **Go** — strong tree-sitter grammar, simple import system (package paths), common in infrastructure
2. **Java** — `class_declaration`, `method_declaration`, `interface_declaration`, `import_declaration`, well-structured grammar
3. **C/C++** — `function_definition`, `struct_specifier`, `class_specifier`, include-based imports
4. **Ruby** — `method`, `class`, `module`, require-based imports
5. **Kotlin** — `function_declaration`, `class_declaration`, `object_declaration`
6. **Lua** — `function_declaration`, `local_function`, assignment-based
7. **Haskell** — `function`, `type_synonym_declaration`, `data_declaration`
8. **Scala** — `function_definition`, `class_definition`, `object_definition`
9. **Swift** — `function_declaration`, `class_declaration`, `protocol_declaration`
10. **PHP** — `function_definition`, `class_declaration`, `namespace_use_declaration`

## Per-Language Notes

### Go
- Import system: `import "path/to/package"` with package-name-based resolution
- No exports keyword: capitalized names are public
- Method declarations have receiver: `func (s *Server) Start()`
- tree-sitter grammar: `tree-sitter-go` is mature

### Java
- Import: `import package.Class` or `import package.*`
- Exports: public/private/protected keywords
- Nested classes, inner classes, anonymous classes add complexity
- tree-sitter grammar: `tree-sitter-java` is mature

### C/C++
- Include-based: `#include "file.h"` or `#include <system>`
- No module system (pre-C++20), header resolution is complex
- Forward declarations, templates, macros add complexity
- Recommendation: extract symbols only, skip import resolution initially

### Ruby
- `require`/`require_relative` for imports
- Convention-based file resolution (class Foo → foo.rb)
- Monkey patching means static analysis is inherently incomplete
- tree-sitter grammar: `tree-sitter-ruby` is mature

## Template for New Profile

```yaml
language: <name>
extensions: [<ext1>, <ext2>]

declarations:
  - node_types: [<tree-sitter-node-type>]
    name_field: <field-name>
    kind: <display-kind>
    body_field: <optional-body-field>

class_like:
  - node_type: <container-type>
    body_field: <body-field>
    member_types: [<member-types>]

imports:
  - node_type: <import-node-type>
    specifier_field: <field-containing-path>

exports:
  - node_type: <exported-node-type>
    visibility: <keyword-or-convention>

references:
  - node_type: identifier
    exclude_parent_types: [comment, string, ...]

separators: [",", ";"]
```
