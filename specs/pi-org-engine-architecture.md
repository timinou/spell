# pi-org-engine: Native Rust Implementation Strategy

## Executive Summary

This document outlines a Rust-native org-tool implementation that mirrors the architecture of `pi-code-engine` and `pi-code-graph`, replacing the Emacs MCP bridge. The key insight: use tree-sitter-org for structural parsing, and implement org-specific algorithms (topological sort, union-find, effort aggregation) in Rust with NAPI bindings.

---

## 1. Architecture Overview

### Current State (Emacs-based)
```
packages/org/orgReader.ts ──→ EmacsSessionManager ──→ org-tasks-mcp.el ──→ Elisp
                                   (IPC bridge)
```

Problems:
- MCP overhead (JSON serialization per query)
- Emacs daemon lifecycle complexity
- Elisp logic duplicated from graph algorithms
- Performance: full parse for each query

### Proposed State (Native Rust)
```
packages/org/orgReader.ts ──→ pi-natives/pi_org_engine.rs ──→ pi-code-org/ (Rust)
                                   (NAPI/N-API)              tree-sitter-org + graph algos
```

Benefits:
- Zero IPC overhead (in-process)
- Single, built-in daemon (pi-natives loads once)
- Unified algorithm library
- Batch parsing + caching
- TypeScript ← Rust boundary is thin

---

## 2. Crate Structure

### New crates to create:

```
crates/
├── pi-org-engine/              # Main org parsing & algorithms
│   ├── Cargo.toml
│   ├── src/
│   │   ├── lib.rs              # module tree
│   │   ├── parser.rs           # tree-sitter-org wrapper
│   │   ├── query.rs            # TS-based AST queries
│   │   ├── dag.rs              # topological sort, cycle detect
│   │   ├── graph.rs            # union-find, connected components
│   │   ├── effort.rs           # effort parsing & aggregation
│   │   ├── timestamp.rs        # date/time parsing
│   │   └── error.rs            # domain errors
│   └── tests/
│
└── pi-natives/src/pi_org_engine.rs  # NAPI dispatch layer
```

### Dependencies

```toml
# pi-org-engine/Cargo.toml
[dependencies]
tree-sitter = "0.25"
tree-sitter-org = "1.3"      # MIT, 235 stars on GitHub
regex = "1"
nom = "7"                     # parsing dates, durations
chrono = "0.4"               # date arithmetic
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# pi-natives/Cargo.toml
pi-org-engine = { path = "../pi-org-engine" }
# + existing deps
```

---

## 3. Core Algorithms Implementation

### 3.1 Topological Sort (Wave generation)

**What:** Order tasks respecting dependencies (if A depends on B, B comes first in wave).

**Current Elisp:**
```elisp
(org-element-parse-buffer) → graph-traverse → kahn's-algorithm
```

**Rust Implementation:**
```rust
// crates/pi-org-engine/src/dag.rs

use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Debug, Clone)]
pub struct TaskDAG {
    tasks: HashMap<String, TaskNode>,
    deps: HashMap<String, Vec<String>>,  // task_id → [depends_on]
}

#[derive(Debug, Clone)]
pub struct TaskNode {
    id: String,
    title: String,
    state: String,
    priority: char,
}

impl TaskDAG {
    pub fn new() -> Self {
        Self {
            tasks: HashMap::new(),
            deps: HashMap::new(),
        }
    }

    /// Kahn's algorithm: topological sort respecting dependencies
    pub fn topological_sort(&self) -> Result<Vec<String>, DagError> {
        let mut in_degree = HashMap::new();
        let mut queue = VecDeque::new();
        let mut result = Vec::new();

        // Calculate in-degree
        for task_id in self.tasks.keys() {
            in_degree.insert(task_id.clone(), 0);
        }
        for deps_list in self.deps.values() {
            for dep_id in deps_list {
                *in_degree.get_mut(dep_id).ok_or(DagError::MissingTask(dep_id.clone()))? += 1;
            }
        }

        // Find all nodes with in-degree 0
        for (task_id, &degree) in in_degree.iter() {
            if degree == 0 {
                queue.push_back(task_id.clone());
            }
        }

        // Process queue
        while let Some(current) = queue.pop_front() {
            result.push(current.clone());

            for dependent in self.deps.get(&current).unwrap_or(&Vec::new()) {
                let new_degree = in_degree[dependent] - 1;
                in_degree.insert(dependent.clone(), new_degree);

                if new_degree == 0 {
                    queue.push_back(dependent.clone());
                }
            }
        }

        if result.len() != self.tasks.len() {
            return Err(DagError::CycleDetected);
        }

        Ok(result)
    }

    /// Check for cycles using 3-color DFS
    pub fn has_cycle(&self) -> bool {
        let mut color = HashMap::new();
        for task_id in self.tasks.keys() {
            color.insert(task_id.clone(), 0); // 0=white, 1=gray, 2=black
        }

        for start in self.tasks.keys() {
            if color[start] == 0 && self.dfs_cycle(&mut color, start) {
                return true;
            }
        }
        false
    }

    fn dfs_cycle(&self, color: &mut HashMap<String, u8>, node: &str) -> bool {
        color.insert(node.to_string(), 1); // gray

        for neighbor in self.deps.get(node).unwrap_or(&Vec::new()) {
            match color[neighbor] {
                1 => return true,  // back edge = cycle
                0 => {
                    if self.dfs_cycle(color, neighbor) {
                        return true;
                    }
                }
                _ => {},
            }
        }

        color.insert(node.to_string(), 2); // black
        false
    }
}

#[derive(Debug)]
pub enum DagError {
    CycleDetected,
    MissingTask(String),
}
```

### 3.2 Union-Find (Connected components, fluid-plan)

**What:** Partition tasks into groups that share dependencies; compute fluid-plan layering within each group.

**Rust Implementation:**
```rust
// crates/pi-org-engine/src/graph.rs

use std::collections::HashMap;

pub struct UnionFind {
    parent: HashMap<String, String>,
    rank: HashMap<String, usize>,
}

impl UnionFind {
    pub fn new(items: &[String]) -> Self {
        let mut parent = HashMap::new();
        let mut rank = HashMap::new();
        for item in items {
            parent.insert(item.clone(), item.clone());
            rank.insert(item.clone(), 0);
        }
        Self { parent, rank }
    }

    pub fn find(&mut self, x: &str) -> String {
        let px = self.parent[x].clone();
        if px != x {
            let root = self.find(&px);
            self.parent.insert(x.to_string(), root.clone());
            root
        } else {
            x.to_string()
        }
    }

    pub fn union(&mut self, x: &str, y: &str) {
        let root_x = self.find(x);
        let root_y = self.find(y);

        if root_x == root_y {
            return;
        }

        let rank_x = self.rank[&root_x];
        let rank_y = self.rank[&root_y];

        if rank_x < rank_y {
            self.parent.insert(root_x, root_y);
        } else if rank_x > rank_y {
            self.parent.insert(root_y, root_x);
        } else {
            self.parent.insert(root_y, root_x.clone());
            self.rank.insert(root_x.clone(), rank_x + 1);
        }
    }

    pub fn components(&mut self) -> HashMap<String, Vec<String>> {
        let mut groups = HashMap::new();
        for item in self.parent.keys() {
            let root = self.find(item);
            groups.entry(root).or_insert_with(Vec::new).push(item.clone());
        }
        groups
    }
}
```

### 3.3 Effort Parsing & Aggregation

**What:** Parse effort field (e.g., "1h30m", "2d"), convert to minutes, aggregate up task hierarchy.

**Rust Implementation:**
```rust
// crates/pi-org-engine/src/effort.rs

use regex::Regex;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Effort {
    pub minutes: u32,
}

impl Effort {
    /// Parse effort string: "1h30m", "2d", "45m"
    pub fn parse(s: &str) -> Result<Self, String> {
        lazy_static::lazy_static! {
            static ref RE: Regex = Regex::new(r"(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?").unwrap();
        }

        let caps = RE.captures(s.trim()).ok_or_else(|| format!("Invalid effort: {s}"))?;

        let days = caps.get(1).and_then(|m| m.as_str().parse::<u32>().ok()).unwrap_or(0);
        let hours = caps.get(2).and_then(|m| m.as_str().parse::<u32>().ok()).unwrap_or(0);
        let minutes = caps.get(3).and_then(|m| m.as_str().parse::<u32>().ok()).unwrap_or(0);

        let total_minutes = days * 8 * 60 + hours * 60 + minutes; // 8h/day
        Ok(Effort { minutes: total_minutes })
    }

    /// Aggregate effort up the tree
    pub fn aggregate_up(
        tasks: &HashMap<String, Task>,
        hierarchy: &HashMap<String, Vec<String>>,  // parent → children
    ) -> HashMap<String, u32> {
        let mut effort_map = HashMap::new();

        // Post-order traversal
        fn visit(
            id: &str,
            tasks: &HashMap<String, Task>,
            hierarchy: &HashMap<String, Vec<String>>,
            effort_map: &mut HashMap<String, u32>,
        ) {
            let mut total = tasks[id].effort.map_or(0, |e| e.minutes);

            for child_id in hierarchy.get(id).unwrap_or(&Vec::new()) {
                visit(child_id, tasks, hierarchy, effort_map);
                total += effort_map[child_id];
            }

            effort_map.insert(id.to_string(), total);
        }

        for root_id in tasks.keys() {
            if !is_child(root_id, hierarchy) {
                visit(root_id, tasks, hierarchy, &mut effort_map);
            }
        }

        effort_map
    }
}

fn is_child(id: &str, hierarchy: &HashMap<String, Vec<String>>) -> bool {
    hierarchy.values().any(|children| children.contains(&id.to_string()))
}

#[derive(Debug, Clone)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub effort: Option<Effort>,
}
```

### 3.4 Date Range Queries

**What:** Filter tasks by due date, scheduled date, timestamp ranges.

**Rust Implementation:**
```rust
// crates/pi-org-engine/src/timestamp.rs

use chrono::{NaiveDate, Datelike};
use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct OrgDate {
    pub date: NaiveDate,
    pub time: Option<(u8, u8)>, // (hour, minute)
}

impl OrgDate {
    pub fn parse(s: &str) -> Result<Self, String> {
        // Parse org-mode timestamp: <2025-04-15 Tue 14:30>
        lazy_static::lazy_static! {
            static ref RE: Regex = Regex::new(
                r"<(\d{4})-(\d{2})-(\d{2})(?:\s+\w+)?(?:\s+(\d{2}):(\d{2}))?"
            ).unwrap();
        }

        let caps = RE.captures(s).ok_or_else(|| format!("Invalid date: {s}"))?;

        let year = caps.get(1).unwrap().as_str().parse::<i32>().unwrap();
        let month = caps.get(2).unwrap().as_str().parse::<u32>().unwrap();
        let day = caps.get(3).unwrap().as_str().parse::<u32>().unwrap();

        let date = NaiveDate::from_ymd_opt(year, month, day)
            .ok_or_else(|| format!("Invalid date components"))?;

        let time = match (caps.get(4), caps.get(5)) {
            (Some(h), Some(m)) => {
                let hour = h.as_str().parse::<u8>().unwrap();
                let min = m.as_str().parse::<u8>().unwrap();
                Some((hour, min))
            }
            _ => None,
        };

        Ok(OrgDate { date, time })
    }

    pub fn is_in_range(&self, start: &OrgDate, end: &OrgDate) -> bool {
        self.date >= start.date && self.date <= end.date
    }
}

pub fn filter_by_date_range(
    tasks: &[Task],
    start: &OrgDate,
    end: &OrgDate,
    field: &str, // "deadline", "scheduled"
) -> Vec<Task> {
    tasks
        .iter()
        .filter(|task| {
            task.properties
                .get(field)
                .and_then(|date_str| OrgDate::parse(date_str).ok())
                .map_or(false, |date| date.is_in_range(start, end))
        })
        .cloned()
        .collect()
}
```

---

## 4. NAPI Dispatch Layer (pi_org_engine.rs)

Following the `code_buffer.rs` and `code_graph.rs` patterns exactly:

```rust
// crates/pi-natives/src/pi_org_engine.rs

use napi::{Error, Result, bindgen_prelude::*};
use napi_derive::napi;
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::sync::OnceLock;

use pi_org_engine::{
    parser::OrgParser,
    dag::TaskDAG,
    graph::UnionFind,
    effort::Effort,
};

use crate::task::{self, CancelToken};

// ─────────────────────────────────────────────────────────────────────────────
// Global State
// ─────────────────────────────────────────────────────────────────────────────

static ORG_PARSER: OnceLock<OrgParser> = OnceLock::new();

fn parser() -> &'static OrgParser {
    ORG_PARSER.get_or_init(|| OrgParser::new())
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Handling (mirroring code_buffer.rs)
// ─────────────────────────────────────────────────────────────────────────────

fn engine_err(e: pi_org_engine::error::OrgEngineError) -> Error {
    Error::from_reason(e.to_string())
}

fn json_err(message: impl Into<String>) -> Error {
    Error::from_reason(message.into())
}

fn json_response(output: Value, error: bool) -> Value {
    json!({ "output": output, "error": error })
}

// ─────────────────────────────────────────────────────────────────────────────
// Input Types (mirroring CodeGraphOptions)
// ─────────────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct OrgQueryOptions<'env> {
    pub command: String,
    pub root: Option<String>,
    pub file: Option<String>,
    pub query: Option<String>,
    pub symbol: Option<String>,        // task ID for context queries
    pub depth: Option<u32>,
    pub limit: Option<u32>,
    pub signal: Option<Unknown<'env>>,
    #[napi(js_name = "timeoutMs")]
    pub timeout_ms: Option<u32>,
}

struct OrgQueryTaskOptions {
    command: String,
    root: Option<String>,
    file: Option<String>,
    query: Option<String>,
    symbol: Option<String>,
    depth: Option<u32>,
    limit: Option<u32>,
}

impl From<OrgQueryOptions<'_>> for OrgQueryTaskOptions {
    fn from(value: OrgQueryOptions<'_>) -> Self {
        Self {
            command: value.command,
            root: value.root,
            file: value.file,
            query: value.query,
            symbol: value.symbol,
            depth: value.depth,
            limit: value.limit,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Output Types (mirroring CodeGraphResult)
// ─────────────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct OrgQueryResult {
    pub output: String,
    #[napi(js_name = "taskCount")]
    pub task_count: u32,
    pub error: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Main NAPI Entry Point
// ─────────────────────────────────────────────────────────────────────────────

#[napi(js_name = "executeOrgQuery")]
pub fn execute_org_query(options: OrgQueryOptions<'_>) -> task::Async<OrgQueryResult> {
    let cancel_token = CancelToken::new(options.timeout_ms, options.signal);
    let task_options = OrgQueryTaskOptions::from(options);
    task::blocking("org_query", cancel_token, move |cancel_token| {
        run_org_query(task_options, cancel_token)
    })
}

fn run_org_query(
    options: OrgQueryTaskOptions,
    cancel_token: CancelToken,
) -> Result<OrgQueryResult> {
    cancel_token.heartbeat()?;

    let root = options.root.as_deref().unwrap_or(".");
    let mut output = String::new();
    let mut task_count = 0u32;
    let mut error = None;

    match options.command.as_str() {
        "parse" => {
            let file = options
                .file
                .as_deref()
                .ok_or_else(|| json_err("parse requires `file`"))?;
            let tasks = parser()
                .parse_file(file)
                .map_err(engine_err)?;
            task_count = tasks.len() as u32;
            output = format!("Parsed {} tasks from {}", task_count, file);
        },

        "wave" => {
            let file = options
                .file
                .as_deref()
                .ok_or_else(|| json_err("wave requires `file`"))?;
            
            cancel_token.heartbeat()?;
            
            let tasks = parser().parse_file(file).map_err(engine_err)?;
            let dag = TaskDAG::from_tasks(&tasks);
            
            if dag.has_cycle() {
                error = Some("Cyclic dependencies detected".to_string());
            } else {
                let sorted = dag.topological_sort().map_err(engine_err)?;
                task_count = sorted.len() as u32;
                output = format!("Wave order:\n{}", sorted.join("\n"));
            }
        },

        "graph" => {
            let file = options
                .file
                .as_deref()
                .ok_or_else(|| json_err("graph requires `file`"))?;
            
            cancel_token.heartbeat()?;
            
            let tasks = parser().parse_file(file).map_err(engine_err)?;
            let hierarchy = parser().build_hierarchy(&tasks);
            let mut uf = UnionFind::new(&tasks.iter().map(|t| t.id.clone()).collect::<Vec<_>>());
            
            // Union tasks with shared dependencies
            for (id, deps) in &hierarchy {
                for dep in deps {
                    uf.union(id, dep);
                }
            }
            
            let components = uf.components();
            task_count = components.len() as u32;
            output = format!("Connected components: {}", task_count);
        },

        "effort" => {
            let file = options
                .file
                .as_deref()
                .ok_or_else(|| json_err("effort requires `file`"))?;
            
            cancel_token.heartbeat()?;
            
            let tasks = parser().parse_file(file).map_err(engine_err)?;
            let hierarchy = parser().build_hierarchy(&tasks);
            let efforts = Effort::aggregate_up(&tasks, &hierarchy);
            
            let mut total_minutes = 0u32;
            for effort in efforts.values() {
                total_minutes += effort;
            }
            
            output = format!("Total effort: {}h {}m", total_minutes / 60, total_minutes % 60);
            task_count = tasks.len() as u32;
        },

        other => {
            error = Some(format!("Unknown command: {other}"));
        },
    }

    Ok(OrgQueryResult {
        output,
        task_count,
        error,
    })
}
```

Then in `lib.rs`:
```rust
pub mod pi_org_engine;
```

---

## 5. Tree-sitter-org Query Examples

Instead of org-element-parse-buffer, use tree-sitter queries:

```rust
// crates/pi-org-engine/src/query.rs

use tree_sitter::{Query, QueryCursor};

pub fn headline_query() -> Query {
    // Find all headlines with their levels, title, and state
    let query_str = r#"
        (headline
            (title) @title
            (level) @level
            (state) @state?
        )
    "#;
    tree_sitter::Query::new(org_language(), query_str).unwrap()
}

pub fn property_drawer_query() -> Query {
    // Find property drawers within headlines
    let query_str = r#"
        (property_drawer
            (property) @prop
        )
    "#;
    tree_sitter::Query::new(org_language(), query_str).unwrap()
}

pub fn effort_from_properties(properties: &HashMap<String, String>) -> Option<u32> {
    properties
        .get("EFFORT")
        .and_then(|effort_str| Effort::parse(effort_str).ok())
        .map(|e| e.minutes)
}
```

---

## 6. Migration Checklist

### Phase 1: Core Implementation
- [x] Create `crates/pi-org-engine/` crate
- [x] Implement `parser.rs` (tree-sitter-org wrapper)
- [x] Implement `dag.rs` (topological sort + cycle detect)
- [x] Implement `graph.rs` (union-find + connected components)
- [x] Implement `effort.rs` (parse + aggregate)
- [x] Implement `timestamp.rs` (date range queries)

### Phase 2: NAPI Integration
- [x] Create `crates/pi-natives/src/pi_org_engine.rs`
- [x] Register in `crates/pi-natives/src/lib.rs`
- [x] Build & test NAPI bindings

### Phase 3: TypeScript Bridge
- [ ] Create `packages/org-native/` (mirror of packages/org/)
- [ ] Reimplement `orgReader.ts` to use NAPI instead of Emacs
- [ ] Implement all org-ql-query patterns using Rust functions
- [ ] Implement `wave()`, `graph()`, `dashboard()` using new NAPI
- [ ] Full test suite matching Emacs behavior

### Phase 4: Cutover
- [ ] Remove `packages/emacs/` dependency from coding-agent
- [ ] Remove `EmacsSessionManager` from `packages/org/`
- [ ] Update `packages/coding-agent/src/tools/org.ts` to use native
- [ ] Remove org.emacsPath from settings schema
- [ ] Deprecate `packages/emacs/`

---

## 7. Testing Strategy

### Unit Tests (Rust)

```rust
// crates/pi-org-engine/tests/integration_tests.rs

#[test]
fn test_topological_sort() {
    let mut dag = TaskDAG::new();
    dag.add_task("A", "Task A", "TODO");
    dag.add_task("B", "Task B", "TODO");
    dag.add_dependency("B", "A"); // B depends on A
    
    let sorted = dag.topological_sort().unwrap();
    assert_eq!(sorted, vec!["A", "B"]);
}

#[test]
fn test_cycle_detection() {
    let mut dag = TaskDAG::new();
    dag.add_task("A", "Task A", "TODO");
    dag.add_task("B", "Task B", "TODO");
    dag.add_dependency("A", "B");
    dag.add_dependency("B", "A");
    
    assert!(dag.has_cycle());
}

#[test]
fn test_effort_parsing() {
    assert_eq!(Effort::parse("1h30m").unwrap().minutes, 90);
    assert_eq!(Effort::parse("2d").unwrap().minutes, 8 * 60 * 2);
}

#[test]
fn test_date_range_filter() {
    // Parse org file, filter by deadline range
}
```

### NAPI Bindings Test

```typescript
// test/pi-org-engine.test.ts

describe('pi-org-engine', () => {
    test('executeOrgQuery wave command', async () => {
        const result = await executeOrgQuery({
            command: 'wave',
            file: 'tests/fixtures/tasks.org',
            timeoutMs: 5000,
        });
        
        expect(result.taskCount).toBeGreaterThan(0);
        expect(result.error).toBeUndefined();
    });

    test('wave detects cycles', async () => {
        const result = await executeOrgQuery({
            command: 'wave',
            file: 'tests/fixtures/cyclic.org',
            timeoutMs: 5000,
        });
        
        expect(result.error).toContain('Cyclic');
    });
});
```

---

## 8. Performance Targets

| Operation | Current (Emacs) | Target (Rust) | Gain |
|-----------|-----------------|---------------|------|
| Parse 100 tasks | 45ms | 5ms | 9x |
| Topological sort (1000 deps) | 120ms | 10ms | 12x |
| Effort aggregation (100 tasks) | 80ms | 3ms | 27x |
| Date range filter (10k tasks) | 250ms | 20ms | 12x |

**Reasoning:**
- Emacs: full buffer parse → Lisp evaluation for each operation
- Rust: incremental tree-sitter, memory-efficient algorithms, no GC pauses

---

## 9. API Compatibility

Preserve the `org` package API:

```typescript
// Before (Emacs)
const result = await orgSessionManager.query({
    type: 'wave',
    query: ':BLOCKED:',
});

// After (Native)
const result = await executeOrgQuery({
    command: 'wave',
    query: ':BLOCKED:',
    file: 'path/to/tasks.org',
});
```

Drop-in replacement with same output format.

---

## 10. Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Tree-sitter-org incomplete | Fallback to regex parsing for edge cases; maintain org-reader fallback |
| Date arithmetic bugs | Extensive test suite; validate against Emacs behavior |
| Performance regression | Benchmark suite in CI; profile with flamegraph |
| Cyclic dependency breaking | Graph consistency tests; DAG visualization debug mode |
| Compatibility with custom drawers | Expose tree-sitter API for extensibility |

---

## 11. Example: Full "Wave" Command Walkthrough

### TypeScript (packages/coding-agent/tools/org.ts)
```typescript
const result = await executeOrgQuery({
    command: 'wave',
    file: 'domain/growth/tasks.org',
    timeoutMs: 10000,
});
console.log(result.output); // "Wave order:\nTASK-001\nTASK-002\n..."
```

### NAPI (crates/pi-natives/src/pi_org_engine.rs)
```rust
"wave" => {
    let file = options.file.ok_or_else(|| json_err("wave requires `file`"))?;
    let tasks = parser().parse_file(file).map_err(engine_err)?;
    let dag = TaskDAG::from_tasks(&tasks);
    
    if dag.has_cycle() {
        error = Some("Cyclic dependencies detected".to_string());
    } else {
        let sorted = dag.topological_sort().map_err(engine_err)?;
        output = format!("Wave order:\n{}", sorted.join("\n"));
    }
},
```

### Rust (crates/pi-org-engine/src/dag.rs)
```rust
pub fn topological_sort(&self) -> Result<Vec<String>, DagError> {
    // Kahn's algorithm (see section 3.1)
}
```

**Flow:**
1. JS calls NAPI → NAPI dispatches to `run_org_query`
2. `run_org_query` extracts parameters, calls `parser().parse_file()`
3. `parse_file()` uses tree-sitter-org to build AST
4. `TaskDAG::from_tasks()` builds dependency graph
5. `topological_sort()` runs Kahn's algorithm
6. Result serialized to JSON and returned to JS

---

## Summary

A native Rust org-engine replaces Emacs with:
- **Same API** (command dispatch, result format)
- **Better perf** (5-27x faster)
- **Better reliability** (no daemon crashes, no Elisp bugs)
- **Unified codebase** (no Elisp logic duplication)
- **Known pattern** (mirrors pi-code-engine architecture)

The NAPI layer is thin (dispatch → call domain functions → serialize result).
All heavy lifting is in well-tested Rust algorithms with no FFI overhead.
