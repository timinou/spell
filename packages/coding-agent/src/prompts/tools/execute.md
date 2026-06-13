Run a **PTC-Lisp** program in a sandboxed BEAM runtime to compute an answer by
chaining tool calls — instead of many Bash turns you parse by eye.

PTC-Lisp is a small, deterministic Clojure subset. The program runs in an
isolated process (no fs/net/shell of its own); it reaches Spell's real tools via
`(tool/<name> {...})`, and you get back ONE small value. Use it to **count,
group, filter, join, and aggregate** — the program does the work; only the
result enters your context.

## Parameters

- `program` (required) — the PTC-Lisp source.
- `context` — a map bound under `data/<key>` inside the program.
- `signature` — an optional return contract, e.g. `{total :int}` or
  `[{id :int}]`. The result is validated against it.
- `timeout_ms` — wall-clock cap, 1..30000 (default 1000).
### Settled fan-out (errors as values)
- `(psettled f coll)` — like `pmap`, but a per-element failure is captured
  rather than aborting the whole batch. Each result is `{"ok" value}` or
  `{"err" reason}`. Use when one bad element shouldn't lose the rest:
  `(->> (psettled (fn [f] (tool/find {:target f})) data/files) (filter ok?) (map #(unwrap-or % nil)))`
- `ok?` / `err?` branch on a settled result; `(unwrap-or settled default)`
  extracts an ok value or yields the default. Errors are DATA, not exceptions.
- NB: heap/timeout/capacity kills still abort the whole run — `psettled` only
  settles *logical* failures, never global safety limits.

### Large tool results (handles)
- A tool result bigger than ~256KB is auto-parked OFF the sandbox heap and
  returned as a *handle*. You don't manage this — just keep projecting:
  `count`, `get`, `get-in`, `keys`, `vals`, `select-keys`, `contains?`,
  `first`, `nth`, `take` run against a handle WITHOUT pulling the whole value
  onto the heap. This is what lets `(count (get (tool/org {:command "dashboard"}) "inProgress"))`
  work where realizing the whole dashboard would `memory_exceeded`.
- `(handle-meta x)` shows a parked value's cost/shape (`bytes`, `shape`,
  `count`, `keys`) without realizing it; `(handle? x)` tests for one.
- A transform over a handle (`map`/`filter`/`reduce`/`group-by`) realizes it
  first — project to a slice (e.g. `take`, `select-keys`) BEFORE transforming
  if the value is large.

### Session bindings (iterate without re-fetching)
- `(def x v)` persists `x` for your NEXT execute on the same session — bind an
  expensive tool result once, then iterate on aggregation cheaply:
  `execute 1: (def hits (tool/find {:target "src/**/*.rs::§line[text~=\"unwrap\"]"})) (count hits)`
  `execute 2: (->> hits (group-by #(get % "file")) (update-vals count))` — zero re-fetch.
- A large bound value stays offloaded (handle) across executes — no re-OOM.
- A program that `(fail ...)`s or errors does NOT commit its `def`s. Bindings
  are a session cache, lost on restart (re-bind by re-running).

### Heap
- `max_heap_mb` — sandbox heap ceiling in MB for this program (default ~50).
  Clamped to the operator's `tools { execute max-heap-mb=N }` setting; you can
  always tighten, never raise beyond it. If a program dies `memory_exceeded`,
  first project/aggregate earlier (pull less data); raise the heap only for
  legitimately large datasets.

## Calling tools

Tools are called kebab-case with a string-keyed map; the result is a value:

```clojure
(tool/find {:target "src/**/*.rs::§line[text~=\"TODO\"]"})   ; → the find result
(tool/org  {:command "query" :query "todo:DOING"})           ; → org items
```

Structured tool results come back as data (maps/lists), so you can pipe them.

**A `tool/<x>` call returns the SAME shape the `<x>` tool returns**, projected
into PTC data. In particular `tool/find` returns a **LIST of node maps**, each
`{"path" "kind" "text" ...}` — index it as a list, not a single map:
`(map #(get % "text") (tool/find {:target "..."}))`, and
`(get (first (tool/find {...})) "text")` for the first node. When unsure of a
result's shape, bind it with `(def r (tool/… …))` and inspect `(keys r)` /
`(handle-meta r)` on the next execute.

## Discover the language from inside it

Don't guess a builtin's name or spelling — ask the runtime:

- `(apropos "index")` — list every builtin whose name/doc matches, each with a
  one-line description. Use it when you reach for a Clojure name and aren't sure
  PTC spells it the same (e.g. `index-of`, `update-vals`, `subs`).
- `(doc "subs")` — full signature + semantics + edge-case notes for one builtin.
- `(dir "str")` — list the names in a namespace.

These run like any expression and return data, so a quick `(apropos "…")`
execute is the fastest way to resolve "does PTC have X?" — cheaper than a failed
program. Substring tests: `(index-of s sub)` (>= 0 when present) or the
Clojure-Java method `(.contains s sub)`.

## Worked examples

Count + group (replaces `rg -c ... | awk`):

```clojure
(let [items (get (tool/org {:command "query" :query "todo:DOING"}) "items")]
  (-> (group-by :layer items) (update-vals count)))
;; → {"kernel" 12 "ui" 5}
```

Aggregate a tool result with a signature:

```clojure
;; program:
{:total (count (get (tool/org {:command "query"}) "items"))}
;; signature: {total :int}
```

Fan-out with `pmap` (concurrent tool calls, bounded by the runtime):

```clojure
(pmap (fn [f] (tool/find {:target (str f "::§function")})) data/files)
```

Frequencies over a projection:

```clojure
(frequencies (map :layer (get (tool/org {:command "query"}) "items")))
;; → {"a" 2 "b" 1}
```

## Available builtins (Clojure subset)

`->` `->>` `let` `fn` `if` `cond` `for` `loop`/`recur` `map` `filter` `reduce`
`mapcat` `group-by` `frequencies` `update-vals` `sort-by` `take` `drop`
`distinct` `dedupe` `count` `get` `get-in` `assoc` `merge` `select-keys`
`str` `join` `split` `re-find` `re-seq` `try`/`catch`/`finally` `fail`
and the usual arithmetic/comparison. (`(apropos "…")` lists the rest.)

### Error handling: `try` / `catch` / `finally`

Clojure-shaped, for when a single failing step shouldn't lose the whole program
(the SEQUENTIAL analogue of `psettled`'s per-element settling):

```clojure
(try (tool/find {:target maybe-missing})
     (catch e {:error e})        ; e = the error message (or the value of (fail v))
     (finally (cleanup)))        ; optional; runs on every exit path
```

- `catch` traps a raised/returned program error AND `(fail v)` (binds the raw
  `v`); `finally` is optional and its value is discarded.
- `(return v)` is NOT trapped — it bubbles through (finally still runs).
- SAFETY: `try` can NOT swallow a heap/timeout/capacity kill — those re-raise
  past the handler, exactly like `psettled`. A global safety limit always wins.
- Prefer `psettled` for fan-out; reach for `try` for a single fallible step or
  a guaranteed `finally` cleanup.

## Gotchas (these will bite)

- `update-vals` is `(update-vals m f)` — thread with `->` (first), NOT `->>`.
- Tool args and the return value must be JSON-serializable (no closures).
- Signatures return **string-keyed** maps: `(get r "total")`, not `(:total r)`.
  (Keyword access `(:total r)` also resolves — keyword→string is automatic — but
  prefer string keys for clarity.)
- A non-terminating loop hits an iteration/timeout limit and returns an error;
  the runtime survives — fix the program and re-run.

## Required keys: `get!` / `get-in!`

`get`/`get-in` return `nil` for a missing key — and `(count nil)` → 0,
`(map f nil)` → [], so a typo'd key can silently yield a plausible-but-wrong
result. When a key MUST exist, use the strict variants:

- `(get! m k)` — like `get`, but a missing key FAILS LOUD naming the key.
- `(get-in! m path)` — like `get-in`, but any missing path segment fails loud.

They are keyword/string/hyphen-aware exactly like `get`. A present key whose
value is `nil` is returned (only ABSENCE fails). A `get!` failure inside
`psettled` settles as `{:err …}` like any other element failure.

## Capability policy

Programs may call **read** and **write** tools (find, get, org, edit, create,
memory, todo_write, …). Tools that run external processes (`bash`, `task`) or
reach the network (`fetch`, `web_search`) are **denied by default** and surface
a policy error if called. Use those tools directly instead.

## Transactional file writes (all-or-nothing)

A program's **file** writes (`edit`, `create`) are transactional: they apply as
the program runs, but if the program **errors or `(fail …)`s** (and the failure
isn't caught by a `try`), every file it wrote is **rolled back** to its
pre-program state — a created file is removed, an
edited file is restored. A program that succeeds keeps its writes. So a
half-finished program never leaves the repo half-edited; fix the program and
re-run cleanly. (A hard crash mid-program self-heals on the next run.)

**Don't mix file writes with non-file mutations in one program.** `edit`/`create`
can roll back, but `org` set/update, `memory` save/note, `todo_write`, and
side-effecting `bash` **cannot** — so a program that mixes them is **rejected**
(if the file writes rolled back but the org/memory change didn't, you'd be left
inconsistent). Split such work: do the file edits in one program, the org/memory
mutation in another. (Reads of any tool — `org query`, `memory search`, `find`
— mix freely with file writes; reads need no rollback.)
