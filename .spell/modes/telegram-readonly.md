---
name: telegram-readonly
description: Read-only tool access for Telegram sessions
tools:
  allow:
    - read
    - grep
    - find
    - lsp
    - ast_grep
    - web_search
    - fetch
    - org
    - calc
    - code_search
---

# Telegram Read-Only Mode

This mode restricts the agent to read-only tools when accessed via Telegram.
No file modifications, no command execution, no writes of any kind.

Suitable for browsing code, searching, and answering questions about the codebase.
