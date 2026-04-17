# Token Usage Pareto Review

> Scope: recent session transcript sample across `bash`, `read`, `grep`, `org`.
"> Assumption: follow-on planning/implementation happens **after** `PLAN-239-bash-low-spill-artifact-policy-plan` lands, so this review treats that work as baseline rather than re-proposing it from scratch.

> Data source used in-session: `.local/token-usage/token-usage-review.data.js` and companion viewer `.local/token-usage/token-usage-review.html`.

> Important: percentages below are for the sampled 4-tool slice, not all possible tool traffic.

## Topline

- Total sampled tokens: ~256.1M
- Total sampled fresh input: ~6.54M
- Total sampled result chars: ~7.85M

### Tool share

| Tool | Token share | Fresh-input share | Result-char share | Main failure mode |
| --- | ---: | ---: | ---: | --- |
| `read` | 34.3% | 44.3% | 49.1% | over-ingestion of raw source/tests/logs |
| `bash` | 28.9% | 19.3% | 11.8% | repeated verification/polling/status churn |
| `org` | 21.5% | 18.6% | 22.4% | planning-state churn and repeated query/wave traffic |
| `grep` | 15.4% | 17.7% | 16.8% | broad exploratory search churn |

### Session concentration

- Top 3 sessions account for ~45.0% of sampled tokens.
- Top 4 sessions account for ~52.3% of sampled tokens.
- Concentration is high enough that category-level runtime policies should pay off quickly.

## Category Pareto

### Token Pareto

Top 10 category buckets account for ~83.3% of sampled tokens:

1. `read:source files` — 23.7%
2. `org:item mutation` — 11.1%
3. `bash:tests` — 10.5%
4. `grep:source search` — 8.3%
5. `bash:other` — 6.3%
6. `grep:other search` — 5.7%
7. `bash:git inspection/staging` — 4.9%
8. `read:tests` — 4.9%
9. `org:lookup/query` — 4.3%
10. `bash:verification/build` — 3.5%

### Fresh-input Pareto

Highest fresh-input categories:

- `read:source files` — 23.9%
- `grep:other search` — 9.4%
- `bash:other` — 6.9%
- `org:metadata` — 5.9%
- `org:lookup/query` — 5.7%
- `read:internal urls` — 5.0%

### Result-char Pareto

Largest visible output categories:

- `read:source files` — 25.7%
- `org:lookup/query` — 11.8%
- `read:spell state/logs` — 9.3%
- `org:planning graph` — 6.8%
- `grep:other search` — 6.6%
- `grep:source search` — 6.2%

## Tool-by-tool review

## 1. Bash

### What is actually useful

- Focused verification after a meaningful code change.
- Explicit deployment/build actions the user asked for.
- Targeted log inspection when narrowing a live failure.
- Fast truth checks when no specialized tool exists.

### What is leaking / low-value

- Repeated `mix test` / `bun test` / `mix precommit` loops with large similar outputs.
- `sleep 1` / `sleep 3` / waiting turns with effectively zero informational yield.
- Repeated `git status --short` / `git diff` / `git show` status churn.
- Transcript spelunking with `jq` over prior session JSONL files.
- Broad runtime/deploy commands whose full logs spill inline instead of summarizing + artifacting.
- Success-path verification output that is much larger than the actual decision needed (`pass/fail`, top failures, artifact URI).

### Strongest bash offenders observed

- `bash:tests` — 10.5% token share
- `bash:verification/build` — 3.5% token share
- `bash:git inspection/staging` — 4.9% token share
- `bash:other` — 6.3% token share
- `bash:sleep/wait` — 1.6% token share with near-zero result chars

### Bash implication after PLAN-239

`PLAN-239-bash-low-spill-artifact-policy-plan` should reduce the obvious spill path: long inline logs. After it lands, the remaining bash problems are more about **turn count**, **repetition**, and **success-path verbosity policy** than raw one-shot spill size.

### Post-PLAN-239 bash follow-ons implied by this review

- Kill `sleep`/poll patterns entirely; require background job + `await`.
- Add duplicate-command suppression for repeated verification/status calls when underlying state has not changed.
- Classify `git status`/`git diff`/`git show` as digest-first commands, not raw output commands.
- Treat transcript `jq` spelunking as a separate anti-pattern with compact summaries, not as ordinary bash.

## 2. Read

### What is actually useful

- Reading non-code files, internal URLs, directories, images/PDFs, and exact line ranges.
- Literal line-oriented inspection when AST/semantic tools are not the right fit.
- Reading a small targeted region after search has already narrowed the location.

### What is leaking / low-value

- Raw reading of source files that should have been `code outline` / `code read` / `lsp`.
- Reading large test files over and over as context rather than extracting only the relevant test or symbol.
- Reading `.spell` session JSONL / logs directly into the prompt.
- Reading `jobs://` repeatedly instead of using evented waiting or compact job summaries.
- Reading the same source file many times with little or no narrowing between calls.
- Reading docs/specs wholesale when only a section is needed.

### Strongest read offenders observed

- `read:source files` — 23.7% token share
- `read:tests` — 4.9% token share
- `read:internal urls` — 2.1% token share, 5.0% fresh input
- `read:spell state/logs` — only 0.34% tokens, but 9.3% of result chars
- Exact op: `read packages/coding-agent/test/tools/code.test.ts` — 3.46% token share by itself
- Exact op: `read jobs://` — 0.91% token share with tiny informational yield relative to cost

### Read implication

Read is the largest overall consumer. The problem is not the tool itself; the problem is using line-oriented raw reads as the default code-understanding path. The largest single fix area is **routing and narrowing**, not prettier truncation.

### Useful vs leaking boundary for read

Useful:

- non-code resources
- exact line ranges
- internal URLs where compact summaries suffice
- post-search confirmation on a small window

Leaking:

- unsupported use as generic code browser
- repeated giant source/test reads
- transcript/log dumps
- polling `jobs://` bodies repeatedly

## 3. Grep

### What is actually useful

- Fast lexical narrowing before reading a file.
- Locating candidate files/functions when syntax shape does not matter yet.
- Looking for exact strings, identifiers, error text, and config keys.
- Cross-file scoping before a semantic or structural follow-up.

### What is leaking / low-value

- Broad exploratory searches over large source areas with weak patterns.
- Workspace-wide or multi-path searches that return many matches but only a tiny visible summary.
- Re-running near-identical searches instead of refining the query/path.
- Using grep to hunt transcript/session details under `.spell` instead of purpose-built summarization.
- Searching docs/plans with giant pattern bags when a narrower section or org query would do.

### Strongest grep offenders observed

- `grep:source search` — 8.3% token share
- `grep:other search` — 5.7% token share, 9.4% fresh input
- `grep:spell transcripts/logs` is smaller in token share but still notable for avoidable noise
- Many exact grep ops consume ~260k–370k tokens and surface only ~29 chars in the final visible result

### Grep implication

Grep waste is mostly **breadth without staged narrowing**. The tool is doing work, but the transcript receives too much of the exploration path instead of a compact intermediate summary.

### Useful vs leaking boundary for grep

Useful:

- exact identifier / literal lookup
- narrow path + narrow regex
- quick file-hit discovery before deeper tools

Leaking:

- broad workspace probes with low-specificity patterns
- repeated exploratory search families
- transcript/log grep under `.spell`
- returning content-heavy match sets too early

## 4. Org

### What is actually useful

- Structured plan/task state.
- Creating durable artifacts with explicit scope, tests, implementation, dependencies, and acceptance criteria.
- Querying existing plans/tasks when deciding whether to revise or branch a plan.
- Wave/graph operations when sequencing genuinely matters.

### What is leaking / low-value

- High-frequency `create` / `update` / `set` churn where the useful result is just a compact success ack.
- Repeated `query` calls that return large bodies or many items when counts/IDs would suffice.
- Repeated `wave` / `graph` calls with large item listings.
- Metadata-heavy mutations whose outputs add little new information.
- Re-querying the same plan state with no change between calls.

### Strongest org offenders observed

- `org:item mutation` — 11.1% token share, tiny char share
- `org:lookup/query` — 4.3% token share, 11.8% char share
- `org:metadata` — 3.4% token share, 5.9% fresh input, tiny char share
- `org:planning graph` — 2.1% token share, 6.8% char share
- Exact op: `org wave` — ~0.92% token share itself

### Org implication

Org is a hidden tax: mutation chatter inflates tokens even when the displayed payload is short, while query/wave inflate visible context. The tool is useful, but its result formatting and repeated-call behavior need a compact mode and memoization strategy.

### Useful vs leaking boundary for org

Useful:

- durable plan creation
- one-time graph/wave computation when sequencing changes
- focused `get`/`query` for a specific item

Leaking:

- repeated broad query/wave refreshes
- mutation acknowledgements with more detail than needed
- large body renders when only IDs/headers changed

## Cross-tool conclusions

1. **The primary optimization unit is category behavior, not exact commands.** Top exact operations are diffuse; top categories are highly concentrated.
2. **`read` is the largest ingestion problem.** Any plan that frames bash as the only culprit is incomplete.
3. **`bash` is the clearest waste pattern tool.** After low-spill artifacting lands, its remaining problems are repetition, success-path verbosity, and sleep/poll churn.
4. **`grep` needs staged narrowing.** Its current pain is exploratory breadth.
5. **`org` needs compact result modes and repeated-call suppression.** It is a planning tax, not just a planning utility.
6. **Transcript/log spelunking deserves special treatment.** It appears across `bash`, `read`, and `grep`, so it should be handled as a cross-tool anti-pattern rather than a single-tool bug.

## Candidate policy bundles after PLAN-239

### Bundle A — source-aware routing
- default code understanding to `code`/`lsp`, not `read`
- preserve `read` for non-code and exact ranges

### Bundle B — bash churn suppression
- remove `sleep`
- digest-first status/test/build outputs
- repeated-command suppression when state unchanged

### Bundle C — grep staged narrowing
- file-hit summaries first
- force narrowing before large content dumps

### Bundle D — org compact mode
- compact mutation success acks
- summarized query/wave results by default
- memoize identical plan-state queries when files are unchanged

### Bundle E — memory persistence guardrails
- do not persist raw low-value tool outputs (especially transcript/log/status noise)
- persist summaries/diagnoses instead of raw bodies

## Open planning questions this review implies

1. Should the post-PLAN-239 work optimize for **token cost**, **fresh-input cost**, **turn count**, or **human readability** first?
2. For `read` on source files, should policy be a hard redirect to `code` or a soft redirect with explicit opt-out?
3. For `grep`, should broad workspace searches become a two-stage protocol by default, even if that changes current ergonomics?
4. For `org`, should compact result mode be global default or only in plan/execution phases?
5. Should transcript/session spelunking get a dedicated summarizer tool/path instead of happening through `bash`/`read`/`grep`?
6. Should memory persistence for tool results become category-aware instead of a flat length threshold?

## Bottom line

If only one thing is changed after PLAN-239, it should **not** be another bash-only tweak. The largest wins come from a combined plan:

- `read` source/test routing + narrowing
- bash churn suppression
- grep staged narrowing
- org compact/query memoization
- memory persistence guardrails

Treat this review as the factual baseline for the follow-on plan.