# Where PtcRunner Shines: Worked Examples from Spell's Real Query Patterns

**Date**: 2026-05-30
**Source**: idiom frequencies mined from `~/.spell/agent/sessions/**` (see `00-evidence`)
**Premise**: with PtcRunner's aggregator/tool surface, a single PTC-Lisp program can
mix **bash commands**, **Spell tools** (find/edit/org/memory), and **MCP tools** —
computing the answer where the data sits instead of dragging it through context.

---

## The mixing model

PtcRunner programs call effects through one mediated builtin per source. The
sandbox stays pure; the host performs the effect and returns a value:

```clojure
(tool/call  {:tool "find"   :args {...}})   ; → Spell native tool (NIF in WS-B, bridge in V1)
(tool/call  {:tool "bash"   :args {:command "..."}})  ; → Spell bash executor (effect, mediated)
(tool/mcp-call {:server "..." :tool "..." :args {...}}) ; → any mounted MCP server
(:value ...)                                 ; unwrap the mediated result
```

So a program is a **typed pipeline over heterogeneous tools**. The model writes the
orchestration once; intermediate payloads never enter the context window.

> Notation below: `;; today` = the Bash idiom agents actually emit (with its measured
> frequency), `;; ptc` = the PtcRunner program that replaces it.

---

## 1. Count-and-group (idiom: `rg|wc` 1,007× · `rg -c` 91× · `sort|uniq` 319×)

```bash
;; today — three calls, model sums in its head, often wrong
rg -c "TODO" src/**/*.rs | awk -F: '{s+=$2} END{print s}'
```
```clojure
;; ptc — exact, one program, returns the number AND the hot files
(let [hits (:value (tool/call {:tool "find"
                               :args {:target "src/**/*.rs::§line[text~=\"TODO\"]"}}))]
  {:total (count hits)
   :by-file (->> hits (group-by :file) (map-vals count)
                 (sort-by val >) (take 5))})
```
Wins: the count is *computed*, not eyeballed; the per-file breakdown is free; raw
match lines never hit context.

## 2. find | xargs fan-out (idiom: 7,479×)

```bash
;; today — fan out, then the model reads each result back into context
find . -name '*.test.ts' | xargs grep -l 'skip(' | head -20
```
```clojure
;; ptc — fan-out + filter + shape, one answer back
(->> (:value (tool/call {:tool "find" :args {:target "**/*.test.ts"}}))
     (map :file)
     (filter (fn [f]
               (-> (tool/call {:tool "find"
                               :args {:target (str f "::§line[text~=\"skip(\"]")}})
                   :value seq)))
     (take 20))
```
Wins: the N inner reads stay in the sandbox; only the final file list returns.

## 3. git log post-processing (idiom: 3,485×)

```bash
;; today — model parses log text by eye to answer "who churned auth/ lately"
git log --since=2.weeks --pretty='%an' -- packages/auth | sort | uniq -c | sort -rn
```
```clojure
;; ptc — bash provides raw lines; PTC-Lisp does the aggregation deterministically
(->> (:value (tool/call {:tool "bash"
                         :args {:command "git log --since=2.weeks --pretty=%an -- packages/auth"}}))
     :stdout
     (#(clojure.string/split-lines %))
     (remove empty?)
     frequencies
     (sort-by val >))
;; → [["alice" 14] ["bob" 6] ...]  — bash for I/O, Lisp for the math
```
This is the canonical **mix**: bash is the right tool to *get* git data; PTC-Lisp is
the right tool to *reduce* it. Today both happen in shell + the model's head.

## 4. awk column math (idiom: 2,279×)

```bash
;; today — awk arithmetic the model can't verify, over tool output
du -sb packages/*/dist | awk '{s+=$1} END{print s/1048576 " MB"}'
```
```clojure
;; ptc
(let [lines (-> (tool/call {:tool "bash" :args {:command "du -sb packages/*/dist"}})
                :value :stdout clojure.string/split-lines)]
  (->> lines
       (map #(-> % (clojure.string/split #"\t") first Long/parseLong))
       (reduce + 0)
       (#(/ % 1048576.0))
       (format "%.1f MB")))
```

## 5. bash for-loops (idiom: 2,232×) — the procedural smell

```bash
;; today — imperative loop, results scroll past, model re-reads
for p in packages/*/; do echo "$p: $(find $p/src -name '*.ts' | wc -l)"; done
```
```clojure
;; ptc — declarative, sorted, capped
(->> (:value (tool/call {:tool "bash" :args {:command "ls -d packages/*/"}}))
     :stdout clojure.string/split-lines (remove empty?)
     (map (fn [p]
            [p (count (:value (tool/call {:tool "find"
                                          :args {:target (str p "src/**/*.ts")}})))]))
     (sort-by second >))
```

## 6. Org dashboard rollup (Spell tool, not bash — pure context-saver)

```clojure
;; today: agent runs `org query`, pulls 200 items into context, counts by eye
(->> (:value (tool/call {:tool "org" :args {:command "query" :query "todo:DOING"}}))
     (group-by #(get % "layer"))
     (map-vals (fn [g] {:open   (count g)
                        :hi-pri (count (filter #(= 1 (get % "priority")) g))
                        :blocked (count (filter #(seq (get % "blocked-by")) g))})))
;; → {"kernel" {:open 12 :hi-pri 4 :blocked 3} ...}  — ~40 tokens, not 200 items
```

## 7. Memory rerank + dedup before re-entry (Spell tool)

```clojure
;; trim a noisy memory.search down to the 5 best, distinct by title
(->> (:value (tool/call {:tool "memory" :args {:action "search" :text "lock liveness"}}))
     (sort-by #(get % "score") >)
     (dedupe-by #(get % "title"))
     (take 5)
     (map #(select-keys % ["id" "title" "score"])))
```

## 8. Cross-source JOIN: org × CI × git (Spell + MCP + bash in ONE program)

The case no single tool can answer — exactly where the mix pays:

```clojure
;; "for each DOING issue, is its branch green in CI and how stale is it?"
(->> (:value (tool/call {:tool "org" :args {:command "query" :query "todo:DOING"}}))
     (map (fn [it]
            (let [branch (get it "branch")
                  ci (:value (tool/mcp-call {:server "ci" :tool "status"
                                             :args {:branch branch}}))
                  age (-> (tool/call {:tool "bash"
                                      :args {:command (str "git log -1 --format=%cr origin/" branch)}})
                          :value :stdout clojure.string/trim)]
              {:id (get it "identifier")
               :ci (get ci "conclusion")
               :last-commit age})))
     (filter #(not= "success" (:ci %))))
;; org (Spell) + ci (MCP) + git (bash) joined; only the failing rows return
```

## 9. find graph edges → impact analysis (Spell semantic surface)

Post-fup-095 the semantic surface IS find/edit. PtcRunner can drive it:

```clojure
;; "which call sites break if I change this signature?" — computed, ranked by package
(->> (:value (tool/call {:tool "find"
                         :args {:target "packages/auth/src/token.ts::verify def\u2192"}}))
     (map :file)
     (group-by #(second (clojure.string/split % #"/")))   ; by package
     (map-vals count)
     (sort-by val >))
```

## 10. Schema-validated extraction (the output_schema contract)

```clojure
;; agent wants a typed object back, not prose — output_schema rejects malformed returns
;; program:
{:failing (->> (:value (tool/call {:tool "bash" :args {:command "bun test --reporter json"}}))
               :stdout json/parse
               (filter #(= "fail" (get % "status")))
               (map #(get % "name")))
 :count   ...}
;; output_schema: {failing [:string], count :int}  → caller gets a validated struct
```

---

## Why these specifically shine (the selection principle)

```
A pattern shines under PtcRunner when it is ANY of:
  · COUNT/AGGREGATE the model currently does by eye      (1,4,6)   → determinism
  · FAN-OUT whose intermediates flood context            (2,5,8)   → context saving
  · MIX of I/O-tool + reduction                           (3,4,8)   → bash for I/O, Lisp for math
  · CROSS-SOURCE JOIN no single tool answers             (8,9)     → composition
  · TYPED result the caller must trust                   (7,10)    → output_schema
Frequencies (from telemetry) rank the ROI:
  pipe|slice 103,672 · find|xargs 7,479 · git-log 3,485 · awk 2,279 · for-loop 2,232 · …
```

## What the mix unlocks that Bash alone cannot

```
bash alone   strings in, strings out; model is the parser AND the calculator
PtcRunner    values in, values out; bash/find/org/MCP are DATA SOURCES,
             PTC-Lisp is the typed reducer; the model only writes the pipeline
∴ the 82,013 pure-query Bash calls (31%) and the 103,672 pipe|slice idioms are the
  addressable market. Each is a program the model should WRITE ONCE, not a transcript
  it should READ BACK.
```

## Subscription boundary (answering "can PtcRunner use Spell subscriptions?")

No — and correctly so. `lisp_eval` is synchronous request/response; PTC-Lisp has no
event-await form (same design discipline as no-fs/no-net). Spell's subscription
surfaces — `subscribeKnowledge` (push frames: `index_changed`, `warm_completed`,
`evicted`, `heartbeat`, `lag`) and the task EventBus (`task:subagent:event`,
`task:subagent:progress`) — are consumed by the **Elixir host**, which folds the
event-derived state into the `context` it passes to `PtcRunner.run`. The program
sees a *snapshot*, never a stream.

```
Spell subscription ──(BEAM message)──► Elixir host state ──(snapshot)──► PtcRunner context
                                            │
                                   program computes over the snapshot, returns a value
```

This is the right factoring: streams are the orchestrator's concern (it's BEAM,
it's built for them); compute is the sandbox's concern (bounded, synchronous, pure).
A program that needs fresher data calls a tool again — it does not subscribe.
