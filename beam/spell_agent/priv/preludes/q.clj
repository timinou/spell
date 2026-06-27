(ns q
  "q/* — the structural-transform algebra over form_tree (PLAN-020 W1).

  form_tree is the ONE walkable node shape that already unifies Lisp history
  (SpellAgent.Hist.Lens.form_tree/1), shell (sh/parse), and — under code/parse —
  source. A node is a string-keyed map:

      {\"node\" <kind>, \"name\"? <string>, \"value\"? <jsonable>, \"children\"? [<node>]}

  This namespace is the SHARED ENGINE two plans consume: the lispy code/edit
  refactoring surface (PLAN-020) and the history-reducer (PLAN-018). It is a pure
  library over form_tree with NO dependency on code/parse — it works at all three
  scopes the moment a tree is in hand.

  ── Pattern vocabulary (holes) ───────────────────────────────────────────────
  A PATTERN is a form_tree with hole sentinels:

    {\"node\" \"~\"  \"name\" n}   node-capture — binds the subtree to n
                                 (n = \"_\" ⇒ wildcard: matches, binds nothing)
    {\"node\" \"~@\" \"name\" n}   splice — binds 0+ remaining CHILDREN to n (a list)
    {\"$\" n}  in a name/value FIELD   field-capture — binds a SCALAR to n

  NB the field sigil: \"name\" and \"value\" are SCALAR FIELDS in form_tree, not
  children, so a child-position hole cannot reach them — capturing a node's name
  needs the {\"$\" n} field form. (PLAN-020 edge-case: field-vs-child.)

  Matching is NON-LINEAR: a capture name that repeats must bind structurally
  equal subtrees, else the match fails.

  ── The two laws this engine guarantees ──────────────────────────────────────
  LAW 1 (structural invariance): q/equal? is structural equality, NOT byte
    equality — the shared correctness currency with PLAN-018's fold proof and
    code/parse re-parse equality. LAW 2: q/equal? is PUBLIC and tested so the
    reducer can call it to prove a reduction sound."
  {:visibility :prompt})

;; ── sentinels ────────────────────────────────────────────────────────────────
;; A no-match is the plain keyword :no-match. It can never collide with a
;; legitimate q/* value: a bindings env is a string-keyed MAP, a captured value
;; is a subtree (map) / list / JSON-able scalar — none is the atom :no-match. So
;; `(= x no-match)` discriminates failure from every success cleanly.
;;
;; NB: deliberately NOT a namespaced keyword (`:q/no-match`). The PTC reader
;; mis-tokenizes a namespaced keyword — `keyword_char?` stops at `/`, so
;; `:q/no-match` silently splits into `[:q]` + symbol `/no-match` and detonates
;; downstream as a cryptic "malformed def". Tracked as BUG-017.
(def no-match :no-match)

(defn no-match?
  "True if x is the no-match sentinel."
  [x]
  (= x no-match))

;; ── hole predicates ──────────────────────────────────────────────────────────
(defn hole?
  "True if pattern node p is a node-hole (~) or splice-hole (~@)."
  [p]
  (and (map? p)
       (let [k (get p "node")]
         (or (= k "~") (= k "~@")))))

(defn splice?
  "True if pattern node p is a splice-hole (~@)."
  [p]
  (and (map? p) (= (get p "node") "~@")))

(defn field-capture?
  "True if a name/value field value v is a field-capture form {\"$\" n}."
  [v]
  (and (map? v) (contains? v "$")))

;; ── binding accumulation (non-linear) ────────────────────────────────────────
(defn bind
  "Add binding nm => val to env, enforcing non-linearity: a repeated name must
  bind an equal value or the whole match collapses to no-match. nm = \"_\" is the
  wildcard — it binds nothing. A no-match env stays no-match (monadic short-circuit)."
  [env nm val]
  (cond
    (no-match? env) no-match
    (= nm "_") env
    (contains? env nm) (if (= (get env nm) val) env no-match)
    :else (assoc env nm val)))

;; ── field matching ───────────────────────────────────────────────────────────
(defn match-field
  "Match a single scalar field k (\"name\"|\"value\") of pattern p against subject
  s, threading env. A field-capture {\"$\" n} binds the subject's scalar; a plain
  field must equal; an absent pattern field is a no-op (don't constrain it)."
  [p s e k]
  (if (contains? p k)
    (let [pv (get p k)
          sv (get s k)]
      (cond
        (field-capture? pv) (bind e (get pv "$") sv)
        (= pv sv) e
        :else no-match))
    e))

;; ── the matcher ──────────────────────────────────────────────────────────────
;; ONE self-recursive function. Child-list matching folds in via an inner
;; loop/recur (the uniform-matcher case needs no mutual recursion). Splice is
;; greedy-from-right: a ~@ binds the prefix that leaves exactly enough children
;; for the remaining fixed pattern to consume the suffix. Two adjacent splices
;; resolve to ONE deterministic partition (the first ~@ takes the maximal prefix
;; the trailing pattern allows) — documented ambiguity, but deterministic, which
;; the reducer's memo-key soundness relies on.
(defn match
  "Match pattern p against subject node s. Returns a bindings map (string =>
  subtree|list|scalar) on success, or the no-match sentinel. Use q/matched? to
  test the result."
  [p s]
  (match-node p s {}))

(defn match-node
  "Core matcher: pattern p vs subject s, threading bindings env."
  [p s env]
  (cond
    (no-match? env) no-match
    ;; a hole matches anything and binds it (splice is only meaningful in a child
    ;; list, handled in match-children; a bare ~@ in node position binds the node)
    (hole? p) (bind env (get p "name") s)
    ;; a non-map pattern is a raw scalar leaf — must be equal
    (not (map? p)) (if (= p s) env no-match)
    ;; pattern is a map but subject is not — cannot match
    (not (map? s)) no-match
    ;; node kind must match
    (not (= (get p "node") (get s "node"))) no-match
    :else
    (let [e1 (match-field p s env "name")
          e2 (match-field p s e1 "value")]
      (if (no-match? e2)
        no-match
        ;; only constrain children when the pattern SPECIFIES them; a pattern
        ;; with no "children" key matches regardless of the subject's children
        ;; (lets you match on kind/name/value alone).
        (if (contains? p "children")
          (match-children (get p "children") (or (get s "children") []) e2)
          e2)))))

(defn match-children
  "Match a pattern child-list ps against a subject child-list ss, threading env,
  honoring splice (~@) holes greedily-from-right."
  [ps ss env]
  (loop [ps ps ss ss e env]
    (cond
      (no-match? e) no-match
      (empty? ps) (if (empty? ss) e no-match)
      (splice? (first ps))
      ;; remaining fixed pattern after this splice consumes the suffix; the
      ;; splice binds the prefix of length k = |ss| - |rest-pat|.
      (let [rest-pat (rest ps)
            n (count rest-pat)
            k (- (count ss) n)]
        (if (< k 0)
          no-match
          (recur rest-pat
                 (drop k ss)
                 (bind e (get (first ps) "name") (take k ss)))))
      (empty? ss) no-match
      :else (recur (rest ps) (rest ss) (match-node (first ps) (first ss) e)))))

;; ── public match result helpers ──────────────────────────────────────────────
(defn matched?
  "True if a q/match result is a successful bindings map (not no-match)."
  [result]
  (not (no-match? result)))

;; ── structural equality (LAW 1 / LAW 2) ──────────────────────────────────────
(defn equal?
  "Structural equality over form_tree: true iff a and b are the same tree.
  Implemented as a hole-free match, so it shares the matcher's drift-resilience
  and is the PUBLIC, tested predicate PLAN-018's reducer calls to prove a
  reduction sound. This is STRUCTURAL invariance, not byte invariance (LAW 1)."
  [a b]
  (matched? (match-node a b {})))

;; ── recursive search ──────────────────────────────────────────────────────────
(defn descend-acc
  "Helper: accumulate bindings-maps for every subtree of s matching p, pre-order."
  [p s acc]
  (let [hit (match p s)
        acc2 (if (matched? hit) (conj acc hit) acc)]
    (if (map? s)
      (reduce (fn [a c] (descend-acc p c a)) acc2 (or (get s "children") []))
      acc2)))

(defn descendant
  "Every subtree of s matching pattern p (pre-order), as a list of bindings-maps.
  ≡ a CodePath descendant query (foo.ex::§call[...])."
  [p s]
  (descend-acc p s []))

(defn child
  "Direct children of s matching pattern p, as a list of bindings-maps.
  ≡ a CodePath direct-child query."
  [p s]
  (if (map? s)
    (->> (or (get s "children") [])
         (map (fn [c] (match p c)))
         (filter matched?))
    []))

(defn select
  "The matched SUBTREES themselves (not bindings), every subtree of s matching p,
  pre-order. Use when you want the nodes, not their captures."
  [p s]
  (let [collect (fn collect [node acc]
                  (let [acc2 (if (matched? (match p node)) (conj acc node) acc)]
                    (if (map? node)
                      (reduce (fn [a c] (collect c a)) acc2 (or (get node "children") []))
                      acc2)))]
    (collect s [])))

;; ── construction / emit (inverse of match) ───────────────────────────────────
(defn subst-field
  "Resolve a template field value against env: a field-capture {\"$\" n} becomes
  env[n]; a plain scalar passes through."
  [tpl env k]
  (let [v (get tpl k)]
    (if (field-capture? v) (get env (get v "$")) v)))

(defn emit
  "Instantiate a template against a bindings map (the inverse of match). A
  node-hole {\"~\" n} becomes env[n]; a splice {\"~@\" n} in a child list splices
  env[n] (a list) into place; a field-capture {\"$\" n} fills env[n]. A literal
  template node is rebuilt with its fields substituted and children emitted."
  [tpl env]
  (cond
    (hole? tpl) (get env (get tpl "name"))
    (not (map? tpl)) tpl
    :else
    (let [base (cond-> {"node" (get tpl "node")}
                 (contains? tpl "name") (assoc "name" (subst-field tpl env "name"))
                 (contains? tpl "value") (assoc "value" (subst-field tpl env "value")))
          kids (get tpl "children")]
      (if (nil? kids)
        base
        (assoc base "children"
               (reduce (fn [acc c]
                         (if (splice? c)
                           (into acc (or (get env (get c "name")) []))
                           (conj acc (emit c env))))
                       []
                       kids))))))

;; ── rewrite / update / wrap ───────────────────────────────────────────────────
(defn rewrite
  "If subject s matches pattern p, return template t emitted with the bindings;
  otherwise return s unchanged. Top-node only (use q/update to rewrite throughout)."
  [p t s]
  (let [e (match p s)]
    (if (matched? e) (emit t e) s)))

(defn update
  "Replace EVERY subtree of s matching pattern p with (f bindings), bottom-up so
  a transform sees already-transformed children. f receives the bindings map and
  returns the replacement node. This is the workhorse rewrite."
  [s p f]
  (let [walk (fn walk [node]
               ;; rebuild children first (bottom-up)
               (let [node2 (if (and (map? node) (contains? node "children"))
                             (assoc node "children" (map walk (get node "children")))
                             node)
                     hit (match p node2)]
                 (if (matched? hit) (f hit) node2)))]
    (walk s)))

(defn wrap
  "Wrap every match of p in s with template tmpl, where the hole {\"~\" \"_\"} in
  tmpl stands for the original matched node. E.g. wrap a risky call in try/catch."
  [s p tmpl]
  (update s p (fn [binds] (emit tmpl (assoc binds "_" (get binds "_"))))))

;; ── projections (replace the #qualifiers) ────────────────────────────────────
(defn body
  "The body span of a def/fn/clause node: its last child (the value/body).
  ≡ the #body qualifier (foo.ex::f#body)."
  [tree]
  (let [kids (and (map? tree) (get tree "children"))]
    (if (and kids (not (empty? kids))) (last kids) nil)))

(defn sig
  "The signature span of a def/fn node: everything but the last child.
  ≡ the #sig qualifier (foo.ex::f#sig)."
  [tree]
  (let [kids (and (map? tree) (get tree "children"))]
    (if (and kids (not (empty? kids))) (drop-last kids) [])))

(defn node-name
  "The name field of a node (the #name projection)."
  [tree]
  (and (map? tree) (get tree "name")))
