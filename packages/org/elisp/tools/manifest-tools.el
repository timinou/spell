;;; manifest-tools.el --- MCP tools for manifest management -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tools for querying manifest ticket state and computing
;; topological dependency order via Kahn's algorithm.

;;; Code:

(require 'mcp-server-tools)
(require 'org-mcp-common)
(require 'org)
(require 'org-element)

(defun manifest-collect-tickets (file)
  "Collect all ticket entries from FILE as alists.
Each ticket has keys: id, title, state, blockers, triggers,
effort, priority, has_gate."
  (with-temp-buffer
    (insert-file-contents file)
    (let ((buffer-file-name file))
      (org-mode)
      (org-tasks--setup-keywords)
      (let ((ast (org-element-parse-buffer))
            (tickets '()))
        (org-element-map ast 'headline
          (lambda (hl)
            (let ((custom-id (org-tasks--extract-property hl "CUSTOM_ID"))
                  (title (org-element-property :raw-value hl))
                  (state (org-element-property :todo-keyword hl))
                  (blocker (org-tasks--extract-property hl "BLOCKER"))
                  (trigger (org-tasks--extract-property hl "TRIGGER"))
                  (effort (org-tasks--extract-property hl "EFFORT"))
                  (priority (org-tasks--extract-property hl "PRIORITY"))
                  (gate-cmd (org-tasks--extract-property hl "GATE_CMD"))
                  (gate-artifact (org-tasks--extract-property hl "GATE_ARTIFACT"))
                  (gate-llm (org-tasks--extract-property hl "GATE_LLM")))
              (when custom-id
                (push `((id . ,custom-id)
                        (title . ,(or title ""))
                        (state . ,(or state "ITEM"))
                        (blockers . ,(if blocker
                                        (vconcat (split-string blocker))
                                      []))
                        (triggers . ,(or trigger ""))
                        (effort . ,(or effort ""))
                        (priority . ,(or priority ""))
                        (has_gate . ,(if (or gate-cmd gate-artifact gate-llm) t :json-false)))
                      tickets)))))
        (nreverse tickets)))))

(defun manifest-ticket-summary--handler (params)
  "MCP handler: return structured ticket summary for a manifest file.
PARAMS is an alist with key \"file\" pointing to the manifest org file."
  (condition-case err
      (let* ((file (alist-get "file" params nil nil #'string=))
             (resolved-file (org-mcp--resolve-file file))
             (tickets (manifest-collect-tickets resolved-file))
             (total (length tickets))
             (done (length (cl-remove-if-not
                            (lambda (tk) (string= (cdr (assoc 'state tk)) "DONE"))
                            tickets)))
             (doing (length (cl-remove-if-not
                             (lambda (tk) (string= (cdr (assoc 'state tk)) "DOING"))
                             tickets)))
             (blocked (length (cl-remove-if-not
                               (lambda (tk) (string= (cdr (assoc 'state tk)) "BLOCKED"))
                               tickets))))
        (json-encode
         `((total . ,total)
           (done . ,done)
           (doing . ,doing)
           (blocked . ,blocked)
           (remaining . ,(- total done))
           (tickets . ,(vconcat tickets)))))
    (error
     (json-encode
      `((error . t)
        (code . "MANIFEST_SUMMARY_ERROR")
        (message . ,(error-message-string err)))))))

(defun manifest-dependency-order--handler (params)
  "MCP handler: return tickets in topological dependency order.
PARAMS is an alist with key \"file\" pointing to the manifest org file.
Uses Kahn's algorithm; detects cycles when output length != input length."
  (condition-case err
      (let* ((file (alist-get "file" params nil nil #'string=))
             (resolved-file (org-mcp--resolve-file file))
             (tickets (manifest-collect-tickets resolved-file))
             ;; Adjacency: blocker -> list of dependents
             (adj (make-hash-table :test 'equal))
             (in-degree (make-hash-table :test 'equal))
             (ids '()))
        ;; Initialize all ticket IDs
        (dolist (tk tickets)
          (let ((id (cdr (assoc 'id tk))))
            (push id ids)
            (puthash id '() adj)
            (puthash id 0 in-degree)))
        ;; Build edges: each blocker points to the ticket it blocks
        (dolist (tk tickets)
          (let ((id (cdr (assoc 'id tk)))
                (blockers (cdr (assoc 'blockers tk))))
            (when (vectorp blockers)
              (dotimes (i (length blockers))
                (let ((blocker (aref blockers i)))
                  ;; Skip references to non-existent tickets
                  (when (gethash blocker adj)
                    (puthash blocker (cons id (gethash blocker adj)) adj)
                    (puthash id (1+ (gethash id in-degree 0)) in-degree)))))))
        ;; Kahn's algorithm
        (let ((queue '())
              (order '()))
          (dolist (id (nreverse ids))
            (when (= (gethash id in-degree 0) 0)
              (push id queue)))
          (while queue
            (let ((current (pop queue)))
              (push current order)
              (dolist (neighbor (gethash current adj))
                (let ((new-deg (1- (gethash neighbor in-degree 0))))
                  (puthash neighbor new-deg in-degree)
                  (when (= new-deg 0)
                    (push neighbor queue))))))
          (json-encode
           `((order . ,(vconcat (nreverse order)))
             (has_cycles . ,(if (= (length order) (length ids)) :json-false t))
             (total . ,(length ids))))))
    (error
     (json-encode
      `((error . t)
        (code . "DEPENDENCY_ORDER_ERROR")
        (message . ,(error-message-string err)))))))

;; Register MCP tools
(mcp-server-register-tool
 (make-mcp-server-tool
  :name "manifest-ticket-summary"
  :title "Manifest Ticket Summary"
  :description "Return structured summary of all tickets in a manifest org file: counts by state and full ticket list."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string")
                               (description . "Path to manifest org file")))))
                  (required . ["file"]))
  :function #'manifest-ticket-summary--handler))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "manifest-dependency-order"
  :title "Manifest Dependency Order"
  :description "Return tickets in topological dependency order using Kahn's algorithm. Detects cycles."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string")
                               (description . "Path to manifest org file")))))
                  (required . ["file"]))
  :function #'manifest-dependency-order--handler))

(provide 'manifest-tools)
;;; manifest-tools.el ends here
