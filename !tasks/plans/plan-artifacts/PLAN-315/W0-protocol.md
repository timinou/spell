# PLAN-315 W0 — Protocol v2 design doc

## Wire format

Line-delimited JSON over `AF_UNIX` SOCK_STREAM. Existing daemon at `$XDG_RUNTIME_DIR/spell/embed.sock` → `$XDG_RUNTIME_DIR/spell/knowledge.sock` (rename). Both names bound during transition; old name resolves to same daemon for one release.

Each frame ends in `\n`. Frames are JSON objects.

### Request → Response (existing)

```jsonc
// → {"command": "init"}
// ← {"ok": true, "initialized": true, "protocol_version": 2, "supported_commands": [...]}

// → {"command": "embed_batch", "texts": [...], "batch_size": 32}
// ← {"ok": true, "vectors": [[...], ...]}

// → {"command": "embed_query", "text": "..."}
// ← {"ok": true, "vector": [...]}
```

### Request → Response (W1 new)

```jsonc
// → {"command": "open", "repo_root": "/abs/path", "include_personal": false, "lanes": ["org_memory", "code_graph"]}
// ← {"ok": true, "repo_handle": "fnv:abc123def", "warm": false, "lanes": ["org_memory", "code_graph"]}

// → {"command": "close", "repo_handle": "fnv:abc123def"}
// ← {"ok": true}

// → {"command": "stats", "repo_handle": null}
// ← {"ok": true, "daemon_rss_bytes": 1234567890, "repos": [{"handle": "...", "lane": "...", "items": 1234, "last_used_ms_ago": 12000}], "embedder": {"model": "bge-m3", "dim": 1024}}
```

### Request → Response (W2 org/memory)

```jsonc
// → {"command": "search", "repo_handle": "...", "text": "...", "scope": ["concept"], "limit": 20, "include_personal": false, "scope_personal_only": false, "profile": null, "focus": null, "hops": 0}
// ← {"ok": true, "hits": [{"id": "CON-foo", "score": 0.87, "kind": "concept", "title": "...", "excerpt": "...", "source": "repo"}, ...]}

// → {"command": "about", "repo_handle": "...", "id": "CON-foo"}
// ← {"ok": true, "node": {...}, "neighbors": [{"id": "...", "via": {"kind": "ABOUT", "direction": "out"}, ...}], "lineage": [...]}

// → {"command": "neighbors", "repo_handle": "...", "focus": "CON-foo", "hops": 2, "kinds": ["ABOUT", "DISTILLED_FROM"]}
// ← {"ok": true, "nodes": [...], "edges": [...]}

// → {"command": "since", "repo_handle": "...", "ts": "2026-05-01T00:00:00Z"}
// ← {"ok": true, "items": [...]}
```

### Request → Response (W3 code-graph)

```jsonc
// → {"command": "cg_search", "repo_handle": "...", "query": "parseConfig", "kind": "hybrid", "limit": 20}
// ← {"ok": true, "hits": [{"symbol_id": "...", "file": "...", "line": 123, "score": 0.92, ...}]}

// → {"command": "cg_definition", "repo_handle": "...", "symbol_id": "..."}
// → {"command": "cg_references", "repo_handle": "...", "symbol_id": "..."}
// → {"command": "cg_callers",    "repo_handle": "...", "symbol_id": "..."}
```

### Subscription (W4)

After connection-init, the client may upgrade to a streaming bidirectional channel:

```jsonc
// → {"command": "subscribe", "repo_handles": ["..."], "lanes": ["org_memory"]}
// ← {"ok": true, "subscription_id": "..."}
// (channel stays open; daemon may push events)
// ← {"event": "index_changed", "repo_handle": "...", "lane": "...", "fingerprint": "..."}
// ← {"event": "warm_completed", "repo_handle": "...", "lane": "...", "ms": 4321}
// ← {"event": "evicted",        "repo_handle": "...", "reason": "idle_ttl"}
// ← {"event": "heartbeat",      "ts": "..."}
// ← {"event": "lag",            "dropped": N}

// → {"command": "unsubscribe", "subscription_id": "..."}
// → {"command": "search", "request_id": "r-42", ...}  // queries interleave; tagged with request_id
// ← {"ok": true, "request_id": "r-42", "hits": [...]}
```

Backpressure: bounded channel of 256 events per subscriber; drop oldest + emit `event: lag`.

Heartbeat: every 30s. Client closes connection after 90s without heartbeat.

## Error frame

```jsonc
// ← {"ok": false, "error": "human-readable", "code": "ENUM_VARIANT", "request_id": "..."}
```

Error codes:
- `NOT_INITIALIZED` — `init` not called
- `UNKNOWN_REPO_HANDLE` — `open` not called for this handle
- `LANE_NOT_OPEN` — handle valid but requested lane not opened
- `PROTOCOL_VERSION_MISMATCH` — client unhappy with version
- `INDEX_BUILD_FAILED` — internal error during warm
- `EMBEDDER_UNAVAILABLE` — model load failed
- `MALFORMED` — JSON parse / schema mismatch
- `INTERNAL` — generic, with stack in `error`

## Version negotiation

1. Client connects, sends `init`.
2. Daemon replies with `protocol_version: 2` and `supported_commands: [...]`.
3. Client compares: if v ≥ required → proceed; else disconnect, fall back to in-process WarmEngine.
4. `supported_commands` array makes feature detection forward-compatible (client uses `open` only if listed).

## RepoCache identity

`repo_handle = "fnv:" + fnv1a_64_hex(canonicalize(repo_root).to_string())`

Same hash function as PLAN-310 W1.5 F6. Stable across daemon restarts; the on-disk cache layout uses the same hash. Multiple `open` for the same `repo_root` → same handle, idempotent.

## LRU eviction policy

Daemon-wide:
- `KNOWLEDGE_MAX_WARM_REPOS` (default 8): max simultaneously-warm repos
- `KNOWLEDGE_IDLE_TTL_SECS` (default 1800): evict if no query for this long

When opening exceeds cap → evict LRU; emit `event: evicted` to subscribers.

Per-lane within a repo: independent eviction so a code-graph-only client doesn't unload the org-memory lane another client is using.

## Concurrency model

- One Tokio task per accepted connection
- `RepoCache: Arc<DashMap<RepoHandle, Arc<RepoSlot>>>`
- `RepoSlot { lanes: HashMap<Lane, Arc<RwLock<LaneState>>>, last_used: AtomicU64, fingerprint }`
- Queries acquire `lane.read()` — concurrent readers
- Ingest acquires `lane.write()` — exclusive; broadcast event on release
- LRU sweeper runs in its own task every 60s

## Auto-spawn

Unchanged from PLAN-310 W3:
- Client connects to socket; on `ECONNREFUSED` / `ENOENT`, forks daemon (`pi-knowledge-worker --socket <path> --pidfile <path> --idle-secs 1800 --daemonize`)
- Waits up to 5s for pidfile to appear; polls socket every 25ms
- Pidfile uses `fd-lock` to guarantee one daemon per user

## Fallback to in-process

If daemon spawn fails or `PI_KNOWLEDGE_WORKER=inprocess`, client falls back to in-process WarmEngine. Through W4, both paths are first-class. W5 removes in-process for normal operation; `inprocess` env stays as a debug/CI escape.
