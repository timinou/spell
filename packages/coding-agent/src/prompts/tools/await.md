Blocks until one or more background jobs complete, fail, or are cancelled.

You **MUST** use this instead of polling `get jobs://` in a loop when you need to wait for background task or bash results before continuing.

Returns the status and results of all watched jobs once at least one finishes.

When a queued task is auto-promoted to running while you are waiting (because its blocker just completed), the result includes a `## Newly Started` section listing those jobs. Re-call `await` (with no arguments, or with the new IDs) to wait for them.