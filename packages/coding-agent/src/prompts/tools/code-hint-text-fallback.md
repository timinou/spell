Fallback text mode is active here:
- Managed lifecycle commands still work: `code read`, `code diff`, `code edit { operation: "replace" }`, `code undo`, `code redo`, `code save`.
- Semantic-only commands such as `code outline` and `code navigate` are unavailable until the file has semantic support.
- If you expected a structural edit here, verify the file type/grammar first; a failed structural edit on a semantic file means re-read and tighten the target, not that `code edit` is generally unreliable.