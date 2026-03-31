;;; org-fluid-plan.el --- MCP tool: org-fluid-plan -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tool that reads a PLAN's linked org items, builds a dependency graph,
;; detects connected components via union-find, computes wave layers per
;; component, and emits FluidPlan-compatible JSON.
;;
;; Input: { plan_id: string } — the PLAN's CUSTOM_ID
;; Output: { components: [...], warnings: [] }

;;; Code:

(require 'cl-lib)
(require 'mcp-server-tools)
(require 'org-mcp-common)

;; ---------------------------------------------------------------------------
;; Union-Find (disjoint-set) for connected component detection
;; ---------------------------------------------------------------------------

(defun org-fluid-plan--make-union-find (ids)
  "Create a union-find structure for IDS (list of strings).
Returns (parent-table . rank-table)."
  (let ((parent (make-hash-table :test 'equal))
        (rank (make-hash-table :test 'equal)))
    (dolist (id ids)
      (puthash id id parent)
      (puthash id 0 rank))
    (cons parent rank)))

(defun org-fluid-plan--find (uf id)
  "Find root of ID in union-find UF with path compression."
  (let ((parent (car uf)))
    (if (equal id (gethash id parent))
        id
      (let ((root (org-fluid-plan--find uf (gethash id parent))))
        (puthash id root parent)
        root))))

(defun org-fluid-plan--union (uf a b)
  "Union sets containing A and B in union-find UF."
  (let* ((parent (car uf))
         (rank (cdr uf))
         (ra (org-fluid-plan--find uf a))
         (rb (org-fluid-plan--find uf b)))
    (unless (equal ra rb)
      (let ((rank-a (gethash ra rank 0))
            (rank-b (gethash rb rank 0)))
        (cond
         ((< rank-a rank-b) (puthash ra rb parent))
         ((> rank-a rank-b) (puthash rb ra parent))
         (t (puthash rb ra parent)
            (puthash ra (1+ rank-a) rank)))))))

;; ---------------------------------------------------------------------------
;; PLAN item resolution — extract [[id:...]] links from PLAN body
;; ---------------------------------------------------------------------------

(defun org-fluid-plan--extract-plan-child-ids (plan-body)
  "Extract CUSTOM_IDs from [[id:...]] links in PLAN-BODY string."
  (let ((ids '())
        (start 0))
    (while (string-match "\\[\\[id:\\([^]]+\\)\\]" plan-body start)
      (push (match-string 1 plan-body) ids)
      (setq start (match-end 0)))
    (nreverse ids)))

(defun org-fluid-plan--find-plan-body (files plan-id)
  "Find the PLAN item with PLAN-ID across FILES and return its full text body.
Returns nil if not found."
  (catch 'found
    (dolist (file files)
      (with-temp-buffer
        (insert-file-contents file)
        (let ((buffer-file-name file))
          (org-mode)
          (org-tasks--setup-keywords)
          (let ((ast (org-element-parse-buffer)))
            (org-element-map ast 'headline
              (lambda (hl)
                (when (equal (org-tasks--extract-property hl "CUSTOM_ID") plan-id)
                  (throw 'found (org-tasks--extract-body hl)))))))))
    nil))

;; ---------------------------------------------------------------------------
;; Resolve linked items across all org files
;; ---------------------------------------------------------------------------

(defun org-fluid-plan--collect-items-by-ids (files target-ids)
  "Collect org items matching TARGET-IDS from FILES.
Returns alist of id -> item-alist. Items include:
custom_id, title, state, depends (list), effort, priority, layer, body."
  (let ((id-set (make-hash-table :test 'equal))
        (result (make-hash-table :test 'equal)))
    (dolist (id target-ids)
      (puthash id t id-set))
    (dolist (file files)
      (with-temp-buffer
        (insert-file-contents file)
        (let ((buffer-file-name file))
          (org-mode)
          (org-tasks--setup-keywords)
          (let ((ast (org-element-parse-buffer)))
            (org-element-map ast 'headline
              (lambda (hl)
                (let ((custom-id (org-tasks--extract-property hl "CUSTOM_ID")))
                  (when (and custom-id (gethash custom-id id-set))
                    (let* ((todo (or (org-element-property :todo-keyword hl) ""))
                           (title (org-element-property :raw-value hl))
                           (depends-str (or (org-tasks--extract-property hl "DEPENDS") ""))
                           (effort (or (org-tasks--extract-property hl "EFFORT") ""))
                           (priority-val (org-element-property :priority hl))
                           (priority (if priority-val (char-to-string priority-val) ""))
                           (layer (or (org-tasks--extract-property hl "LAYER") ""))
                           (body (org-tasks--extract-body hl))
                           (depends (when (not (string-empty-p (string-trim depends-str)))
                                      (split-string (string-trim depends-str) "[ \t]+" t))))
                      (puthash custom-id
                               `((custom_id . ,custom-id)
                                 (title . ,title)
                                 (state . ,todo)
                                 (depends . ,(or depends '()))
                                 (effort . ,effort)
                                 (priority . ,priority)
                                 (layer . ,layer)
                                 (body . ,body))
                               result))))))))))
    result))

;; ---------------------------------------------------------------------------
;; Cycle detection — three-color DFS
;; ---------------------------------------------------------------------------

(defun org-fluid-plan--detect-cycle (adj all-ids)
  "Detect cycles in directed graph ADJ over ALL-IDS.
ADJ is hash-table: id -> list of successor ids.
Returns nil if acyclic, or a list of ids forming the cycle."
  (let ((white (make-hash-table :test 'equal))
        (gray (make-hash-table :test 'equal)))
    (dolist (id all-ids)
      (puthash id t white))
    (catch 'cycle
      (dolist (id all-ids)
        (when (gethash id white)
          (org-fluid-plan--dfs-visit id adj white gray)))
      nil)))

(defun org-fluid-plan--dfs-visit (node adj white gray)
  "DFS visit NODE. WHITE=unvisited, GRAY=in-stack. Throws cycle if found."
  (remhash node white)
  (puthash node t gray)
  (dolist (succ (gethash node adj))
    (cond
     ((gethash succ gray)
      (throw 'cycle (list succ node)))
     ((gethash succ white)
      (org-fluid-plan--dfs-visit succ adj white gray))))
  (remhash node gray))

;; ---------------------------------------------------------------------------
;; Wave computation per component (Kahn's algorithm)
;; ---------------------------------------------------------------------------

(defun org-fluid-plan--compute-waves (component-ids adj-forward)
  "Compute wave layers for COMPONENT-IDS using Kahn's algorithm.
ADJ-FORWARD: hash of id -> list of ids that depend on it.
Returns list of ((number . N) (items . [id1 id2 ...]))."
  (let ((in-degree (make-hash-table :test 'equal)))
    ;; Initialize in-degree for component items only
    (dolist (id component-ids)
      (puthash id 0 in-degree))
    ;; Count in-degree from forward adjacency
    (dolist (id component-ids)
      (dolist (succ (gethash id adj-forward))
        (when (gethash succ in-degree)
          (puthash succ (1+ (gethash succ in-degree 0)) in-degree))))
    ;; Kahn's: process wave by wave
    (let ((queue '())
          (waves '())
          (wave-num 0))
      ;; Seed with in-degree 0 nodes
      (dolist (id component-ids)
        (when (= 0 (gethash id in-degree 0))
          (push id queue)))
      (setq queue (sort (nreverse queue) #'string<))
      (while queue
        (cl-incf wave-num)
        (let ((next-queue '()))
          (push `((number . ,wave-num)
                  (items . ,(vconcat queue)))
                waves)
          (dolist (id queue)
            (dolist (succ (gethash id adj-forward))
              (when (gethash succ in-degree)
                (let ((new-deg (1- (gethash succ in-degree 1))))
                  (puthash succ new-deg in-degree)
                  (when (= new-deg 0)
                    (push succ next-queue))))))
          (setq queue (sort (nreverse next-queue) #'string<))))
      (nreverse waves))))

;; ---------------------------------------------------------------------------
;; Main handler: build graph, split components, compute waves, emit JSON
;; ---------------------------------------------------------------------------

(defun org-fluid-plan--build-fluid-plan (files plan-id)
  "Build FluidPlan JSON for PLAN-ID by reading items from FILES."
  (let ((warnings '()))
    ;; 1. Find the PLAN item and extract child IDs
    (let ((plan-body (org-fluid-plan--find-plan-body files plan-id)))
      (unless plan-body
        (error "PLAN item not found: %s" plan-id))
      (let ((child-ids (org-fluid-plan--extract-plan-child-ids plan-body)))
        (when (null child-ids)
          (error "PLAN has no linked child items (no [[id:...]] links found)"))

        ;; 2. Resolve all linked items across files
        (let ((items-table (org-fluid-plan--collect-items-by-ids files child-ids)))

          ;; Check for missing items
          (dolist (id child-ids)
            (unless (gethash id items-table)
              (push (format "Linked item not found: %s (will be skipped)" id) warnings)))

          ;; Collect resolved IDs
          (let* ((resolved-ids '())
                 (_ (maphash (lambda (k _v) (push k resolved-ids)) items-table))
                 (resolved-ids (sort resolved-ids #'string<)))

            (when (null resolved-ids)
              (error "No linked items could be resolved"))

            ;; 3. Build adjacency (directed: dep -> dependent) and validate deps
            (let ((adj-forward (make-hash-table :test 'equal))
                  (adj-deps (make-hash-table :test 'equal))
                  (id-set (make-hash-table :test 'equal)))
              (dolist (id resolved-ids)
                (puthash id '() adj-forward)
                (puthash id '() adj-deps)
                (puthash id t id-set))
              (dolist (id resolved-ids)
                (let* ((item (gethash id items-table))
                       (deps (cdr (assoc 'depends item))))
                  (dolist (dep deps)
                    (if (gethash dep id-set)
                        (progn
                          (puthash dep (cons id (gethash dep adj-forward)) adj-forward)
                          (puthash id (cons dep (gethash id adj-deps)) adj-deps))
                      (push (format "Item %s depends on %s which is outside this plan (ignored)" id dep)
                            warnings)))))

              ;; 4. Cycle detection
              (let ((cycle (org-fluid-plan--detect-cycle adj-forward resolved-ids)))
                (when cycle
                  (error "Cycle detected in dependency graph: %s"
                         (string-join cycle " -> "))))

              ;; 5. Connected components via union-find
              (let ((uf (org-fluid-plan--make-union-find resolved-ids)))
                (dolist (id resolved-ids)
                  (dolist (dep (cdr (assoc 'depends (gethash id items-table))))
                    (when (gethash dep id-set)
                      (org-fluid-plan--union uf id dep))))

                ;; Group by component root
                (let ((comp-map (make-hash-table :test 'equal)))
                  (dolist (id resolved-ids)
                    (let ((root (org-fluid-plan--find uf id)))
                      (puthash root (cons id (gethash root comp-map)) comp-map)))

                  ;; 6. Build per-component FluidPlan
                  (let ((components '())
                        (comp-idx 0))
                    (maphash
                     (lambda (_root members)
                       (cl-incf comp-idx)
                       (let* ((member-ids (sort (copy-sequence members) #'string<))
                              (waves (org-fluid-plan--compute-waves member-ids adj-forward))
                              (agents (mapcar
                                       (lambda (id)
                                         (let* ((item (gethash id items-table))
                                                (deps (cdr (assoc 'depends item)))
                                                ;; Filter deps to only those within plan
                                                (valid-deps (seq-filter
                                                             (lambda (d) (gethash d id-set))
                                                             deps)))
                                           `((id . ,id)
                                             (task . ,(cdr (assoc 'title item)))
                                             (dependsOn . ,(vconcat valid-deps))
                                             (orgItemId . ,id)
                                             (effort . ,(cdr (assoc 'effort item)))
                                             (priority . ,(cdr (assoc 'priority item)))
                                             (state . ,(cdr (assoc 'state item)))
                                             (body . ,(cdr (assoc 'body item))))))
                                       member-ids)))
                         (push `((id . ,(format "component-%d" comp-idx))
                                 (agents . ,(vconcat agents))
                                 (waves . ,(vconcat waves)))
                               components)))
                     comp-map)

                    ;; Return final structure
                    `((components . ,(vconcat (nreverse components)))
                      (warnings . ,(vconcat (nreverse warnings))))))))))))))

(defun org-mcp-fluid-plan-handler (args)
  "Handle org-fluid-plan tool call with ARGS.
ARGS is an alist with key: plan_id."
  (condition-case err
      (let* ((plan-id (org-mcp--arg args 'plan_id))
             (files (org-tasks--all-org-files)))
        (unless plan-id
          (error "plan_id argument is required"))
        (json-encode (org-fluid-plan--build-fluid-plan files plan-id)))
    (error
     (json-encode
      `((error . t)
        (code . "FLUID_PLAN_ERROR")
        (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-fluid-plan"
  :title "Build Fluid Plan"
  :description "Build a FluidPlan from a PLAN item's linked org items. Reads org items, builds dependency graph, detects connected components via union-find, computes wave layers per component, and emits FluidPlan-compatible JSON with agents and dependency ordering."
  :input-schema '((type . "object")
                  (properties
                   . ((plan_id . ((type . "string")
                                  (description . "CUSTOM_ID of the PLAN item")))))
                  (required . ["plan_id"]))
  :function #'org-mcp-fluid-plan-handler))

(provide 'org-fluid-plan)

;;; org-fluid-plan.el ends here
