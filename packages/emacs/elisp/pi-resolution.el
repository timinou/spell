;;; pi-resolution.el --- Resolution-aware code reading for pi-emacs -*- lexical-binding: t; -*-

;;; Code:

(require 'pi-treesit)

;; ---------------------------------------------------------------------------
;; Resolution 0 — names only
;; ---------------------------------------------------------------------------

(defun pi-resolution-names (nodes)
  "Return a list of declaration name strings from NODES."
  (delq nil
        (mapcar (lambda (n)
                  (let ((name (pi-treesit-declaration-name n))
                        (kind (pi-treesit-declaration-kind n)))
                    (when name (format "%s %s" kind name))))
                nodes)))

;; ---------------------------------------------------------------------------
;; Resolution 1 — signatures (bodies stubbed)
;; ---------------------------------------------------------------------------

(defun pi-resolution-signature (node)
  "Return signature of NODE with body replaced by { ... }."
  (pi-treesit-stub-body node "{ ... }"))

;; ---------------------------------------------------------------------------
;; Resolution 2 — structure (class members visible, method bodies stubbed)
;; ---------------------------------------------------------------------------

(defun pi-resolution-structure-node (node indent)
  "Return structured text for NODE at INDENT level."
  (let ((type (treesit-node-type node))
        (inner-type
         (let ((d (treesit-node-child-by-field-name node "declaration")))
           (when d (treesit-node-type d)))))
    (cond
     ;; Class: show class header + members (methods stubbed, fields shown)
     ((or (member type '("class_declaration" "abstract_class_declaration"))
          (string= inner-type "class_declaration")
          (string= inner-type "abstract_class_declaration"))
      (let ((actual (if (string= type "export_statement")
                        (treesit-node-child-by-field-name node "declaration")
                      node)))
        (pi-resolution--expand-class actual indent)))
     ;; Everything else: stub bodies
     (t (pi-resolution-signature node)))))

(defun pi-resolution--expand-class (class-node indent)
  "Expand CLASS-NODE showing members at INDENT."
  (let* ((body (pi-treesit-find-body class-node))
         (prefix (make-string indent ? ))
         (header (if body
                     (buffer-substring-no-properties
                      (treesit-node-start class-node)
                      (treesit-node-start body))
                   (treesit-node-text class-node t)))
         (members '()))
    (when body
      (let ((child (treesit-node-child body 0)))
        (while child
          (let ((child-type (treesit-node-type child)))
            (unless (member child-type '("{" "}"))
              (push
               (concat "  "
                       (if (member child-type
                                   '("method_definition" "public_field_definition"
                                     "private_field_definition"))
                           (pi-treesit-stub-body child "{ ... }")
                         (treesit-node-text child t)))
               members)))
          (setq child (treesit-node-next-sibling child)))))
    (concat header
            "{\n"
            (mapconcat #'identity (nreverse members) "\n")
            "\n" prefix "}")))

;; ---------------------------------------------------------------------------
;; Resolution 3 — full source (with optional offset/limit)
;; ---------------------------------------------------------------------------

(defun pi-resolution-full (&optional offset limit)
  "Return full buffer content, optionally restricted to OFFSET..LIMIT lines."
  (if (and offset limit)
      (let ((lines (split-string (buffer-string) "\n")))
        (mapconcat #'identity
                   (seq-subseq lines (1- offset) (min (length lines) (+ (1- offset) limit)))
                   "\n"))
    (if offset
        (let ((lines (split-string (buffer-string) "\n")))
          (mapconcat #'identity (seq-subseq lines (1- offset)) "\n"))
      (buffer-string))))

;; ---------------------------------------------------------------------------
;; Public API
;; ---------------------------------------------------------------------------

(defun pi-resolution-read (file resolution &optional offset limit)
  "Read FILE at RESOLUTION (0-3). OFFSET and LIMIT apply to resolution 3."
  (let ((buf (pi-treesit-open-file file)))
    (unwind-protect
        (with-current-buffer buf
          (pcase resolution
            (0 (mapconcat #'identity
                          (pi-resolution-names (pi-treesit-top-level-nodes))
                          "\n"))
            (1 (mapconcat #'pi-resolution-signature
                          (pi-treesit-top-level-nodes)
                          "\n\n"))
            (2 (mapconcat (lambda (n) (pi-resolution-structure-node n 0))
                          (pi-treesit-top-level-nodes)
                          "\n\n"))
            (3 (pi-resolution-full offset limit))
            (_ (error "Invalid resolution %s; must be 0-3" resolution))))
      (kill-buffer buf))))

(provide 'pi-resolution)
;;; pi-resolution.el ends here
