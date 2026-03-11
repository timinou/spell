;;; org-property.el --- MCP tools: org-get-property, org-set-property -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tools for property access with inheritance support.
;; org-get-property: reads a property with optional inheritance.
;; org-set-property: sets a property value on an item.

;;; Code:

(require 'mcp-server-tools)
(require 'org-mcp-common)

(defun org-mcp-get-property-handler (args)
  "Handle org-get-property tool call with ARGS.
ARGS is an alist with keys: file, custom_id, key, inherit (default true)."
  (condition-case err
      (let* ((file (alist-get 'file args))
             (custom-id (alist-get 'custom_id args))
             (key (alist-get 'key args))
             (inherit (if (eq (alist-get 'inherit args) :json-false) nil t))
             (resolved-file (org-mcp--resolve-file file)))
        (unless custom-id
          (error "custom_id argument is required"))
        (unless key
          (error "key argument is required"))
        (unless (file-exists-p resolved-file)
          (error "File not found: %s" resolved-file))
        (when (and inherit (string= key "CUSTOM_ID"))
          (setq inherit nil))
        (with-current-buffer (find-file-noselect resolved-file)
          (org-mode)
          (org-tasks--setup-keywords)
          (goto-char (point-min))
          (let ((pos (org-find-property "CUSTOM_ID" custom-id)))
            (unless pos
              (error "Item %s not found" custom-id))
            (goto-char pos)
            (let* ((local-val (org-entry-get nil key nil))
                   (inherited-val (when inherit
                                    (org-entry-get-with-inheritance key)))
                   (value (or local-val (when inherit inherited-val)))
                   (is-inherited (and inherit
                                      (null local-val)
                                      (not (null inherited-val))))
                   (source (when is-inherited
                             (save-excursion
                               (when (org-up-heading-safe)
                                 (org-get-heading t t t t))))))
              (json-encode
               `((custom_id . ,custom-id)
                 (key . ,key)
                 (value . ,value)
                 (inherited . ,(if is-inherited t :json-false))
                 (source_heading . ,source)))))))
    (error
     (json-encode
      `((error . t)
        (code . "GET_PROPERTY_ERROR")
        (message . ,(error-message-string err)))))))

(defun org-mcp-set-property-handler (args)
  "Handle org-set-property tool call with ARGS.
ARGS is an alist with keys: file, custom_id, key, value."
  (condition-case err
      (let* ((file (alist-get 'file args))
             (custom-id (alist-get 'custom_id args))
             (key (alist-get 'key args))
             (value (alist-get 'value args))
             (resolved-file (org-mcp--resolve-file file)))
        (unless custom-id
          (error "custom_id argument is required"))
        (unless key
          (error "key argument is required"))
        (when (string= key "CUSTOM_ID")
          (error "Cannot modify CUSTOM_ID property"))
        (unless (file-exists-p resolved-file)
          (error "File not found: %s" resolved-file))
        (with-current-buffer (find-file-noselect resolved-file)
          (org-mode)
          (org-tasks--setup-keywords)
          (goto-char (point-min))
          (let ((pos (org-find-property "CUSTOM_ID" custom-id)))
            (unless pos
              (error "Item %s not found" custom-id))
            (goto-char pos)
            (let ((old-value (org-entry-get nil key nil)))
              (org-set-property key (format "%s" value))
              (save-buffer)
              (json-encode
               `((success . t)
                 (custom_id . ,custom-id)
                 (key . ,key)
                 (old_value . ,old-value)
                 (new_value . ,(format "%s" value))))))))
    (error
     (json-encode
      `((error . t)
        (code . "SET_PROPERTY_ERROR")
        (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-get-property"
  :title "Get Property"
  :description "Get a property value for an item, with optional inheritance. CUSTOM_ID never inherits. When inherit=true (default), walks up the heading tree to find inherited values."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string")
                               (description . "Path to org file (absolute or relative to @tasks/)")))
                      (custom_id . ((type . "string")
                                    (description . "CUSTOM_ID of the item")))
                      (key . ((type . "string")
                              (description . "Property key to read")))
                      (inherit . ((type . "boolean")
                                  (description . "Enable property inheritance (default: true)")))))
                  (required . ["file" "custom_id" "key"]))
  :function #'org-mcp-get-property-handler))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-set-property"
  :title "Set Property"
  :description "Set a property value on an item. Cannot modify CUSTOM_ID."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string")
                               (description . "Path to org file (absolute or relative to @tasks/)")))
                      (custom_id . ((type . "string")
                                    (description . "CUSTOM_ID of the item")))
                      (key . ((type . "string")
                              (description . "Property key to set")))
                      (value . ((type . "string")
                                (description . "Property value")))))
                  (required . ["file" "custom_id" "key" "value"]))
  :function #'org-mcp-set-property-handler))

(provide 'org-property)

;;; org-property.el ends here
