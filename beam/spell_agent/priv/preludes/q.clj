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

(defn- no-match?
  "True if x is the no-match sentinel."
  [x]
  (= x no-match))

;; ── hole predicates ──────────────────────────────────────────────────────────
(defn- hole?
  "True if pattern node p is a node-hole (~) or splice-hole (~@)."
  [p]
  (and (map? p)
       (let [k (get p "node")]
         (or (= k "~") (= k "~@")))))

(defn- splice?
  "True if pattern node p is a splice-hole (~@)."
  [p]
  (and (map? p) (= (get p "node") "~@")))

(defn- field-capture?
  "True if a name/value field value v is a field-capture form {\"$\" n}."
  [v]
  (and (map? v) (contains? v "$")))

;; ── structural equality (the ONE notion of "equal", used everywhere) ──────────
;; tree-equal? is a SENTINEL-BLIND structural comparator: it compares two
;; form_tree values as DATA, never interpreting `~` / `~@` / {"$" n} as pattern
;; syntax (that is q/match's job, not equality's). It is the public q/equal?
;; below AND the equality `bind` uses for non-linear repeated captures, so the
;; algebra has exactly ONE notion of "the same tree" (PLAN-018 proof currency).
;;
;; Defined before `bind` because `bind` calls it. Self-recursive over children;
;; maps compare by FULL key set (so {node command name rg} and
;; {node command name rg children [...]} are NOT equal — the missing-children
;; laxness of q/match must never leak into equality).
(defn- tree-equal? [a b]
  (cond
    (and (map? a) (map? b))
    (let [ka (keys a) kb (keys b)]
      (and (= (count ka) (count kb))
           ;; every key present in both with structurally-equal values
           (every? (fn [k] (and (contains? b k) (tree-equal? (get a k) (get b k)))) ka)))
    (and (sequential? a) (sequential? b))
    (and (= (count a) (count b))
         (every? (fn [pair] (tree-equal? (first pair) (second pair)))
                 (map (fn [x y] [x y]) a b)))
    :else (= a b)))

;; ── binding accumulation (non-linear) ────────────────────────────────────────
(defn- bind
  "Add binding nm => val to env, enforcing non-linearity: a repeated name must
  bind a STRUCTURALLY-equal value (tree-equal?, the same notion q/equal? uses) or
  the whole match collapses to no-match. nm = \"_\" is the wildcard — it binds
  nothing. A no-match env stays no-match (monadic short-circuit)."
  [env nm val]
  (cond
    (no-match? env) no-match
    (= nm "_") env
    (contains? env nm) (if (tree-equal? (get env nm) val) env no-match)
    :else (assoc env nm val)))

;; ── field matching ───────────────────────────────────────────────────────────
(defn- match-field
  "Match a single scalar field k (\"name\"|\"value\") of pattern p against subject
  s, threading env. A field-capture {\"$\" n} binds the subject's scalar; a plain
  field must equal; an absent pattern field is a no-op (don't constrain it).

  If the PATTERN specifies field k but the SUBJECT lacks it, that is a no-match,
  not a nil-bind — a pattern asking for `name` must not silently match a Lens
  `literal` leaf (no name) or an sh `raw`/`word` leaf by binding nil. A subject
  field present with an explicit nil value still matches (absence != nil)."
  [p s e k]
  (if (contains? p k)
    (if (not (contains? s k))
      no-match
      (let [pv (get p k)
            sv (get s k)]
        (cond
          (field-capture? pv) (bind e (get pv "$") sv)
          (= pv sv) e
          :else no-match)))
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

(defn- match-node
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
    ;; constrain each SCALAR field the pattern specifies: `name` (semantic name),
    ;; `value` (leaf text), and `field` (the tree-sitter role from code/parse, so
    ;; a codemod can select a child BY ROLE — e.g. {"node" "identifier" "field"
    ;; "left"} matches only the left operand). Each supports a {"$" n} capture.
    (let [e1 (match-field p s env "name")
          e2 (match-field p s e1 "value")
          e3 (match-field p s e2 "field")]
      (if (no-match? e3)
        no-match
        ;; only constrain children when the pattern SPECIFIES them; a pattern
        ;; with no "children" key matches regardless of the subject's children
        ;; (lets you match on kind/name/value/field alone).
        (if (contains? p "children")
          (match-children (get p "children") (or (get s "children") []) e3)
          e3)))))

(defn- match-children
  "Match a pattern child-list ps against a subject child-list ss, threading env,
  honoring splice (~@) holes greedily-from-right."
  [ps ss env]
  (loop [ps ps ss ss e env]
    (cond
      (no-match? e) no-match
      (empty? ps) (if (empty? ss) e no-match)
      (splice? (first ps))
      ;; A splice binds a prefix; the trailing fixed pattern consumes the suffix.
      ;; The suffix length is the count of NON-splice children remaining (a
      ;; trailing `~@` requires 0 subject children, not 1 — the earlier bug used
      ;; `count rest-pat`, treating each later splice as needing one child). So
      ;; the first splice takes the MAXIMAL prefix the trailing fixed nodes
      ;; allow; any further splices then bind `[]` greedily-from-left. This is
      ;; the documented deterministic partition for adjacent splices.
      (let [rest-pat (rest ps)
            n (count (filter (fn [c] (not (splice? c))) rest-pat))
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
  "Structural equality over form_tree: true iff a and b are the same tree, as
  DATA. SENTINEL-BLIND — it never interprets `~` / `~@` / {\"$\" n} as pattern
  syntax (that is q/match's role), and it requires the FULL key set to agree
  (the missing-children laxness of q/match must never leak into equality). This
  is the PUBLIC, tested predicate PLAN-018's reducer calls to prove a reduction
  sound: STRUCTURAL invariance, not byte invariance (LAW 1). Delegates to the
  one true comparator `tree-equal?` (also used by `bind` for non-linear
  captures, so the algebra has a single notion of equal)."
  [a b]
  (tree-equal? a b))

;; ── recursive search ──────────────────────────────────────────────────────────
(defn- descend-acc
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
(defn- subst-field
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
                 (contains? tpl "value") (assoc "value" (subst-field tpl env "value"))
                 (contains? tpl "field") (assoc "field" (subst-field tpl env "field")))
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
  "Replace EVERY subtree of s matching pattern p with (f bindings node), bottom-up
  so a transform sees already-transformed children. f receives the bindings map
  AND the matched node itself (so a wrapper can re-embed the original). This is
  the workhorse rewrite. NB: closure-based — NOT reifiable; for a recorded,
  composable edit (PLAN-018) use q/apply-ops with data {op pattern template}."
  [s p f]
  ;; Apply f, then INVALIDATE the stale verbatim `text` cache on the result if
  ;; it changed: a replacement that differs from the original node (in any field,
  ;; including a leaf whose `value` changed) must NOT keep the old node's `text`,
  ;; or code/unparse's text-fast-path would emit the OLD source and silently drop
  ;; the edit. f may set a fresh `text` deliberately (e.g. a leaf rename that
  ;; updates both value and text); only an UNCHANGED result keeps its text.
  (let [apply-f (fn [hit node]
                  (let [out (f hit node)]
                    (if (tree-equal? out node)
                      out
                      ;; changed: drop stale text UNLESS f rewrote text itself to
                      ;; something other than the original's.
                      (if (and (map? out)
                               (contains? out "text")
                               (= (get out "text") (get node "text")))
                        (dissoc out "text")
                        out))))
        walk (fn walk [node]
               (if (and (map? node) (contains? node "children"))
                 ;; rebuild children first (bottom-up)
                 (let [kids (get node "children")
                       kids2 (map walk kids)
                       ;; If any child changed, this node's verbatim `text` cache
                       ;; (from code/parse) is STALE — drop it so code/unparse
                       ;; rejoins from children instead of emitting old source.
                       ;; The whole ancestor chain of an edit thus loses `text`,
                       ;; while untouched siblings keep theirs (byte-exact).
                       changed (not (tree-equal? kids2 kids))
                       node2 (cond-> (assoc node "children" kids2)
                               changed (dissoc "text"))
                       hit (match p node2)]
                   (if (matched? hit) (apply-f hit node2) node2))
                 ;; a leaf: just test/replace it
                 (let [hit (match p node)]
                   (if (matched? hit) (apply-f hit node) node))))]
    (walk s)))

(defn wrap
  "Wrap every match of p in s with template tmpl, where the node-hole
  {\"node\" \"~\" \"name\" \"_\"} in tmpl stands for the ORIGINAL matched node.
  E.g. wrap a risky call in try/catch. The `_` hole resolves to the matched
  subtree (it is bound explicitly here — `bind` skips `_` during matching, so we
  inject it into the emit env from the node update hands us)."
  [s p tmpl]
  (update s p (fn [binds node] (emit tmpl (assoc binds "_" node)))))

;; reifiable transforms (the DATA edit surface PLAN-018 composes).
;; An OP is a plain-data form_tree edit, NOT a closure, so a recorded edit is a
;; VALUE the reducer can compare (q/equal? on the ops), compose, and cancel
;; algebraically (PLAN-018: reduced == comp(e2,e1); edit then inverse == id).
;;
;;   {"op" "update"  "pattern" <tpl> "template" <tpl>}  ; tree-wide find+replace
;;   {"op" "rewrite" "pattern" <tpl> "template" <tpl>}  ; top-node only
;;   {"op" "wrap"    "pattern" <tpl> "template" <tpl>}  ; wrap matches ({~ _}=orig)
;;
;; Both pattern and template are ordinary form_tree maps (holes allowed), so an
;; op round-trips through JSON and through q/equal?. q/update's closure form
;; stays as sugar for one-off interactive edits.
(defn apply-op
  "Apply ONE data-op to subject s, returning the rewritten tree. An UNKNOWN op
  kind FAILS LOUD (not a silent no-op) — a typo'd `:op` would otherwise pass the
  code/edit parse-gate and write an unchanged file, masking a broken edit."
  [s op]
  (let [kind (get op "op")
        p (get op "pattern")
        t (get op "template")]
    (cond
      (= kind "update") (update s p (fn [binds _node] (emit t binds)))
      (= kind "rewrite") (rewrite p t s)
      (= kind "wrap") (wrap s p t)
      :else (fail (str "q/apply-op: unknown op kind " (pr-str kind)
                       " (expected \"update\" | \"rewrite\" | \"wrap\")")))))

(defn apply-ops
  "Apply a SEQUENCE of data-ops to subject s, left-to-right (op2 sees op1's
  output). The composition of the list IS the composed edit; PLAN-018 records a
  tape edit as this ops list and reasons about it as data.

  COMPOSITION SEMANTICS (PLAN-018 must heed): each op rewrites EVERY current
  match, so ops are only cleanly composable/cancellable when DISJOINT. Dependent
  ops do NOT cancel — e.g. [a->b, b->a] on `a + b` yields `a + a` (the second op
  catches both the original b AND the a-that-became-b), and [a->b, b->c] yields
  `c + c`. The reducer must therefore only algebraically cancel/compose ops whose
  match-sets are disjoint (the freshness precondition), or carry before-images."
  [s ops]
  (reduce apply-op s ops))

;; ── projections (replace the #qualifiers) ────────────────────────────────────
(defn token?
  "True if node is an anonymous-token leaf (punctuation/operator/keyword the
  code/parse projector keeps for lossless unparse). Structural projections skip
  these; they are presentation, not semantic children. Lisp-history and shell
  form_trees never contain `token` nodes, so this is a no-op there."
  [node]
  (and (map? node) (= (get node "node") "token")))

(defn structural-children
  "A node's SEMANTIC children: its `children` with anonymous `token` leaves
  removed. The basis of `body`/`sig` so a construct ending in `)`/`]`/`end`
  doesn't report that delimiter as its body."
  [tree]
  (->> (and (map? tree) (get tree "children"))
       (remove token?)))

(defn body
  "The body span of a def/fn/clause node: its last SEMANTIC child (the
  value/body), skipping anonymous tokens. ≡ the #body qualifier (foo.ex::f#body)."
  [tree]
  (let [kids (structural-children tree)]
    (if (empty? kids) nil (last kids))))

(defn sig
  "The signature span of a def/fn node: every SEMANTIC child but the last,
  skipping anonymous tokens. ≡ the #sig qualifier (foo.ex::f#sig)."
  [tree]
  (let [kids (structural-children tree)]
    (if (empty? kids) [] (drop-last kids))))

(defn node-name
  "The name field of a node (the #name projection)."
  [tree]
  (and (map? tree) (get tree "name")))
