;;; pi-treesit.el --- Shared treesit utilities for pi-emacs -*- lexical-binding: t; -*-

;;; Code:

(require 'treesit)

;; ---------------------------------------------------------------------------
;; Buffer helpers
;; ---------------------------------------------------------------------------

(defun pi-treesit-open-file (file)
  "Open FILE in a buffer with treesit parsing, return buffer.
Always reads fresh from disk to avoid stale cached buffers."
  (let ((buf (generate-new-buffer (format " *pi-emacs:%s*" (file-name-nondirectory file)))))
    (with-current-buffer buf
      (insert-file-contents file)
      (let ((mode (pi-treesit--mode-for-file file)))
        (when mode (funcall mode)))
      ;; Ensure treesit parser is active.
      (unless (treesit-parser-list)
        (pi-treesit--activate-parser file)))
    buf))

(defun pi-treesit--mode-for-file (file)
  "Return appropriate major mode for FILE based on extension."
  (let ((ext (file-name-extension file)))
    (cond
     ((member ext '("ts" "tsx")) 'typescript-ts-mode)
     ((member ext '("js" "jsx" "mjs")) 'js-ts-mode)
     ((member ext '("py")) 'python-ts-mode)
     ((member ext '("rs")) 'rust-ts-mode)
     ((member ext '("go")) 'go-ts-mode)
     ((member ext '("json")) 'json-ts-mode)
     ((member ext '("css")) 'css-ts-mode)
     ((member ext '("html" "htm")) 'html-ts-mode)
     ((member ext '("yaml" "yml")) 'yaml-ts-mode)
     ((member ext '("toml")) 'toml-ts-mode)
     ((member ext '("el")) 'emacs-lisp-mode)
     (t nil))))

(defun pi-treesit--activate-parser (file)
  "Try to activate an appropriate treesit parser for FILE."
  (let ((lang (pi-treesit--lang-for-file file)))
    (when (and lang (treesit-language-available-p lang))
      (treesit-parser-create lang))))

(defun pi-treesit--lang-for-file (file)
  "Return treesit language symbol for FILE."
  (let ((ext (file-name-extension file)))
    (cond
     ((member ext '("ts" "tsx")) 'typescript)
     ((member ext '("js" "jsx" "mjs")) 'javascript)
     ((member ext '("py")) 'python)
     ((member ext '("rs")) 'rust)
     ((member ext '("go")) 'go)
     ((member ext '("json")) 'json)
     ((member ext '("css")) 'css)
     ((member ext '("html" "htm")) 'html)
     ((member ext '("yaml" "yml")) 'yaml)
     (t nil))))

;; ---------------------------------------------------------------------------
;; Node helpers — treesit positions are 1-indexed buffer positions
;; ---------------------------------------------------------------------------

(defun pi-treesit-node-text (node)
  "Return text of NODE."
  (treesit-node-text node t))

(defun pi-treesit-node-at-line (line lang)
  "Return the smallest node at the start of LINE for LANG parser."
  (let ((pos (save-excursion
               (goto-char (point-min))
               (forward-line (1- line))
               (point))))
    (treesit-node-at pos lang)))

(defun pi-treesit-find-body (node)
  "Find body node (class_body or statement_block) of declaration NODE."
  (or
   (treesit-node-child-by-field-name node "body")
   (when-let* ((decl (treesit-node-child-by-field-name node "declaration"))
               (b (treesit-node-child-by-field-name decl "body")))
     b)
   (treesit-search-subtree
    node
    (lambda (n)
      (member (treesit-node-type n)
              '("class_body" "statement_block" "block")))
    nil nil 3)))

(defun pi-treesit-stub-body (node stub)
  "Return NODE text with body replaced by STUB."
  (let ((body (pi-treesit-find-body node)))
    (if body
        (concat
         (buffer-substring-no-properties
          (treesit-node-start node)
          (treesit-node-start body))
         stub)
      (treesit-node-text node t))))

(defun pi-treesit-top-level-nodes ()
  "Return top-level declaration nodes from the current buffer's parse tree."
  (let ((root (treesit-buffer-root-node)))
    (when root
      (let ((children '()))
        (let ((n (treesit-node-child root 0)))
          (while n
            (push n children)
            (setq n (treesit-node-next-sibling n))))
        (nreverse children)))))

(defun pi-treesit-declaration-name (node)
  "Return the declared name of NODE, or nil if not a named declaration."
  (let ((type (treesit-node-type node)))
    (cond
     ;; function_declaration, class_declaration, interface_declaration
     ((member type '("function_declaration" "class_declaration"
                     "interface_declaration" "type_alias_declaration"
                     "enum_declaration" "abstract_class_declaration"))
      (let ((name-node (treesit-node-child-by-field-name node "name")))
        (when name-node (treesit-node-text name-node t))))
     ;; export_statement wrapping a declaration
     ((string= type "export_statement")
      (let ((decl (treesit-node-child-by-field-name node "declaration")))
        (when decl (pi-treesit-declaration-name decl))))
     ;; lexical_declaration (const/let/var)
     ((string= type "lexical_declaration")
      (let ((declarator (treesit-node-child-by-field-name node "declarator")))
        (when declarator
          (let ((name (treesit-node-child-by-field-name declarator "name")))
            (when name (treesit-node-text name t))))))
     (t nil))))

(defun pi-treesit-declaration-kind (node)
  "Return a short kind string for NODE: function, class, interface, type, const, etc."
  (let ((type (treesit-node-type node)))
    (cond
     ((string= type "export_statement")
      (let ((decl (treesit-node-child-by-field-name node "declaration")))
        (if decl (pi-treesit-declaration-kind decl) "export")))
     ((member type '("function_declaration" "function_expression")) "function")
     ((member type '("class_declaration" "abstract_class_declaration")) "class")
     ((string= type "interface_declaration") "interface")
     ((string= type "type_alias_declaration") "type")
     ((string= type "enum_declaration") "enum")
     ((string= type "lexical_declaration") "const")
     ((string= type "method_definition") "method")
     (t type))))

(provide 'pi-treesit)
;;; pi-treesit.el ends here
