# Architecture Assertions (Brainstorm)

**Status**: Brainstorm — revisit when pi-code-engine + pi-code-graph refactor is complete.

## Concept

Define architectural rules in a declarative YAML file that are validated against the code graph:

```yaml
# .spell/architecture.yaml
rules:
  - name: no-circular-packages
    deny_cycles_between:
      - packages/ai
      - packages/agent
      - packages/coding-agent

  - name: tools-dont-import-tui
    deny_edge:
      from: packages/coding-agent/src/tools/**
      to: packages/tui/**
      kinds: [Imports]

  - name: utils-has-no-outbound-deps
    deny_edge:
      from: packages/utils/**
      to_except: [node:*, bun:*]

  - name: no-cross-package-internals
    deny_edge:
      from: packages/*/src/**
      to: packages/*/src/**
      # Only allow imports via package index (not internal paths)
      to_except: [packages/*/src/index.ts]
```

## Integration

- New graph command: `code { command: "check-architecture" }`
- Reads `.spell/architecture.yaml`
- Validates each rule against the graph
- Returns violations with specific file:line references
- Could also run as CI check via `spell check-architecture`

## Prerequisites

- pi-code-graph must support glob-based file matching in edge queries
- Graph must have accurate import edges (already exists for TS, needed for Rust/Python)
- Cycle detection between specific subsets of the graph (not full SCC)

## Open Questions

- Should violations be warnings or errors?
- Should this support allow-list exceptions per rule?
- Should it integrate with the dead_code analysis (unused exports at package boundaries)?
- How to handle dynamic imports / require() that aren't statically resolved?
