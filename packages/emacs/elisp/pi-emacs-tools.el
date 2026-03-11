;;; pi-emacs-tools.el --- MCP tool registrations for pi-emacs -*- lexical-binding: t; -*-

;;; Code:

(require 'mcp-server-tools)
(require 'pi-resolution)
(require 'pi-outline)
(require 'pi-edit)
(require 'pi-buffer)

;; ---------------------------------------------------------------------------
;; code-read
;; ---------------------------------------------------------------------------

(defun pi-resolution-read-handler (args)
  "Handle code-read tool call with ARGS."
  (condition-case err
      (let* ((file (alist-get 'file args))
             (resolution (or (alist-get 'resolution args) 2))
             (offset (alist-get 'offset args))
             (limit (alist-get 'limit args)))
        (pi-resolution-read file resolution offset limit))
    (error (json-encode `((error . t) (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "code-read"
  :title "Code Read"
  :description "Read a source file at a given resolution level. Resolution 0=names only, 1=signatures, 2=structure (default), 3=full source."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string") (description . "Absolute or project-relative path")))
                      (resolution . ((type . "integer") (description . "Zoom level 0-3 (default 2)")))
                      (offset . ((type . "integer") (description . "Start line 1-indexed (resolution 3 only)")))
                      (limit . ((type . "integer") (description . "Max lines (resolution 3 only)")))))
                  (required . ["file"]))
  :function #'pi-resolution-read-handler))

;; ---------------------------------------------------------------------------
;; code-outline
;; ---------------------------------------------------------------------------

(defun pi-outline-get-handler (args)
  "Handle code-outline tool call with ARGS."
  (condition-case err
      (let* ((file (alist-get 'file args))
             (depth (alist-get 'depth args))
             (entries (pi-outline-get file depth)))
        (if entries
            entries
          ;; Return a structured warning so the agent sees a real explanation
          ;; instead of the opaque "nil" that falls through format-result.
          (json-encode
           `((result . [])
             (warning . "no-outline")
             (message . ,(format
                          "No recognized top-level declarations in '%s'. \
The outline extractor supports TS/JS/Rust/Go/Python/Elm. \
If this language is unsupported, use `emacs_code read` (resolution 1-2) as a fallback, \
or add a tree-sitter grammar via .omp/treesitter.json."
                          (file-name-nondirectory file)))))))
    (error (json-encode `((error . t) (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "code-outline"
  :title "Code Outline"
  :description "Extract a structural outline of a source file showing top-level declarations and class members with their line numbers."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string") (description . "Absolute or project-relative path")))
                      (depth . ((type . "integer") (description . "Nesting depth (default: full)")))))
                  (required . ["file"]))
  :function #'pi-outline-get-handler))

;; ---------------------------------------------------------------------------
;; code-edit
;; ---------------------------------------------------------------------------

(defun pi-edit-execute-handler (args)
  "Handle code-edit tool call with ARGS."
  (condition-case err
      (let* ((file (alist-get 'file args))
             (operation (alist-get 'operation args))
             (target (alist-get 'target args))
             (content (alist-get 'content args))
             (envelope (alist-get 'envelope args))
             (save (alist-get 'save args)))
        (pi-edit-execute file operation target content envelope save))
    (error (json-encode `((error . t) (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "code-edit"
  :title "Code Edit"
  :description "Perform structural edits on a source file. Supports replace, insert-before, insert-after, kill, splice, drag-up, drag-down, clone, and envelope operations."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string") (description . "Absolute or project-relative path")))
                      (operation . ((type . "string") (description . "Edit operation: replace, insert-before, insert-after, kill, splice, drag-up, drag-down, clone, envelope")))
                      (target . ((type . "object")
                                 (description . "Target node selector")
                                 (properties
                                  . ((line . ((type . "integer") (description . "1-indexed line number")))
                                     (node_type . ((type . "string") (description . "Treesit node type filter (optional)")))))))
                      (content . ((type . "string") (description . "Replacement or insertion text (omit for kill)")))
                      (envelope . ((type . "string") (description . "Combobulate envelope template name (envelope op only)")))
                      (save . ((type . "boolean") (description . "Save file after edit (default false)")))))
                  (required . ["file" "operation" "target"]))
  :function #'pi-edit-execute-handler))

;; ---------------------------------------------------------------------------
;; buffer-list
;; ---------------------------------------------------------------------------

(defun pi-buffer-list-handler (_args)
  "Handle buffer-list tool call."
  (condition-case err
      (pi-buffer-list)
    (error (json-encode `((error . t) (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "buffer-list"
  :title "Buffer List"
  :description "List all currently open managed buffers with their file path, modification status, size, and language."
  :input-schema '((type . "object")
                  (properties . ()))
  :function #'pi-buffer-list-handler))

;; ---------------------------------------------------------------------------
;; buffer-diff
;; ---------------------------------------------------------------------------

(defun pi-buffer-diff-handler (args)
  "Handle buffer-diff tool call with ARGS."
  (condition-case err
      (let ((file (alist-get 'file args)))
        (pi-buffer-diff file))
    (error (json-encode `((error . t) (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "buffer-diff"
  :title "Buffer Diff"
  :description "Show unified diff of unsaved changes in a buffer against its on-disk content. Returns empty string if the buffer is unmodified."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string") (description . "Absolute or project-relative path")))))
                  (required . ["file"]))
  :function #'pi-buffer-diff-handler))

;; ---------------------------------------------------------------------------
;; code-navigate
;; ---------------------------------------------------------------------------

(defun pi-navigate-handler (args)
  "Handle code-navigate tool call with ARGS."
  (condition-case err
      (let ((file (alist-get 'file args))
            (action (alist-get 'action args))
            (line (alist-get 'line args))
            (column (alist-get 'column args)))
        (pi-navigate-execute file action line column))
    (error (json-encode `((error . t) (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "code-navigate"
  :title "Code Navigate"
  :description "Navigate the treesit parse tree at a given position. Actions: defun-at (enclosing function), parent (parent node), references-local (in-file references to symbol at point)."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string") (description . "Absolute or project-relative path")))
                      (action . ((type . "string") (description . "Navigation action: defun-at, parent, references-local")))
                      (line . ((type . "integer") (description . "1-indexed line number")))
                      (column . ((type . "integer") (description . "1-indexed column number")))))
                  (required . ["file" "action"]))
  :function #'pi-navigate-handler))

(provide 'pi-emacs-tools)
;;; pi-emacs-tools.el ends here
