Legacy alias of `find` — same CodePath `target` grammar, same output. Prefer `find`.

Kept one release for compatibility (REMOVE_AT_WAVE_11). Extra params (`recursive`, `depth`, `format`, …) map onto `find` qualifiers: directory tree → `dir/#tree [depth=N]`, listing → `dir/`, metadata → `path#stat`.
