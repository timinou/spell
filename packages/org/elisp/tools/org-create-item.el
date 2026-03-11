;;; org-create-item.el --- MCP tool: org-create-item -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tool that creates a fully-formed org item with title, state,
;; properties, and body in one atomic call. Enhanced version of org-add-todo.

;;; Code:

(require 'mcp-server-tools)
(require 'org-mcp-common)

(defun org-mcp-create-item-handler (args)
  "Handle org-create-item tool call with ARGS.
ARGS is an alist with keys: file (required), title (required),
state (optional, default ITEM), properties (optional object), body (optional)."
  (condition-case err
      (let* ((file (alist-get 'file args))
             (title (alist-get 'title args))
             (state (or (alist-get 'state args) "ITEM"))
             (properties (alist-get 'properties args))
             (body (alist-get 'body args))
             (resolved-file (org-mcp--resolve-file file)))
        (unless title
          (error "title argument is required"))
        (unless (file-exists-p resolved-file)
          (error "File not found: %s" resolved-file))
        ;; Validate state
        (unless (member state org-tasks-todo-keywords)
          (error "Invalid state: %s (valid: %s)" state
                 (string-join org-tasks-todo-keywords ", ")))
        ;; Extract and validate properties
        (let ((effort (alist-get 'effort properties))
              (layer (alist-get 'layer properties))
              (custom-id (or (alist-get 'custom_id properties)
                             (org-tasks--generate-id title))))
          ;; Validate effort format
          (when effort
            (unless (string-match org-tasks-effort-regexp effort)
              (error "Invalid EFFORT format: %s (expected Xh, Xm, or Xd)" effort)))
          ;; Validate layer
          (when layer
            (unless (member layer org-tasks-valid-layers)
              (error "Invalid LAYER: %s (valid: %s)" layer
                     (string-join org-tasks-valid-layers ", "))))
          ;; Insert into file
          (with-current-buffer (find-file-noselect resolved-file)
            (org-mode)
            (org-tasks--setup-keywords)
            (goto-char (point-max))
            (unless (bolp) (insert "\n"))
            (unless (= (char-before) ?\n) (insert "\n"))
            ;; Heading with state
            (insert (format "* %s %s\n" state title))
            ;; Property drawer
            (insert ":PROPERTIES:\n")
            (insert (format ":CUSTOM_ID: %s\n" custom-id))
            ;; Insert all other properties from the object
            (when properties
              (let ((prop-list (if (listp properties) properties nil)))
                (dolist (prop prop-list)
                  (let ((key (symbol-name (car prop)))
                        (val (cdr prop)))
                    (unless (string= key "custom_id")
                      (insert (format ":%s: %s\n" (upcase key) val)))))))
            (insert ":END:\n")
            ;; Body text
            (when (and body (not (string-empty-p body)))
              (insert body)
              (unless (string-suffix-p "\n" body)
                (insert "\n")))
            (save-buffer)
            (json-encode
             `((success . t)
               (custom_id . ,custom-id)
               (title . ,title)
               (state . ,state)
               (file . ,resolved-file))))))
    (error
     (json-encode
      `((error . t)
        (code . "CREATE_ITEM_ERROR")
        (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-create-item"
  :title "Create Org Item"
  :description "Create a fully-formed org item with title, state, properties, and body in one atomic call. Enhanced version of org-add-todo that supports state selection, body text, and all properties at once. Auto-generates CUSTOM_ID if not provided."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string")
                               (description . "Path to org file (absolute or relative to @tasks/)")))
                      (title . ((type . "string")
                                (description . "Item title")))
                      (state . ((type . "string")
                                (description . "TODO state (default: ITEM)")
                                (enum . ("ITEM" "DOING" "REVIEW" "DONE" "BLOCKED"))))
                      (properties . ((type . "object")
                                     (description . "Properties object: { effort, layer, agent, depends, blocks, custom_id, ... }")))
                      (body . ((type . "string")
                               (description . "Body text content")))))
                  (required . ["file" "title"]))
  :function #'org-mcp-create-item-handler))

(provide 'org-create-item)

;;; org-create-item.el ends here
