# Development Rules

## Default Context

This repo contains multiple packages, but **`packages/coding-agent/`** is the primary focus unless stated otherwise.

**Terminology:** when the user says “agent” or asks why “agent” is doing X, they mean the coding-agent package implementation, not the current assistant session.

### Package Structure

| Package                 | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `packages/ai`           | Multi-provider LLM client with streaming support     |
| `packages/agent`        | Agent runtime with tool calling and state management |
| `packages/coding-agent` | Main CLI application (primary focus)                 |
| `packages/tui`          | Terminal UI library with differential rendering      |
| `packages/natives`      | bindings for native text/image/grep operations       |
| `packages/stats`        | Local observability dashboard (`spell stats`)          |
| `packages/utils`        | Shared utilities (logger, streams, temp files)       |
| `crates/pi-natives`     | Rust crate for performance-critical text/grep ops    |

## Org Logic: Native-First Policy

Org-mode parsing, querying, and graph algorithms run natively via `pi-org-engine` in `@oh-my-pi/pi-natives`.
- Canonical tool: `executeOrg` NAPI dispatch (`parse`, `query`, `graph`, `computeWaves`, `nextWave`, `editSection`, `toMarkdown`).
- No Emacs dependency; the org tool runs without Emacs, socat, or other external processes.
- Writes stay in TypeScript; `org-writer.ts` handles file mutations and the native engine stays read-only.
- Plan execution uses `FluidOrchestrator` with `OrgFluidBridge` for ITEM→DOING→DONE lifecycle.

## Code Quality

- No `any` types unless absolutely necessary.
- Prefer `export * from "./module"` over named re-export blocks, including `export type { ... } from`; in pure barrel files, use star re-exports even for single-specifier cases, and remove redundant exports if star re-exports create ambiguity.
- Class encapsulation: ES `#` private fields, bare for accessible. No `private`/`protected`/`public` keywords except constructor parameter properties.
- No `ReturnType<>` — use actual type names from source or `node_modules` type definitions.
- Check `node_modules` for external API types instead of guessing.
- No inline imports: avoid `await import(...)`, `import("pkg").Type`, and dynamic imports for types; use top-level imports.
- Never remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead.
- Ask before removing functionality or code that appears intentional.
- Never build prompts in code: no inline strings, template literals, or concatenation; prompts live in static `.md` files and dynamic content uses Handlebars.
- Import static text files via Bun text imports (`import content from "./prompt.md" with { type: "text" }`) instead of `readFileSync`.
- Use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)` for cleaner, typed resolvers.

## Bun Over Node

Use Bun APIs when they are simpler; use Node APIs only where Bun lacks coverage or the task needs Node-specific behavior.

- Spawn shell commands only when no direct API exists.
- Process execution: use `$` template literals for simple commands; use `Bun.spawn` only for long-running, streaming, or lifecycle-managed processes.
- Sleep: use `await Bun.sleep(ms)`.
- Node imports: `node:fs`, `node:path`, `node:os` → `import * as` namespace only.
- File I/O: `Bun.file()` for reads, `Bun.write()` for writes (auto-creates parent dirs), and `node:fs/promises` for directory ops.
- File I/O anti-patterns: no `exists()` before read, no duplicate handles to the same path, no `Buffer.from(await Bun.file(...).arrayBuffer())`, and no redundant exists-check + try/catch.
- Streams: use `readStream()` and `readLines()` helpers; manual reader loops only for SSE or streaming JSON-RPC.
- JSON5/JSONL: use `Bun.JSON5` and `Bun.JSONL`; for streaming JSONL use `parseChunk()` / `parse()` without decoding first.
- String width: use `Bun.stringWidth()`.
- Wrapping: use `Bun.wrapAnsi()`.
- Where Bun wins: file read/write, process spawn, sleep, binary lookup, HTTP server, SQLite, hashing, path resolution, JSON5, JSONL, string width, text wrapping.
- Anti-patterns: `Bun.spawnSync` for simple commands, `setTimeout` promises for sleep, sync file APIs in async code, manual `child.stdout.getReader()` loops for non-streaming commands, `json5` dependency, custom width logic, custom ANSI wrapping.

### File I/O Anti-Patterns

- Do not check `.exists()` before reading; use `try/catch` with `isEnoent()`.
- Do not create multiple handles to the same path.
- Do not use `Buffer.from(await Bun.file(x).arrayBuffer())`; use `readFile`.
- Do not mix redundant existence checks with `try/catch`.

### Patterns

- Subprocess streams: cast when using pipe mode.
- Password hashing: use Bun built-in bcrypt/argon2.

## Logging

- Never use `console.log`, `console.error`, or `console.warn` in the coding-agent package; console output corrupts the TUI rendering.
- Use the centralized logger instead.
- Logs go to `~/.spell/logs/spell.YYYY-MM-DD.log` with automatic rotation.

## TUI Rendering Sanitization

All text displayed in tool renderers must be sanitized before output; raw file content, error messages, and tool output can break terminal rendering or leak home directories.

### Rules

- Tabs → spaces: always pass displayed text through `replaceTabs()` before rendering.
- Line truncation: truncate displayed lines with `truncateToWidth()` or `ui.truncate()` and use `TRUNCATE_LENGTHS` for consistency.
- Path shortening: use `shortenPath()` for user-visible file paths.
- Content preview limits: use `PREVIEW_LIMITS` constants for collapsed/expanded line counts.

### Where to apply

Apply sanitization to every TUI render path, including success output, error messages, diff content, and streaming previews; if a message includes file content, it needs `replaceTabs()`.

### Streaming tool previews

- Preview-only fields must survive every preview/render path, including partial JSON, transcript rebuilds, and merged call/result rendering.
- Bash previews may need raw `partialJson` before arguments parse.
- Preserve preview-only fields through `event-controller.ts`, `ui-helpers.ts`, and `tool-execution.ts`.
- `ToolExecutionComponent.#buildRenderContext()` must work before a result exists.
- Verify live streaming and rebuilt transcript paths together.

## Commands

| Command        | Description                      |
| -------------- | -------------------------------- |
| `bun check`    | Check all (TypeScript + Rust)    |
| `bun check:ts` | Biome check + tsgo type checking |
| `bun check:rs` | Cargo fmt --check + clippy       |
| `bun lint`     | Lint all                         |
| `bun lint:ts`  | Biome lint                       |
| `bun lint:rs`  | Cargo clippy                     |
| `bun fmt`      | Format all                       |
| `bun fmt:ts`   | Biome format                     |
| `bun fmt:rs`   | Cargo fmt                        |
| `bun fix`      | Fix all (unsafe fixes + format)  |
| `bun fix:ts`   | Biome --unsafe + format-prompts  |
| `bun fix:rs`   | Clippy --fix + cargo fmt         |

- Never run `bun run dev` or `bun test` unless the user instructs it.
- Only run specific tests if the user instructs them, for example `bun test test/specific.test.ts`.
- Never commit unless the user asks.
- Do not use `tsc` or `npx tsc`; always use `bun check`.

## Testing Guidance

- Test the externally observable contract, not the easiest internal detail.
- Every new test must defend one concrete contract: behavior, output shape, state transition, error mapping, or a regression-prone parsing boundary.
- Avoid placeholder tests, tautologies, and assertions that only prove execution.
- Prefer contract-level tests over implementation-detail tests; avoid helper wiring, incidental ordering, singleton identity, boilerplate, or passthrough assertions unless another component depends on them.
- For lifecycle or stateful code, prefer one test per invariant or transition over several tiny field-level tests.
- For error handling, trigger the real failure path and assert the surfaced contract.
- Smoke tests are acceptable only when they catch a failure mode narrower tests would miss.
- Assert exact strings, ordering, and formatting only when downstream code depends on the exact bytes.
- If a guarantee is compile-time only, enforce it with type checks or type-test coverage.
- Skip tests for tiny low-risk changes unless they affect a real contract or a regression-prone edge case.
- Prefer focused package-local verification for the changed area.

## GitHub Issues

- Always read all comments on an issue.
- Use standard GitHub labels when creating issues.
- Mention the affected package in the title or description when relevant.
- Include `fixes #<number>` or `closes #<number>` in commit messages that close issues.

## Tools

- GitHub CLI for issues and PRs.
- Use tmux for TUI interaction.

## Style

- Keep answers short and concise.
- No emojis in commits, issues, PR comments, or code.
- No fluff or cheerful filler text.
- Technical prose only; be kind but direct.

## Changelog

Location: `packages/*/CHANGELOG.md` (each package has its own)

### Format

- Under `## [Unreleased]`, use `### Added`, `### Changed`, `### Fixed`, `### Removed`, and `### Breaking Changes` as needed.
- New entries always go under `## [Unreleased]`.
- Never modify already-released version sections.
- Released version sections are immutable.
- Attribution: internal issue-driven changes use `Fixed foo bar ([#123](https://github.com/can1357/oh-my-pi/issues/123))`; external contributions use `Added feature X ([#456](https://github.com/can1357/oh-my-pi/pull/456) by [@username](https://github.com/username))`.

## Releasing

1. Update CHANGELOGs in each affected package’s `[Unreleased]` section.
2. Run `bun run release`.

The release script handles version bump, CHANGELOG finalization, commit, tag, publish, and new `[Unreleased]` sections.

## Agent Tools

Spell agents use 4 generic tools as the canonical code interaction surface:

<critical>
The 4 generic tools (`get`, `edit`, `manage`, `create`) are the canonical surface for all code and file operations. Legacy tools (`read`, `grep`, `find`, `ast_grep`, `ast_edit`, `write`, `code`) are being phased out.
</critical>

### Tool Overview

| Tool      | Purpose                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `get`     | Read files, search content, find files, grep patterns, AST queries     |
| `edit`    | Structural edits, LINE#ID edits, patches, all file modifications       |
| `manage`  | Save, undo, redo, diff, buffers, index, status, context                |
| `create`  | Create new files with text, bytes, or base64 content                   |

### Precedence

Pick the right tool for the job:

1. **Read operations**: `get` for all file reads, searches, and queries (code AND non-code)
2. **Write operations**: `edit` for modifications, `create` for new files
3. **State management**: `manage` for workspace state, diffs, and coordination
4. **Bash**: simple one-liners only (`cargo build`, `npm install`, `docker run`)

You **MUST NOT** use Bash when a specialized tool exists:
- `get` not bash cat/grep/find/rg
- `edit` not bash sed/awk/perl
- `create` not bash echo/cat redirects

### Migration from Legacy Tools

| Legacy Tool         | New Equivalent                           |
| ------------------- | ---------------------------------------- |
| `read`              | `get`                                    |
| `grep`              | `get` (with pattern parameter)           |
| `find`              | `get` (with glob/directory target)       |
| `ast_grep`          | `get` (AST-aware search)                 |
| `code read`         | `get`                                    |
| `code outline`      | `get` (with format: tree)                |
| `code edit`         | `edit`                                   |
| `code symbols`      | `get` (symbol search)                    |
| `ast_edit`          | `edit` (structural mode)                 |
| `write`             | `create` (new files) or `edit` (replace) |
| `code save/undo/..` | `manage`                                 |

### Best Practices

- Use `get` for all read/search operations, regardless of file type
- Use `edit` for any file modification, from line edits to structural refactors
- Use `manage save` before risky operations; `manage undo` to revert
- Use `create` only for new files; use `edit` to replace existing files
- Prefer `get` with targeted parameters over full-file reads
- Always use `manage diff` to verify changes before committing
