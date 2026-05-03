Clojure code tool guidance:
- Clojure edit accepts both local target IDs (`src/app/core.clj::normalize-name`) and copied workspace/graph FQ vars (`src/app/core.clj::app.core/normalize-name`).
- Prefer graph context before cross-file rename or impact work; aliases and `:refer` affect resolution.
- Prefer semantic form navigation (`children`/`siblings`) over token-level node spelunking; let bindings, branch forms, map entries, and defn body forms are the useful units.
- For scoped literal string changes, use `findAndReplace` for normal text or `rawTextReplace` for exact byte replacement inside a form.
- Graph context keeps keyword refs but reports them separately as `Data keywords`; treat them as data coupling, not function calls.
- EDN is data, not Clojure code: use data paths like `file.edn::[:books 0 :title]`; do not assume namespaces, vars, runtime evaluation, or graph semantics for `.edn` files.