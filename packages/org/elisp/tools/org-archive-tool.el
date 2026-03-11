;;; org-archive-tool.el --- MCP tool: org-archive-item -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tool for archiving completed items on demand.
;; Only DONE items can be archived. Uses org-archive-subtree.

;;; Code:

(require 'mcp-server-tools)
(require 'org-mcp-common)
(require 'org-archive)

(defun org-mcp--compute-archive-file (source-file)
  "Compute the archive file path for SOURCE-FILE.
Uses `org-archive-location' to determine the target file.
Falls back to SOURCE-FILE_archive."
  (let* ((location (or org-archive-location "%s_archive::"))
         (file-part (car (split-string location "::"))))
    (if (string-match-p "%s" file-part)
        (format file-part source-file)
      (if (string= file-part "")
          (concat source-file "_archive")
        file-part))))

(defun org-mcp-archive-item-handler (args)
  "Handle org-archive-item tool call with ARGS.
ARGS is an alist with keys: file, custom_id."
  (condition-case err
      (let* ((file (alist-get 'file args))
             (custom-id (alist-get 'custom_id args))
             (resolved-file (org-mcp--resolve-file file)))
        (unless custom-id
          (error "custom_id argument is required"))
        (unless (file-exists-p resolved-file)
          (error "File not found: %s" resolved-file))
        (with-current-buffer (find-file-noselect resolved-file)
          (org-mode)
          (org-tasks--setup-keywords)
          (goto-char (point-min))
          (let ((pos (org-find-property "CUSTOM_ID" custom-id)))
            (unless pos
              (error "Item %s not found in %s" custom-id resolved-file))
            (goto-char pos)
            (let ((state (org-get-todo-state)))
              (unless (string= state "DONE")
                (error "Only DONE items can be archived (current state: %s)" state))
              (let ((archive-file (org-mcp--compute-archive-file resolved-file)))
                (org-archive-subtree)
                (save-buffer)
                (json-encode
                 `((success . t)
                   (custom_id . ,custom-id)
                   (archived_to . ,archive-file))))))))
    (error
     (json-encode
      `((error . t)
        (code . "ARCHIVE_ERROR")
        (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-archive-item"
  :title "Archive Item"
  :description "Archive a completed (DONE) item. Moves the subtree to the archive file. Only DONE items can be archived."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string")
                               (description . "Path to org file (absolute or relative to @tasks/)")))
                      (custom_id . ((type . "string")
                                    (description . "CUSTOM_ID of the DONE item to archive")))))
                  (required . ["file" "custom_id"]))
  :function #'org-mcp-archive-item-handler))

(provide 'org-archive-tool)

;;; org-archive-tool.el ends here
