# pi-natives: Extracted Code Examples

## Exact Source: code_buffer.rs Pattern

### Registry Initialization (lines 21-33)
```rust
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

### Error Handling Functions (lines 34-45)
```rust
fn engine_err(e: pi_code_engine::error::CodeEngineError) -> Error {
    Error::from_reason(e.to_string())
}

fn json_err(message: impl Into<String>) -> Error {
    Error::from_reason(message.into())
}

fn json_response(output: Value, error: bool) -> Value {
    json!({ "output": output, "error": error })
}

fn to_json<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|error| json_err(error.to_string()))
}
```

### Parameter Extraction Helpers (lines 47-72)
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

### Enum Parsing from String (lines 74-84)
```rust
fn navigate_action(value: Option<&str>) -> Result<NavigateAction> {
    match value.unwrap_or("node-at") {
        "node-at" => Ok(NavigateAction::NodeAt),
        "defun-at" => Ok(NavigateAction::DefunAt),
        "parent" => Ok(NavigateAction::Parent),
        "siblings" => Ok(NavigateAction::Siblings),
        "children" => Ok(NavigateAction::Children),
        "references" => Ok(NavigateAction::References),
        other => Err(json_err(format!("Unknown navigate action: {other}"))),
    }
}
```

### Complex Dispatch with Nested Logic (lines 86-121)
```rust
fn edit_operation(buffer: &CodeBuffer, options: &Value) -> Result<Vec<TextEdit>> {
    let line = value_to_usize(options.get("line"), 0);
    let column = value_to_usize(options.get("column"), 0);
    let content = options.get("content").and_then(Value::as_str).unwrap_or("");
    let node_type = options
        .get("node_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    let operation = options
        .get("operation")
        .and_then(Value::as_str)
        .ok_or_else(|| json_err("Missing required field: operation"))?;
    
    match operation {
        "replace" => replace_node(buffer, line, node_type, content).map_err(engine_err),
        "insert-before" => insert_before(buffer, line, node_type, content).map_err(engine_err),
        "insert-after" => insert_after(buffer, line, node_type, content).map_err(engine_err),
        "kill" => kill_node(buffer, line, node_type).map_err(engine_err),
        "splice" => {
            let mode = match options
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("self")
            {
                "up" => SpliceMode::Up,
                "down" => SpliceMode::Down,
                _ => SpliceMode::Self_,
            };
            splice_node(buffer, line, mode).map_err(engine_err)
        },
        "drag-up" => drag_node(buffer, line, DragDirection::Up).map_err(engine_err),
        "drag-down" => drag_node(buffer, line, DragDirection::Down).map_err(engine_err),
        "clone" => clone_node(buffer, line).map_err(engine_err),
        "transpose" => transpose_nodes(buffer, line, column).map_err(engine_err),
        other => Err(json_err(format!("Unknown edit operation: {other}"))),
    }
}
```

### Render Functions (lines 123-140)
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
    Value::Array(results.into_iter().map(|result| json!({
        "version": result.version,
        "changedRanges": result.changed_ranges.into_iter()
            .map(|range| json!({
                "start": {"line": range.start_point.row + 1, "column": range.start_point.column},
                "end": {"line": range.end_point.row + 1, "column": range.end_point.column}
            }))
            .collect::<Vec<_>>(),
        "inputEdit": {
            "startByte": result.input_edit.start_byte,
            "oldEndByte": result.input_edit.old_end_byte,
            "newText": result.input_edit.new_text
        }
    })).collect())
}
```

### Main Dispatch Function: "open" command (lines 142-162)
```rust
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
            let lines = buffer
                .source()
                .lines()
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>();
            Ok(json_response(
                json!({ 
                    "success": true,
                    "language": buffer.language().to_string(),
                    "lines": lines
                }),
                false,
            ))
        },
        // ... other commands ...
    }
}
```

### Complex Command with Conditional Logic (lines 187-242)
```rust
"edit" => {
    let results = buffer
        .edit_batch(edit_operation(buffer, &options)?)
        .map_err(engine_err)?;
    Ok(json_response(render_edit_results(results), false))
},
"undo" => Ok(json_response(
    render_optional_edit_result(buffer.undo().map_err(engine_err)?),
    false,
)),
"redo" => Ok(json_response(
    render_optional_edit_result(buffer.redo().map_err(engine_err)?),
    false,
)),
"diff" => Ok(json_response(
    Value::Array(
        buffer
            .diff_from_disk()
            .map_err(engine_err)?
            .into_iter()
            .map(render_diff_hunk)
            .collect(),
    ),
    false,
)),
"save" => {
    buffer.save().map_err(engine_err)?;
    Ok(json_response(json!({ "success": true, "version": buffer.version() }), false))
},
```

---

## Exact Source: code_graph.rs Pattern

### Input Object with JS Name Mapping (lines 43-56)
```rust
#[napi(object)]
pub struct CodeGraphOptions<'env> {
    pub command:    String,
    pub root:       Option<String>,
    pub file:       Option<String>,
    pub symbol:     Option<String>,
    pub query:      Option<String>,
    pub depth:      Option<u32>,
    pub limit:      Option<u32>,
    pub semantic:   Option<bool>,
    pub signal:     Option<Unknown<'env>>,
    #[napi(js_name = "timeoutMs")]
    pub timeout_ms: Option<u32>,
}
```

### Internal Task Options (No NAPI) (lines 58-67)
```rust
struct CodeGraphTaskOptions {
    command:  String,
    root:     Option<String>,
    file:     Option<String>,
    symbol:   Option<String>,
    query:    Option<String>,
    depth:    Option<u32>,
    limit:    Option<u32>,
    semantic: Option<bool>,
}

impl From<CodeGraphOptions<'_>> for CodeGraphTaskOptions {
    fn from(value: CodeGraphOptions<'_>) -> Self {
        Self {
            command:  value.command,
            root:     value.root,
            file:     value.file,
            symbol:   value.symbol,
            query:    value.query,
            depth:    value.depth,
            limit:    value.limit,
            semantic: value.semantic,
        }
    }
}
```

### Output Object with JS Name Mapping (lines 84-98)
```rust
#[napi(object)]
pub struct CodeGraphResult {
    pub output:          String,
    #[napi(js_name = "cacheStatus")]
    pub cache_status:    String,
    pub rebuilt:         bool,
    #[napi(js_name = "fileCount")]
    pub file_count:      u32,
    #[napi(js_name = "symbolCount")]
    pub symbol_count:    u32,
    #[napi(js_name = "edgeCount")]
    pub edge_count:      u32,
    #[napi(js_name = "semanticStatus")]
    pub semantic_status: Option<String>,
}
```

### Async NAPI Function with Cancellation (lines 127-134)
```rust
#[napi(js_name = "executeCodeGraph")]
pub fn execute_code_graph(options: CodeGraphOptions<'_>) -> task::Async<CodeGraphResult> {
    let cancel_token = CancelToken::new(options.timeout_ms, options.signal);
    let task_options = CodeGraphTaskOptions::from(options);
    task::blocking("code_graph", cancel_token, move |cancel_token| {
        run_code_graph(task_options, cancel_token)
    })
}
```

### Implementation Function with Multiple Heartbeats (lines 136-200)
```rust
fn run_code_graph(
    options: CodeGraphTaskOptions,
    cancel_token: CancelToken,
) -> napi::Result<CodeGraphResult> {
    cancel_token.heartbeat()?;  // Check immediately
    let root = resolve_root(options.root.as_deref())?;
    let cache = CacheStore::new(root.join(".spell/graph"));
    let builder = CodeGraphBuilder::new(
        LanguageRegistry::new()
            .with_defaults()
            .map_err(to_napi_error)?,
        cache.clone(),
    );

    if options.command == "status" {
        return render_status(&root, &builder);
    }

    let (graph, cache_status, rebuilt) =
        ensure_graph(&root, &cache, &builder, &cancel_token, options.command == "index")?;
    let stats = graph.graph_status();
    let mut semantic_status = None;
    
    let output = match options.command.as_str() {
        "index" => {
            let mut status_output = format_status(&stats, &cache_status, rebuilt);
            if options.semantic == Some(true) {
                match build_semantic_index(&graph, &cache) {
                    Ok(vector_count) => {
                        let status = format!("{vector_count} vectors indexed");
                        let _ = write!(status_output, "\nSemantic: {status}");
                        semantic_status = Some(status);
                    },
                    Err(error) => {
                        let status = format!("failed: {error}");
                        let _ = write!(status_output, "\nSemantic: {status}");
                        semantic_status = Some(status);
                    },
                }
            }
            status_output
        },
        // ... more commands ...
    };

    Ok(CodeGraphResult {
        output,
        cache_status,
        rebuilt,
        file_count: stats.file_count,
        symbol_count: stats.symbol_count,
        edge_count: stats.edge_count,
        semantic_status,
    })
}
```

### Enum-like Dispatch with Required Parameters (lines 177-187)
```rust
"context" => {
    let symbol = options
        .symbol
        .as_deref()
        .ok_or_else(|| Error::from_reason("context requires `symbol`"))?;
    let result = graph.graph_context(symbol).ok_or_else(|| {
        Error::from_reason(format!("No symbol found for context query: {symbol}"))
    })?;
    format_context(&result, options.limit.unwrap_or(DEFAULT_LIMIT) as usize)
},
```

### Helper for Error Conversion (lines 454-456)
```rust
fn to_napi_error(error: impl std::fmt::Display) -> Error {
    Error::from_reason(error.to_string())
}
```

---

## Exact Source: task.rs Pattern

### CancelToken Structure (lines 108-139)
```rust
#[derive(Clone, Default)]
pub struct CancelToken {
    deadline: Option<Instant>,
    flag: Option<Arc<Flag>>,
}

impl CancelToken {
    pub fn new(timeout_ms: Option<u32>, signal: Option<Unknown>) -> Self {
        let mut result = Self::default();
        if let Some(signal) = signal.and_then(|s| AbortSignal::from_unknown(s).ok()) {
            let flag = Arc::new(Flag::default());
            signal.on_abort({
                let weak = Arc::downgrade(&flag);
                move || {
                    if let Some(flag) = weak.upgrade() {
                        flag.abort(AbortReason::Signal);
                    }
                }
            });
            result.flag = Some(flag);
        }
        if let Some(timeout_ms) = timeout_ms {
            result.deadline = Some(Instant::now() + Duration::from_millis(timeout_ms as u64));
        }
        result
    }
```

### Heartbeat Check (lines 145-157)
```rust
pub fn heartbeat(&self) -> Result<()> {
    if let Some(flag) = &self.flag
        && let Some(reason) = flag.cause()
    {
        return Err(Error::from_reason(format!("Aborted: {reason:?}")));
    }
    if let Some(deadline) = self.deadline
        && deadline < Instant::now()
    {
        return Err(Error::from_reason("Aborted: Timeout"));
    }
    Ok(())
}
```

### Blocking Task Structure (lines 239-271)
```rust
pub struct Blocking<T>
where
    T: Send + 'static,
{
    tag:          &'static str,
    cancel_token: CancelToken,
    work:         Option<Box<dyn FnOnce(CancelToken) -> Result<T> + Send>>,
}

impl<T> Task for Blocking<T>
where
    T: ToNapiValue + Send + 'static + TypeName,
{
    type JsValue = T;
    type Output = T;

    fn compute(&mut self) -> Result<Self::Output> {
        let _guard = profile_region(self.tag);
        let work = self
            .work
            .take()
            .ok_or_else(|| Error::from_reason("BlockingTask: work already consumed"))?;
        work(self.cancel_token.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub type Async<T> = AsyncTask<Blocking<T>>;
```

### blocking() Constructor (lines 299-309)
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

### Async Task Constructor (lines 335-348)
```rust
pub fn future<'env, T, Fut>(
    env: &'env Env,
    tag: &'static str,
    work: Fut,
) -> Result<PromiseRaw<'env, T>>
where
    Fut: Future<Output = Result<T>> + Send + 'static,
    T: ToNapiValue + Send + 'static,
{
    env.spawn_future(async move {
        let _guard = profile_region(tag);
        work.await
    })
}
```

---

## Exact Source: code_buffer.rs Commands (Full List, lines 148-261)

### Command: "open"
```rust
"open" => {
    let path = required_path(&options)?;
    let mut guard = registry().lock();
    let buffer = guard.open(&path).map_err(engine_err)?;
    let lines = buffer
        .source()
        .lines()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    Ok(json_response(
        json!({ "success": true, "language": buffer.language().to_string(), "lines": lines }),
        false,
    ))
},
```

### Command: "close"
```rust
"close" => {
    let path = required_path(&options)?;
    registry().lock().close(&path).map_err(engine_err)?;
    Ok(json_response(json!({ "success": true }), false))
},
```

### Command: "list"
```rust
"list" => {
    let buffers = registry().lock().list();
    Ok(json_response(
        Value::Array(buffers.into_iter().map(render_buffer_info).collect()),
        false,
    ))
},
```

### Command: "languages"
```rust
"languages" => {
    let reg = language_registry();
    let langs: Vec<Value> = reg
        .languages()
        .iter()
        .map(|id| {
            let profile = reg.get(id).unwrap();
            json!({ "id": id.to_string(), "extensions": profile.extensions })
        })
        .collect();
    Ok(json_response(json!({ "languages": langs }), false))
},
```

### Commands: "outline", "read", "navigate", "edit", "undo", "redo", "diff", "save" (Multi-step dispatch)
```rust
"outline" | "read" | "navigate" | "edit" | "undo" | "redo" | "diff" | "save" => {
    let path = required_path(&options)?;
    let mut guard = registry().lock();
    if guard.get(&path).is_none() {
        guard.open(&path).map_err(engine_err)?;
    }
    let buffer = guard.get_mut(&path).unwrap();
    let profile = get_profile(&path, buffer.language())?;
    
    match command {
        "outline" => Ok(json_response(to_json(outline_buffer(buffer, &profile))?, false)),
        "read" => {
            let resolution = options
                .get("resolution")
                .and_then(Value::as_u64)
                .and_then(|n| u8::try_from(n).ok())
                .unwrap_or(3);
            let offset = options
                .get("offset")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok());
            let limit = options
                .get("limit")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok());
            Ok(json_response(
                Value::String(read_buffer(buffer, &profile, resolution, offset, limit)),
                false,
            ))
        },
        "navigate" => {
            let action = navigate_action(options.get("action").and_then(Value::as_str))?;
            let line = value_to_u32(options.get("line"), 1);
            let column = options
                .get("column")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok());
            let symbol = options.get("symbol").and_then(Value::as_str);
            let result = navigate_buffer(buffer, &profile, action, line, column, symbol)
                .map_err(engine_err)?;
            Ok(json_response(render_navigate_result(result), false))
        },
        "edit" => {
            let results = buffer
                .edit_batch(edit_operation(buffer, &options)?)
                .map_err(engine_err)?;
            Ok(json_response(render_edit_results(results), false))
        },
        "undo" => Ok(json_response(
            render_optional_edit_result(buffer.undo().map_err(engine_err)?),
            false,
        )),
        "redo" => Ok(json_response(
            render_optional_edit_result(buffer.redo().map_err(engine_err)?),
            false,
        )),
        "diff" => Ok(json_response(
            Value::Array(
                buffer
                    .diff_from_disk()
                    .map_err(engine_err)?
                    .into_iter()
                    .map(render_diff_hunk)
                    .collect(),
            ),
            false,
        )),
        "save" => {
            buffer.save().map_err(engine_err)?;
            Ok(json_response(json!({ "success": true, "version": buffer.version() }), false))
        },
        _ => unreachable!(),
    }
},
```

### Default: Unknown Command
```rust
other => Ok(json_response(Value::String(format!("Unknown command: {other}")), true)),
```

---

## Cargo.toml Dependencies

```toml
[dependencies]
tokio = { version = "1", features = ["full"] }
tokio-util = { version = "0.7", features = ["full"] }

napi = { version = "3", features = [
   "napi10",
   "serde-json",
   "tokio_rt",
   "tokio_time",
] }
napi-derive = "3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
ropey = "=2.0.0-beta.1"

parking_lot = "0.12.5"
dashmap = "6.1"

# Domain crates
pi-code-graph = { path = "../pi-code-graph", features = ["semantic"] }
pi-code-vectors = { path = "../pi-code-vectors" }
pi-code-engine = { path = "../pi-code-engine" }

# Tree-sitter
tree-sitter = "0.25"
tree-sitter-bash = "0.25"
tree-sitter-c = "0.24"
# ... other tree-sitter languages
```

---

## Key Imports

```rust
use std::{
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};

use napi::{Error, bindgen_prelude::*};
use napi_derive::napi;
use parking_lot::Mutex;
use serde_json::{Value, json};

// Domain-specific imports
use pi_code_engine::{
    buffer::{BufferRegistry, CodeBuffer},
    edit::{/* ... */},
    language::{LanguageId, LanguageProfile, LanguageRegistry},
    navigate::{/* ... */},
    outline::{/* ... */},
};

use crate::task::{self, CancelToken};
```

---

## Text Module Example (lines 1353-1358)

Simple synchronous function (no dispatch, no async):

```rust
#[napi(js_name = "visibleWidth")]
pub fn visible_width_napi(text: JsString, tab_width: Option<u32>) -> Result<u32> {
    let text_u16 = text.into_utf16()?;
    let tab_width = clamp_tab_width(tab_width);
    Ok(crate::utils::clamp_u32(visible_width_u16(text_u16.as_slice(), tab_width) as u64))
}
```

JavaScript call:
```typescript
const width = await native.visibleWidth(text, 3);
```

---

## Appearance Module Example (lines 406-437)

Class-based NAPI with instance methods:

```rust
#[napi]
pub struct MacAppearanceObserver {
    #[cfg(target_os = "macos")]
    inner: Option<platform::ObserverInner>,
}

#[napi]
impl MacAppearanceObserver {
    #[napi(factory)]
    pub fn start(
        #[napi(ts_arg_type = "(err: null | Error, appearance: string) => void")]
        callback: napi::threadsafe_function::ThreadsafeFunction<String>,
    ) -> napi::Result<Self> {
        #[cfg(target_os = "macos")]
        {
            Ok(Self { inner: Some(platform::ObserverInner::start(callback)) })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = callback;
            Ok(Self {})
        }
    }

    #[napi]
    pub fn stop(&mut self) {
        #[cfg(target_os = "macos")]
        if let Some(inner) = &mut self.inner {
            inner.stop();
        }
    }
}
```

JavaScript usage:
```typescript
const observer = MacAppearanceObserver.start((err, appearance) => {
    console.log(appearance);
});
observer.stop();
```
