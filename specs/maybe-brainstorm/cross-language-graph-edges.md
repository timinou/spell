# Cross-Language Graph Edges (Brainstorm)

**Status**: Brainstorm — revisit after multi-language graph extractors are working.

## Concept

Track edges across language boundaries:
- TypeScript → Rust via NAPI (`@napi` decorators → exported function names)
- TypeScript → Elisp via MCP tool calls (`callTool("code-navigate", ...)`)
- Python → C via ctypes/CFFI
- Any → Any via gRPC proto definitions

## Approach

Pattern-based edge detection:

```yaml
# Cross-language edge patterns
cross_language_edges:
  - name: napi-binding
    from_language: rust
    to_language: typescript
    pattern:
      rust_marker: "#[napi"
      rust_function: function_item
      ts_import: "@oh-my-pi/pi-natives"
    edge_kind: NapiBinding

  - name: mcp-tool-call
    from_language: typescript
    to_language: elisp
    pattern:
      ts_call: "callTool"
      ts_first_arg: string_literal  # tool name
      elisp_registration: "mcp-server-register-tool"
    edge_kind: McpToolCall
```

## Prerequisites

- Multiple language extractors working (TS, Rust at minimum)
- Pattern matching on function call arguments (need to extract string literal values)
- Tool registration extraction from Elisp (or declarative tool manifests)

## Open Questions

- How to handle indirect references (e.g., tool name comes from a variable)?
- Performance: cross-language edge detection requires correlating two parse results
- Should cross-language edges be a separate graph pass or integrated into extraction?
