;;; org-get-item.el --- MCP tool: org-get-item -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tool that wraps `org-tasks-get-item' from org-tasks.el.
;; Returns a single task item by CUSTOM_ID with full properties and body text.

;;; Code:

(require 'mcp-server-tools)
(require 'org-mcp-common)

(defun org-mcp-get-item-handler (args)
  "Handle org-get-item tool call with ARGS.
ARGS is an alist with keys: file, custom_id."
  (condition-case err
      (let* ((file (alist-get 'file args))
             (custom-id (alist-get 'custom_id args))
             (resolved-file (org-mcp--resolve-file file)))
        (unless custom-id
          (error "custom_id argument is required"))
        (unless (file-exists-p resolved-file)
          (error "File not found: %s" resolved-file))
        (org-tasks-get-item resolved-file custom-id))
    (error
     (json-encode
      `((error . t)
        (code . "GET_ITEM_ERROR")
        (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-get-item"
  :title "Get Org Item"
  :description "Get a single task item by CUSTOM_ID with all properties and body text. Returns full item detail including title, state, priority, effort, agent, layer, depends, blocks, tags, body, and all custom properties."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string")
                               (description . "Path to org file (absolute or relative to @tasks/)")))
                      (custom_id . ((type . "string")
                                    (description . "The CUSTOM_ID of the item to retrieve")))))
                  (required . ["file" "custom_id"]))
  :function #'org-mcp-get-item-handler))

(provide 'org-get-item)

;;; org-get-item.el ends here
