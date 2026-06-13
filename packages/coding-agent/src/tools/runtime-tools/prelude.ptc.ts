/**
 * PTC-Lisp prelude for `deftool` runtime tools (PLAN-337).
 *
 * A runtime-tool `.ptc` file declares a tool's INTERFACE: its verbs, each with
 * an arg schema, an argv builder (`:exec`), an output parser (`:parse`), and a
 * `:class` (read | write | destructive). The file binds `(def tool (deftool ...))`.
 *
 * The functions in a verb (`:exec`/`:parse`) are PTC closures — they CANNOT
 * cross the BEAM↔Node wire (closures are unencodable). So the tool never leaves
 * the sandbox: Node prepends this prelude + the tool file to a tiny dispatch
 * call and runs it through the ordinary `execute` path. Only DATA crosses —
 * the built argv (beat 1) and the parsed value (beat 3), both encodable.
 *
 * Dispatch entrypoints the bridge appends after the tool file:
 *   (rt-describe)          → { name, doc, verbs:{ verb:{class,args} } }   (load)
 *   (rt-argv  verb args)   → ["bin" "sub" ...]                            (beat 1)
 *   (rt-parse verb stdout) → structured value                            (beat 3)
 *
 * Args + stdout reach the program via the safe `context` channel (`data/*`),
 * never string-interpolated into source.
 */
// PTC has no forward references: a `defn` captures the vars it names at
// DEFINITION time. So the dispatch helpers (which reference `tool`) must be
// defined AFTER the tool file binds `(def tool ...)`. The prelude is therefore
// split: `deftool` is available BEFORE the file; the rt-* helpers come AFTER.

/** Helpers available to a tool file (prepended before it). */
export const RUNTIME_TOOL_PRELUDE = `
;; deftool: tag a tool spec with its name. The spec is a plain map:
;;   {:doc "..." :verbs { "verb" {:class "read"|"write"|"destructive"
;;                                :args  {:k {:type "int"|"str"|"list" ...}}
;;                                :exec  (fn [args] ["bin" "sub" ...])
;;                                :parse (fn [stdout] <structured>)} }}
(defn deftool [nm spec] (assoc spec "__name" nm))
`;

/** Dispatch helpers (appended AFTER the tool file, so `tool` is in scope). */
export const RUNTIME_TOOL_POSTLUDE = `
;; rt-describe: the load-time descriptor — name, doc, and per-verb {class,args}.
;; Strips the unencodable :exec/:parse closures; only metadata crosses the wire.
(defn rt-describe []
  {"name"  (get tool "__name")
   "doc"   (get tool :doc)
   "verbs" (->> (get tool :verbs)
                (map (fn [pair]
                       [(first pair)
                        {"class" (get (second pair) :class)
                         "args"  (get (second pair) :args)}]))
                (into {}))})

;; rt-argv: beat 1 — build the process argv for a verb from its args map.
(defn rt-argv [verb args]
  (let [v (get-in tool [:verbs verb])]
    (if (nil? v)
      {"err" (str "unknown verb: " verb)}
      ((get v :exec) args))))

;; rt-parse: beat 3 — shape raw stdout into a structured value for the verb.
;; A verb without a :parse returns the raw text unchanged.
(defn rt-parse [verb stdout]
  (let [v (get-in tool [:verbs verb])]
    (if (nil? v)
      {"err" (str "unknown verb: " verb)}
      (let [p (get v :parse)]
        (if (nil? p) stdout (p stdout))))))
`;
