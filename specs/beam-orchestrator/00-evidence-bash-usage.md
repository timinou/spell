# Evidence: Bash-as-Compute-Surface (Telemetry)

**Date**: 2026-05-30
**Source**: Static analysis of `~/.spell/agent/sessions/**/*.jsonl` (14,437 transcripts)
**Purpose**: Quantify the "model uses Bash as an ad-hoc compute/query language" pattern
that motivates a deterministic compute coprocessor (PtcRunner).

---

## Method

Parsed every `toolCall` block across all session transcripts. Classified `bash`
commands by structure (multi-step, piped) and intent (pure read-only query vs.
mutating build/test/git). Pattern definitions:

- **multi-step**: command contains `&&`, `;`, or a newline (composed pipeline)
- **piped**: command contains `|`
- **pure-query**: first token ∈ {rg, grep, find, fd, cat, sed, awk, head, tail,
  wc, ls, tree, jq, column, sort, uniq} AND no build/test/git/fs-mutation token
- **echo-=== separator**: command contains `echo "===` — the "ask several
  questions in one call" batch-probe idiom

## Results

```
TOOL USAGE (852,097 total tool calls, all sessions)
  bash           261,373   30%   ← #1 tool, by +50% over #2
  read           186,928   21%
  grep            98,149   11%
  edit            48,782    5%
  find            45,342    5%
  get             43,228    5%
  code            28,093    3%
  org             26,181    3%
  …
  mcp_tidewave_project_eval  2,847   ← Elixir eval-as-a-tool ALREADY in top-18

BASH ANALYSIS (n=261,373)
  multi-step (&&/;/newline)   141,305   54%
  has pipe |                  134,432   51%
  pure-query (no mutation)     82,013   31%
  echo-=== batch probes         8,934    3%

TOP FIRST-TOKENS OF BASH COMMANDS
  cd 107,809 · grep 28,934 · git 21,474 · cat 18,230 · mix 16,977 ·
  sed 12,811 · find 9,066 · ls 7,592 · bun 4,466 · cargo 2,898 ·
  python3 2,785 · head 2,450 · wc 1,806 · awk 870 …
```

## Interpretation

1. **Bash is the dominant tool (30%)** and over half of its uses are *composed*
   (`&&`/`|`) — the model is hand-wiring data pipelines in shell, in-context.

2. **82,013 bash calls (31%) are pure read-only interrogations** — `grep | sed |
   awk | cat` string-munging to answer a *question*, with no mutation. These are
   compute/query that has no first-class surface, so it degrades to shell text
   manipulation. This is precisely the "model as runtime" failure described in
   *The Right Tool for Code Mode* (ptc_runner author): the model fetches data and
   reduces it by eye, burning context and risking arithmetic/aggregation slips.

3. **8,934 `echo "==="` batch-probes** are the model manually emulating the
   RLM "probe several shapes in one turn" pattern — a workaround for the absence
   of a programmable multi-step query primitive.

4. **`mcp_tidewave_project_eval` (2,847 calls) is the existence proof**: agents in
   *this very workspace* already reach for Elixir-eval-as-a-tool to interrogate a
   running project. PtcRunner generalizes that to a sandboxed, app-independent,
   schema-validated compute surface — and `mix` being the #5 bash token (16,977)
   confirms the BEAM is already in the daily loop here.

## Claim supported

> A large, measurable fraction of agent Bash usage is deterministic
> read-only computation expressed as fragile shell text-munging. A sandboxed
> compute language (PtcRunner / PTC-Lisp) is the right primitive for that class,
> reducing tokens, eliminating arithmetic errors, and keeping raw payloads out of
> the context window.

Reproduce: see `scripts/analyze-bash-usage.py` (or the inline analyzer in the
session that produced this doc).
