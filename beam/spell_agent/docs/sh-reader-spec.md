# `sh::` — almost-native shell as a PTC-Lisp reader form

> Status: **approved spec**, pre-implementation. The brush execution engine and
> the full quoting story (`docs/quoting-spec.md`) are tracked separately. This
> document is the settled design for the *reader form* and its desugaring; the
> `W*` build plan for `sh::` + brush lands in a follow-up.

---

## 0. The goal

The cleanest interface to write **any** script the runtime would ever need:

1. **write** almost-native shell with no quoting/escaping ceremony,
2. **compose** scripts with the full Lisp combinator library (`->>`, `pmap`, `for`),
3. **remember** a script as a durable, diffable entry in the toolset.

The design achieves this by making a shell command **a vector of argument
values** (babashka's real model — not string interpolation), written with a
reader form `sh::`, executed on a vendored **brush** NIF, and returning a
**structured Lisp value**. Composition is therefore ordinary Lisp; the shell is
only the leaf.

---

## 1. Why argv-vector, not interpolation

Rejected: string interpolation (`#sh "rg -l TODO ~{dir}"`). It reintroduces a
quoting/escaping contract and is injection-prone.

Adopted: **babashka's `babashka.process` model** — arguments are a Lisp vector
of values; a hole is *one* argv element, never concatenated into a command
string.

```clojure
;; babashka:           (process ["rg" "-l" "TODO" dir])
;; PTC sh:: desugars:  (sh     ["rg" "-l" "TODO" dir])
```

Consequence — **injection-proof by construction**: a value spliced into argv is
a single element passed to the NIF, which does **no** shell parsing of argv.
There is no command string to escape, so there is no escaping contract.

---

## 2. Lexing — verified against `fast_parser.ex`

Facts established by reading the reader (`lib/ptc_runner/lisp/fast_parser.ex`):

- `:` is **not** a symbol-continuation char (`symbol_rest_char?/1`) and **not** a
  keyword char (`keyword_char?/1`). ∴ `sh::` does not lex as any token today;
  bare `::` errors. **The spelling `sh::` is free** — PTC never implemented
  Clojure's `::auto-kw`, so there is no collision.
- `~` is an **unused reader char** — available for unquote.
- The reader is clean recursive descent: a `case` in `do_parse_expr/2`
  dispatching on the leading bytes (`(`, `[`, `{`, `#{`, `#(`, `#"`, `#'`, `'`,
  …). Adding `sh::` is **one additive branch**; nothing existing changes.

### Hook point

`sh::` is a **head-position reader form**: detected immediately after `(`,
before normal list parsing.

```
do_parse_expr, the "(" branch:
  peek (after optional ws) starts with "sh::"  → parse_sh_list  (argv mode; consumes the closing `)` )
  else                                          → parse_sequence (normal list — UNCHANGED)
```

---

## 3. Token rules (locked: pure argv)

`parse_sh_list` reads whitespace-separated tokens until the matching `)`.
**No shell operators** — pipes/redirects are expressed in Lisp (§6). This is the
most homoiconic, most Lisp-like, inject-proof option.

| token in source | reader action | AST part produced |
|---|---|---|
| `rg` `-l` `TODO` | bare word | `{:string, "rg"}` … (auto-quoted) |
| `~dir` | `~` then recurse `parse_expr` for one form | `<expr>` (unquote) |
| `~@flags` | `~@` then recurse `parse_expr` for one form | `{:splice, <expr>}` |
| `~(f x)` | `~` then recurse → any form | `<expr>` |
| `"a b"` | normal string reader (token with spaces) | `{:string, "a b"}` |

Notes:
- A bare word is **data** (a string), never evaluated as a symbol. This is what
  lets `-l`, `*.ex`, `TODO` appear literally without fighting the Lisp lexer.
- `~` escapes **one** following form back into Lisp (evaluate it).
- `~@` splices a Lisp **list** into argv (multiple elements).
- Globs like `*.ex` are passed **literally** to brush, which performs expansion
  (shell semantics), not the Lisp reader.

---

## 4. Desugaring — `sh::` is pure sugar over `(sh [argv])`

`sh::` lowers to an ordinary function call on a vector. **The analyzer and
evaluator need zero changes** — they already handle calls and vectors.

```clojure
(sh:: rg -l TODO ~dir)
;; reads as →
(sh ["rg" "-l" "TODO" dir])

(sh:: rg ~@extra-flags ~dir)
;; ~@ splices a list into argv →
(sh (into ["rg"] (concat extra-flags [dir])))
```

The **substrate is a plain data vector** — inspectable, diffable, crystallizable,
storable as a `:ptc` tool. `sh::` is only the keystrokes. This is the property
that keeps the design homoiconic: *surface is sugar; substrate is a vector of
values.*

> Implementation choice for `~@`: the reader emits `{:splice, expr}` parts and
> desugars the whole vector to `(into [] (concat …))` segments, OR emits a direct
> `(sh (vector-with-splices …))`. Either way the desugar target is a normal call;
> pick the simpler lowering at implementation time. No new AST node leaks past
> the reader.

---

## 5. The `sh` builtin / brush-NIF contract

```
(sh ["rg" "-l" "TODO" dir]) → {:exit 0 :out "…" :err "" :lines ["lib/a.ex" …]}
```

- **Input:** an argv **vector of values**. The NIF does **no** shell parsing of
  argv → inject-proof. A hole (`dir`) is exactly one argv element.
- **Output:** a structured Lisp value. Accessors: `:exit` `:out` `:err`
  `:lines` (stdout split on newlines) and, by convention, `:json` (lazy parse of
  `:out` when the caller asks).
- **Safety / liveness (never brick the loop):**
  - NIF runs on a **dirty scheduler** (brush `run` is long/blocking).
  - wrapped in **`catch_unwind`** → a panic returns `{:exit nonzero :err …}` as
    data, never a scheduler crash.
  - **timeout / cancellation** via the cancel token already on brush
    `ExecutionParameters`.
  - failure ladder mirrors `SchemeWordPreprocessor`: resolve-fail → defer →
    surfaced error; the agent loop survives every shell outcome.
- **Word/URI expansion:** the existing `WordPreprocessor` bridge (PLAN-310 W5)
  resolves `skill://`, `local://`, … inside argv elements through the kernel
  `SchemeRegistry`, so URI tokens work in `sh::` natively.

---

## 6. Pipes & redirects — in Lisp, two flavors

There are two distinct "pipes." Keeping them separate is the whole ergonomic
win.

```clojure
;; (a) VALUE pipe — across commands. results are Lisp data; compose with ->>:
(->> (sh:: rg -l TODO src)
     :lines
     (pmap #(tool/sh {:argv ["wc" "-l" %]}))  ; concurrent fan-out, free on the BEAM
     (map :out))

;; (b) BYTE pipe — within one brush pipeline, no materialization between stages.
;; Shipped as the `tool/sh-pipe` native tool (PLAN-011 W4). `:stages` is a list
;; of argv vectors; brush connects each stage's stdout to the next stage's stdin:
(tool/sh-pipe {:stages [["cat" f]
                        ["grep" "ERR"]
                        ["wc" "-l"]]})       ; brush connects stdout→stdin natively
```

- `tool/sh-pipe` takes N argv-vectors (under `:stages`) and runs them as **one**
  brush pipeline. Each stage is still pure argv — no shell-string, still
  inject-proof per stage. Result shape is identical to `sh`
  (`{:exit :out :err :lines}`); `:exit` is the pipeline's overall (last-stage)
  exit.
- NB on surface: `|` cannot appear in a PTC symbol (the reader excludes it), so
  the byte pipe is a NAMED tool (`tool/sh-pipe`), not a `sh/|` reader form. A
  `sh/|`-style reader sugar desugaring to `tool/sh-pipe` is a possible future
  ergonomic, but the canonical, parseable surface is the tool call above.
- Redirects are DEFERRED to a later wave (the fd-overwrite surface gets its own
  review). For now, write output from Lisp (e.g. a file tool over `:out`).

```
mental model:
  bash  |   bytes, within one command  (rg | head)         → tool/sh-pipe (brush)
  lisp ->>  values, across commands     (sh → :lines → map)  → Lisp
```

---

## 7. Remember & compose — the toolset payoff

A remembered shell script is just a `:ptc` tool whose body is `(sh …)`. It is
durable (registry → Khepri, per the registry spine), diffable, and composes with
the full combinator library, late-bound:

```clojure
;; remember:
(tool/define-tool
  {:name "todo-files" :params [:dir]
   :source "(:lines (sh:: rg -l TODO ~data/dir))"})

;; compose remembered scripts in pure Lisp:
(->> (tool/todo-files {:dir "lib"})
     (pmap #(tool/blame-summary {:file %}))
     (sort-by :age)
     (take 5))
```

Because the substrate of a `sh::` form is the same data shape as any `:ptc`
tool, **one recall layer** (`hist/forms`, crystal/provenance) covers both shell
scripts and Lisp programs — no special-casing.

---

## 8. What the reader change unlocks beyond shell

The token sub-reader is incidental; **`~` unquote is the real primitive.** PTC
today has `quote` (symbols only — verified: `(quote (a b))` raises *"quote only
supports symbols in this phase"*) and no quasiquote, no `eval`. Adding `~`/`~@`
in the `sh::` reader is the first concrete instance of *escape-to-Lisp inside a
literal*, and the structural groundwork for general quasiquote.

```
1. sh::                  almost-native shell, argv-vector, inject-proof   ← this spec
2. quasiquote groundwork ~ is half of syntax-quote → programs that write
                         programs (the deepest homoiconic door)           → docs/quoting-spec.md
3. ~@ splice everywhere  list-templating into any constructed form
4. sibling leaf DSLs     sql:: re:: path:: — same reader pattern, same
                         desugar-to-vector; one primitive, many surfaces
5. crystal/recall parity (sh [...]) == any :ptc tool data shape → one
                         durable, diffable, composable toolset
```

Door #2 is the prize and is specified separately. `sh::` is the useful first
instance that justifies the reader work.

---

## 9. Scope boundaries

- **In scope (this spec):** the `sh::` reader form, token rules, desugar to
  `(sh [argv])`, the `sh` builtin return contract, `sh/|` and redirect-opts
  shape, safety/liveness requirements for the brush NIF.
- **Out of scope (separate specs/plans):**
  - General quasiquote / `eval` / code-templating → `docs/quoting-spec.md`.
  - Concrete `W*` deliverables (exact `parse_sh_list` code, `brush_nif` rustler
    signatures, Khepri durability wiring) → the sh+brush build plan.
  - Streaming/long-running command lifecycle (channels, backpressure) → deferred;
    v1 `sh` is request/response with a structured summary.

---

## 10. Verified facts underpinning this spec

| claim | evidence |
|---|---|
| `sh::` spelling is free (no `::kw` collision) | `:` ∉ `symbol_rest_char?` ∧ `:` ∉ `keyword_char?` (`fast_parser.ex`) |
| reader is one-branch extensible | recursive-descent `case` in `do_parse_expr/2` |
| `~` is available | not in any char class, no existing unquote/quasiquote |
| desugar needs no analyzer/eval change | target is `(sh [vector])` — an ordinary call |
| `quote` is symbols-only today | `analyze_quote/1` → `{:symbol_ref, _}`; non-symbol raises |
| no `eval` builtin | absent from `lib/ptc_runner/lisp/env/builtin.ex` |
| URI tokens already resolve in brush | `SchemeWordPreprocessor` (PLAN-310 W5) |
| brush NIF precedent | `ex_ratatui` vendored rustler NIF, already patched |
