;;; org-compute-waves.el --- MCP tool: org-compute-waves -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tool that computes topological wave layers from sub-outline dependency graph.
;; Sub-outlines are headings with CUSTOM_ID containing "::" separator.
;; Waves emerge from topological sorting: wave 1 = items with no deps,
;; wave N = items whose all deps are in waves < N.

;;; Code:

(require 'mcp-server-tools)
(require 'org-mcp-common)

(defun org-mcp--collect-sub-outlines (file)
  "Collect all sub-outline headings from FILE.
Sub-outlines have CUSTOM_ID containing \"::\" separator.
Returns list of alists with custom_id, parent_id, title, depends."
  (with-temp-buffer
    (insert-file-contents file)
    (let ((buffer-file-name file))
      (org-mode)
      (org-tasks--setup-keywords)
      (let ((ast (org-element-parse-buffer))
            (items '()))
        (org-element-map ast 'headline
          (lambda (hl)
            (let ((custom-id (org-tasks--extract-property hl "CUSTOM_ID")))
              (when (and custom-id (string-match-p "::" custom-id))
                (let* ((title (org-element-property :raw-value hl))
                       (depends-str (or (org-tasks--extract-property hl "DEPENDS") ""))
                       (parent-id (car (split-string custom-id "::")))
                       (depends (when (not (string-empty-p (string-trim depends-str)))
                                  (split-string (string-trim depends-str) "[ \t]+" t))))
                  (push `((custom_id . ,custom-id)
                          (parent_id . ,parent-id)
                          (title . ,title)
                          (depends . ,(or depends '())))
                        items))))))
        (nreverse items)))))

(defun org-mcp--compute-wave-layers (items)
  "Compute wave layers from ITEMS using topological sort (Kahn's algorithm).
Returns (waves . warnings) cons cell.
Waves is a list of ((number . N) (items . [...]))."
  (let* ((id-map (make-hash-table :test 'equal))
         (in-degree (make-hash-table :test 'equal))
         (adj (make-hash-table :test 'equal))
         (warnings '())
         (all-ids '()))
    ;; Build lookup
    (dolist (item items)
      (let ((id (cdr (assoc 'custom_id item))))
        (puthash id item id-map)
        (puthash id 0 in-degree)
        (puthash id '() adj)
        (push id all-ids)))
    ;; Build edges: dep -> dependents
    (dolist (item items)
      (let ((id (cdr (assoc 'custom_id item)))
            (deps (cdr (assoc 'depends item))))
        (dolist (dep deps)
          (if (gethash dep id-map)
              (progn
                (puthash dep (cons id (gethash dep adj)) adj)
                (puthash id (1+ (gethash id in-degree 0)) in-degree))
            (push (format "Warning: %s depends on %s which is not a sub-outline" id dep)
                  warnings)))))
    ;; Kahn's algorithm: process wave by wave
    (let ((queue '())
          (waves '())
          (wave-num 0)
          (processed 0))
      ;; Find initial wave (in-degree 0)
      (dolist (id (nreverse all-ids))
        (when (= 0 (gethash id in-degree 0))
          (push id queue)))
      (setq queue (nreverse queue))
      ;; Process wave by wave
      (while queue
        (cl-incf wave-num)
        (let ((wave-items '())
              (next-queue '()))
          (dolist (id queue)
            (cl-incf processed)
            (let ((item (gethash id id-map)))
              (push `((custom_id . ,(cdr (assoc 'custom_id item)))
                      (parent_id . ,(cdr (assoc 'parent_id item)))
                      (title . ,(cdr (assoc 'title item))))
                    wave-items))
            ;; Reduce in-degree of neighbors
            (dolist (neighbor (gethash id adj))
              (let ((new-deg (1- (gethash neighbor in-degree 1))))
                (puthash neighbor new-deg in-degree)
                (when (= new-deg 0)
                  (push neighbor next-queue)))))
          (push `((number . ,wave-num)
                  (items . ,(vconcat (nreverse wave-items))))
                waves)
          (setq queue (sort (nreverse next-queue) #'string<))))
      ;; Check for cycles: any unprocessed nodes have in-degree > 0
      (let ((cycles '()))
        (when (< processed (length all-ids))
          (dolist (id all-ids)
            (when (> (gethash id in-degree 0) 0)
              (push id cycles)))
          (push (format "Cycle detected involving: %s" (string-join (nreverse cycles) ", "))
                warnings))
        (cons (nreverse waves) (nreverse warnings))))))

(defun org-mcp-compute-waves-handler (args)
  "Handle org-compute-waves tool call with ARGS.
ARGS is an alist with key: file."
  (condition-case err
      (let* ((file (alist-get 'file args))
             (resolved-file (org-mcp--resolve-file file)))
        (unless (file-exists-p resolved-file)
          (error "File not found: %s" resolved-file))
        (let* ((items (org-mcp--collect-sub-outlines resolved-file))
               (result (org-mcp--compute-wave-layers items))
               (waves (car result))
               (warnings (cdr result)))
          (json-encode
           `((waves . ,(vconcat waves))
             (warnings . ,(vconcat warnings))
             (total_sub_outlines . ,(length items))))))
    (error
     (json-encode
      `((error . t)
        (code . "COMPUTE_WAVES_ERROR")
        (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-compute-waves"
  :title "Compute Waves"
  :description "Compute topological wave layers from sub-outline dependency graph. Sub-outlines have CUSTOM_ID with :: separator. Returns waves (layers of parallelizable items), warnings, and cycle detection."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string")
                               (description . "Path to org file (absolute or relative to @tasks/)")))))
                  (required . ["file"]))
  :function #'org-mcp-compute-waves-handler))

(provide 'org-compute-waves)

;;; org-compute-waves.el ends here
