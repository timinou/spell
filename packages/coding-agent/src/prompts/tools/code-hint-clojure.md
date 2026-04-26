Clojure code tool guidance:
- Treat Clojure target IDs as fully-qualified vars: `src/app/core.clj::app.core/normalize-name`.
- Prefer graph context before cross-file rename or impact work; aliases and `:refer` affect resolution.
- Prefer form-level `code edit` operations and Clojure procedures for balanced forms; avoid text edits for paren-sensitive mutations unless native code edit cannot support the file.
- Macro-generated code is statically incomplete. Report uncertainty instead of inventing generated vars or call edges.
- EDN is data, not Clojure code: do not assume namespaces, vars, runtime evaluation, or graph semantics for `.edn` files.
