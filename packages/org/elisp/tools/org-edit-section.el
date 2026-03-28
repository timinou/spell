;;; org-edit-section.el --- MCP tool: org-edit-section -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tool that wraps `org-tasks-edit-section' from org-tasks.el.

;;; Code:

(require 'mcp-server-tools)
(require 'org-mcp-common)

(defun org-mcp-edit-section-handler (args)
  "Handle org-edit-section tool call with ARGS.
ARGS is an alist with keys: file, custom_id, section, body, mode."
  (condition-case err
      (let* ((file (org-mcp--arg args 'file))
             (custom-id (org-mcp--arg args 'custom_id))
             (section (org-mcp--arg args 'section))
             (body (org-mcp--arg args 'body))
             (mode (or (org-mcp--arg args 'mode) "replace"))
             (resolved-file (org-mcp--resolve-file file)))
        (unless custom-id
          (error "custom_id argument is required"))
        (unless section
          (error "section argument is required"))
        (unless body
          (error "body argument is required"))
        (org-tasks-edit-section resolved-file custom-id section body mode))
    (error
     (json-encode
      `((error . t)
        (code . "EDIT_SECTION_ERROR")
        (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-edit-section"
  :title "Edit Section Body"
  :description "Edit a named section body inside an org item identified by CUSTOM_ID. Section match is case-sensitive and targets the first heading with matching raw title within the item subtree."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string")
                               (description . "Path to org file (absolute or relative to @tasks/)")))
                      (custom_id . ((type . "string")
                                    (description . "The CUSTOM_ID of the item to edit")))
                      (section . ((type . "string")
                                  (description . "Section heading title to target (case-sensitive raw headline value)")))
                      (body . ((type . "string")
                               (description . "Section body text content")))
                      (mode . ((type . "string")
                               (description . "Edit mode: replace or append")
                               (enum . ("replace" "append"))))))
                  (required . ["file" "custom_id" "section" "body"]))
  :function #'org-mcp-edit-section-handler))

(provide 'org-edit-section)

;;; org-edit-section.el ends here
