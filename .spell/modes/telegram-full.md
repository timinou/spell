---
name: telegram-full
description: Full tool access for Telegram sessions (requires /unlock)
extends: telegram-readonly
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
    - edit
    - write
    - bash
    - ast_edit
    - task
    - todo_write
    - emacs_code
    - notebook
    - generate_image
---

# Telegram Full Access Mode

This mode provides full tool access when accessed via Telegram.
Activated via the /unlock command with owner confirmation.

Includes all read-only tools plus write access: file editing, bash execution,
task delegation, and code generation.
