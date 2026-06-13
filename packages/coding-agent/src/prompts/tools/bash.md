Processes only. Build · test · git · scripts.

<patterns>
|pattern|example|
|---|---|
|build|`cargo check -p X`  ·  `bun run check:ts`|
|test|`cargo test -p X filter`  ·  `bun test path/foo.test.ts`|
|git query|`git log --oneline -S 'symbol'`  ·  `git show HASH`|
|git mutate|`git commit -m '…'`  ·  `git checkout file`|
|fs mutate|`mkdir -p X`  ·  `rm -rf Y`  ·  `chmod +x Z`|
|inline script|`python3 -c '…'`  ·  `sqlite3 db '…'`|
</patterns>

<spill>
- default → artifact-first: stdout/stderr saved to artifact://…, summary inline
- `head: N` / `tail: N` → bounded raw output for that call
- `async: true` → returns job id; wait via `await`
</spill>

<rules>
- file reads/search/list/stat → use `find`, not bash (`find` handles slicing, regex, listing, stat via the CodePath grammar)
- file mutations → use `edit` for known files, `create` for new files
- bash is for *processes* — build, test, git, scripts. Not for cat/grep/sed pipelines on source files.
- streams already merged; no `2>&1` or `2>/dev/null` needed
</rules>