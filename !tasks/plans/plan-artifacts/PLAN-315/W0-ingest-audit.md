# PLAN-315 W0 — Notify watcher topology audit

Goal: catalogue every `notify::Watcher` instantiation in the workspace. Confirm zero overlap before W4 collapses them into the daemon's per-repo watcher.

## Current watchers

| crate | file | scope | trigger | consumer |
|-------|------|-------|---------|----------|
| `pi-knowledge-core` | `src/ingest.rs:25` | per repo_root | `.org` / `.spell/memory/**/*.org` | `watch_and_rebuild` → `RecallEngineHandle::ensure_warm` (in-process, per-session today) |
| `pi-code-engine` | `src/watcher.rs:10` | per repo_root | source-code files matching language registry | code-graph indexer (per-session) |

Two distinct watchers per session today. With 10 sessions on same repo = 20 watchers = 20 inotify slots consumed.

## Post-PLAN-315 topology

Watchers move into the daemon, one of each per repo (not per session):

```
pi-knowledge-worker daemon
├─ per repo_handle:
│   ├─ ingest::watch_and_rebuild     ← org/memory lane
│   └─ code-engine watcher           ← code-graph lane
└─ broadcasts → all subscribed sessions
```

Sessions: 0 watchers. Daemon: 2 watchers per warm repo, max 8 warm = 16 inotify slots total.

## Inotify cost (Linux)

- Per-watch syscall cost: negligible
- Per-watch kernel memory: ~1 KB
- `fs.inotify.max_user_watches` default: 8192 (Linux ≥ 5.11)

Before: 20 sessions × 2 watchers × N repos. After: 2 watchers × 8 max-warm repos = 16. Headroom: ≈ 99.8% of inotify quota recovered.

## Race window

Sessions making concurrent edits via `edit` tool write files; daemon's watcher fires. Between fs::write completion and watcher dispatch (typically < 5 ms), a session query may see stale results. Push-subscribe model (W4) closes the gap: client receives `index_changed` and may force re-issue.

## Zero-overlap claim

Confirmed: the two watchers have disjoint file globs (`.org` files vs source code via language registry). No double-fire on the same file. Daemon-side: same disjoint structure; ingest::watch_and_rebuild registers only `.org`; code-engine watcher registers only source files known to the language registry.
