;;; org-next-ids.el --- MCP tool: org-next-ids -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tool that computes the next available CUSTOM_IDs for a given category prefix.
;; Scans all .org files in @tasks/ directory and returns the next N IDs.

;;; Code:

(require 'mcp-server-tools)
(require 'org-mcp-common)

(defun org-mcp-next-ids-handler (args)
  "Handle org-next-ids tool call with ARGS.
ARGS is an alist with keys: category (required), count (optional, default 1)."
  (condition-case err
      (let* ((category (alist-get 'category args))
             (count (or (alist-get 'count args) 1)))
        (unless category
          (error "category argument is required"))
        (unless (and (integerp count) (> count 0))
          (error "count must be a positive integer"))
        (let ((next-ids (org-mcp--compute-next-ids category count)))
          (json-encode `((ids . ,next-ids)))))
    (error
     (json-encode
      `((error . t)
        (code . "NEXT_IDS_ERROR")
        (message . ,(error-message-string err)))))))

(defun org-mcp--compute-next-ids (category count)
  "Compute the next N IDs for CATEGORY.
Returns a JSON array of strings like [\"TASK-004-\", \"TASK-005-\"]."
  (let ((all-ids (org-mcp--collect-ids-for-category category))
        (max-num 0))
    ;; Find the maximum number used so far
    (dolist (id all-ids)
      (when (string-match (format "^%s-\\([0-9]\\{3\\}\\)-" category) id)
        (let ((num (string-to-number (match-string 1 id))))
          (when (> num max-num)
            (setq max-num num)))))
    ;; Generate the next N IDs
    (let ((result '()))
      (dotimes (i count)
        (let ((next-num (+ max-num i 1)))
          (push (format "%s-%03d-" category next-num) result)))
      (vconcat (nreverse result)))))

(defun org-mcp--collect-ids-for-category (category)
  "Collect all CUSTOM_IDs matching CATEGORY from all @tasks files.
Returns a list of ID strings."
  (let ((ids '())
        (tasks-dir (org-tasks--directory)))
    (dolist (file (directory-files-recursively tasks-dir "\\.org$"))
      (with-temp-buffer
        (insert-file-contents file)
        (let ((buffer-file-name file))
          (org-mode)
          (let ((ast (org-element-parse-buffer)))
            (org-element-map ast 'headline
              (lambda (hl)
                (when-let ((custom-id (org-tasks--extract-property hl "CUSTOM_ID")))
                  (when (string-match (format "^%s-" category) custom-id)
                    (push custom-id ids)))))))))
    ids))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-next-ids"
  :title "Get Next Org IDs"
  :description "Compute the next available CUSTOM_IDs for a given category prefix. Scans all .org files in @tasks/ and returns the next N IDs with trailing hyphen (e.g., [\"TASK-004-\", \"TASK-005-\"])."
  :input-schema '((type . "object")
                  (properties
                   . ((category . ((type . "string")
                                   (description . "Category prefix (e.g., \"TASK\", \"BUG\", \"FEAT\")")))
                      (count . ((type . "integer")
                                (description . "Number of IDs to generate (default 1)")
                                (minimum . 1)))))
                  (required . ["category"]))
  :function #'org-mcp-next-ids-handler))

(provide 'org-next-ids)

;;; org-next-ids.el ends here
