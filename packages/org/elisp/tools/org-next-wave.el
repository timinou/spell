;;; org-next-wave.el --- MCP tool: org-next-wave -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tool that computes the next execution wave from dependency graph + current states.
;; Uses topological ordering: returns items whose all dependencies are DONE,
;; excluding DONE/BLOCKED items, respecting priority, capped at 8 items.

;;; Code:

(require 'mcp-server-tools)
(require 'org-mcp-common)
(require 'org-dependency-graph)

(defun org-mcp--build-dependency-map (edges)
  "Build a hash from target-id -> list of dependency source-ids from EDGES.
Each edge represents: to depends on from."
  (let ((dep-map (make-hash-table :test 'equal)))
    (dolist (edge edges)
      (let ((from (cdr (assoc 'from edge)))
            (to (cdr (assoc 'to edge))))
        (puthash to (cons from (gethash to dep-map)) dep-map)))
    dep-map))

(defun org-mcp--all-deps-done-p (custom-id dep-map state-map)
  "Return non-nil if all dependencies of CUSTOM-ID are in DONE state.
DEP-MAP maps id -> list of dependency ids.
STATE-MAP maps id -> state string."
  (let ((deps (gethash custom-id dep-map)))
    (or (null deps)
        (cl-every (lambda (dep-id)
                    (equal (gethash dep-id state-map) "DONE"))
                  deps))))

(defun org-mcp--priority-sort-value (priority-str)
  "Return numeric sort value for PRIORITY-STR (A=0, B=1, C=2, empty=3)."
  (cond
   ((equal priority-str "A") 0)
   ((equal priority-str "B") 1)
   ((equal priority-str "C") 2)
   (t 3)))

(defun org-mcp-next-wave-handler (args)
  "Handle org-next-wave tool call with ARGS.
ARGS is an alist with optional key: file."
  (condition-case err
      (let* ((file (alist-get 'file args))
             (resolved-file (org-mcp--resolve-file file)))
        (unless (file-exists-p resolved-file)
          (error "File not found: %s" resolved-file))
        ;; Collect full item data including priority/effort/agent/layer
        (let* ((all-items (org-mcp--collect-full-items resolved-file))
               (graph-nodes (org-mcp--collect-graph-nodes resolved-file))
               (edges (org-mcp--build-edges graph-nodes))
               (dep-map (org-mcp--build-dependency-map edges))
               (state-map (make-hash-table :test 'equal))
               (wave-items '())
               (blocked-items '())
               (completed-count 0)
               (total-count (length all-items)))
          ;; Build state map
          (dolist (item all-items)
            (let ((id (cdr (assoc 'custom_id item)))
                  (state (cdr (assoc 'state item))))
              (puthash id state state-map)
              (when (equal state "DONE")
                (cl-incf completed-count))))
          ;; Find wave candidates: not DONE/BLOCKED, all deps DONE
          (dolist (item all-items)
            (let ((id (cdr (assoc 'custom_id item)))
                  (state (cdr (assoc 'state item))))
              (cond
               ((member state '("DONE" "BLOCKED"))
                nil)
               ((org-mcp--all-deps-done-p id dep-map state-map)
                (push item wave-items))
               (t
                (unless (equal state "DONE")
                  (push item blocked-items))))))
          ;; Sort by priority (A first), then by custom_id for stability
          (setq wave-items
                (sort wave-items
                      (lambda (a b)
                        (let ((pa (org-mcp--priority-sort-value (cdr (assoc 'priority a))))
                              (pb (org-mcp--priority-sort-value (cdr (assoc 'priority b)))))
                          (or (< pa pb)
                              (and (= pa pb)
                                   (string< (cdr (assoc 'custom_id a))
                                            (cdr (assoc 'custom_id b)))))))))
          ;; Cap at 8
          (when (> (length wave-items) 8)
            (setq wave-items (cl-subseq wave-items 0 8)))
          ;; Compute wave number (how many complete waves have passed)
          (let ((wave-number (org-mcp--compute-wave-number
                              all-items dep-map state-map)))
            (json-encode
             `((wave_number . ,wave-number)
               (items . ,(vconcat wave-items))
               (blocked_items . ,(vconcat blocked-items))
               (completed_count . ,completed-count)
               (total_count . ,total-count))))))
    (error
     (json-encode
      `((error . t)
        (code . "NEXT_WAVE_ERROR")
        (message . ,(error-message-string err)))))))

(defun org-mcp--collect-full-items (file)
  "Collect items from FILE with priority, effort, agent, layer for wave output."
  (with-temp-buffer
    (insert-file-contents file)
    (let ((buffer-file-name file))
      (org-mode)
      (org-tasks--setup-keywords)
      (let ((ast (org-element-parse-buffer))
            (items '()))
        (org-element-map ast 'headline
          (lambda (hl)
            (when-let ((todo (org-element-property :todo-keyword hl)))
              (when (member todo org-tasks-todo-keywords)
                (let ((custom-id (org-tasks--extract-property hl "CUSTOM_ID"))
                      (title (org-element-property :raw-value hl))
                      (priority-val (org-element-property :priority hl))
                      (effort (org-tasks--extract-property hl "EFFORT"))
                      (agent (org-tasks--extract-property hl "AGENT"))
                      (layer (org-tasks--extract-property hl "LAYER")))
                  (when custom-id
                    (push `((custom_id . ,custom-id)
                            (title . ,title)
                            (state . ,todo)
                            (priority . ,(if priority-val
                                            (char-to-string priority-val)
                                          ""))
                            (effort . ,(or effort ""))
                            (agent . ,(or agent ""))
                            (layer . ,(or layer "")))
                          items)))))))
        (nreverse items)))))

(defun org-mcp--compute-wave-number (all-items dep-map state-map)
  "Compute current wave number based on dependency layers.
Wave 1 = items with no deps. Wave N = items whose deps are all in waves < N.
Returns the wave number of the current execution front."
  (let ((item-wave (make-hash-table :test 'equal))
        (max-done-wave 0))
    ;; Assign wave numbers via BFS
    (dolist (item all-items)
      (let ((id (cdr (assoc 'custom_id item))))
        (puthash id 1 item-wave)))
    ;; Iteratively compute wave for each item
    (let ((changed t))
      (while changed
        (setq changed nil)
        (dolist (item all-items)
          (let* ((id (cdr (assoc 'custom_id item)))
                 (deps (gethash id dep-map))
                 (max-dep-wave 0))
            (dolist (dep deps)
              (let ((dw (gethash dep item-wave 1)))
                (when (> dw max-dep-wave)
                  (setq max-dep-wave dw))))
            (let ((new-wave (if deps (1+ max-dep-wave) 1)))
              (unless (= new-wave (gethash id item-wave 1))
                (puthash id new-wave item-wave)
                (setq changed t)))))))
    ;; Find highest wave where all items are DONE
    (let ((waves-complete (make-hash-table :test 'equal)))
      (dolist (item all-items)
        (let* ((id (cdr (assoc 'custom_id item)))
               (wave (gethash id item-wave 1))
               (state (gethash id state-map)))
          (unless (gethash wave waves-complete)
            (puthash wave t waves-complete))
          (unless (equal state "DONE")
            (puthash wave nil waves-complete))))
      (maphash (lambda (wave complete)
                 (when (and complete (> wave max-done-wave))
                   (setq max-done-wave wave)))
               waves-complete))
    (1+ max-done-wave)))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-next-wave"
  :title "Next Execution Wave"
  :description "Compute the next execution wave from dependency graph and current states. Returns items whose all dependencies are DONE, sorted by priority, capped at 8. Used by Atlas to determine what to execute next."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string")
                               (description . "Path to org file (absolute or relative to @tasks/)")))))
                  (required . ["file"]))
  :function #'org-mcp-next-wave-handler))

(provide 'org-next-wave)

;;; org-next-wave.el ends here
