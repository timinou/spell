# First-party Clojure integration for Spell code tool

Q: first-party Clojure in Spell code tool?

A: not “add `.clj` to syntax highlight”.  
A: make `code` understand Clojure’s real unit of meaning:

```text
file → namespace → vars/forms → refs/aliases/protocol impls/tests
not
file → class → method
```

∴ Clojure integration should be namespace/form/data-aware, macro-honest, REPL-compatible, and static-analysis conservative.

---

## 0. Current repo state → Clojure gap

Evidence:

- `crates/pi-code-engine/src/language/mod.rs:46-59`
  - built-in semantic registry: TS/Rust/Python/HTML/CSS/Typst/Markdown/Elixir/Org/text.
  - ∄ Clojure.
- `crates/pi-code-engine/src/language/profile.rs:7-36`
  - `LanguageProfile` drives outline, navigate, graph extraction, structural edits.
- `crates/pi-code-engine/build.rs:57-110`
  - grammar metadata generated from tree-sitter `node-types.json`.
  - ∄ Clojure grammar entry.
- `crates/pi-code-graph/src/language.rs:88-100`
  - graph layer has `LanguageExtractor` + `ImportResolver`.
- `crates/pi-code-graph/src/language/generic.rs:60-121`
  - generic extractor can consume engine profiles, but import resolution is per-language.
- `crates/pi-natives/src/language/mod.rs:248-288`
  - ast-grep support has many languages; ∄ Clojure.
- `crates/pi-natives/src/highlight.rs:155-189`
  - syntax highlighting already aliases `clj/clojure` → `Clojure`.
- `packages/coding-agent/src/lsp/utils.ts:23-64`
  - LSP detection already maps `.clj` → `clojure`.
- `packages/coding-agent/src/tools/code-supported-files.ts:4-26`
  - semantic fallback extensions exclude `clj/cljs/cljc/bb`.
- `packages/coding-agent/src/tools/code.ts:53-63`
  - language-specific code-tool hints exist for Markdown/Typst only.

∴ repo already has partial Clojure surface area: highlight + LSP detection.  
∄ native semantic Clojure in code engine / graph / ast-grep.

External parser availability:
- `tree-sitter-clojure` crate exists; docs expose `LANGUAGE` + `NODE_TYPES` for `tree_sitter::Parser` use: https://docs.rs/tree-sitter-clojure/latest/tree_sitter_clojure/

---

## 1. Clojure philosophy → what the tool must respect

Clojure’s core traits, from official docs:

- pragmatic hosted Lisp on JVM / host platforms → https://clojure.org/about/jvm_hosted
- functional-first; immutable persistent data structures → https://clojure.org/about/rationale
- code-as-data + macros / syntactic abstraction → https://clojure.org/about/lisp and https://clojure.org/reference/macros
- REPL-oriented development; running system matters, not only files.
- namespaces + vars are primary organization units.
- data literals are not incidental; maps/vectors/keywords often are the program’s architecture.

Implication for `code`:

```text
Clojure semantic model:
  ns      = module boundary
  var     = named value/function/macro/protocol/etc
  form    = structural edit unit
  keyword = semantic identifier, often config/spec/event route
  alias   = graph edge constructor
  macro   = maybe-code-generator; static certainty boundary
```

Wrong integration:

```text
.clj parses? ✓
outline returns defn? ✓
∴ "done"
```

Correct integration:

```text
code outline → top-level forms + vars + arities + docstrings
code navigate defun-at → enclosing balanced form
code graph deps → namespace require/import graph
code context → var + callers + aliases + tests
code edit → safe form-level structural edits
code warnings → macro-generated/unknown refs are marked uncertain, not hidden
```

---

## 2. First-party UX shape

### `code languages`

Would include:

```json
{
  "id": "clojure",
  "extensions": ["clj", "cljs", "cljc", "bb"],
  "semanticCapable": true,
  "capabilities": ["outline", "read", "navigate", "resolve", "edit", "graph"]
}
```

NB: `.edn` should probably be separate:

```text
edn:
  read ✓
  structural form nav ✓
  declarations ✗
  graph maybe keywords only
```

Do not lump EDN into Clojure code semantics.

---

### `code outline src/app/core.clj`

Target output should feel idiomatic:

```text
src/app/core.clj
└─ ns app.core
   ├─ require clojure.string as str
   ├─ def config
   ├─ defn normalize-name [s]
   ├─ defmulti dispatch :type
   ├─ defmethod dispatch :user [event]
   ├─ defprotocol Store
   │  ├─ fetch [this id]
   │  └─ save! [this value]
   ├─ defrecord MemoryStore
   └─ deftest normalize-name-test
```

Needed kinds:

```text
Namespace
Var
Function
PrivateFunction
Macro
Multimethod
Defmethod
Protocol
ProtocolMethod
Record
Type
Test
Spec
Keyword
```

Current `SymbolKind` has:

```text
Function | Class | Method | Variable | Interface | TypeAlias | Enum | Module | Macro | Template | ...
```

Minimum mapping:

```text
ns          → Module
defn        → Function
defn-       → Function(exported=false)
defmacro    → Macro
defprotocol → Interface
defrecord   → Class
deftype     → Class
defmulti    → Function
defmethod   → Method
deftest     → Function or Test? current enum lacks Test
```

First-party-quality recommendation:

```text
extend SymbolKind:
  Namespace
  Var
  Protocol
  Record
  Multimethod
  Test
  Spec
  Keyword
```

Reason: Clojure domain distinctions matter. Collapsing `defprotocol` into `Interface` is acceptable as MVP; not first-party semantics.

---

### `code read`

Clojure read mode should not be declaration-only. It should use forms.

Resolution idea:

```text
resolution 0 → ns + top-level symbol list
resolution 1 → top-level forms signatures/docstrings
resolution 2 → selected top-level form bodies collapsed
resolution 3 → exact source
```

Example:

```clojure
(ns app.core
  (:require [clojure.string :as str]))

(defn normalize-name
  "Trim and lower-case user input."
  [s]
  ...)
```

For Lisp, “body” means balanced form range, not `{ ... }`.

---

### `code navigate`

Essential actions:

```text
defun-at      → enclosing top-level form
parent        → enclosing form/vector/map
children      → child forms/items
siblings      → peer forms/items
references    → symbol refs in current file, with namespace/alias awareness
node-at       → exact AST node
```

Clojure-specific expectation:

```clojure
cursor inside:
  (-> x
      normalize
      persist!)

defun-at → whole enclosing defn
parent   → thread form
children → x / normalize / persist!
```

---

### `code edit`

Clojure editing should be form-safe.

Generic existing actions already fit:

```text
write
findAndReplace
wrap
splice
move
clone
transpose
delete
insertBefore/After
```

But first-party Clojure needs procedures:

```text
threadFirst       (f (g x))        → (-> x g f)
threadLast        (f a (g x))      → (->> x g (f a))
unthread          inverse
raiseForm         replace parent with child
slurpForward      include next sibling into list
barfForward       eject last child
wrapLet           bind subform
extractDef        lift form to (def name ...)
sortNsRequires    canonicalize :require
expandRequire     [foo.bar :as fb] → fully qualified refs or inverse
renameVar         ns-aware var rename across files
renameKeyword     qualified keyword-safe rename
```

Why this matters:

```text
Clojure syntax is mostly data structure.
Generic AST replace works, but Lisp editing invariants are balance + form identity.
∴ first-party = paredit-style ops, not text patches.
```

---

## 3. Rust crate integration plan

### 3.1 `pi-code-engine` — semantic buffer/profile layer

Files:

```text
crates/pi-code-engine/Cargo.toml
crates/pi-code-engine/build.rs
crates/pi-code-engine/src/language/generated.rs
crates/pi-code-engine/src/language/mod.rs
crates/pi-code-engine/src/language/profile.rs
```

Changes:

```toml
# crates/pi-code-engine/Cargo.toml
tree-sitter-clojure = "0.1"
```

`build.rs`:

```rust
GrammarSource {
    name:            "clojure",
    dependency_name: Some("tree-sitter-clojure"),
    package_prefix:  "tree-sitter-clojure-",
    json_subpath:    "src/node-types.json",
}
```

`generated.rs`:

```rust
include_grammar!(clojure, "grammar_clojure.rs");
```

`LanguageRegistry::with_builtins()`:

```rust
reg.register(clojure_profile())?;
```

`clojure_profile()` should define:

```text
id: "clojure"
extensions: ["clj", "cljs", "cljc", "bb"]
capabilities: semantic_capabilities(&[])
declarations:
  ns
  def
  defonce
  defn
  defn-
  defmacro
  defmulti
  defmethod
  defprotocol
  defrecord
  deftype
  deftest
imports:
  ns form require/import/use clauses
references:
  symbols + qualified symbols + maybe keywords
separators:
  whitespace, /, ., :, -, ?
```

Potential profile limitation:

Current `NameExtractor` supports:

```text
Field
ChildField
ChildText
Literal
AttributeValue
Attributed
```

Clojure def forms likely need:

```text
list form:
  head symbol = defn
  name symbol = nth semantic child after head
```

If tree-sitter grammar gives useful fields → use existing profile.  
If not, add a new extractor:

```rust
NameExtractor::NthNamedChild {
  parent_type: String,
  index: usize,
  skip_comments: bool,
}
```

or more domain-specific:

```rust
NameExtractor::ListFormArgument {
  head: String,
  index: usize
}
```

I’d prefer generic `NthNamedChild` if grammar node layout is stable.  
I’d prefer custom Clojure extractor if node layout is too list-centric.

Design rule:

```text
Do not force Clojure into field-based OO assumptions.
If profile abstraction can’t express "second item in list after defn", extend it.
```

---

### 3.2 `pi-code-graph` — namespace/var graph

Files:

```text
crates/pi-code-graph/src/language.rs
crates/pi-code-graph/src/language/generic.rs
crates/pi-code-graph/src/language/clojure.rs   # new
crates/pi-code-graph/src/indexer.rs
crates/pi-code-graph/src/model.rs
```

Two options:

#### A. Generic engine extractor

```text
clojure_profile() declarations/imports/references
→ EngineProfileExtractor auto indexes Clojure
```

✓ less code  
✗ weak for `ns` require clauses and aliases  
✗ weak for `:refer`, `:rename`, `:as`, platform-specific `.cljc`

#### B. Dedicated `ClojureExtractor` + `ClojureImportResolver`

Recommended.

Why:

```text
Clojure graph correctness mostly = namespace resolution.
Namespace resolution is not just "specifier string in field".
It requires parsing nested data inside (ns ... (:require [...])).
```

Implement:

```rust
pub struct ClojureExtractor;
pub struct ClojureImportResolver;
```

Extractor output:

```rust
ExtractedFile {
  path,
  language: "clojure",
  symbols: [
    ns app.core,
    var app.core/normalize-name,
    macro app.core/with-tx,
    protocol app.core/Store,
    method app.core/Store.fetch,
    record app.core/MemoryStore,
  ],
  imports: [
    specifier: "clojure.string",
    bindings: [{ imported_name: "*", local_name: "str" }],
    specifier: "app.db",
    bindings: [{ imported_name: "connect!", local_name: "connect!" }],
  ],
}
```

Resolver:

```text
ns "foo.bar-baz"
→ foo/bar_baz? no, Clojure convention:
   namespace segment hyphen remains hyphen in symbol,
   file segment hyphen becomes underscore on disk.
→ foo/bar_baz.clj / .cljc / .cljs
```

Candidate search:

```text
source roots:
  deps.edn :paths
  deps.edn :aliases .* :extra-paths
  project.clj :source-paths / :test-paths
  build.boot source paths if cheap
  default: src, test, dev, resources
extensions:
  .clj
  .cljc
  .cljs
  .bb
```

Reference resolution:

```text
str/split       → alias str → clojure.string/split
app.db/connect! → namespace-qualified var
connect!        → local/referred var if :refer [connect!]
::foo/id        → alias-qualified keyword foo/id
::id            → current ns keyword
```

Be honest:

```text
unqualified symbol with no local/refer match:
  unresolved, not random global match
```

---

### 3.3 `pi-natives` — NAPI + ast-grep support

Files:

```text
crates/pi-natives/Cargo.toml
crates/pi-natives/src/language/parsers.rs
crates/pi-natives/src/language/mod.rs
crates/pi-natives/src/code_buffer.rs
crates/pi-natives/src/code_graph.rs
```

Add dependency:

```toml
tree-sitter-clojure = "0.1"
```

Parser:

```rust
pub fn language_clojure() -> TSLanguage {
    tree_sitter_clojure::LANGUAGE.into()
}
```

AST-grep support:

```rust
impl_lang_expando!(Clojure, language_clojure, 'µ');
```

Add enum variant + dispatch + extensions:

```rust
SupportLang::Clojure
canonical_name() => "clojure"
extensions => &["clj", "cljs", "cljc", "bb"]
```

Expando char should be tested. Clojure symbols can contain many punctuation chars; `$` may be valid in JVM interop symbols. The ast-grep user syntax should remain:

```clojure
(defn $NAME [$ARGS] $$$BODY)
```

Internal preprocessing can map metavars safely.

---

### 3.4 TypeScript/code tool surface

Files:

```text
packages/coding-agent/src/tools/code-supported-files.ts
packages/coding-agent/src/tools/code.ts
packages/coding-agent/src/prompts/tools/code-hint-clojure.md  # new
packages/coding-agent/src/lsp/utils.ts
packages/coding-agent/src/modes/theme/theme.ts
```

`code-supported-files.ts` fallback:

```ts
"clj",
"cljs",
"cljc",
"bb",
```

`describeCodeToolSemanticFiles()`:

```ts
"TypeScript, Rust, Python, HTML, CSS, Typst, Markdown, Org, Elixir, and Clojure"
```

`code.ts`:

```ts
const LANGUAGE_BY_EXTENSION = new Map([
  ["clj", "clojure"],
  ["cljs", "clojure"],
  ["cljc", "clojure"],
  ["bb", "clojure"],
  ...
]);

const LANGUAGE_INJECTIONS = new Map([
  ["clojure", clojureHint.trim()],
  ...
]);
```

`code-hint-clojure.md` should teach agents:

```text
- target declarations by fully qualified var: file.clj::app.core/foo
- prefer form-level edits
- do not text-edit balanced forms unless code edit fails structurally
- use namespace graph before cross-file rename
- macro-generated code may be incomplete statically
```

LSP:
- `.clj` already mapped.
- add `.cljs`, `.cljc`, `.bb` if absent.

---

## 4. Clojure-specific graph semantics

Current graph has:

```text
EdgeKind:
  Defines
  Imports
  Calls
  References
  Inherits
  Renders
  Styles
  TypeImports
  TypeParameterOf
```

Clojure wants:

```text
Requires       ns → ns
Refers         ns → var via :refer
Aliases        alias → namespace
Calls          var → var
Dispatches     defmethod → defmulti
Implements     record/type → protocol
Tests          deftest → var under test
UsesKeyword    var → keyword
```

Minimal no-enum-change mapping:

```text
Requires/Aliases → Imports
Refers           → References
Calls            → Calls
Implements       → Inherits
Dispatches       → References
Tests            → References
UsesKeyword      → References
```

First-party recommendation:

```text
add EdgeKind:
  Requires
  Refers
  Aliases
  Implements
  Dispatches
  Tests
  UsesKeyword
```

Reason:

```text
deps/impact in Clojure has high value only if it distinguishes:
  "file requires ns"
  vs "var calls var"
  vs "record implements protocol"
  vs "test covers var"
```

Otherwise impact reports become plausible lies.

---

## 5. Macro honesty model

Clojure macros are not a footnote. They are normal architecture.

Static engine can reliably detect:

```text
defmacro forms
macro call sites by known macro vars
core def-like macros
library macros if configured/known
```

Static engine cannot reliably know:

```text
arbitrary generated vars
generated calls
runtime eval/load-string
reader conditionals fully without platform context
macroexpand result without executing host code
```

Tool behavior should expose certainty:

```json
{
  "edge": "Calls",
  "certainty": "static" | "macro-expanded" | "heuristic" | "unresolved",
  "reason": "resolved via :require alias str"
}
```

If API churn is too high, at least add rendering markers:

```text
app.core/foo → app.macros/with-tx   macro call
? generated refs omitted; run with nREPL macroexpand for runtime view
```

Optional second tier:

```text
static tier:
  tree-sitter + namespace parser + clj-kondo cache

runtime tier:
  nREPL macroexpand / doc / test / eval
  disabled unless user explicitly opts in
```

Do not execute Clojure project code during normal `code index`.

---

## 6. Clojure strengths the code tool can make visible

### 6.1 Simplicity / decomplecting

Clojure emphasizes separating identity/state/value/time.

Tool affordance:

```text
code context app.core/update-state
  pure inputs: state, event
  stateful refs touched: app.db/*conn*, app.cache/cache
  side-effect fns: save!, publish!
```

Static heuristic:

```text
flag:
  atom
  ref
  agent
  volatile!
  delay
  future
  promise
  dynamic vars ^:dynamic
  ! suffix functions
```

Not as lint. As architectural context.

---

### 6.2 Data orientation

Clojure programs often route through data:

```clojure
{:event/type :user/created
 :db/id      id}
```

Tool should index keywords:

```text
:user/created
:db/id
::spec/user
::route/home
```

Queries:

```text
code symbols query=":user/created"
code impact symbol=":events/user-created"
```

This is unusually valuable in Clojure because keywords often function as protocol between subsystems.

---

### 6.3 Namespace graph

Clojure maintainers care about:

```text
What namespaces depend on this ns?
What aliases point here?
What vars are referred directly?
What tests exercise this ns?
```

`code deps src/app/core.clj` should render:

```text
app.core
requires:
  clojure.string as str
  app.db as db
  app.events refer [emit!]

required by:
  app.web.routes
  app.jobs.sync

tests:
  app.core-test
```

---

### 6.4 REPL-first workflow

First-party Clojure should feel live-aware, but safe.

Possible future commands under `code` or sibling tool:

```text
code hover app.core/foo
  static docstring + arglists
  if nREPL attached: runtime var metadata

code macroexpand file line column
  requires explicit opt-in because it can execute code

code test symbol app.core-test/foo-test
  maybe outside code tool; only user-instructed due repo test rules
```

For this repo’s `code` tool, I’d keep runtime features out of MVP and design the static model so runtime data can layer on later.

---

## 7. Implementation waves

### Wave 1 — parse + outline + form navigation

Deliverable:

```text
.clj/.cljs/.cljc/.bb open through code tool
code languages lists clojure
code outline shows ns/def/defn/defmacro/defprotocol/defrecord/deftest
code navigate defun-at returns top-level form
code read preserves balanced form boundaries
ast_grep lang=clojure works
```

Touch:

```text
pi-code-engine Cargo/build/profile/generated
pi-natives Cargo/parsers/SupportLang
coding-agent supported extensions + hint
```

Tests:

```text
cargo test -p pi-code-engine clojure
cargo test -p pi-natives clojure
bun check:ts
```

Fixtures:

```clojure
(ns app.core
  (:require [clojure.string :as str]
            [app.db :as db :refer [connect!]]))

(def config {:app/name "demo"})

(defn normalize-name
  "Trim + lower."
  [s]
  (some-> s str/trim str/lower-case))

(defmacro with-log [& body]
  `(do ~@body))

(defprotocol Store
  (fetch [this id]))

(defrecord MemoryStore [state]
  Store
  (fetch [_ id] (get @state id)))
```

---

### Wave 2 — namespace graph

Deliverable:

```text
code index includes Clojure files
code deps works at namespace level
code context app.core/normalize-name works
alias refs resolve: str/trim → clojure.string/trim when local source exists
:refer refs resolve
```

Touch:

```text
pi-code-graph/src/language/clojure.rs
pi-code-graph/src/language.rs registration
generic resolver or dedicated resolver
maybe model.rs kind/edge expansions
```

Tests:

```text
fixtures:
  deps.edn with :paths ["src" "test"]
  src/app/core.clj requires src/app/db.clj
  test/app/core_test.clj requires app.core
assert graph edges:
  app.core imports app.db
  app.core-test imports app.core
  app.core/normalize-name calls clojure.string/trim if resolvable or unresolved external if not local
```

---

### Wave 3 — Clojure form procedures

Deliverable:

```text
code edit kind=threadFirst
code edit kind=sortNsRequires
code edit kind=renameVar
balanced-form safety tests
```

Touch:

```text
pi-code-engine/src/procedure/*
pi-code-engine/src/language/mod.rs clojure_profile().procedures
```

Tests must assert exact source for:
- comments preserved
- metadata preserved
- reader conditionals preserved
- no paren imbalance
- no namespace require semantic loss

---

### Wave 4 — optional clj-kondo / clojure-lsp / nREPL enrichment

Deliverable:

```text
if clj-kondo analysis cache exists:
  enrich symbols with arities/docs/usages
if clojure-lsp exists:
  LSP references/rename available through existing lsp tool
if nREPL explicitly configured:
  hover/macroexpand runtime mode
```

NB:

```text
normal code index must remain pure/static/no execution
```

---

## 8. Key design decisions

### Decision 1: dedicated graph extractor?

Recommendation:

```text
pi-code-engine: declarative Clojure profile for buffer ops
pi-code-graph: dedicated ClojureExtractor + ClojureImportResolver
```

Why:

```text
outline/edit = form structure → profile works
graph = ns aliases + :refer + platform paths → custom code needed
```

---

### Decision 2: `.edn` support?

Recommendation:

```text
separate edn language/profile
```

Capabilities:

```text
read/form navigation/edit balanced forms ✓
outline declarations ✗
graph keywords/config refs maybe later
```

Reason:

```text
EDN is data, not Clojure code.
Conflating them makes code graph lie.
```

---

### Decision 3: macro expansion?

Recommendation:

```text
static default, runtime opt-in
```

Static index should report:

```text
macro declaration ✓
macro call site ✓
generated internals ✗ / unknown
```

Optional nREPL can macroexpand, but only explicit.

---

### Decision 4: Symbol target IDs

Current pattern:

```text
<file>::Symbol.member
```

Clojure should use fully-qualified vars:

```text
src/app/core.clj::app.core/normalize-name
src/app/core.clj::app.core/Store.fetch
src/app/core.clj::app.core/MemoryStore
```

For private vars:

```text
src/app/core.clj::app.core/internal-helper
exported=false
```

For keywords:

```text
src/app/core.clj::app.core::user/id
```

Maybe awkward; could encode keyword target IDs as:

```text
keyword://app.core/user-id
```

But that’s broader API churn. MVP: don’t expose keyword target IDs as edit targets; expose them in graph/search.

---

## 9. What “first-party” means here

Checklist:

```text
✓ tree-sitter parser built into Rust crates
✓ code languages reports Clojure semantic support
✓ code read/outline/navigate/edit work on balanced forms
✓ code graph indexes namespaces + vars + requires
✓ ast_grep supports lang=clojure
✓ clojure-lsp detection and format path work
✓ Clojure-specific hint teaches agents form/namespace rules
✓ tests cover .clj/.cljs/.cljc + deps.edn roots
✓ macro uncertainty exposed, not hidden
✓ no runtime execution during static indexing
```

Non-goal for MVP:

```text
✗ full macro expansion
✗ full classpath/JAR indexing
✗ perfect dynamic var/eval resolution
✗ executing tests/eval from code tool
```

---

## 10. Final shape

A good Clojure integration would make `code` feel like this:

```text
Q: "What happens if I change app.user/normalize?"
code context app.user/normalize

A:
- defined in src/app/user.clj
- called by app.web.handlers/create-user
- used in tests app.user-test/normalize-test
- references keyword :user/name
- requires clojure.string as str
- pure-looking function: no stateful refs detected
- one macro boundary nearby: with-validation, refs inside not statically expanded
```

And editing would feel like:

```text
code edit targetId="src/app/user.clj::app.user/normalize"
  action=wrapLet / threadFirst / findAndReplace
→ balanced form preserved
→ namespace requires sorted if touched
→ save + format via clojure-lsp if available
```

∴ First-party Clojure is not just language support.  
It is a Clojure-shaped semantic model:

```text
forms over lines
namespaces over files
vars over methods
data over syntax
macro honesty over fake certainty
REPL compatibility without default execution
```
