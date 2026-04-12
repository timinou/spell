# Org Algorithm Specifications for Rust Implementation

## Overview
This document provides complete algorithmic specifications for the three core graph operations used by the org tool. These algorithms are currently implemented in Elisp (`packages/org/elisp/tools/`) and must be reimplemented as native Rust functions for the `pi-org-engine` crate.

---

## 1. DEPENDENCY GRAPH ALGORITHM

### Purpose
Build a directed acyclic graph (DAG) from task dependencies, detect cycles, and serialize to JSON for visualization/analysis.

### Input Format
**Source**: Org task items with two properties:
- `DEPENDS`: Space-separated list of task IDs that this task depends on
- `BLOCKS`: Space-separated list of task IDs that this task blocks

Example:
```
* ITEM Task A
:PROPERTIES:
:CUSTOM_ID: TASK-001
:DEPENDS: TASK-002 TASK-003
:BLOCKS: TASK-004
:END:
```

**Data Structure** (from `org-tasks.el`):
```elisp
;; Item alist with fields:
((custom_id . "TASK-001")
 (title . "Task A")
 (state . "ITEM")
 (depends . "TASK-002 TASK-003")  ;; String (space-separated)
 (blocks . "TASK-004"))
```

### Algorithm: DAG Construction

1. **Parse Properties** (`org-mcp--parse-space-separated`)
   - Take DEPENDS and BLOCKS properties (strings)
   - Split on whitespace regex `[ \t]+`
   - Filter empty strings

2. **Build Edge List** (`org-mcp--build-edges`)
   - For each task:
     - Parse DEPENDS: create edges `dep -> this_task` (type: "depends")
     - Parse BLOCKS: create edges `this_task -> blocked_task` (type: "blocks")
   - Only add edges where both nodes exist (validate against known ID set)
   - Discard external dependencies (references to items outside the graph)

3. **Edge Semantics**
   - DEPENDS: "this task depends on X" → edge from X to this task
   - BLOCKS: "this task blocks Y" → edge from this task to Y
   - Final edge direction: `from=dependency, to=dependent`
   - Example: "B depends on A" → edge `{from: "A", to: "B", type: "depends"}`

### Algorithm: Cycle Detection

**Method**: 3-color DFS (Recursive)

Colors:
- **WHITE** (unvisited): Not yet encountered
- **GRAY** (in-stack): Currently being visited (on DFS path)
- **BLACK** (visited): Finished with all descendants

**Pseudocode**:
```
function detect_cycles(nodes, edges):
  adj = build_adjacency_list(nodes, edges)  // node_id -> [successor_ids]
  visited = {}
  rec_stack = {}
  cycles = []
  
  for each node_id in nodes:
    if node_id not in visited:
      dfs_visit(node_id, adj, visited, rec_stack, cycles)
  
  return cycles

function dfs_visit(node, adj, visited, rec_stack, cycles):
  visited[node] = true
  rec_stack[node] = true
  
  for each neighbor in adj[node]:
    if neighbor in rec_stack:
      // Found back edge (cycle)
      cycle = extract_cycle_path(rec_stack, neighbor)
      cycles.append(cycle)
    else if neighbor not in visited:
      dfs_visit(neighbor, adj, visited, rec_stack, cycles)
  
  delete rec_stack[node]  // Mark as finished
```

**Cycle Extraction**: When a back edge is found (neighbor is in rec_stack), trace back from neighbor to current node to extract the cycle path.

**Edge Cases**:
- Multiple cycles: Function finds all of them
- Self-loops: Detected as single-node cycles
- Disconnected components: All are checked

### Output Format

```json
{
  "nodes": [
    {
      "custom_id": "TASK-001",
      "title": "Task A",
      "state": "ITEM"
    }
  ],
  "edges": [
    {
      "from": "TASK-002",
      "to": "TASK-001",
      "type": "depends"
    }
  ],
  "cycles": [
    ["TASK-001", "TASK-002", "TASK-003", "TASK-001"]
  ]
}
```

Notes:
- Nodes are stripped of DEPENDS/BLOCKS properties in output
- Cycles are represented as lists of node IDs (closing with first node repeated)
- Empty cycles array means the graph is acyclic

---

## 2. NEXT WAVE ALGORITHM

### Purpose
Compute the next execution wave: topologically sorted items whose all dependencies are satisfied (DONE), sorted by priority, capped at 8 items.

### Input Format
Same as dependency graph: collection of task items with:
- `custom_id`: Unique ID
- `state`: TODO state ("INIT", "ITEM", "DOING", "REVIEW", "DONE", "BLOCKED")
- `depends`: Space-separated dependency IDs
- `priority`: Single character ("A", "B", "C") or empty
- `effort`: Duration string (e.g., "2h", "30m", "1d")

### Algorithm: Wave Computation

**Phase 1: Build Dependency Map**
```
dep_map = {}
for each item:
  for each dependency_id in item.depends:
    if dependency_id not in dep_map:
      dep_map[dependency_id] = []
    dep_map[dependency_id].append(item.custom_id)
```

Maps each ID → list of IDs that depend on it.

**Phase 2: Build State Map**
```
state_map = {}
completed_count = 0
for each item:
  state_map[item.custom_id] = item.state
  if item.state == "DONE":
    completed_count += 1
```

**Phase 3: Filter Wave Candidates**
```
wave_items = []
blocked_items = []

for each item:
  state = state_map[item.custom_id]
  
  if state in ("DONE", "BLOCKED"):
    skip  // Don't include in wave or blocked_items
  elif all_dependencies_done(item.custom_id, dep_map, state_map):
    wave_items.append(item)
  else:
    blocked_items.append(item)

function all_dependencies_done(id, dep_map, state_map):
  deps = dep_map.get(id, [])
  if not deps:
    return true  // No dependencies
  return all(state_map[dep] == "DONE" for dep in deps)
```

**Phase 4: Sort by Priority**
```
priority_value = {
  "A": 0,
  "B": 1,
  "C": 2,
  None: 3  // No priority = lowest
}

wave_items.sort(
  key=lambda item: (
    priority_value[item.priority],
    item.custom_id  // Secondary sort: alphabetical stability
  )
)
```

**Phase 5: Cap at 8 items**
```
wave_items = wave_items[0:8]
```

### Algorithm: Wave Number Computation

Determines the current execution front (how many complete waves have passed).

**Pseudocode**:
```
function compute_wave_number(items, dep_map, state_map):
  item_wave = {}
  
  // Initialize: all items start at wave 1
  for each item in items:
    item_wave[item.custom_id] = 1
  
  // Iteratively propagate: wave N+1 = max(deps' waves) + 1
  changed = true
  while changed:
    changed = false
    for each item in items:
      id = item.custom_id
      deps = dep_map.get(id, [])
      max_dep_wave = max([item_wave.get(d, 1) for d in deps], default=0)
      
      new_wave = max_dep_wave + 1 if deps else 1
      
      if new_wave != item_wave[id]:
        item_wave[id] = new_wave
        changed = true
  
  // Find highest complete wave (all items in it are DONE)
  waves_complete = {}
  for each item in items:
    wave = item_wave[item.custom_id]
    state = state_map[item.custom_id]
    
    if wave not in waves_complete:
      waves_complete[wave] = true
    if state != "DONE":
      waves_complete[wave] = false
  
  max_done_wave = max([w for w, complete in waves_complete.items() if complete], default=0)
  return max_done_wave + 1  // Next wave
```

### Output Format

```json
{
  "wave_number": 3,
  "items": [
    {
      "custom_id": "TASK-001",
      "title": "Task A",
      "state": "ITEM",
      "priority": "A",
      "effort": "2h",
      "agent": "alice",
      "layer": "backend"
    }
  ],
  "blocked_items": [
    {
      "custom_id": "TASK-002",
      "title": "Task B",
      "state": "ITEM"
    }
  ],
  "completed_count": 15,
  "total_count": 23
}
```

Constraints:
- `items` array length ≤ 8
- Items in `items` have state ∉ {"DONE", "BLOCKED"}
- All dependencies of items in `items` have state == "DONE"
- Items sorted by priority (A < B < C), then ID
- `blocked_items` are items not DONE/BLOCKED but blocked by dependencies
- `wave_number` = 1 + (highest complete wave)

---

## 3. FLUID PLAN ALGORITHM

### Purpose
Convert a PLAN item (which links to multiple tasks) into a parallelizable execution structure with connected components, dependency ordering, and wave layers.

### Input Format

**PLAN Item** (from org file):
```
* DOING Feature Integration Plan
:PROPERTIES:
:CUSTOM_ID: PLAN-001
:END:

Plan body with links to tasks:
- [[id:TASK-001]]
- [[id:TASK-002]]
- [[id:TASK-003]]
```

Extract child IDs using regex: `\[\[id:([^\]]+)\]\]`

**Linked Items**: Same as other algorithms (custom_id, state, depends, effort, priority, layer, body)

### Algorithm: Phase 1 - Union-Find (Connected Components)

Used to partition the dependency graph into disconnected subgraphs.

**Data Structure**:
```
UnionFind {
  parent: Map<id, id>      // parent[x] = root of set containing x
  rank: Map<id, int>        // rank for union by rank optimization
}
```

**Operations**:

```
function make_union_find(ids):
  uf = UnionFind()
  for each id in ids:
    uf.parent[id] = id
    uf.rank[id] = 0
  return uf

function find(uf, id):
  // Find with path compression
  root = uf.parent[id]
  if root == id:
    return id
  
  uf.parent[id] = find(uf, root)  // Compress path
  return uf.parent[id]

function union(uf, a, b):
  // Union by rank
  root_a = find(uf, a)
  root_b = find(uf, b)
  
  if root_a == root_b:
    return  // Already in same set
  
  rank_a = uf.rank[root_a]
  rank_b = uf.rank[root_b]
  
  if rank_a < rank_b:
    uf.parent[root_a] = root_b
  else if rank_a > rank_b:
    uf.parent[root_b] = root_a
  else:
    uf.parent[root_b] = root_a
    uf.rank[root_a] += 1
```

**Component Extraction**:
```
function extract_components(uf, all_ids):
  components = {}
  for each id in all_ids:
    root = find(uf, id)
    if root not in components:
      components[root] = []
    components[root].append(id)
  return components
```

### Algorithm: Phase 2 - Cycle Detection (Same as Graph Algorithm)

Apply 3-color DFS to each connected component to ensure acyclicity.

### Algorithm: Phase 3 - Wave Computation (Kahn's Algorithm)

Compute topological layers **per component** using Kahn's algorithm.

```
function compute_waves(component_ids, adj_forward):
  // adj_forward: id -> [ids_that_depend_on_it]
  // (reverse of dependency direction)
  
  in_degree = {}
  
  // Initialize in-degree for component items only
  for each id in component_ids:
    in_degree[id] = 0
  
  // Count in-degree from adjacency
  for each id in component_ids:
    for each successor in adj_forward[id]:
      if successor in component_ids:
        in_degree[successor] += 1
  
  // Kahn's algorithm: process wave by wave
  waves = []
  queue = []
  wave_num = 0
  
  // Seed with in-degree 0 nodes
  for each id in component_ids:
    if in_degree[id] == 0:
      queue.append(id)
  
  queue.sort()  // Alphabetical for determinism
  
  while queue not empty:
    wave_num += 1
    next_queue = []
    
    waves.append({
      "number": wave_num,
      "items": queue  // Copy of current queue
    })
    
    for each id in queue:
      for each successor in adj_forward[id]:
        if successor in component_ids:
          in_degree[successor] -= 1
          if in_degree[successor] == 0:
            next_queue.append(successor)
    
    queue = sort(next_queue)
  
  return waves
```

**Key Points**:
- Only process edges **within** the component
- Initialize with nodes that have no unmet dependencies
- Process items in alphabetical order for determinism
- Each wave contains items executable in parallel

### Algorithm: Phase 4 - Item Resolution

Collect full item data for each resolved ID:

```
function resolve_plan_items(files, plan_id, component_ids):
  items_table = {}
  
  for each file in files:
    parse org file, for each heading:
      custom_id = extract_property(heading, "CUSTOM_ID")
      if custom_id in component_ids:
        items_table[custom_id] = {
          "custom_id": custom_id,
          "title": heading.raw_value,
          "state": heading.todo_keyword,
          "depends": parse_space_separated(extract_property(heading, "DEPENDS")),
          "effort": extract_property(heading, "EFFORT"),
          "priority": heading.priority,
          "layer": extract_property(heading, "LAYER"),
          "body": extract_body(heading)
        }
  
  return items_table
```

**Special Case - Hierarchical IDs** (`parent::child` syntax):
```
If direct CUSTOM_ID lookup fails for ID containing "::",
split into (parent_id, sub_slug):
  - Find parent heading with parent_id
  - Search its children for one with title slug matching sub_slug
  - Use that heading's body as the resolved item
```

### Algorithm: Phase 5 - FluidPlan Assembly

Combine all components into final JSON structure:

```
function build_fluid_plan(files, plan_id):
  // 1. Find PLAN item and extract child IDs
  plan_body = find_plan_body(files, plan_id)
  child_ids = extract_plan_child_ids(plan_body)  // [[id:...]] links
  
  // 2. Resolve items across files
  items_table = collect_items_by_ids(files, child_ids)
  resolved_ids = items_table.keys()
  
  // 3. Build adjacency and validate
  adj_forward = {}
  adj_deps = {}
  id_set = {}
  
  for each id in resolved_ids:
    adj_forward[id] = []
    adj_deps[id] = []
    id_set[id] = true
  
  warnings = []
  for each id in resolved_ids:
    item = items_table[id]
    for each dep in item.depends:
      if dep in id_set:
        adj_forward[dep].append(id)
        adj_deps[id].append(dep)
      else:
        warnings.append(f"Item {id} depends on {dep} outside plan")
  
  // 4. Detect cycles
  cycle = detect_cycle(adj_forward, resolved_ids)
  if cycle:
    error(f"Cycle detected: {' -> '.join(cycle)}")
  
  // 5. Extract connected components
  uf = make_union_find(resolved_ids)
  for each id in resolved_ids:
    for each dep in adj_deps[id]:
      union(uf, id, dep)
  
  components_map = extract_components(uf, resolved_ids)
  
  // 6. Build per-component FluidPlan
  components = []
  component_idx = 0
  
  for each (root, member_ids) in components_map:
    component_idx += 1
    member_ids.sort()
    
    waves = compute_waves(member_ids, adj_forward)
    
    agents = []
    for each id in member_ids:
      item = items_table[id]
      
      // Filter depends to only those in plan
      valid_deps = [d for d in item.depends if d in id_set]
      
      agents.append({
        "id": id,
        "task": item.title,
        "dependsOn": valid_deps,
        "orgItemId": id,
        "effort": item.effort,
        "priority": item.priority,
        "state": item.state,
        "body": item.body,
        "deferred": id.startswith("FUP-")  // Deferred items (FUP = Future)
      })
    
    components.append({
      "id": f"component-{component_idx}",
      "agents": agents,
      "waves": waves
    })
  
  return {
    "components": components,
    "warnings": warnings
  }
```

### Output Format

```json
{
  "components": [
    {
      "id": "component-1",
      "agents": [
        {
          "id": "TASK-001",
          "task": "Task A",
          "dependsOn": ["TASK-002"],
          "orgItemId": "TASK-001",
          "effort": "2h",
          "priority": "A",
          "state": "ITEM",
          "body": "...task description...",
          "deferred": false
        }
      ],
      "waves": [
        {
          "number": 1,
          "items": ["TASK-002", "TASK-003"]
        },
        {
          "number": 2,
          "items": ["TASK-001"]
        }
      ]
    }
  ],
  "warnings": [
    "Item TASK-100 depends on TASK-200 which is outside this plan (ignored)",
    "Linked item not found: TASK-999 (will be skipped)"
  ]
}
```

---

## Edge Cases & Error Handling

### Dependency Graph
| Case | Handling |
|------|----------|
| Missing dependency target | Ignored (no edge created), no error |
| Self-loop (depends on self) | Detected as cycle |
| Multiple edges same pair | Deduplicated (only keep one) |
| Invalid ID in property | Ignored, no warning |
| Cycle detected | Return cycles array in JSON |

### Next Wave
| Case | Handling |
|------|----------|
| No dependencies | Item in wave (in-degree = 0) |
| Circular dependency | Item treated as blocked (never eligible) |
| BLOCKED state | Excluded from wave AND blocked_items |
| Wave > 8 items | Return only first 8 (sorted by priority) |
| No eligible items | Return empty wave_items, show blocked_items |

### Fluid Plan
| Case | Handling |
|------|----------|
| No child links | Error: "PLAN has no linked child items" |
| Link not resolvable | Warning added, item skipped |
| Cross-file links | Resolved via TS implementation across all files |
| Parent::child links | Resolved via hierarchical ID lookup |
| Missing PLAN item | Error: "PLAN item not found: ID" |
| Cycle in component | Error with cycle path listed |
| All items isolated (no edges) | N components (each item is its own component) |
| FUP- prefix items | Marked as deferred=true in agents |

---

## Type Definitions (Rust Target)

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct OrgItem {
    pub custom_id: String,
    pub title: String,
    pub state: String,  // "INIT" | "ITEM" | "DOING" | "REVIEW" | "DONE" | "BLOCKED"
    pub depends: Vec<String>,  // IDs this depends on
    pub blocks: Vec<String>,   // IDs this blocks
    pub priority: Option<char>,  // 'A', 'B', 'C'
    pub effort: String,
    pub layer: String,
    pub agent: String,
    pub body: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DependencyGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<Edge>,
    pub cycles: Vec<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GraphNode {
    pub custom_id: String,
    pub title: String,
    pub state: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Edge {
    pub from: String,
    pub to: String,
    #[serde(rename = "type")]
    pub edge_type: String,  // "depends" | "blocks"
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NextWaveResponse {
    pub wave_number: usize,
    pub items: Vec<OrgItem>,
    pub blocked_items: Vec<OrgItem>,
    pub completed_count: usize,
    pub total_count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FluidPlan {
    pub components: Vec<Component>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Component {
    pub id: String,
    pub agents: Vec<Agent>,
    pub waves: Vec<Wave>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub task: String,
    #[serde(rename = "dependsOn")]
    pub depends_on: Vec<String>,
    #[serde(rename = "orgItemId")]
    pub org_item_id: String,
    pub effort: String,
    pub priority: String,
    pub state: String,
    pub body: String,
    pub deferred: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Wave {
    pub number: usize,
    pub items: Vec<String>,
}
```

---

## Testing Strategy

Each algorithm should have:
1. **Unit tests** for sub-functions (cycle detection, wave computation, component extraction)
2. **Integration tests** using real org files with:
   - Linear dependencies (A→B→C)
   - Diamond shapes (A→{B,C}→D)
   - Disconnected components
   - Cycles (error cases)
   - Missing dependencies (warning cases)
   - Empty/edge cases (no items, no deps)
3. **Property tests** for invariants:
   - Wave items all have satisfied dependencies
   - Cycles never appear in acyclic graphs
   - Wave count equals dependency depth
   - Union-find components are disjoint and complete

