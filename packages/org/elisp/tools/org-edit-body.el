;;; org-edit-body.el --- MCP tool: org-edit-body -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tool that wraps `org-tasks-edit-body' from org-tasks.el.

;;; Code:

(require 'mcp-server-tools)
(require 'org-mcp-common)

(defun org-mcp-edit-body-handler (args)
  "Handle org-edit-body tool call with ARGS.
ARGS is an alist with keys: file, custom_id, body, mode."
  (condition-case err
      (let* ((file (org-mcp--arg args 'file))
             (custom-id (org-mcp--arg args 'custom_id))
             (body (org-mcp--arg args 'body))
             (mode (or (org-mcp--arg args 'mode) "replace"))
             (resolved-file (org-mcp--resolve-file file)))
        (unless custom-id
          (error "custom_id argument is required"))
        (unless body
          (error "body argument is required"))
        (org-tasks-edit-body resolved-file custom-id body mode))
    (error
     (json-encode
      `((error . t)
        (code . "EDIT_BODY_ERROR")
        (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-edit-body"
  :title "Edit Item Body"
  :description "Edit the main body text of an org item identified by CUSTOM_ID."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string")
                               (description . "Path to org file (absolute or relative to @tasks/)")))
                      (custom_id . ((type . "string")
                                    (description . "The CUSTOM_ID of the item to edit")))
                      (body . ((type . "string")
                               (description . "Body text content")))
                      (mode . ((type . "string")
                               (description . "Edit mode: replace or append")
                               (enum . ("replace" "append"))))))
                  (required . ["file" "custom_id" "body"]))
  :function #'org-mcp-edit-body-handler))

(provide 'org-edit-body)

;;; org-edit-body.el ends here
