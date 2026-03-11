;;; org-get-items.el --- MCP tool: org-get-items -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tool that wraps `org-tasks-get-items' from org-tasks.el.
;; Returns task items from an org file with optional filtering.
;; This is the first org MCP tool — sets the pattern for all subsequent tools.

;;; Code:

(require 'mcp-server-tools)
(require 'org-mcp-common)

(defun org-mcp-get-items-handler (args)
  "Handle org-get-items tool call with ARGS.
ARGS is an alist with optional keys: file, state, layer, tags."
  (condition-case err
      (let* ((file (alist-get 'file args))
             (state (alist-get 'state args))
             (layer (alist-get 'layer args))
             (tags (alist-get 'tags args))
             (resolved-file (org-mcp--resolve-file file)))
        (unless (file-exists-p resolved-file)
          (error "File not found: %s" resolved-file))
        (let ((filters '()))
          (when state
            (push (cons 'state (append state nil)) filters))
          (when layer
            (push (cons 'layer layer) filters))
          (when tags
            (push (cons 'tags (append tags nil)) filters))
          (org-tasks-get-items resolved-file filters)))
    (error
     (json-encode
      `((error . t)
        (code . "GET_ITEMS_ERROR")
        (message . ,(error-message-string err)))))))


(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-get-items"
  :title "Get Org Items"
  :description "Get task items from an org file with optional filtering. Returns JSON array of items with custom_id, title, state, priority, effort, agent, layer, depends, blocks, tags, and file fields."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string")
                               (description . "Path to org file (absolute or relative to @tasks/)")))
                      (state . ((type . "array")
                                (items . ((type . "string")))
                                (description . "Filter by TODO states (e.g. [\"DOING\", \"ITEM\"])")))
                      (layer . ((type . "string")
                                (description . "Filter by layer (e.g. \"backend\")")))
                      (tags . ((type . "array")
                               (items . ((type . "string")))
                               (description . "Filter by tags")))))
                  (required . ["file"]))
  :function #'org-mcp-get-items-handler))

(provide 'org-get-items)

;;; org-get-items.el ends here
