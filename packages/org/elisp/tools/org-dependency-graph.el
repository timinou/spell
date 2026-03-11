;;; org-dependency-graph.el --- MCP tool: org-dependency-graph -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tool that builds a dependency DAG from DEPENDS/BLOCKS properties.
;; Detects cycles and returns nodes + edges as structured JSON.

;;; Code:

(require 'mcp-server-tools)
(require 'org-mcp-common)

(defun org-mcp--collect-graph-nodes (file)
  "Collect all task items from FILE as graph node alists.
Returns list of ((custom_id . ID) (title . TITLE) (state . STATE)
 (depends . \"A B\") (blocks . \"C D\"))."
  (with-temp-buffer
    (insert-file-contents file)
    (let ((buffer-file-name file))
      (org-mode)
      (org-tasks--setup-keywords)
      (let ((ast (org-element-parse-buffer))
            (nodes '()))
        (org-element-map ast 'headline
          (lambda (hl)
            (when-let ((todo (org-element-property :todo-keyword hl)))
              (when (member todo org-tasks-todo-keywords)
                (let ((custom-id (org-tasks--extract-property hl "CUSTOM_ID"))
                      (title (org-element-property :raw-value hl))
                      (depends (org-tasks--extract-property hl "DEPENDS"))
                      (blocks (org-tasks--extract-property hl "BLOCKS")))
                  (when custom-id
                    (push `((custom_id . ,custom-id)
                            (title . ,title)
                            (state . ,todo)
                            (depends . ,(or depends ""))
                            (blocks . ,(or blocks "")))
                          nodes)))))))
        (nreverse nodes)))))

(defun org-mcp--parse-space-separated (value)
  "Parse space-separated VALUE string into a list of trimmed tokens."
  (when (and value (not (string-empty-p (string-trim value))))
    (split-string (string-trim value) "[ \t]+" t)))

(defun org-mcp--build-edges (nodes)
  "Build edge list from NODES based on DEPENDS and BLOCKS properties.
Returns list of ((from . FROM_ID) (to . TO_ID) (type . \"depends\"|\"blocks\"))."
  (let ((edges '())
        (id-set (make-hash-table :test 'equal)))
    ;; Build set of known IDs for validation
    (dolist (node nodes)
      (puthash (cdr (assoc 'custom_id node)) t id-set))
    (dolist (node nodes)
      (let ((id (cdr (assoc 'custom_id node)))
            (depends-str (cdr (assoc 'depends node)))
            (blocks-str (cdr (assoc 'blocks node))))
        ;; DEPENDS: this item depends on listed items (edge: dep -> this)
        (dolist (dep (org-mcp--parse-space-separated depends-str))
          (when (gethash dep id-set)
            (push `((from . ,dep) (to . ,id) (type . "depends")) edges)))
        ;; BLOCKS: this item blocks listed items (edge: this -> blocked)
        (dolist (blocked (org-mcp--parse-space-separated blocks-str))
          (when (gethash blocked id-set)
            (push `((from . ,id) (to . ,blocked) (type . "blocks")) edges)))))
    (nreverse edges)))

(defun org-mcp--detect-cycles (nodes edges)
  "Detect cycles in graph defined by NODES and EDGES.
Returns list of cycle paths (each a list of CUSTOM_IDs).
Uses recursive DFS with 3-color marking."
  (let ((adj (make-hash-table :test 'equal))
        (all-ids '())
        (visited (make-hash-table :test 'equal))
        (rec-stack (make-hash-table :test 'equal))
        (cycles '()))
    ;; Build adjacency list (from -> list of to)
    (dolist (node nodes)
      (let ((id (cdr (assoc 'custom_id node))))
        (puthash id '() adj)
        (push id all-ids)))
    (dolist (edge edges)
      (let ((from (cdr (assoc 'from edge)))
            (to (cdr (assoc 'to edge))))
        (puthash from (cons to (gethash from adj)) adj)))
    ;; Recursive DFS helper via cl-labels
    (cl-labels
        ((dfs (current path)
           (puthash current t visited)
           (puthash current t rec-stack)
           (dolist (neighbor (gethash current adj))
             (cond
              ((gethash neighbor rec-stack)
               (let* ((cycle-start (cl-position neighbor path :test #'equal))
                      (cycle (when cycle-start
                               (append (cl-subseq path cycle-start)
                                       (list neighbor)))))
                 (when cycle
                   (push cycle cycles))))
              ((not (gethash neighbor visited))
               (dfs neighbor (append path (list neighbor))))))
           (remhash current rec-stack)))
      ;; Visit all nodes
      (dolist (id (nreverse all-ids))
        (unless (gethash id visited)
          (dfs id (list id)))))
    (nreverse cycles)))

(defun org-mcp-dependency-graph-handler (args)
  "Handle org-dependency-graph tool call with ARGS.
ARGS is an alist with optional key: file."
  (condition-case err
      (let* ((file (alist-get 'file args))
             (resolved-file (org-mcp--resolve-file file))
             (nodes (org-mcp--collect-graph-nodes resolved-file))
             (edges (org-mcp--build-edges nodes))
             (cycles (org-mcp--detect-cycles nodes edges))
             ;; Strip internal depends/blocks from node output
             (clean-nodes (mapcar (lambda (n)
                                    `((custom_id . ,(cdr (assoc 'custom_id n)))
                                      (title . ,(cdr (assoc 'title n)))
                                      (state . ,(cdr (assoc 'state n)))))
                                  nodes)))
        (json-encode
         `((nodes . ,(vconcat clean-nodes))
           (edges . ,(vconcat edges))
           (cycles . ,(vconcat (mapcar #'vconcat cycles))))))
    (error
     (json-encode
      `((error . t)
        (code . "DEPENDENCY_GRAPH_ERROR")
        (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-dependency-graph"
  :title "Dependency Graph"
  :description "Build dependency DAG from DEPENDS/BLOCKS properties. Returns nodes, edges, and detected cycles. Edge direction: from=dependency, to=dependent (e.g., A->B means B depends on A)."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string")
                               (description . "Path to org file (absolute or relative to @tasks/)")))))
                  (required . ["file"]))
  :function #'org-mcp-dependency-graph-handler))

(provide 'org-dependency-graph)

;;; org-dependency-graph.el ends here
