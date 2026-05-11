# Bug: `proxy_create` doubles the cwd prefix when path argument repeats it

## TL;DR

When the session cwd is `/home/user/code/ora/monorepo/apps/hotelcomm` and an agent calls `proxy_create` with `path: "apps/hotelcomm/design/foo/bar.png"`, the file is written to `apps/hotelcomm/apps/hotelcomm/design/foo/bar.png` (i.e., the cwd prefix is concatenated, not coalesced). The tool says "Created …" successfully so agents only notice when subsequent reads or `ls` fail.

Has been reproduced in **at least 6 independent agent sessions** over Wave 11 → Wave 13 (~10 days). Each agent had to detect + manually `mv` the file post-create.

## Steps to reproduce

```
1. cwd = /home/user/code/ora/monorepo/apps/hotelcomm
2. proxy_create { path: "apps/hotelcomm/design/wave-12/feat-274/screenshot.png", content: { kind: "base64", data: "..." } }
3. The created tool response reports success.
4. `ls apps/hotelcomm/design/wave-12/feat-274/` shows the file is NOT there.
5. `find . -name "screenshot.png"` finds it at `./apps/hotelcomm/apps/hotelcomm/design/wave-12/feat-274/screenshot.png`.
```

## Observed sessions where it leaked

| Agent / wave | Symptom |
|---|---|
| FEAT-271 (Wave 11) | Storybook fixtures file written to nested path; agent recovered manually |
| FEAT-274 (Wave 12) | 5 screenshots saved to nested `apps/hotelcomm/apps/hotelcomm/design/...`; agent manually moved them |
| FEAT-277 (Wave 12) | Same pattern — 7 timeline screenshots leaked |
| FEAT-278 (Wave 12) | Recovered before submit |
| FEAT-282 (Wave 13) | 9 thread-window-pill screenshots leaked; orchestrator manually `mv`-ed them |
| FEAT-289 (PLAN-013 parallel) | PMS reservations migration `.exs` written to nested path; not yet rescued |

In every case the agent's `unexpected_issues` JSON field flagged the same root cause: `"proxy_create / create tool saves screenshots to a nested apps/hotelcomm/apps/hotelcomm/ path when given a relative path from the apps/hotelcomm working directory."`

## Expected behaviour

The `path` arg in the tool's JSON-schema doc explicitly states:

> If a spec or AGENTS.md addresses files as `apps/foo/lib/...` from the monorepo root, and the session cwd is `apps/foo`, pass `lib/...` — not `apps/foo/lib/...`. Passing `apps/foo/lib/x.ts` while cwd is `apps/foo` is rejected with `cwd_prefix_duplication` (would silently nest at `apps/foo/apps/foo/lib/x.ts`).

So the documented behaviour is **rejection with diagnostic `cwd_prefix_duplication`**. The actual behaviour is **silent nesting** — the rejection logic appears to either not fire or only fire for some path shapes.

## Hypothesis on root cause

The guard probably checks if `path` starts with `<cwd-basename>/` (e.g. `hotelcomm/`) but not the full `cwd-relative-to-git-root` prefix (`apps/hotelcomm/`). When agents are dispatched with goal descriptions that reference files at monorepo-root-paths (`apps/hotelcomm/lib/...`), they pass those paths verbatim, which slips past the basename-only guard.

A fix should reject (or, kinder, coalesce) any `path` that starts with the cwd's path relative to the git root, where the git root is detected via `rev-parse --show-toplevel`.

## Reproducer (one-shot)

```bash
cd /tmp && mkdir -p repro/apps/svc && cd repro/apps/svc
# simulate agent dispatch context:
# cwd = /tmp/repro/apps/svc
# git root would be /tmp/repro
# agent passes a monorepo-root-relative path

cat > /tmp/proxy-create-call.json <<'JSON'
{ "path": "apps/svc/design/test.txt", "content": "hello" }
JSON
# Expected: tool rejects with cwd_prefix_duplication
# Actual: file created at /tmp/repro/apps/svc/apps/svc/design/test.txt
```

## Workarounds in place

1. Every agent dispatch context now warns: `"proxy_create may save to nested apps/hotelcomm/apps/hotelcomm/ — verify with ls after create"`.
2. Agents that hit it manually run `find -name X -path '*apps/hotelcomm/apps*'` and `mv` the file out.
3. The orchestrator's "settle commit" after each wave includes a `git mv` cleanup of any nested-apps leftovers.

These workarounds shouldn't be needed.

## Severity

**Medium-high.** Doesn't lose data (file IS created somewhere), but:

- It silently breaks browser-screenshot capture pipelines, where the agent thinks success and the orchestrator finds nothing.
- Every dispatched UI agent burns 2-3 minutes detecting + recovering.
- Some leaked files are never noticed (FEAT-289's migration is currently still at the nested path because no one has looked yet).
- The "silent" failure mode contradicts the tool's documented hard-fail contract.

## Suggested fix

1. **Compute cwd relative to git root** at tool entry (e.g. `Path.relative_to(cwd, git_root)` → `apps/hotelcomm`).
2. **Check if `path` starts with that string**. If yes, return `cwd_prefix_duplication` diagnostic AS DOCUMENTED.
3. **Better still**: emit a warning + auto-coalesce (strip the prefix) for the common case where the agent meant a monorepo-root path. Agents will keep doing this because their dispatch contexts naturally reference monorepo-root paths.

Either explicit rejection or auto-coalesce would fix this — both better than the current silent nest.

## Verification after fix

Run this in the spell coding harness:

```
# Setup
cwd = /home/user/code/ora/monorepo/apps/hotelcomm

# Call A — should succeed with file at <cwd>/lib/foo.ex
proxy_create { path: "lib/foo.ex", content: "..." }

# Call B — should reject OR auto-coalesce
proxy_create { path: "apps/hotelcomm/lib/foo.ex", content: "..." }
# expected: error cwd_prefix_duplication
# OR:      success at <cwd>/lib/foo.ex (NOT at <cwd>/apps/hotelcomm/lib/foo.ex)
```

Both calls must NOT produce a file at `<cwd>/apps/hotelcomm/lib/foo.ex`.
