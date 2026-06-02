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

## Calling tools

Tools are called kebab-case with a string-keyed map; the result is a value:

```clojure
(tool/find {:target "src/**/*.rs::§line[text~=\"TODO\"]"})   ; → the find result
(tool/org  {:command "query" :query "todo:DOING"})           ; → org items
```

Structured tool results come back as data (maps/lists), so you can pipe them.

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
`str` `join` `split` `re-find` `re-seq` and the usual arithmetic/comparison.

## Gotchas (these will bite)

- `update-vals` is `(update-vals m f)` — thread with `->` (first), NOT `->>`.
- Tool args and the return value must be JSON-serializable (no closures).
- Signatures return **string-keyed** maps: `(get r "total")`, not `(:total r)`.
- A non-terminating loop hits an iteration/timeout limit and returns an error;
  the runtime survives — fix the program and re-run.

## Capability policy

Programs may call **read** and **write** tools (find, get, org, edit, create,
memory, todo_write, …). Tools that run external processes (`bash`, `task`) or
reach the network (`fetch`, `web_search`) are **denied by default** and surface
a policy error if called. Use those tools directly instead.
