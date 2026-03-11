;;; pi-outline.el --- Outline extraction for pi-emacs -*- lexical-binding: t; -*-

;;; Code:

(require 'pi-treesit)

(defun pi-outline--node-line (node)
  "Return 1-indexed line number of NODE start."
  (line-number-at-pos (treesit-node-start node)))

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
                      (line . ,(pi-outline--node-line child)))
                    members)))))
      (setq child (treesit-node-next-sibling child)))
    (nreverse members)))

(defun pi-outline--entry (node)
  "Build outline entry alist for NODE, or nil if not a named declaration."
  (let ((name (pi-treesit-declaration-name node))
        (kind (pi-treesit-declaration-kind node))
        (line (pi-outline--node-line node)))
    (when name
      (let ((entry `((name . ,name) (type . ,kind) (line . ,line))))
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
