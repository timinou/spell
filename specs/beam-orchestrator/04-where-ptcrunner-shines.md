# Where PtcRunner Shines: Worked Examples (verified, runnable)

**Date**: 2026-06-02 (rewritten from invented syntax to verified PTC-Lisp)
**Source**: every program here is the oracle in
`packages/coding-agent/src/tools/ptc-runtime/shines.integration.test.ts`, run
against a real `ptc_runner` BEAM. If you edit a program here, update that test
(and vice-versa) — they must stay identical.
**Premise**: with the `execute` tool, one PTC-Lisp program can mix **Spell
tools** (find/org/memory/…), **bash** output, and **MCP tools** — computing the
answer where the data sits instead of dragging it through context.

> ⚠ The earlier draft of this doc used `(tool/call {:tool …})`, `:value`
> unwrapping, and `map-vals` — **none of which exist** in PTC-Lisp. The forms
> below are the corrected, empirically-verified syntax.

---

## The real calling convention

```clojure
(tool/find {:target "src/**/*.rs"})    ; tool called kebab-case, string-keyed map arg
                                        ; → the tool's structured result (a map/list)
(get (tool/org {:command "query"}) "items")   ; results are STRING-keyed
```

No `tool/call` wrapper, no `:value` unwrap. A tool call *is* a value. Aggregate
with `group-by` + `update-vals` (thread-FIRST `->`), `frequencies`, `reduce`,
`sort-by`, `filter`, `map`.

---

## 1. Count + group (replaces `rg -c … | awk`)

```clojure
(let [hits (get (tool/find {:target "src/**/*.rs"}) "hits")]
  {:total (count hits)
   :by-file (update-vals (group-by (fn [h] (get h "file")) hits) count)})
;; → {"total" 3 "by-file" {"src/a.rs" 2 "src/b.rs" 1}}
```

Count is *computed*; the per-file breakdown is free; raw lines never hit context.

## 2. Fan-out filter (replaces `find … | xargs grep -l | head`)

```clojure
(->> (get (tool/files {}) "files")
     (filter (fn [x] (re-find #"test" x)))
     (take 20))
;; → ["a.test.ts" "c.test.ts"]
```

## 3. git log post-processing — bash for I/O, Lisp for the reduce

```clojure
(->> (get (tool/bash {:command "git log --pretty=%an"}) "stdout")
     (#(split % "\n"))
     (filter (fn [s] (not (empty? s))))
     frequencies)
;; → {"alice" 3 "bob" 2 "carol" 1}
```

The canonical **mix**: `bash` is the right tool to *get* git data; PTC-Lisp is
the right tool to *reduce* it. Today both happen in shell + the model's head.
(`bash` is `exec` — denied under the default policy; run it directly, or use a
permissive policy. See the capability-policy FUP.)

## 4. Numeric aggregate (replaces `du … | awk '{s+=$1}'`)

```clojure
(reduce + 0 (map (fn [r] (get r "bytes")) (get (tool/du {}) "rows")))
;; → 400
```

## 5. Declarative replacement for a bash `for` loop

```clojure
(->> (get (tool/org {:command "query"}) "items")
     (group-by (fn [it] (get it "layer")))
     (#(map (fn [[k g]] [k (count g)]) %))
     (sort-by second >))
;; → [["kernel" 3] ["ui" 2]]
```

## 6. Org dashboard rollup (pure context-saver)

```clojure
(update-vals
  (group-by (fn [it] (get it "layer"))
            (get (tool/org {:command "query" :query "todo:DOING"}) "items"))
  (fn [g]
    {:open (count g)
     :hi-pri (count (filter (fn [it] (= 1 (get it "priority"))) g))
     :blocked (count (filter (fn [it] (seq (get it "blocked-by"))) g))}))
;; → {"kernel" {"open" 3 "hi-pri" 2 "blocked" 1} "ui" {...}}
```

## 7. Memory rerank + dedup by title

There is **no `dedupe-by` builtin** — dedup by key via `group-by`/`vals`/`first`:

```clojure
(->> (get (tool/memory {:action "search" :text "lock liveness"}) "hits")
     (sort-by (fn [h] (get h "score")) >)
     (group-by (fn [h] (get h "title")))
     vals
     (map first)                                    ; one per title (the top-scored)
     (sort-by (fn [h] (get h "score")) >)
     (take 5)
     (map (fn [h] (select-keys h ["id" "title"]))))
;; → [{"id" "C1" "title" "lock liveness"} {"id" "C3" "title" "warm kernel"}]
```

## 8. Cross-source JOIN: org × CI (the case no single tool answers)

```clojure
(let [runs (get (tool/ci {}) "runs")
      pass-by-id (update-vals (group-by (fn [r] (get r "id")) runs)
                              (fn [g] (get (first g) "pass")))]
  (->> (get (tool/org {:command "query"}) "items")
       (filter (fn [it] (contains? pass-by-id (get it "identifier"))))
       (map (fn [it] {:id (get it "identifier")
                      :pass (get pass-by-id (get it "identifier"))}))
       (filter (fn [r] (not (get r "pass"))))))
;; → [{"id" "K-2" "pass" false}]   (only the failing rows)
```

`org` (Spell) joined with `ci` (an MCP tool) in ONE program; only failures
return. This is the thing the model currently fakes across many turns.

## 9. find graph edges → impact analysis

```clojure
(->> (get (tool/find {:target "x::verify def→"}) "hits")
     (map (fn [h] (get h "file")))
     (map (fn [f] (nth (split f "/") 1)))   ; 2nd path segment
     frequencies)
;; → {"a.rs" 2 "b.rs" 1}
```

Post-fup-095 the semantic surface IS find/edit; PtcRunner can drive `def→` and
rank the blast radius — computed, not eyeballed.

## 10. Signature-validated extraction (typed contract)

```clojure
;; program:
{:total (count (get (tool/org {:command "query"}) "items"))}
;; signature: {total :int}
;; → {"total" 5}   (validated; caller gets a typed struct)
```

---

## Why these shine (the selection principle)

```
A pattern shines under `execute` when it is ANY of:
  · COUNT/AGGREGATE the model currently does by eye      (1,4,6)   → determinism
  · FAN-OUT whose intermediates flood context            (2,5)     → context saving
  · MIX of I/O-tool + reduction                           (3,4)     → bash gets data, Lisp reduces
  · CROSS-SOURCE JOIN no single tool answers             (8,9)     → composition
  · TYPED result the caller must trust                   (7,10)    → signature
ROI (idiom frequencies, see 00-evidence): pipe|slice 103,672 · find|xargs 7,479 ·
git-log 3,485 · awk 2,279 · for-loop 2,232 · rg|wc 1,007 …
```

## Verified-syntax cheat-sheet (gotchas that bite)

```
(tool/name {...})              call; NOT (tool/call {:tool ...}); NO :value wrap
(update-vals m f)              thread-FIRST → ; map-vals does NOT exist
(group-by f coll)              f first, coll second
dedup-by-key                   (->> xs (group-by f) vals (map first))  ; no dedupe-by
results are STRING-keyed       (get r "items") / (get h "file"), not (:items r)
signatures return string maps  {total :int} → {"total" 5}
data/<key>                     reads the execute `context` map
(#(f % x) )                    anonymous fn for thread-last shape adjustments
```

## Subscription boundary (answering "can a program use Spell subscriptions?")

No — and correctly so. A program is synchronous request/response; PTC-Lisp has
no event-await form (same discipline as no-fs/no-net). Spell's subscriptions
(`subscribeKnowledge` push frames; the task EventBus) are consumed by the host,
which folds event-derived state into the `context` it passes to `execute`. The
program sees a *snapshot*, never a stream; it re-calls a tool for fresher data.

```
Spell subscription ──► host state ──(snapshot into execute context)──► program
                                          program computes, returns a value
```
