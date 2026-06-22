# Shell as data — `sh/parse` and `sh/unparse`

> PLAN-011 W5. The homoiconic completion. Up to W4 a shell command was *opaque
> text* the moment it left the `sh::` reader. W5 makes bash itself **walkable
> data**: `sh/parse` turns a bash string into a PTC-native tree (the same shape
> Lisp history projects through), and `sh/unparse` turns that tree back into
> bash. The shell stops being a black box at the leaf — it becomes one more
> value the agent can read, transform, and remember.

---

## 0. Why this is the layer that makes the thesis true

The `sh::` reader (W2) was honest about a tension: a shell command body is a
string, and a string is not homoiconic the way an s-expression is. W2 resolved
it by moving the homoiconic unit *up* — the catalog and the composition graph are
data, the leaf command is text. W5 closes the gap at the leaf too:

```
W2:  (sh:: rg -l TODO ~dir)   → argv vector (data) → opaque to brush
W5:  (sh/parse "rg -l TODO | head")  → a WALKABLE TREE, same shape as Lisp history
```

Once bash parses to the **same `form_tree` shape** the Lisp history uses, a
shell pipeline and a Lisp program become the **same kind of walkable data** — one
structural projector (`form_tree/1`) traverses both. (The *concrete* `hist/forms`
recall query over shell calls is a W6 follow-up, not a W5 claim — see §5.) That is
the "one source of truth per concern" principle reaching down to the shell at the
representational layer.

---

## 1. The shared projection shape (`form_tree`)

`SpellAgent.Hist.Lens.form_tree/1` defines the canonical walkable-node shape for
Lisp forms:

```
%{"node" => <kind-string>,
  "name"     => <string>,    # optional — present for named nodes
  "value"    => <jsonable>,  # optional — present for literals
  "children" => [<node>]}    # optional — structural children
```

Tuple-free, JSON-safe, drift-resilient (an unknown kind still becomes a walkable
subtree). `sh/parse` produces nodes of **exactly this shape**, so the two
syntaxes — bash and Lisp — project through one lens.

---

## 2. What `sh/parse` produces

brush parses bash into `brush_parser::ast` (Program → CompoundList → AndOrList →
Pipeline → Command → SimpleCommand → Word). The NIF projects the **common
structure** into `form_tree` nodes:

```
bash                          PTC tree (form_tree shape)
────                          ──────────────────────────
rg -l TODO                    {"node":"command",
                               "name":"rg",
                               "children":[{"node":"word","value":"-l"},
                                           {"node":"word","value":"TODO"}]}

a | b | c                     {"node":"pipeline",
                               "children":[<command a>, <command b>, <command c>]}

a && b                        {"node":"and_or",
                               "children":[<pipeline a>,
                                           {"node":"and","children":[<pipeline b>]}]}

a; b                          {"node":"program",
                               "children":[<list-item a>, <list-item b>]}
```

### Drift-resilient fallback

Exotic bash (compound commands `if`/`for`/`while`/`case`/`{…}`, function
definitions, process substitutions, here-docs) is not exhaustively modelled in
v1. Such a node projects to a **safe, walkable** form that preserves its source
text:

```
{"node":"raw", "value":"<the exact source span>"}
```

So `sh/parse` NEVER fails on valid-but-exotic bash — it degrades to a `raw`
leaf you can still see and `unparse` round-trips verbatim. The common 90% (the
pipelines and simple commands an agent actually writes) is fully structured;
the exotic tail is preserved, not lost.

---

## 3. What `sh/unparse` does

`sh/unparse` is the inverse: a `form_tree`-shaped tree → a bash string.

- `command` → the name plus its word children, each **re-escaped** (single-quote
  rules, exactly like `sh::`) so a value placed in a `word` can never inject. A
  hand-built tree with a malicious `word` is safe by construction — the word
  becomes one single-quoted literal argument.
- `pipeline` → stages joined by ` | `.
- `and_or` → joined by ` && ` / ` || `.
- `program` → items joined by `; `.
- `raw` → the preserved source text **verbatim** (NOT re-escaped).

> **Trust boundary for `raw`.** A `raw` node renders verbatim, because it holds a
> whole bash fragment (a `for` loop, an assignment-prefixed command) that must
> stay intact to round-trip. This means `unparse`'s inject-proof guarantee covers
> `word` nodes, **not** `raw` nodes: a *hand-built* `{"node":"raw","value":"$(rm
> -rf /)"}` renders that text unescaped. This is not an execution hole — `unparse`
> returns a STRING, and running it requires an explicit `(tool/sh {:argv ["sh"
> "-c" …]})` opt-in (the documented shell escape hatch). But treat `unparse`
> output of an *agent-constructed* tree as untrusted bash, exactly as you would
> any `sh -c` string. `raw` nodes that came from `sh/parse` of real bash are, by
> definition, valid bash already.

```clojure
;; read bash as a tree, transform a node, run the result:
(def tree (sh/parse "rg -l TODO src | head"))
;; … walk/edit the tree as ordinary PTC data …
(sh/unparse tree)            ; → "rg -l TODO src | head"
```

---

## 4. Round-trip contract

```
parse → unparse → parse   is SEMANTICALLY STABLE (re-parse equality): the second
  parse equals the first. Word VALUES are quote-removed to their logical content
  on parse and re-escaped on unparse, and `unquote_word` inverts even the
  `'\''` run `shell_escape` emits — so idempotency holds for words containing
  single quotes (`"it's"`, `echo it\'s`) and empty words (`echo ''`).
parse → unparse           canonicalizes: every word renders single-quoted
  (`rg` → `'rg'`), and `raw` fallbacks render verbatim.
```

We assert **re-parse equality**, not byte equality — quoting normalizes (`a|b` →
`'a' | 'b'`) but the *structure* and the logical word values are invariant. This
is the same standard a code formatter meets, and the right one for a homoiconic
substrate: meaning is preserved, presentation canonicalizes. (Verified by a
per-form re-parse-equality test set covering quoted, empty, and metacharacter
words.)

---

## 5. One recall layer — what is shared today, what is not yet

Be precise about the payoff (a reviewer caught an earlier over-claim here):

**Shared today — the structural shape.** `sh/parse` emits nodes of *exactly* the
`form_tree` shape (`"node"`/`"name"`/`"value"`/`"children"`), so the **generic
structural lens** (`Hist.Lens.form_tree/1`) walks a bash tree and a Lisp tree
with one projector. Any consumer that traverses `form_tree`-shaped data — a
structural search, a diff, a crystallizer — works over both syntaxes unchanged.
That is the real, shipped win: bash is now the *same kind of data* as Lisp.

**Not wired yet — the concrete `hist/forms` query.** The `(hist/forms {:tool …})`
recall query does NOT read the live tree; it reads a precomputed `"form_tools"`
field that `Lens.project_node` fills from the *Lisp* CoreAST when a turn is
recorded. A `sh/parse` tree is not a recorded Hist node and has no `form_tools`,
so `(hist/forms {:shell "rg"})` is **not** implemented by W5. Wiring shell trees
into the recorded-node recall index (a `form_shells` companion field, or
projecting shell calls into `form_tools`) is a tracked follow-up — see the W6
recall wave.

```
SHIPPED (W5):  one STRUCTURAL shape — form_tree walks bash & Lisp alike.
FOLLOW-UP (W6): one RECALL QUERY — hist/forms over shell calls, not just Lisp.
```

The thesis holds at the representational layer (bash is walkable data in the
shared shape); the *query convenience* over recorded history is the next step,
not a W5 claim.

---

## 6. Scope & honesty

- **In scope (W5):** `sh/parse` (common bash → `form_tree` tree, exotic → `raw`),
  `sh/unparse` (tree → safe bash), re-parse-equality round-trip, one-recall-layer
  wiring.
- **Out of scope:** exhaustive structured modelling of every bash construct (the
  `raw` fallback covers the tail); editing helpers for the tree (ordinary PTC
  map ops suffice); redirects as structured nodes (deferred with the W4 redirect
  work).

---

## 7. Verified facts this builds on

| fact | evidence |
|---|---|
| canonical node shape | `Hist.Lens.form_tree/1` (`"node"`/`"name"`/`"value"`/`"children"`) |
| brush parses to an inspectable AST | `brush_parser::ast::Program` + descendants |
| escaping prevents injection on unparse | `argv.rs::shell_escape` (W0) |
| brush can re-run a built Program | `Shell::run_program` (W0) |
| the recall lens is drift-resilient | `form_tree/1` generic tuple clause |
