# NAPI Patterns in pi-natives: Implementation Guide

## Overview

The `crates/pi-natives/` crate provides native Rust extensions to Node.js via N-API (Node.js API). This document catalogs the exact patterns used for adding new NAPI functions, command dispatch, error handling, and threading models.

**Key files:**
- `crates/pi-natives/src/code_buffer.rs` — Complex NAPI module with command dispatch pattern
- `crates/pi-natives/src/code_graph.rs` — Async NAPI module with task scheduling
- `crates/pi-natives/src/task.rs` — Threading primitives (blocking tasks, cancellation tokens)
- `crates/pi-natives/src/lib.rs` — Module registration
- `crates/pi-natives/Cargo.toml` — Dependency versions

---

## 1. Module Registration (lib.rs)

**Pattern:** Each module is declared as a public submodule, automatically compiled into the native extension.

```rust
// crates/pi-natives/src/lib.rs
pub mod code_buffer;
pub mod code_graph;
pub mod task;
// ... other modules
```

**Compilation:**
- `Cargo.toml` specifies `crate-type = ["cdylib"]` for dynamic library output
- `napi-build` build script generates N-API glue code
- Exported functions are automatically registered by `#[napi]` macro

---

## 2. NAPI Function Signature Pattern

### Simple Synchronous Function

```rust
// From text.rs — simple, no state, no dispatch
#[napi(js_name = "visibleWidth")]
pub fn visible_width_napi(text: JsString, tab_width: Option<u32>) -> Result<u32> {
    let text_u16 = text.into_utf16()?;
    let tab_width = clamp_tab_width(tab_width);
    Ok(crate::utils::clamp_u32(visible_width_u16(text_u16.as_slice(), tab_width) as u64))
}
```

**Key attributes:**
- `#[napi(js_name = "...")]` — JS function name (defaults to snake_case → camelCase)
- `pub fn` — must be public
- Parameters: JS types (`JsString`, etc.) or Rust types that implement `FromNapiValue`
- Return: `Result<T>` where `T: ToNapiValue`

### Asynchronous Function with Task Scheduling

```rust
// From code_graph.rs — async + cancellation
#[napi(js_name = "executeCodeGraph")]
pub fn execute_code_graph(options: CodeGraphOptions<'_>) -> task::Async<CodeGraphResult> {
    let cancel_token = CancelToken::new(options.timeout_ms, options.signal);
    let task_options = CodeGraphTaskOptions::from(options);
    task::blocking("code_graph", cancel_token, move |cancel_token| {
        run_code_graph(task_options, cancel_token)
    })
}
```

**Key patterns:**
- `task::Async<T>` is a type alias for `AsyncTask<Blocking<T>>` (returns Promise on JS side)
- `CancelToken` wraps `timeout_ms` and `signal` (AbortSignal) for cancellation
- `task::blocking()` schedules work on libuv thread pool
- Closure captures moved variables via `move`

### Command Dispatch Pattern (Multi-command Functions)

```rust
// From code_buffer.rs — single function, multiple commands
#[napi(js_name = "executeCodeBuffer")]
pub fn execute_code_buffer(options: Value) -> Result<Value> {
    let command = options
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| json_err("Missing required field: command"))?;
    
    match command {
        "open" => {
            let path = required_path(&options)?;
            let mut guard = registry().lock();
            let buffer = guard.open(&path).map_err(engine_err)?;
            let lines = buffer.source()
                .lines()
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>();
            Ok(json_response(
                json!({ "success": true, "language": buffer.language().to_string(), "lines": lines }),
                false,
            ))
        },
        "close" => {
            let path = required_path(&options)?;
            registry().lock().close(&path).map_err(engine_err)?;
            Ok(json_response(json!({ "success": true }), false))
        },
        "list" => {
            let buffers = registry().lock().list();
            Ok(json_response(
                Value::Array(buffers.into_iter().map(render_buffer_info).collect()),
                false,
            ))
        },
        other => Ok(json_response(Value::String(format!("Unknown command: {other}")), true)),
    }
}
```

**Pattern structure:**
1. Extract `command` string from options (JSON object)
2. Match on command string (statically guaranteed at compile time)
3. For each command:
   - Extract parameters from options using `options.get()`, `as_str()`, etc.
   - Call implementation function
   - Serialize result to JSON
4. Unknown commands → error flag in response (not thrown error)

---

## 3. Error Handling

### Three-Tier Error System

#### Tier 1: Domain Errors (from engine)
```rust
fn engine_err(e: pi_code_engine::error::CodeEngineError) -> Error {
    Error::from_reason(e.to_string())
}
```
Use when domain library returns an error. Example:
```rust
guard.open(&path).map_err(engine_err)?
```

#### Tier 2: Validation Errors
```rust
fn json_err(message: impl Into<String>) -> Error {
    Error::from_reason(message.into())
}
```
Use for missing fields, invalid arguments, precondition violations:
```rust
.ok_or_else(|| json_err("Missing required field: command"))?
```

#### Tier 3: Serialization Errors
```rust
fn to_json<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|error| json_err(error.to_string()))
}
```

### Pattern: Distinguish User Errors from System Errors

Command dispatch returns a JSON response with an `error` flag instead of throwing:

```rust
fn json_response(output: Value, error: bool) -> Value {
    json!({ "output": output, "error": error })
}

// In dispatch:
// Unknown commands = user error (bad command string)
other => Ok(json_response(Value::String(format!("Unknown command: {other}")), true)),
```

This allows JS to distinguish:
- `output` = actual result or error message (string)
- `error` = boolean flag (true if result is an error, not an exception)

---

## 4. Result Serialization

### Using the `json!` Macro

```rust
use serde_json::{Value, json};

// Direct JSON construction
json!({ 
    "success": true, 
    "language": buffer.language().to_string(), 
    "lines": lines 
})

// Nested structures
json!({
    "version": result.version,
    "changedRanges": result.changed_ranges.into_iter().map(|range| 
        json!({
            "start": {"line": range.start_point.row + 1, "column": range.start_point.column},
            "end": {"line": range.end_point.row + 1, "column": range.end_point.column}
        })
    ).collect::<Vec<_>>(),
    "inputEdit": {
        "startByte": result.input_edit.start_byte,
        "oldEndByte": result.input_edit.old_end_byte,
        "newText": result.input_edit.new_text
    }
})
```

### Using `#[napi(object)]` for Structured Output

```rust
#[napi(object)]
pub struct CodeGraphResult {
    pub output: String,
    #[napi(js_name = "cacheStatus")]
    pub cache_status: String,
    pub rebuilt: bool,
    #[napi(js_name = "fileCount")]
    pub file_count: u32,
}

// Function returns the struct directly
pub fn run_code_graph(...) -> napi::Result<CodeGraphResult> {
    Ok(CodeGraphResult {
        output,
        cache_status,
        rebuilt,
        file_count: stats.file_count,
        // ...
    })
}
```

**Key attributes:**
- `#[napi(object)]` — marks struct as a NAPI object type (auto-serializes)
- `#[napi(js_name = "...")]` — snake_case Rust field → camelCase JS property
- `pub struct` and all fields must be public

### Converting Rust Types to JSON

```rust
// Generic serializer
fn to_json<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|error| json_err(error.to_string()))
}

// Usage
Ok(json_response(to_json(outline_buffer(buffer, &profile))?, false))
```

Requires type `T` to implement `serde::Serialize`. Use on domain types that already implement it.

---

## 5. Threading and Concurrency

### Static Registries with `OnceLock`

```rust
use std::sync::OnceLock;
use parking_lot::Mutex;

static LANGUAGE_REGISTRY: OnceLock<Arc<LanguageRegistry>> = OnceLock::new();
static BUFFER_REGISTRY: OnceLock<Mutex<BufferRegistry>> = OnceLock::new();

fn language_registry() -> Arc<LanguageRegistry> {
    LANGUAGE_REGISTRY
        .get_or_init(|| {
            Arc::new(LanguageRegistry::with_builtins().expect("failed to load language profiles"))
        })
        .clone()
}

fn registry() -> &'static Mutex<BufferRegistry> {
    BUFFER_REGISTRY.get_or_init(|| Mutex::new(BufferRegistry::new(language_registry())))
}
```

**Pattern:**
- `OnceLock::new()` creates a once-initialized static slot (thread-safe, no runtime overhead after init)
- `get_or_init()` initializes on first call, then returns reference (subsequent calls are O(1) check)
- `Mutex` wraps mutable state; guard acquired via `.lock()`
- `Arc` for shared ownership across threads

### Using `parking_lot::Mutex` for Fairness

```rust
use parking_lot::Mutex;

let mut guard = registry().lock();
let buffer = guard.open(&path).map_err(engine_err)?;
let lines = buffer.source().lines().map(ToOwned::to_owned).collect::<Vec<_>>();
```

**Advantages over `std::sync::Mutex`:**
- Faster (no poisoning logic)
- Fair (prevents starvation)
- Panic-safe (guard is released even if panicked)

### Blocking Tasks with Cancellation

```rust
pub fn blocking<T, F>(
    tag: &'static str,
    cancel_token: impl Into<CancelToken>,
    work: F,
) -> AsyncTask<Blocking<T>>
where
    F: FnOnce(CancelToken) -> Result<T> + Send + 'static,
    T: ToNapiValue + TypeName + Send + 'static,
{
    AsyncTask::new(Blocking {
        tag,
        cancel_token: cancel_token.into(),
        work: Some(Box::new(work)),
    })
}
```

**Execution model:**
1. `blocking()` wraps closure in a `Blocking<T>` task
2. `AsyncTask::new()` schedules on libuv thread pool
3. `Task::compute()` runs on worker thread (calls closure with `cancel_token`)
4. `Task::resolve()` runs on main JS thread (returns result to Promise)

### Cancellation Token Pattern

```rust
pub struct CancelToken {
    deadline: Option<Instant>,
    flag: Option<Arc<Flag>>,
}

impl CancelToken {
    pub fn new(timeout_ms: Option<u32>, signal: Option<Unknown>) -> Self {
        // Captures AbortSignal + timeout_ms
        // Sets up async handlers for both
    }

    pub fn heartbeat(&self) -> Result<()> {
        if let Some(flag) = &self.flag && let Some(reason) = flag.cause() {
            return Err(Error::from_reason(format!("Aborted: {reason:?}")));
        }
        if let Some(deadline) = self.deadline && deadline < Instant::now() {
            return Err(Error::from_reason("Aborted: Timeout"));
        }
        Ok(())
    }
}
```

**Usage in blocking work:**
```rust
fn run_code_graph(options: CodeGraphTaskOptions, cancel_token: CancelToken) -> napi::Result<CodeGraphResult> {
    cancel_token.heartbeat()?;
    let root = resolve_root(options.root.as_deref())?;
    // ... heavy computation ...
    cancel_token.heartbeat()?;
    // ... more computation ...
}
```

Call `heartbeat()` periodically to respect cancellation requests from:
- `timeout_ms` — milliseconds until timeout
- `signal` (AbortSignal) — JS user cancellation

---

## 6. Input Parameter Extraction Patterns

### From JSON Object

```rust
let command = options
    .get("command")
    .and_then(Value::as_str)
    .ok_or_else(|| json_err("Missing required field: command"))?;

let line = value_to_usize(options.get("line"), 0);  // with default
let column = value_to_usize(options.get("column"), 0);

let path = required_path(&options)?;  // helper for required field
```

### Helper Functions

```rust
fn required_path(options: &Value) -> Result<PathBuf> {
    let path = options
        .get("file")
        .or_else(|| options.get("path"))
        .and_then(Value::as_str)
        .ok_or_else(|| json_err("Missing required field: file"))?;
    Ok(PathBuf::from(path))
}

fn value_to_u32(value: Option<&Value>, default: u32) -> u32 {
    value
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(default)
}

fn value_to_usize(value: Option<&Value>, default: usize) -> usize {
    value
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(default)
}
```

### Using Structured Input Objects

```rust
#[napi(object)]
pub struct CodeGraphOptions<'env> {
    pub command: String,
    pub root: Option<String>,
    pub file: Option<String>,
    pub symbol: Option<String>,
    pub query: Option<String>,
    pub depth: Option<u32>,
    pub limit: Option<u32>,
    pub semantic: Option<bool>,
    pub signal: Option<Unknown<'env>>,
    #[napi(js_name = "timeoutMs")]
    pub timeout_ms: Option<u32>,
}
```

Then in function:
```rust
#[napi(js_name = "executeCodeGraph")]
pub fn execute_code_graph(options: CodeGraphOptions<'_>) -> task::Async<CodeGraphResult> {
    let cancel_token = CancelToken::new(options.timeout_ms, options.signal);
    // ... options.command, options.root, etc.
}
```

---

## 7. Implementation Workflow

### To add a new command to existing dispatch function:

1. **Add case to match statement:**
   ```rust
   "new_command" => {
       let required_param = options
           .get("required_param")
           .and_then(Value::as_str)
           .ok_or_else(|| json_err("Missing: required_param"))?;
       
       let result = implementation_function(required_param)?;
       Ok(json_response(to_json(result)?, false))
   },
   ```

2. **Handle errors properly:**
   - Domain errors: `.map_err(engine_err)`
   - Validation: `.ok_or_else(|| json_err(...))`
   - Serialization: `.map_err(|e| json_err(e.to_string()))`

3. **Return JSON response:**
   - Success: `json_response(json!({ "field": value }), false)`
   - User error: `json_response(Value::String(message), true)`
   - Exceptions (invalid state, system errors): `Err(json_err(...))`

### To add a new standalone NAPI function:

1. **Choose async or sync:**
   - Sync: `pub fn name(params: Type) -> Result<Output>`
   - Async: `pub fn name(params: Type) -> task::Async<Output>`

2. **Add `#[napi]` macro and js_name:**
   ```rust
   #[napi(js_name = "camelCaseName")]
   pub fn snake_case_name(params: Type) -> Result<Output> {
       // ...
   }
   ```

3. **Define input struct if many parameters:**
   ```rust
   #[napi(object)]
   pub struct Options {
       pub field: String,
       #[napi(js_name = "jsFieldName")]
       pub rust_field: Type,
   }
   ```

4. **Define output struct if complex result:**
   ```rust
   #[napi(object)]
   pub struct Result {
       pub output: String,
       pub status: String,
   }
   ```

5. **Module auto-registers** (no additional code needed in `lib.rs`)

---

## 8. Dependencies

Key crates used in pi-natives:

```toml
napi = { version = "3", features = [
  "napi10",
  "serde-json",
  "tokio_rt",
  "tokio_time",
] }
napi-derive = "3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
parking_lot = "0.12.5"
tokio = { version = "1", features = ["full"] }
tokio-util = { version = "0.7", features = ["full"] }
```

**Critical versions:**
- `napi@3` with `napi10` feature — N-API v10 support
- `parking_lot@0.12.5` — Faster, fairer mutexes than `std::sync::Mutex`
- `tokio@1` + `tokio-util` — Async runtime, task scheduling

---

## 9. Code Structure Best Practices (Observed)

### Render Functions (Output Formatting)

```rust
fn render_buffer_info(info: pi_code_engine::buffer::BufferInfo) -> Value {
    json!({ 
        "path": info.path.map(|path| path.display().to_string()),
        "language": info.language.to_string(),
        "version": info.version,
        "dirty": info.dirty,
        "lineCount": info.line_count
    })
}

fn render_edit_results(results: Vec<pi_code_engine::buffer::EditResult>) -> Value {
    Value::Array(results.into_iter().map(|result| 
        json!({
            "version": result.version,
            "changedRanges": result.changed_ranges.into_iter()
                .map(|range| json!({ /* ... */ }))
                .collect::<Vec<_>>(),
        })
    ).collect())
}
```

**Pattern:** Render functions (plural) convert domain types to JSON. Paired with domain operation functions.

### Helper Functions for Complex Logic

```rust
fn edit_operation(buffer: &CodeBuffer, options: &Value) -> Result<Vec<TextEdit>> {
    let line = value_to_usize(options.get("line"), 0);
    let column = value_to_usize(options.get("column"), 0);
    let content = options.get("content").and_then(Value::as_str).unwrap_or("");
    let operation = options
        .get("operation")
        .and_then(Value::as_str)
        .ok_or_else(|| json_err("Missing required field: operation"))?;
    
    match operation {
        "replace" => replace_node(buffer, line, node_type, content).map_err(engine_err),
        "insert-before" => insert_before(buffer, line, node_type, content).map_err(engine_err),
        // ...
    }
}
```

**Pattern:** Extract common logic into helper functions. These encapsulate parameter extraction + dispatch + error mapping.

---

## 10. Summary: Adding a New NAPI Module (pi-org-engine example)

To add `crates/pi-natives/src/pi_org_engine.rs`:

1. **Define input/output types:**
   ```rust
   #[napi(object)]
   pub struct OrgQueryOptions<'env> {
       pub command: String,
       pub root: Option<String>,
       pub query: Option<String>,
       pub signal: Option<Unknown<'env>>,
       #[napi(js_name = "timeoutMs")]
       pub timeout_ms: Option<u32>,
   }

   #[napi(object)]
   pub struct OrgQueryResult {
       pub output: String,
       pub count: u32,
   }
   ```

2. **Implement the NAPI dispatch function:**
   ```rust
   #[napi(js_name = "executeOrgQuery")]
   pub fn execute_org_query(options: OrgQueryOptions<'_>) -> task::Async<OrgQueryResult> {
       let cancel_token = CancelToken::new(options.timeout_ms, options.signal);
       task::blocking("org_query", cancel_token, move |cancel_token| {
           run_org_query(options, cancel_token)
       })
   }

   fn run_org_query(options: OrgQueryOptions<'_>, cancel_token: CancelToken) -> napi::Result<OrgQueryResult> {
       cancel_token.heartbeat()?;
       match options.command.as_str() {
           "query" => { /* ... */ },
           "dag" => { /* ... */ },
           other => Err(Error::from_reason(format!("Unknown command: {other}"))),
       }
   }
   ```

3. **Register in lib.rs:**
   ```rust
   pub mod pi_org_engine;
   ```

4. **Build and bind:**
   ```bash
   cargo build -p pi-natives
   ```

5. **JavaScript side receives:**
   ```typescript
   const result = await executeOrgQuery({
       command: "query",
       root: "/path/to/project",
       query: "todo:DOING",
       timeoutMs: 5000,
   });
   // result: { output: string, count: number }
   ```

That's it. The N-API build system automatically generates bindings.

---

## References

- **Source files:**
  - `crates/pi-natives/src/code_buffer.rs` — 262 lines, complex dispatch
  - `crates/pi-natives/src/code_graph.rs` — 611 lines, async with cancellation
  - `crates/pi-natives/src/task.rs` — 349 lines, threading primitives
  - `crates/pi-natives/Cargo.toml` — dependency specs

- **Key patterns observed:**
  1. Command dispatch via string matching (statically safe)
  2. Error tiers: domain → validation → serialization
  3. `OnceLock` + `parking_lot::Mutex` for global state
  4. `task::blocking()` + `CancelToken` for cancellable work
  5. `json!` macro for inline JSON, `#[napi(object)]` for structured types
  6. Render functions for domain → JSON conversion
  7. Helper functions for parameter extraction + validation
