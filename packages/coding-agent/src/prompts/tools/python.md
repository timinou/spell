Runs Python cells sequentially in a persistent IPython kernel.

<instruction>
- Kernel state persists across calls; imports, variables, and functions survive
- Work incrementally: one logical step per cell
- Use multiple small cells in one call when useful
- Define small reusable functions
- Put workflow explanations in the assistant message or cell title
- If a cell fails, resubmit only the fixed cell or fixed cell plus remaining cells
</instruction>

<output>
Use `display()` for rich output; object repr is not the rendered result.
</output>

<caution>
Per-call mode uses a fresh kernel; use `reset: true` to clear state in session mode.
</caution>

<critical>
Use `run()` for shell commands; do not use raw `subprocess`.
</critical>