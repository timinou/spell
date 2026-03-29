;;; loop-navigation.el --- Loop navigation helpers -*- lexical-binding: t; -*-

(require 'org)
(require 'org-element)

(defun spell-loop-jump-to-linked (target-id)
  "Jump to the first entry with CUSTOM_ID TARGET-ID in the current buffer."
  (let ((line nil))
    (org-map-entries
     (lambda ()
       (when (and (not line) (string= (or (org-entry-get (point) "CUSTOM_ID") "") target-id))
         (setq line (line-number-at-pos))))
     nil 'file)
    line))

(defun spell-loop-show-dep-graph ()
  "Return a simple textual dependency graph for LOOP_CHILDREN in the current buffer."
  (let ((lines '()))
    (org-map-entries
     (lambda ()
       (let ((id (or (org-entry-get (point) "CUSTOM_ID") ""))
             (children (or (org-entry-get (point) "LOOP_CHILDREN") "")))
         (push (format "%s -> %s" id children) lines)))
     nil 'file)
    (mapconcat #'identity (nreverse lines) "\n")))

(defun spell-loop-highlight-acceptance ()
  "Return non-nil when the current buffer contains an Acceptance Criteria section."
  (save-excursion
    (goto-char (point-min))
    (re-search-forward "Acceptance Criteria" nil t)))

(defun spell-loop-show-gate-results ()
  "Return the LAST_GATE_OUTCOME property for the current item."
  (or (org-entry-get (point) "LAST_GATE_OUTCOME") ""))

;; ---------------------------------------------------------------------------
;; MCP tool handlers
;; ---------------------------------------------------------------------------

(defun spell-loop-jump-to-linked--handler (params)
  "MCP handler: jump to linked item by CUSTOM_ID."
  (let* ((file (alist-get "file" params nil nil #'string=))
         (custom-id (alist-get "custom_id" params nil nil #'string=)))
    (unless (and file custom-id)
      (error "loop-jump-to-linked requires 'file' and 'custom_id' parameters"))
    (with-current-buffer (find-file-noselect file)
      (let ((line (spell-loop-jump-to-linked custom-id)))
        (json-encode (list (cons "line" (or line :null))
                           (cons "file" file)
                           (cons "custom_id" custom-id)))))))

(defun spell-loop-show-dep-graph--handler (params)
  "MCP handler: show dependency graph for an org file."
  (let* ((file (alist-get "file" params nil nil #'string=)))
    (unless file
      (error "loop-show-dep-graph requires 'file' parameter"))
    (with-current-buffer (find-file-noselect file)
      (json-encode (list (cons "graph" (spell-loop-show-dep-graph)))))))

(defun spell-loop-highlight-acceptance--handler (params)
  "MCP handler: check if file has Acceptance Criteria section."
  (let* ((file (alist-get "file" params nil nil #'string=)))
    (unless file
      (error "loop-highlight-acceptance requires 'file' parameter"))
    (with-current-buffer (find-file-noselect file)
      (json-encode (list (cons "found" (if (spell-loop-highlight-acceptance) t :json-false)))))))

(defun spell-loop-show-gate-results--handler (params)
  "MCP handler: show gate results for a specific item."
  (let* ((file (alist-get "file" params nil nil #'string=))
         (custom-id (alist-get "custom_id" params nil nil #'string=)))
    (unless (and file custom-id)
      (error "loop-show-gate-results requires 'file' and 'custom_id' parameters"))
    (with-current-buffer (find-file-noselect file)
      (let ((result nil))
        (org-map-entries
         (lambda ()
           (when (string= (or (org-entry-get (point) "CUSTOM_ID") "") custom-id)
             (setq result (spell-loop-show-gate-results))))
         nil 'file)
        (json-encode (list (cons "outcome" (or result ""))
                           (cons "custom_id" custom-id)))))))

;; ---------------------------------------------------------------------------
;; MCP tool registrations (only when loaded through MCP server bootstrap)
;; ---------------------------------------------------------------------------

(when (featurep 'mcp-server-tools)
  (mcp-server-register-tool
   (make-mcp-server-tool
    :name "loop-jump-to-linked"
    :title "Jump to Linked Loop Item"
    :description "Find the line number of an org entry by CUSTOM_ID in a file."
    :input-schema '((type . "object")
                    (properties
                     . ((file . ((type . "string")
                                 (description . "Absolute path to .org file")))
                        (custom_id . ((type . "string")
                                      (description . "CUSTOM_ID to locate")))))
                    (required . ["file" "custom_id"]))
    :function #'spell-loop-jump-to-linked--handler))

  (mcp-server-register-tool
   (make-mcp-server-tool
    :name "loop-show-dep-graph"
    :title "Show Loop Dependency Graph"
    :description "Return a textual dependency graph of LOOP_CHILDREN properties in an org file."
    :input-schema '((type . "object")
                    (properties
                     . ((file . ((type . "string")
                                 (description . "Absolute path to .org file")))))
                    (required . ["file"]))
    :function #'spell-loop-show-dep-graph--handler))

  (mcp-server-register-tool
   (make-mcp-server-tool
    :name "loop-highlight-acceptance"
    :title "Check Acceptance Criteria"
    :description "Check if an org file contains an Acceptance Criteria section."
    :input-schema '((type . "object")
                    (properties
                     . ((file . ((type . "string")
                                 (description . "Absolute path to .org file")))))
                    (required . ["file"]))
    :function #'spell-loop-highlight-acceptance--handler))

  (mcp-server-register-tool
   (make-mcp-server-tool
    :name "loop-show-gate-results"
    :title "Show Gate Results"
    :description "Return the LAST_GATE_OUTCOME for a specific entry by CUSTOM_ID."
    :input-schema '((type . "object")
                    (properties
                     . ((file . ((type . "string")
                                 (description . "Absolute path to .org file")))
                        (custom_id . ((type . "string")
                                      (description . "CUSTOM_ID of the entry")))))
                    (required . ["file" "custom_id"]))
    :function #'spell-loop-show-gate-results--handler)))

(provide 'loop-navigation)
;;; loop-navigation.el ends here
