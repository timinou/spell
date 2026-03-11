;;; pi-outline.el --- Outline extraction for pi-emacs -*- lexical-binding: t; -*-

;;; Code:

(require 'pi-treesit)

(defun pi-outline--node-line (node)
  "Return 1-indexed line number of NODE start."
  (line-number-at-pos (treesit-node-start node)))

(defun pi-outline--node-end-line (node)
  "Return 1-indexed end line of NODE."
  (line-number-at-pos (treesit-node-end node)))

(defun pi-outline--node-column (node)
  "Return 1-indexed column of NODE start."
  (save-excursion
    (goto-char (treesit-node-start node))
    (1+ (current-column))))

(defun pi-outline--node-exported-p (node)
  "Return t if NODE is or is directly wrapped by an export_statement."
  (or (string= (treesit-node-type node) "export_statement")
      (when-let* ((parent (treesit-node-parent node)))
        (string= (treesit-node-type parent) "export_statement"))))

(defun pi-outline--node-signature (node)
  "Return signature string for NODE (header without body), capped at 200 chars.
For nodes with a body, returns everything before the body opener.
For nodes without a body, returns the full node text."
  (let* ((sig (string-trim-right (pi-treesit-stub-body node "")))
         (len (length sig)))
    (if (> len 200) (substring sig 0 200) sig)))

(defun pi-outline--declaration-name-node (node)
  "Return the name treesit node for NODE's declared name, or nil.
Mirrors pi-treesit-declaration-name but returns the node rather than its text."
  (let ((type (treesit-node-type node)))
    (cond
     ((member type '("function_declaration" "class_declaration"
                     "interface_declaration" "type_alias_declaration"
                     "enum_declaration" "abstract_class_declaration"
                     "function_item" "struct_item" "enum_item"
                     "trait_item" "mod_item" "type_item"
                     "const_item" "static_item"
                     "function_definition" "class_definition"
                     "function_declaration" "method_declaration"))
      (treesit-node-child-by-field-name node "name"))
     ;; export_statement: recurse into the wrapped declaration
     ((string= type "export_statement")
      (let ((decl (treesit-node-child-by-field-name node "declaration")))
        (when decl (pi-outline--declaration-name-node decl))))
     ;; lexical_declaration (const/let/var)
     ((string= type "lexical_declaration")
      (let ((declarator (treesit-node-child-by-field-name node "declarator")))
        (when declarator
          (treesit-node-child-by-field-name declarator "name"))))
     ;; impl_item: name is the implementing type, not a "name" field
     ((string= type "impl_item")
      (treesit-node-child-by-field-name node "type"))
     ;; decorated_definition: unwrap to inner definition
     ((string= type "decorated_definition")
      (let ((def (treesit-node-child-by-field-name node "definition")))
        (when def (pi-outline--declaration-name-node def))))
     ;; Go type_declaration: first child is type_spec, which has a "name" field
     ((string= type "type_declaration")
      (let ((spec (treesit-node-child node 0)))
        (when spec (treesit-node-child-by-field-name spec "name"))))
     (t nil))))

(defun pi-outline--class-members (body-node)
  "Extract member outline entries from BODY-NODE (class_body)."
  (let ((members '())
        (child (treesit-node-child body-node 0)))
    (while child
      (let ((type (treesit-node-type child)))
        (when (member type '("method_definition" "public_field_definition"
                             "private_field_definition" "abstract_method_signature"))
          (let ((name-node (treesit-node-child-by-field-name child "name")))
            (when name-node
              (push `((name . ,(treesit-node-text name-node t))
                      (type . ,(if (member type '("public_field_definition"
                                                 "private_field_definition"))
                                   "field" "method"))
                      (line . ,(pi-outline--node-line child))
                      (end_line . ,(pi-outline--node-end-line child))
                      (column . ,(pi-outline--node-column name-node))
                      (signature . ,(pi-outline--node-signature child)))
                    members)))))
      (setq child (treesit-node-next-sibling child)))
    (nreverse members)))

(defun pi-outline--entry (node)
  "Build outline entry alist for NODE, or nil if not a named declaration."
  (let ((name (pi-treesit-declaration-name node))
        (kind (pi-treesit-declaration-kind node))
        (line (pi-outline--node-line node)))
    (when name
      (let* ((end-line (pi-outline--node-end-line node))
             (name-node (pi-outline--declaration-name-node node))
             (column (when name-node (pi-outline--node-column name-node)))
             (exported (pi-outline--node-exported-p node))
             (signature (pi-outline--node-signature node))
             (entry `((name . ,name)
                      (type . ,kind)
                      (line . ,line)
                      (end_line . ,end-line)
                      ,@(when column `((column . ,column)))
                      ,@(when exported `((exported . t)))
                      (signature . ,signature))))
        ;; For classes, recurse into body to get member entries.
        (when (member kind '("class" "interface"))
          (let* ((actual (if (string= (treesit-node-type node) "export_statement")
                             (treesit-node-child-by-field-name node "declaration")
                           node))
                 (body (pi-treesit-find-body actual)))
            (when body
              (let ((members (pi-outline--class-members body)))
                (when members
                  (setq entry (append entry `((children . ,members)))))))))
        entry))))

(defun pi-outline-get (file &optional _depth)
  "Return outline entries for FILE as a list of alists.
Optional DEPTH is currently unused (all nesting returned)."
  (let ((buf (pi-treesit-open-file file)))
    (unwind-protect
        (with-current-buffer buf
          (delq nil
                (mapcar #'pi-outline--entry
                        (pi-treesit-top-level-nodes))))
      (kill-buffer buf))))

(provide 'pi-outline)
;;; pi-outline.el ends here
