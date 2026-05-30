# Spell

Spell is a terminal-native AI coding agent. It runs locally, talks to Claude, and gives you a full-featured TUI with tool calling, plan mode, org-mode project tracking, QML desktop windows, and Emacs code intelligence — all wired together into a single CLI.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/timinou/spell/main/install.sh | bash
```

Supported platforms: **Arch Linux**, **Ubuntu / Debian**, **macOS**.

The script installs Bun and Rust if missing, clones the repo to `~/.local/spell`, builds the native extensions, and links the `spell` binary. It is idempotent — running it again pulls the latest changes and rebuilds.

<details>
<summary>Manual steps</summary>

```bash
# 1. Prerequisites: git, curl, a C compiler, pkg-config + libssl (Linux only)
# 2. Install Bun
curl -fsSL https://bun.sh/install | bash
# 3. Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# 4. Clone
git clone https://github.com/timinou/spell ~/.local/spell
cd ~/.local/spell

# 5. Install JS deps
bun install --frozen-lockfile

# 6. Build native Rust extensions
bun run build:native

# 7. Link the CLI
bun run install:dev
```

After install, `spell --help` should be available in a new shell.

</details>

---

## What's New — week of 2026-03-10

### Features

- **QML desktop mode** — native Qt 6 window bridge with daemon process, push-based event delivery, and screenshot capture. Agent can open, interact with, and screenshot desktop windows without any manual listen loop.
- **Spell onboarding UI** — step-list QML window that guides through initial setup including automatic ADB configuration and Android remote bridge (`apps/spell/`) for controlling a phone from the agent.
- **Org-mode project management** — `org://` protocol handler for plan references; `update` now supports `body`, `title`, `append`, and `note` mutations; session context embedded in new category files.
- **Plan mode improvements** — org draft pre-created at plan entry, initial message prepended on finalization, `org` and `todo_write` tools always available inside plan mode.
- **Emacs code intelligence** — `OutlineEntry` enriched with `end_line`, `column`, `exported`, and `signature`; Rust/Python/Go/Elm outline support; structured warmup pipeline; project-local `treesitter.json`.
- **Multi-path tool support** — `find`, `grep`, `ast_grep`, and `ast_edit` now accept comma- or space-separated path lists.
- **Interactive input submission** — agent can now accept mid-session input from the user without a full restart.

### Fixes

- QML bridge timeout resolved; `onX` theme property naming conflict fixed; daemon stdio handling corrected.
- WM close no longer aborts an active agent turn.
- ADB unauthorized-device guidance surfaced; device filtering tightened.
- Plan mode session access guarded against closure race.
- Error log serialization corrected; APK-unavailable error made actionable.
- `abort()` now correctly sets `state.error`.
- Org plan errors surfaced as warnings rather than silently swallowed.

### Other

- **Renamed**: OMP / omp / kika → **Spell** / spell across the entire codebase and Android package ID.
- **Relicensed**: GPL-3.0-only (original MIT notices retained for compliance).

**wezterm:** Create `~/.wezterm.lua`:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

**Windows Terminal:** Does not support the Kitty keyboard protocol. Shift+Enter cannot be distinguished from Enter. Use Ctrl+Enter for multi-line input instead. All other keybindings work correctly.

### API Keys & OAuth

**Option 1: Environment variables** (common examples)

| Provider                                        | Environment Variable                         |
|-------------------------------------------------| -------------------------------------------- |
| Anthropic                                       | `ANTHROPIC_API_KEY`                          |
| OpenAI                                          | `OPENAI_API_KEY`                             |
| Google                                          | `GEMINI_API_KEY`                             |
| Mistral                                         | `MISTRAL_API_KEY`                            |
| Groq                                            | `GROQ_API_KEY`                               |
| Cerebras                                        | `CEREBRAS_API_KEY`                           |
| Hugging Face (`huggingface`)                    | `HUGGINGFACE_HUB_TOKEN` or `HF_TOKEN`        |
| Synthetic                                       | `SYNTHETIC_API_KEY`                          |
| NVIDIA (`nvidia`)                               | `NVIDIA_API_KEY`                             |
| NanoGPT (`nanogpt`)                             | `NANO_GPT_API_KEY`                           |
| Together (`together`)                           | `TOGETHER_API_KEY`                           |
| Ollama (`ollama`)                               | `OLLAMA_API_KEY` _(optional)_                |
| LiteLLM (`litellm`)                             | `LITELLM_API_KEY`                            |
| LM Studio (`lm-studio`)                         | `LM_STUDIO_API_KEY` _(optional)_             |
| llama.cpp (`llama.cpp`)                         | `LLAMA_CPP_API_KEY` _(optional)_             |
| Xiaomi MiMo (`xiaomi`)                          | `XIAOMI_API_KEY`                             |
| Moonshot (`moonshot`)                           | `MOONSHOT_API_KEY`                           |
| Venice (`venice`)                               | `VENICE_API_KEY`                             |
| Kilo Gateway (`kilo`)                           | `KILO_API_KEY`                               |
| GitLab Duo (`gitlab-duo`)                       | _OAuth only_                                 |
| Jina (`jina`, web search)                       | `JINA_API_KEY`                               |
| Perplexity                                      | `PERPLEXITY_API_KEY` or `PERPLEXITY_COOKIES` |
| xAI                                             | `XAI_API_KEY`                                |
| OpenRouter                                      | `OPENROUTER_API_KEY`                         |
| Z.AI                                            | `ZAI_API_KEY`                                |
| Qwen Portal (`qwen-portal`)                     | `QWEN_OAUTH_TOKEN` or `QWEN_PORTAL_API_KEY`  |
| vLLM (`vllm`)                                   | `VLLM_API_KEY`                               |
| Cloudflare AI Gateway (`cloudflare-ai-gateway`) | `CLOUDFLARE_AI_GATEWAY_API_KEY`              |
| Qianfan (`qianfan`)                             | `QIANFAN_API_KEY`                            |

See [Environment Variables](docs/environment-variables.md) for the full list.

**Option 2: `/login` (interactive auth / API key setup)**

Use `/login` with supported providers:

- Anthropic (Claude Pro/Max)
- ChatGPT Plus/Pro (Codex)
- GitHub Copilot
- Google Cloud Code Assist (Gemini CLI)
- Antigravity (Gemini 3, Claude, GPT-OSS)
- Cursor
- Kimi Code
- Perplexity
- NVIDIA (`nvidia`)
- NanoGPT (`nanogpt`)
- Hugging Face Inference (`huggingface`)
- OpenCode Zen
- Kilo Gateway (`kilo`)
- GitLab Duo (`gitlab-duo`)
- Qianfan (`qianfan`)
- Ollama (local / self-hosted, `ollama`)
- LM Studio (local / self-hosted, `lm-studio`)
- llama.cpp (local / self-hosted, `llama.cpp`)
- vLLM (local OpenAI-compatible, `vllm`)
- Z.AI (GLM Coding Plan)
- Synthetic
- Together (`together`)
- LiteLLM (`litellm`)
- Xiaomi MiMo (`xiaomi`)
- Moonshot (Kimi API, `moonshot`)
- Venice (`venice`)
- MiniMax Coding Plan (International / China)
- Qwen Portal (`qwen-portal`)
- Cloudflare AI Gateway (`cloudflare-ai-gateway`)

For `ollama`, API key is optional. Leave it unset for local no-auth instances, or set `OLLAMA_API_KEY` for authenticated hosts.
For `llama.cpp`, API key is optional. Leave it unset for local no-auth instances, or set `LLAMA_CPP_API_KEY` for authenticated hosts.
For `lm-studio`, API key is optional. Leave it unset for local no-auth instances, or set `LM_STUDIO_API_KEY` for authenticated hosts.
For `vllm`, paste your key in `/login` (or use `VLLM_API_KEY`). For local no-auth servers, any placeholder value works (for example `vllm-local`).
For `nanogpt`, `/login nanogpt` opens `https://nano-gpt.com/api` and prompts for your `sk-...` key (or set `NANO_GPT_API_KEY`). Login validates the key via NanoGPT's models endpoint (not a fixed model entitlement).
For `cloudflare-ai-gateway`, set provider base URL to
`https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`
(for example in `~/.spell/agent/models.yml`).

```bash
spell
/login
```

**Credential behavior:**

- `/login` appends credentials for the provider (it does not wipe existing entries)
- `/logout` clears saved credentials for the selected provider
- Credentials are stored in `~/.spell/agent/agent.db`
- For the same provider, saved API key credentials are selected before OAuth credentials

### First 15 Minutes (Recommended)

This is the practical onboarding flow for new users.

#### 1) Set up providers

- **API keys** (fastest): export `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.
- **OAuth subscriptions**: run `/login` and authenticate with your provider account

#### 2) Configure model roles via `/model`

Use `/model` in the TUI and assign role models:

- `default` → normal implementation work
- `smol` → fast/cheap exploration and lightweight tasks
- `slow` → deep reasoning for complex debugging/refactors
- `plan` → model used while plan mode is active (`/plan`)
- `commit` → model used by commit/changelog workflows

This setup is interactive and persisted for you.

#### 3) Use `/plan` before making large changes

`/plan` toggles plan mode. Use it when you want architecture and execution sequencing before edits.

Typical flow:

1. Run `/plan`
2. Ask for a concrete implementation plan
3. Refine the plan
4. Approve and execute

##### Optional: allow plan mode writes in specific folders

If you want `/plan` to create or update files in a small set of directories before approval, configure `planMode.allowedFolders` in your Spell config. Keys are folder paths; values are short descriptions surfaced back to the agent in plan mode prompts.

Paths may be relative to the current workspace, absolute, or `~`-prefixed. These exceptions only allow create/update operations. Deletes and moves remain blocked.

```yaml
planMode:
  allowedFolders:
    ./docs/plans: "Architecture notes and plan artifacts"
    ./scratch: "Temporary exploration files"
    ~/shared-plans: "Cross-project plan output directory"
```

#### 4) Review context via `/extensions`

If context usage is unexpectedly high, inspect discovered external provider assets (rules/prompts/context/hooks/extensions).

Run `/extensions` and:

- Browse provider tabs (`Tab` / `Shift+Tab`)
- Inspect each item source (`via <provider>` + file path)
- Disable full providers or specific items you don't want (`Space`)

---

## Usage

### Slash Commands

These are **in-chat slash commands** (not CLI subcommands).
| Command | Description |
| ------- | ----------- |
| `/settings` | Open settings menu |
| `/plan` | Toggle plan mode |
| `/model` (`/models`) | Open model selector |
| `/export [path]` | Export session to HTML |
| `/dump` | Copy session transcript to clipboard |
| `/share` | Upload session as a secret gist |
| `/session` | Show session info and usage |
| `/usage` | Show provider usage and limits |
| `/hotkeys` | Show keyboard shortcuts |
| `/extensions` (`/status`) | Open Extension Control Center |
| `/changelog` | Show changelog entries |
| `/tree` | Navigate session tree |
| `/branch` | Open branch selector (tree or message selector, based on settings) |
| `/fork` | Fork from a previous message |
| `/resume` | Open session picker |
| `/new` | Start a new session |
| `/compact [focus]` | Compact context manually |
| `/handoff [focus]` | Hand off context to a new session |
| `/browser [headless\|visible]` | Toggle browser mode |
| `/mcp ...` | Manage MCP servers |
| `/memory ...` | Inspect/clear/rebuild memory state |
| `/move <path>` | Move current session to a different cwd |
| `/background` (`/bg`) | Detach UI and continue in background |
| `/debug` | Open debug tools |
| `/copy` | Copy last agent message |
| `/login` / `/logout` | OAuth login/logout |
| `/exit` (`/quit`) | Exit interactive mode |

Bundled custom slash commands include `/review` (interactive code review launcher).

### Editor Features

**File reference (`@`):** Type `@` to fuzzy-search project files. Respects `.gitignore`.

**Path completion (Tab):** Complete relative paths, `../`, `~/`, etc.

**Drag & drop:** Drag files from your file manager into the terminal.

**Multi-line paste:** Pasted content is collapsed in preview but sent in full.

**Message queuing:** Submit messages while the agent is working; queue behavior is configurable in `/settings`.

### Keyboard Shortcuts

**Navigation:**

| Key                      | Action                                       |
| ------------------------ | -------------------------------------------- |
| Arrow keys               | Move cursor / browse history (Up when empty) |
| Option+Left/Right        | Move by word                                 |
| Ctrl+A / Home / Cmd+Left | Start of line                                |
| Ctrl+E / End / Cmd+Right | End of line                                  |

**Editing:**

| Key                       | Action                  |
| ------------------------- | ----------------------- |
| Enter                     | Send message            |
| Shift+Enter / Alt+Enter   | New line                |
| Ctrl+W / Option+Backspace | Delete word backwards   |
| Ctrl+U                    | Delete to start of line |
| Ctrl+K                    | Delete to end of line   |

**Other:**

| Key                   | Action                                                    |
| --------------------- | --------------------------------------------------------- |
| Tab                   | Path completion / accept autocomplete                     |
| Escape                | Cancel autocomplete / abort streaming                     |
| Ctrl+C                | Clear editor (first) / exit (second)                      |
| Ctrl+D                | Exit (when editor is empty)                               |
| Ctrl+Z                | Suspend to background (use `fg` in shell to resume)       |
| Shift+Tab             | Cycle thinking level                                      |
| Ctrl+P / Shift+Ctrl+P | Cycle role models (slow/default/smol), temporary on shift |
| Alt+P                 | Select model temporarily                                  |
| Ctrl+L                | Open model selector                                       |
| Alt+Shift+P           | Toggle plan mode                                          |
| Ctrl+R                | Search prompt history                                     |
| Ctrl+O                | Toggle tool output expansion                              |
| Ctrl+T                | Toggle todo list expansion                                |
| Ctrl+G                | Edit message in external editor (`$VISUAL` or `$EDITOR`)  |
| Alt+H                 | Toggle speech-to-text recording                           |

### Bash Mode

Prefix commands with `!` to execute them and include output in context:

```bash
!git status
!ls -la
```

Use `!!` to execute but **exclude output from LLM context**:

```bash
!!git status
```

Output streams in real-time. Press Escape to cancel.

### Image Support

**Attach images by reference:**

```text
What's in @/path/to/image.png?
```

Or paste/drop images directly (`Ctrl+V` or drag-and-drop).

Supported formats: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`

Toggle inline images via `/settings` or set `terminal.showImages: false`.

---

## Sessions

Sessions are stored as JSONL with a tree structure for branching and replay.

See [docs/session.md](docs/session.md) for the file format and API.

### Session Management

Sessions auto-save to `~/.spell/agent/sessions/` (grouped by working directory).

```bash
spell --continue             # Continue most recent session
spell -c

spell --resume               # Open session picker
spell -r

spell --resume <id-prefix>   # Resume by session ID prefix
spell --resume <path>        # Resume by explicit .jsonl path
spell --session <value>      # Alias of --resume
spell --no-session    # Ephemeral mode (don't save)
```

Session IDs are Snowflake-style hex IDs (not UUIDs).

### Context Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent context.

**Manual:** `/compact` or `/compact Focus on the API changes`

**Automatic:** Enable via `/settings`.

- **Overflow recovery**: model returns context overflow; compact and retry.
- **Threshold maintenance**: context exceeds configured headroom after a successful turn.

**Configuration** (`~/.spell/agent/config.yml`):

```yaml
compaction:
  enabled: true
  reserveTokens: 16384
  keepRecentTokens: 20000
  autoContinue: true
```

See [docs/compaction.md](docs/compaction.md) for internals and hook integration.

### Branching

**In-place navigation (`/tree`):** Navigate the session tree without creating new files.

- Search by typing, page with ←/→
- Filter modes (`Ctrl+O`): default → no-tools → user-only → labeled-only → all
- Press `Shift+L` to label entries as bookmarks

**Create new session (`/branch` / `/fork`):** Branch to a new session file from a selected previous message.

### Autonomous Memory

When enabled, the agent extracts durable knowledge from past sessions and injects it at startup. The pipeline runs in the background and never blocks the active session.

Memory is isolated per project (working directory) and stored under `~/.spell/agent/memories/`. At session start, a compact summary is injected into the system prompt. The agent can read deeper context via `memory://root/MEMORY.md` and `memory://root/skills/<name>/SKILL.md`.

Manage via the `/memory` slash command:

- `/memory view` — show current injection payload
- `/memory clear` — delete all memory data and artifacts
- `/memory enqueue` — force consolidation at next startup

> See [Memory Documentation](docs/memory.md).

---

## Configuration

### Project Context Files

spell discovers project context from supported config directories (for example `.spell`, `.claude`, `.codex`, `.gemini`).

Common files:

- `AGENTS.md`
- `CLAUDE.md`

Use these for:

- Project instructions and guardrails
- Common commands and workflows
- Architecture documentation
- Coding/testing conventions

### Custom System Prompt

Replace the default system prompt by creating `SYSTEM.md`:

1. **Project-local:** `.spell/SYSTEM.md` (takes precedence)
2. **Global:** `~/.spell/agent/SYSTEM.md` (fallback)
   `--system-prompt` overrides both files. Use `--append-system-prompt` to append additional instructions.

### Custom Models and Providers

Add custom providers/models via `~/.spell/agent/models.yml`.

`models.json` is still supported for legacy configs, but `models.yml` is the modern format.

> See [models.yml provider integration guide](docs/models.md) for schema and merge behavior.

```yaml
providers:
  ollama:
    baseUrl: http://localhost:11434/v1
    apiKey: OLLAMA_API_KEY
    api: openai-completions
    models:
      - id: llama-3.1-8b
        name: Llama 3.1 8B (Local)
        reasoning: false
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
        maxTokens: 32000

  llama.cpp:
    baseUrl: http://127.0.0.1:8080
    api: openai-responses
    auth: none
    discovery:
      type: llama.cpp
```

**Supported APIs:** `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `google-generative-ai`, `google-vertex`

### Settings File

Global settings are stored in:

- `~/.spell/agent/config.yml`

Project overrides are loaded from discovered project settings files (commonly `.spell/settings.json`).

Global `config.yml` example:

```yaml
theme:
  dark: titanium
  light: light

modelRoles:
  default: anthropic/claude-sonnet-4-20250514
  plan: anthropic/claude-opus-4-1:high
  smol: anthropic/claude-sonnet-4-20250514
defaultThinkingLevel: high
enabledModels:
  - anthropic/*
  - "*gpt*"
  - gemini-2.5-pro:high

steeringMode: one-at-a-time
followUpMode: one-at-a-time
interruptMode: immediate

shellPath: C:\\path\\to\\bash.exe
hideThinkingBlock: false
collapseChangelog: false

disabledProviders: []
disabledExtensions: []

compaction:
  enabled: true
  reserveTokens: 16384
  keepRecentTokens: 20000

skills:
  enabled: true

retry:
  enabled: true
  maxRetries: 3
  baseDelayMs: 2000

terminal:
  showImages: true

topP: -1 # Nucleus sampling (0-1, -1 = provider default)
topK: -1 # Top-K tokens (-1 = provider default)
minP: -1 # Minimum probability (0-1, -1 = provider default)

display:
  tabWidth: 4 # Tab rendering width (.editorconfig integration)

async:
  enabled: false
  maxJobs: 100

task:
  eager: false
  isolation:
    mode: none # none | worktree | fuse-overlay | fuse-projfs
    merge: patch # patch | branch
```

Legacy migration notes:

- `settings.json` → `config.yml`
- `queueMode` → `steeringMode`
- flat `theme: "..."` → `theme.dark` / `theme.light`

---

## Extensions

### Themes

Built-in themes include `dark`, `light`, and many bundled variants.

**Automatic dark/light switching**: spell detects terminal appearance via Mode 2031, native macOS CoreFoundation FFI, or `COLORFGBG` fallback, and switches between `theme.dark` and `theme.light` automatically.

Select theme via `/settings` or set in `~/.spell/agent/config.yml`:

```yaml
theme:
  dark: titanium
  light: light
```

**Custom themes:** create `~/.spell/agent/themes/*.json`.

> See [Theme Documentation](docs/theme.md).

### Custom Slash Commands

Define reusable prompt commands as Markdown files:

- Global: `~/.spell/agent/commands/*.md`
- Project: `.spell/commands/*.md`

```markdown
---
description: Review staged git changes
---

Review the staged changes (`git diff --cached`). Focus on:

- Bugs and logic errors
- Security issues
- Error handling gaps
```

Filename (without `.md`) becomes the command name.

Argument placeholders:

- `$1`, `$2`, ... positional arguments
- `$@` and `$ARGUMENTS` for all arguments joined

TypeScript custom commands are also supported:

- `~/.spell/agent/commands/<name>/index.ts`
- `.spell/commands/<name>/index.ts`

Bundled TypeScript command: `/review`.

### Skills

Skills are capability packages loaded on-demand.

Common locations:

- `~/.spell/agent/skills/*/SKILL.md`
- `.spell/skills/*/SKILL.md`
- `~/.claude/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md`
- `~/.codex/skills/*/SKILL.md`, `.codex/skills/*/SKILL.md`

```markdown
---
name: brave-search
description: Web search via Brave Search API.
---

# Brave Search
```

`description` drives matching; `name` defaults to the folder name when omitted.

Disable skills with `spell --no-skills` or `skills.enabled: false`.

> See [Skills Documentation](docs/skills.md).

### Hooks

Hooks are TypeScript modules that subscribe to lifecycle events.

Hook locations:

- Global: `~/.spell/agent/hooks/pre/*.ts`, `~/.spell/agent/hooks/post/*.ts`
- Project: `.spell/hooks/pre/*.ts`, `.spell/hooks/post/*.ts`
- CLI: `--hook <path>`

```typescript
import type { HookAPI } from "@spell/pi-coding-agent/hooks";

export default function (omp: HookAPI) {
	omp.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash" && /sudo/.test(event.input.command as string)) {
			const ok = await ctx.ui.confirm("Allow sudo?", event.input.command as string);
			if (!ok) return { block: true, reason: "Blocked by user" };
		}
		return undefined;
	});
}
```

Inject messages from hooks with:

```ts
omp.sendMessage(message, { triggerTurn: true });
```

> See [Hooks Documentation](docs/hooks.md) and [examples/hooks/](packages/coding-agent/examples/hooks/).

### Custom Tools

Custom tools extend the built-in toolset and are callable by the model.

Auto-discovered locations:

- Global: `~/.spell/agent/tools/*/index.ts`
- Project: `.spell/tools/*/index.ts`

```typescript
import { Type } from "@sinclair/typebox";
import type { CustomToolFactory } from "@spell/pi-coding-agent";
const factory: CustomToolFactory = () => ({
	name: "greet",
	label: "Greeting",
	description: "Generate a greeting",
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),
	async execute(_toolCallId, params) {
		const { name } = params as { name: string };
		return { content: [{ type: "text", text: `Hello, ${name}!` }] };
	},
});
export default factory;
```

> See [Custom Tools Documentation](docs/custom-tools.md) and [examples/custom-tools/](packages/coding-agent/examples/custom-tools/).

---

## CLI Reference

```bash
spell [options] [@files...] [messages...]
spell <command> [args] [flags]
```

### Options

| Option                                | Description                                                        |
| ------------------------------------- | ------------------------------------------------------------------ |
| `--provider <name>`                   | Provider hint (legacy; prefer `--model`)                           |
| `--model <id>`                        | Model ID (supports fuzzy match)                                    |
| `--smol <id>`                         | Override the `smol` role model for this run                        |
| `--slow <id>`                         | Override the `slow` role model for this run                        |
| `--plan <id>`                         | Override the `plan` role model for this run                        |
| `--models <patterns>`                 | Comma-separated model patterns for role cycling                    |
| `--list-models [pattern]`             | List available models (optional fuzzy filter)                      |
| `--thinking <level>`                  | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--api-key <key>`                     | API key (overrides environment/provider lookup)                    |
| `--system-prompt <text\|file>`        | Replace system prompt                                              |
| `--append-system-prompt <text\|file>` | Append to system prompt                                            |
| `--mode <mode>`                       | Output mode: `text`, `json`, `rpc`                                 |
| `--print`, `-p`                       | Non-interactive: process prompt and exit                           |
| `--continue`, `-c`                    | Continue most recent session                                       |
| `--resume`, `-r [id\|path]`           | Resume by ID prefix/path (or open picker if omitted)               |
| `--session <value>`                   | Alias of `--resume`                                                |
| `--session-dir <dir>`                 | Directory for session storage and lookup                           |
| `--no-session`                        | Don't save session                                                 |
| `--tools <tools>`                     | Restrict to comma-separated built-in tool names                    |
| `--no-tools`                          | Disable all built-in tools                                         |
| `--no-lsp`                            | Disable LSP integration                                            |
| `--no-pty`                            | Disable PTY-based interactive bash execution                       |
| `--extension <path>`, `-e`            | Load extension file (repeatable)                                   |
| `--hook <path>`                       | Load hook/extension file (repeatable)                              |
| `--no-extensions`                     | Disable extension discovery (`-e` paths still load)                |
| `--no-skills`                         | Disable skills discovery and loading                               |
| `--skills <patterns>`                 | Comma-separated glob patterns to filter skills                     |
| `--no-rules`                          | Disable rules discovery and loading                                |
| `--allow-home`                        | Allow starting from home dir without auto-chdir                    |
| `--no-title`                          | Disable automatic session title generation                         |
| `--export <file> [output]`            | Export session to HTML                                             |
| `--help`, `-h`                        | Show help                                                          |
| `--version`, `-v`                     | Show version                                                       |

### Subcommands

`spell` also ships dedicated subcommands:

- `commit`
- `config`
- `grep`
- `jupyter`
- `plugin`
- `search` (alias: `q`)
- `setup`
- `shell`
- `ssh`
- `stats`
- `update`

### File Arguments

Include files with `@` prefix:

```bash
spell @prompt.md "Answer this"
spell @screenshot.png "What's in this image?"
spell @requirements.md @design.png "Implement this"
```

Text files are wrapped in `<file ...>` blocks. Images are attached.

### Examples

```bash
# Interactive mode
spell
# Non-interactive
spell -p "List all .ts files in src/"
spell -c "What did we discuss?"
# Resume by ID prefix
spell -r abc123

# Model cycling with patterns
spell --models "sonnet:high,haiku:low"

# Restrict toolset for read-only review
spell --tools read,grep,find -p "Review the architecture"
# Export session
spell --export session.jsonl output.html
```

### Environment Variables

| Variable                                          | Description                                             |
| ------------------------------------------------- | ------------------------------------------------------- |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.       | Provider credentials                                    |
| `PI_CODING_AGENT_DIR`                             | Override agent data directory (default: `~/.spell/agent`) |
| `PI_PACKAGE_DIR`                                  | Override package directory resolution                   |
| `PI_SMOL_MODEL`, `PI_SLOW_MODEL`, `PI_PLAN_MODEL` | Role-model overrides                                    |
| `PI_NO_PTY`                                       | Disable PTY-based bash execution                        |
| `VISUAL`, `EDITOR`                                | External editor for Ctrl+G                              |

See [Environment Variables](docs/environment-variables.md) for the complete reference.

---

## Tools

Use `--tools <list>` to restrict available built-in tools.

### Built-in Tool Names (`--tools`)

| Tool             | Description                                                    |
| ---------------- | -------------------------------------------------------------- |
| `ask`            | Ask the user structured follow-up questions (interactive mode) |
| `bash`           | Execute shell commands                                         |
| `python`         | Execute Python code in IPython kernel                          |
| `calc`           | Deterministic calculator/evaluator                             |
| `ssh`            | Execute commands on configured SSH hosts                       |
| `edit`           | In-place file editing with LINE#ID anchors                     |
| `find`           | Find files by glob pattern                                     |
| `grep`           | Search file content                                            |
| `ast_grep`       | Structural code search using AST matching (ast-grep)           |
| `ast_edit`       | Structural AST-aware code rewrites (ast-grep)                  |
| `lsp`            | Language server actions (11 operations)                        |
| `notebook`       | Edit Jupyter notebooks                                         |
| `read`           | Read files/directories (default text cap: 3000 lines)          |
| `browser`        | Browser automation tool (model-facing name: `puppeteer`)       |
| `task`           | Launch subagents for parallel execution                        |
| `await`          | Block on async background jobs                                 |
| `todo_write`     | Phased task tracking with progress management                  |
| `fetch`          | Fetch and extract URL content                                  |
| `web_search`     | Multi-provider web search                                      |
| `deep_search`    | AI-powered deep research with synthesized results (Exa)        |
| `code_search`    | Search code snippets and technical documentation (Exa)         |
| `write`          | Create/overwrite files                                         |
| `generate_image` | Generate or edit images using Gemini image models              |

Notes:

- Some tools are setting-gated (`calc`, `browser`, etc.)
- `ask` requires interactive UI
- `ssh` requires configured SSH hosts

Example:

`spell --tools read,grep,find -p "Review this codebase"`

For adding new tools, see [Custom Tools](#custom-tools).

---

## Programmatic Usage

### SDK

For embedding spell in Node.js/TypeScript applications, use the SDK:

```typescript
import { ModelRegistry, SessionManager, createAgentSession, discoverAuthStorage } from "@spell/pi-coding-agent";
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();
const { session } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
session.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});
await session.prompt("What files are in the current directory?");
```

The SDK provides control over:

- Model selection and thinking level
- System prompt (replace or append)
- Built-in/custom tools
- Hooks, skills, context files, slash commands
- Session persistence (`SessionManager`)
- Settings (`Settings`)
- API key and OAuth resolution

> See [SDK Documentation](docs/sdk.md) and [examples/sdk/](packages/coding-agent/examples/sdk/).

### RPC Mode

For embedding from other languages or process isolation:

```bash
spell --mode rpc --no-session
```

Send JSON commands on stdin:

```json
{"id":"req-1","type":"prompt","message":"List all .ts files"}
{"id":"req-2","type":"abort"}
```

Responses are emitted as `type: "response"`; session events stream on stdout as they occur.

> See [RPC Documentation](docs/rpc.md) for the full protocol.

### HTML Export

```bash
spell --export session.jsonl              # Auto-generated filename
spell --export session.jsonl output.html  # Custom filename
```

Works with session files and JSON event logs from `--mode json`.

---

## Philosophy

spell is a fork of [pi-mono](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner), extended with a batteries-included coding workflow.

Key ideas:

- Keep interactive terminal-first UX for real coding work
- Include practical built-ins (tools, sessions, branching, subagents, extensibility)
- Make advanced behavior configurable rather than hidden

---

## Development

```bash
# Install dependencies
bun install

# Build native Rust extensions (required once, and after Rust changes)
bun run build:native

# Link the CLI locally
bun run install:dev

# Type-check + lint
bun check

# Watch mode (TUI dev)
bun dev
```
