;;; org-search.el --- MCP tool: org-search -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tool for full-text search across org files.
;; Searches headings, body text, and properties.

;;; Code:

(require 'mcp-server-tools)
(require 'org-mcp-common)

(defun org-mcp--search-file (file query max-results)
  "Search FILE for QUERY, return up to MAX-RESULTS matches."
  (let ((results '())
        (query-re (regexp-quote query)))
    (with-temp-buffer
      (insert-file-contents file)
      (let ((buffer-file-name file))
        (org-mode)
        (org-tasks--setup-keywords)
        (let ((ast (org-element-parse-buffer)))
          (org-element-map ast 'headline
            (lambda (hl)
              (when (< (length results) max-results)
                (let* ((todo (org-element-property :todo-keyword hl))
                       (title (org-element-property :raw-value hl))
                       (custom-id (or (org-tasks--extract-property hl "CUSTOM_ID") ""))
                       (body (org-tasks--extract-body hl))
                       (all-props (org-tasks--extract-all-properties hl))
                       (line (org-element-property :begin hl))
                       (line-num (count-lines 1 (min line (point-max)))))
                  (cond
                   ((string-match-p query-re title)
                    (push `((custom_id . ,custom-id)
                            (title . ,title)
                            (file . ,file)
                            (line . ,line-num)
                            (match_type . "heading")
                            (context . ,title))
                          results))
                   ((cl-some (lambda (prop)
                               (and (cdr prop)
                                    (string-match-p query-re (cdr prop))))
                             all-props)
                    (let ((matched (cl-find-if
                                    (lambda (prop)
                                      (and (cdr prop)
                                           (string-match-p query-re (cdr prop))))
                                    all-props)))
                      (push `((custom_id . ,custom-id)
                              (title . ,title)
                              (file . ,file)
                              (line . ,line-num)
                              (match_type . "property")
                              (context . ,(format "%s: %s" (car matched) (cdr matched))))
                            results)))
                   ((and body (string-match-p query-re body))
                    (let* ((pos (string-match query-re body))
                           (start (max 0 (- pos 40)))
                           (end (min (length body) (+ pos (length query) 40)))
                           (ctx (substring body start end)))
                      (push `((custom_id . ,custom-id)
                              (title . ,title)
                              (file . ,file)
                              (line . ,line-num)
                              (match_type . "body")
                              (context . ,(string-trim ctx)))
                            results)))))))))))
    (nreverse results)))

(defun org-mcp-search-handler (args)
  "Handle org-search tool call with ARGS.
ARGS is an alist with keys: query (required), scope (optional), limit (optional)."
  (condition-case err
      (let* ((query (alist-get 'query args))
             (scope (or (alist-get 'scope args) "all"))
             (limit (or (alist-get 'limit args) 50))
             (files (org-tasks--all-org-files))
             (all-results '()))
        (unless query
          (error "query argument is required"))
        (unless (> (length query) 0)
          (error "query must not be empty"))
        (dolist (file files)
          (when (< (length all-results) limit)
            (let ((remaining (- limit (length all-results))))
              (setq all-results
                    (append all-results
                            (org-mcp--search-file file query remaining))))))
        (json-encode
         `((query . ,query)
           (scope . ,scope)
           (total_matches . ,(length all-results))
           (results . ,(vconcat (seq-take all-results limit))))))
    (error
     (json-encode
      `((error . t)
        (code . "SEARCH_ERROR")
        (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-search"
  :title "Search Org Files"
  :description "Full-text search across all @tasks/ org files. Searches headings, body text, and properties. Returns matches with context snippets."
  :input-schema '((type . "object")
                  (properties
                   . ((query . ((type . "string")
                                (description . "Search query string")))
                      (scope . ((type . "string")
                                (description . "Search scope (default: all)")
                                (enum . ("all" "@tasks" "@research"))))
                      (limit . ((type . "number")
                                (description . "Maximum results (default: 50)")))))
                  (required . ["query"]))
  :function #'org-mcp-search-handler))

(provide 'org-search)

;;; org-search.el ends here
