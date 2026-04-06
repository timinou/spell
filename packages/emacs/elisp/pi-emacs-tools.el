;;; pi-emacs-tools.el --- MCP tool registrations for pi-emacs -*- lexical-binding: t; -*-

;;; Code:

(require 'mcp-server-tools)
(require 'pi-resolution)
(require 'pi-outline)
(require 'pi-edit)
(require 'pi-buffer)
(require 'pi-treesit-recipes)
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
The outline extractor supports 50+ languages via tree-sitter. \
If this language is unsupported, use `code read` (resolution 1-2) as a fallback, \
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
  :description "Perform structural edits on a source file. Supports replace, insert-before, insert-after, kill, splice, splice-self, splice-down, drag-up, drag-down, clone, envelope, and transpose operations."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string") (description . "Absolute or project-relative path")))
                      (operation . ((type . "string") (description . "Edit operation: replace, insert-before, insert-after, kill, splice, splice-self, splice-down, drag-up, drag-down, clone, envelope, transpose")))
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
  :description "Navigate the treesit parse tree at a given position. Actions: defun-at (enclosing function), parent (parent node), references-local (in-file references), node-at (inspect node), siblings (list siblings), children (list child nodes)."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string") (description . "Absolute or project-relative path")))
                      (action . ((type . "string") (description . "Navigation action: defun-at, parent, references-local, node-at, siblings, children")))
                      (line . ((type . "integer") (description . "1-indexed line number")))
                      (column . ((type . "integer") (description . "1-indexed column number")))))
                  (required . ["file" "action"]))
  :function #'pi-navigate-handler))

;; ---------------------------------------------------------------------------
;; code-languages
;; ---------------------------------------------------------------------------

(defun pi-code-languages-handler (args)
  "Handle code-languages tool call with ARGS."
  (condition-case err
      (let* ((installed-only (alist-get 'installed_only args))
             (result '()))
        (dolist (recipe pi-treesit-recipes)
          (let* ((lang (car recipe))
                 (installed (treesit-language-available-p lang))
                 (url (pi-treesit--recipe-prop recipe :url))
                 (exts (pi-treesit--recipe-prop recipe :exts))
                 (filenames (pi-treesit--recipe-prop recipe :filenames))
                 (mode (pi-treesit--recipe-prop recipe :ts-mode))
                 (err-reason (pi-prelude-grammar-unavailable-p lang)))
            (unless (and (eq installed-only t) (not installed))
              (push `((lang . ,(symbol-name lang))
                      (installed . ,(if installed t :json-false))
                      (url . ,url)
                      ,@(when exts `((extensions . ,exts)))
                      ,@(when filenames `((filenames . ,filenames)))
                      ,@(when mode `((mode . ,(symbol-name mode))))
                      ,@(when err-reason `((error . ,err-reason))))
                    result))))
        ;; Also include project-local grammars
        (dolist (ext-lang pi-treesit--project-lang-map)
          (let* ((lang (cdr ext-lang))
                 (installed (treesit-language-available-p lang)))
            (unless (assq lang (mapcar (lambda (r) (cons (car r) t)) pi-treesit-recipes))
              (push `((lang . ,(symbol-name lang))
                      (installed . ,(if installed t :json-false))
                      (source . "project"))
                    result))))
        (json-encode (nreverse result)))
    (error (json-encode `((error . t) (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "code-languages"
  :title "Code Languages"
  :description "List available tree-sitter language grammars with installation status."
  :input-schema '((type . "object")
                  (properties
                   . ((installed_only . ((type . "boolean") (description . "Only list installed grammars"))))))
  :function #'pi-code-languages-handler))

;; ---------------------------------------------------------------------------
;; code-install-grammar
;; ---------------------------------------------------------------------------

(defun pi-code-install-grammar-handler (args)
  "Handle code-install-grammar tool call with ARGS."
  (condition-case err
      (let* ((lang-str (alist-get 'lang args))
             (lang (intern lang-str))
             (url-override (alist-get 'url args))
             (rev-override (alist-get 'revision args))
             (src-override (alist-get 'source_dir args)))
        ;; If custom URL provided, add/override in treesit-language-source-alist
        (when url-override
          (setq treesit-language-source-alist
                (cons (list lang url-override rev-override src-override)
                      (assq-delete-all lang treesit-language-source-alist))))
        ;; If no URL and no recipe, error
        (unless (or url-override (assq lang treesit-language-source-alist))
          (error "No recipe or URL for grammar '%s'. Use the url parameter or add to treesitter.json" lang-str))
        ;; Install
        (message "[pi-emacs] Installing grammar for %s ..." lang)
        (treesit-install-language-grammar lang pi-prelude--managed-dir)
        (if (treesit-language-available-p lang)
            (json-encode `((success . t) (lang . ,lang-str)))
          (json-encode `((success . :json-false)
                         (lang . ,lang-str)
                         (error . "Compiled but not loadable — check logs")))))
    (error (json-encode `((success . :json-false)
                          (lang . ,(or (alist-get 'lang args) "unknown"))
                          (error . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "code-install-grammar"
  :title "Install Grammar"
  :description "Install a tree-sitter grammar for a language. Uses built-in recipe URL or accepts a custom URL."
  :input-schema '((type . "object")
                  (properties
                   . ((lang . ((type . "string") (description . "Language name (e.g. elixir, nix, ruby)")))
                      (url . ((type . "string") (description . "Custom grammar URL (overrides recipe)")))
                      (revision . ((type . "string") (description . "Git revision/tag (optional)")))
                      (source_dir . ((type . "string") (description . "Subdirectory containing grammar source (optional)")))))
                  (required . ["lang"]))
  :function #'pi-code-install-grammar-handler))

(provide 'pi-emacs-tools)
;;; pi-emacs-tools.el ends here
