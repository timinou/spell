;;; pi-treesit.el --- Shared treesit utilities for pi-emacs -*- lexical-binding: t; -*-

;;; Code:

(require 'treesit)
(require 'pi-treesit-recipes)

;; Declare project-local extension maps (populated by pi-prelude from
;; treesitter.json).  The defvar ensures a safe default when pi-prelude has
;; not yet loaded — e.g. in isolated ERT test runs.
(defvar pi-treesit--project-mode-map '())
(defvar pi-treesit--project-lang-map '())

;; ---------------------------------------------------------------------------
;; Buffer helpers
;; ---------------------------------------------------------------------------

(defun pi-treesit-open-file (file)
  "Open FILE in a buffer with treesit parsing enabled, return buffer.
Always reads fresh from disk to avoid stale cached content.
Signals an error with an actionable message if no tree-sitter parser is
available for the file's language — listing the grammar name and where to
look for installation details."
  (let ((buf (generate-new-buffer (format " *pi-emacs:%s*" (file-name-nondirectory file)))))
    (with-current-buffer buf
      (insert-file-contents file)
      (let ((mode (pi-treesit--mode-for-file file)))
        (when (and mode (fboundp mode)) (funcall mode)))
      (unless (treesit-parser-list)
        (pi-treesit--activate-parser file))
      ;; After best-effort activation, check whether a parser is actually running.
      ;; If not, produce an explicit error so callers get a useful message rather
      ;; than a cryptic "no parser" or "killed buffer" failure later.
      (unless (treesit-parser-list)
        (kill-buffer buf)
        (let* ((lang (pi-treesit--lang-for-file file))
               (reason (and lang
                            (fboundp 'pi-prelude-grammar-unavailable-p)
                            (pi-prelude-grammar-unavailable-p lang))))
          (if lang
              (error (concat
                     (format "Tree-sitter grammar '%s' is not available for %s.%s "
                             lang (file-name-nondirectory file)
                             (if reason (format " Compile error: %s." reason) ""))
                     "To fix: restart the Emacs daemon (it auto-compiles missing grammars), "
                     "or add a .omp/treesitter.json with grammar sources and restart. "
                     "See ~/.omp/logs/ for compilation errors."))
            (error (concat
                   (format "No tree-sitter parser for %s (extension .%s not in built-in table). "
                           (file-name-nondirectory file)
                           (or (file-name-extension file) "?"))
                   "To add support: create .omp/treesitter.json with grammar sources "
                   "and extension mappings, then restart the Emacs daemon."))))))
    buf))

(defun pi-treesit--mode-for-file (file)
  "Return the appropriate treesit major mode for FILE based on extension.
Checks the project-local mode map (from treesitter.json) before the built-in table.
Returns nil for file types without a treesit mode (e.g. .el)."
  (let* ((ext (file-name-extension file))
         (project-mode (cdr (assoc ext pi-treesit--project-mode-map))))
    (or project-mode
        (pi-treesit-recipe-mode-for-ext ext)
        (pi-treesit-recipe-mode-for-filename (file-name-nondirectory file))
        ;; Non-treesit modes (no grammar needed)
        (when (string= ext "el") 'emacs-lisp-mode))))

(defun pi-treesit--activate-parser (file)
  "Try to activate an appropriate treesit parser for FILE."
  (let ((lang (pi-treesit--lang-for-file file)))
    (when (and lang (treesit-language-available-p lang))
      (treesit-parser-create lang))))

(defun pi-treesit--lang-for-file (file)
  "Return the treesit language symbol for FILE, or nil if not a treesit language.
Checks the project-local lang map (from treesitter.json) before the built-in table."
  (let* ((ext (file-name-extension file))
         (project-lang (cdr (assoc ext pi-treesit--project-lang-map))))
    (or project-lang
        (pi-treesit-recipe-lang-for-ext ext)
        (pi-treesit-recipe-lang-for-filename (file-name-nondirectory file)))))

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

(defun pi-treesit--heading-level-from-text (text)
  "Return the markdown heading level from TEXT.

Return nil when no leading # marker is present."
  (when (string-match "\\`[[:space:]]*\\(#+\\)" text)
    (length (match-string 1 text))))

(defun pi-treesit--strip-markdown-heading-markers (text)
  "Strip ATX heading markers from TEXT.

Used for both heading start and trailing markers.
This keeps only the core heading content.
"
  (let ((trimmed (string-trim text)))
    (setq trimmed (replace-regexp-in-string "\\`[[:space:]]*#+[[:space:]]*" "" trimmed))
    (string-trim-right (replace-regexp-in-string "[[:space:]]*#+[[:space:]]*\\'" "" trimmed))))

(defun pi-treesit--unquote-string (text)
  "Strip matching outer quotes from TEXT.

Used for keys that are represented as quoted literals.
"
  (if (string-match "\\`[\"']\\(.*\\)[\"']\\'" text)
      (match-string 1 text)
    text))

(defun pi-treesit--top-level-nodes-children (node)
  "Collect top-level declaration-like children for NODE.

Some tree-sitter grammars wrap statements in implicit container nodes,
including markdown/yaml/json documents. Unwrap known wrappers so callers get
actual declaration nodes.
"
  (let* ((type (treesit-node-type node))
         (child (treesit-node-child node 0))
         (out '()))
    (cond
      ((member type '("document" "stream" "block_mapping" "object" "section"))
       (while child
         (setq out (append out (pi-treesit--top-level-nodes-children child)))
         (setq child (treesit-node-next-sibling child))))
      (t
       (push node out)))
    (nreverse out)))

(defun pi-treesit-top-level-nodes ()
  "Return top-level declaration nodes from the current buffer's parse tree."
  (let ((root (treesit-buffer-root-node)))
    (when root
      (let ((children '())
            (n (treesit-node-child root 0)))
        (while n
          (setq children (append children (pi-treesit--top-level-nodes-children n)))
          (setq n (treesit-node-next-sibling n)))
        children))))

(defun pi-treesit-declaration-name (node)
  "Return the declared name of NODE, or nil if not a named declaration."
  (let ((type (treesit-node-type node))
        (parent (treesit-node-parent node)))
    (cond
     ;; TypeScript / JavaScript top-level declarations
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
     ;; Rust: fn, struct, enum, impl, trait, mod, type, const, static
     ((member type '("function_item" "struct_item" "enum_item"
                     "trait_item" "mod_item" "type_item"
                     "const_item" "static_item"))
      (let ((name-node (treesit-node-child-by-field-name node "name")))
        (when name-node (treesit-node-text name-node t))))
     ;; impl_item: show the implementing type name (no "name" field in tree-sitter-rust)
     ((string= type "impl_item")
      (let ((type-node (treesit-node-child-by-field-name node "type")))
        (when type-node (treesit-node-text type-node t))))
     ;; Python: function_definition, class_definition, decorated_definition
     ((member type '("function_definition" "class_definition"))
      (let ((name-node (treesit-node-child-by-field-name node "name")))
        (when name-node (treesit-node-text name-node t))))
     ((string= type "decorated_definition")
      (let ((def (treesit-node-child-by-field-name node "definition")))
        (when def (pi-treesit-declaration-name def))))
     ;; Go: function_declaration, method_declaration, type_declaration
     ((member type '("function_declaration" "method_declaration"))
      (let ((name-node (treesit-node-child-by-field-name node "name")))
        (when name-node (treesit-node-text name-node t))))
     ((string= type "type_declaration")
      ;; Go type_declaration contains type_spec children; first child holds the name.
      (let ((spec (treesit-node-child node 0)))
        (when spec
          (let ((name (treesit-node-child-by-field-name spec "name")))
            (when name (treesit-node-text name t))))))
     ;; Elm: value_declaration, type_alias_declaration, type_declaration, port_annotation
     ((member type '("type_alias_declaration" "type_declaration" "port_annotation"))
      (let ((name-node (treesit-node-child-by-field-name node "name")))
        (when name-node (treesit-node-text name-node t))))
     ((string= type "value_declaration")
      ;; value_declaration → functionDeclarationLeft → lower_case_identifier (child)
      (let ((fdl (treesit-node-child-by-field-name node "functionDeclarationLeft")))
        (when fdl
          (let ((id (treesit-search-subtree fdl "lower_case_identifier" nil nil 1)))
            (when id (treesit-node-text id t))))))
     ;; Markdown: atx_heading
     ((string= type "atx_heading")
      (let* ((full-text (pi-treesit-node-text node))
             (heading-level (or (pi-treesit--heading-level-from-text full-text) 1))
             (content-node (or (treesit-node-child-by-field-name node "heading_content")
                               (let ((child (treesit-node-child node 0))
                                     (candidate nil))
                                 (while (and child
                                             (not candidate))
                                   (unless (member (treesit-node-type child)
                                                   '("atx_h1_marker" "atx_h2_marker"
                                                     "atx_h3_marker" "atx_h4_marker"
                                                     "atx_h5_marker" "atx_h6_marker"))
                                     (setq candidate child))
                                   (setq child (treesit-node-next-sibling child)))
                                 candidate)))
             (text (if content-node
                       (treesit-node-text content-node t)
                     (pi-treesit--strip-markdown-heading-markers full-text))))
        (setq text (string-trim text))
        (when (> (length text) 0)
          (format "h%d: %s" heading-level text))))
     ;; YAML: top-level block mapping pairs
     ((string= type "block_mapping_pair")
      (let ((grandparent (and parent (treesit-node-parent parent)))
            (key-node (treesit-node-child-by-field-name node "key")))
        (when (and key-node
                   (string= (treesit-node-type parent) "block_mapping")
                   (member (and grandparent (treesit-node-type grandparent))
                           '("document" "stream")))
          (let ((text (treesit-node-text key-node t)))
            (unless (string-prefix-p "&" (string-trim text))
              text)))))
     ((string= type "pair")
      (let* ((parent-type (and parent (treesit-node-type parent)))
             (grandparent-type (and parent (treesit-node-parent parent)
                                    (treesit-node-type (treesit-node-parent parent))))
             (key-node (treesit-node-child-by-field-name node "key")))
        (when (and key-node
                   (or
                    ;; JSON: top-level pair in root object
                    (and (string= parent-type "object")
                         (member grandparent-type '("document" "stream")))
                    ;; TOML: top-level pair under document/table context
                    (and (member parent-type '("table" "document" "stream"))
                         (not (equal grandparent-type "table")))))
          (let ((raw (treesit-node-text key-node t)))
            (if (string= parent-type "object")
                (pi-treesit--unquote-string raw)
              raw))))
     ;; Markdown / TOML tables
     ((string= type "table")
      (string-trim (car (split-string (treesit-node-text node t) "\n"))))
     ;; Elixir: def, defp, defmodule, etc. — all are `call` nodes in tree-sitter-elixir
     ((string= type "call")
      (let* ((target (treesit-node-child node 0))
             (target-text (when target (treesit-node-text target t))))
        (when (and target-text
                   (member target-text
                           '("def" "defp" "defmodule" "defprotocol" "defimpl"
                             "defmacro" "defmacrop" "defguard" "defguardp"
                             "defstruct" "defdelegate" "defexception")))
          (let ((args-node (treesit-node-child-by-field-name node "arguments")))
            (when args-node
              (let ((first-arg (treesit-node-child args-node 0)))
                (when first-arg
                  (if (string= (treesit-node-type first-arg) "call")
                      (let ((fn-name (treesit-node-child first-arg 0)))
                        (when fn-name (treesit-node-text fn-name t)))
                    (treesit-node-text first-arg t)))))))))
    
     (t nil)))))

(defun pi-treesit-declaration-kind (node)
  "Return a short kind string for NODE: function, class, interface, type, const, etc."
  (let ((type (treesit-node-type node)))
    (cond
     ;; TypeScript / JavaScript
     ((string= type "export_statement")
      (let ((decl (treesit-node-child-by-field-name node "declaration")))
        (if decl (pi-treesit-declaration-kind decl) "export")))
     ((member type '("function_declaration" "function_expression")) "function")
     ((member type '("class_declaration" "abstract_class_declaration")) "class")
     ((string= type "interface_declaration") "interface")
     ((string= type "type_alias_declaration") "type")
     ((string= type "enum_declaration") "enum")
     ((string= type "atx_heading") "heading")
     ((string= type "block_mapping_pair") "key")
     ((string= type "pair") "key")
     ((string= type "table") "table")
     ((string= type "lexical_declaration") "const")
     ((string= type "method_definition") "method")
     ;; Rust
     ((string= type "function_item") "fn")
     ((string= type "struct_item") "struct")
     ((string= type "enum_item") "enum")
     ((string= type "impl_item") "impl")
     ((string= type "trait_item") "trait")
     ((string= type "mod_item") "mod")
     ((string= type "type_item") "type")
     ((string= type "const_item") "const")
     ((string= type "static_item") "static")
     ;; Python
     ((string= type "function_definition") "def")
     ((string= type "class_definition") "class")
     ((string= type "decorated_definition") "decorated")
     ;; Go
     ((string= type "function_declaration") "func")
     ((string= type "method_declaration") "method")
     ((string= type "type_declaration") "type")
     ;; Elm
     ((string= type "value_declaration") "def")
     ((string= type "type_alias_declaration") "type alias")
     ((string= type "port_annotation") "port")
     ;; Elixir
     ((string= type "call")
      (let* ((target (treesit-node-child node 0))
             (target-text (when target (treesit-node-text target t))))
        (cond
         ((member target-text '("def" "defp")) "def")
         ((string= target-text "defmodule") "defmodule")
         ((string= target-text "defprotocol") "defprotocol")
         ((string= target-text "defimpl") "defimpl")
         ((member target-text '("defmacro" "defmacrop")) "defmacro")
         ((member target-text '("defguard" "defguardp")) "defguard")
         ((string= target-text "defstruct") "defstruct")
         ((string= target-text "defdelegate") "defdelegate")
         ((string= target-text "defexception") "defexception")
         (t type)))
     (t type)))))

(provide 'pi-treesit)
;;; pi-treesit.el ends here
