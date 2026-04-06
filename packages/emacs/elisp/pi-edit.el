;;; pi-edit.el --- Structural code editing for pi-emacs -*- lexical-binding: t; -*-

;;; Code:

(require 'pi-treesit)
(require 'pi-buffer)

(defun pi-edit--find-node-at-target (file line node-type)
  "Find node of NODE-TYPE at LINE in FILE buffer.
Returns the node or nil."
  (let ((buf (pi-buffer-open file)))
    (with-current-buffer buf
      (save-excursion
        (goto-char (point-min))
        (forward-line (1- line))
        (let ((pos (point))
              (root (treesit-buffer-root-node)))
          (when root
            (treesit-search-subtree
             root
             (lambda (n)
               (and
                (or (null node-type) (string= (treesit-node-type n) node-type))
                (<= (treesit-node-start n) (1+ pos))
                (>= (treesit-node-end n) (1+ pos))))
             nil nil 10)))))))

(defun pi-edit--replace-node (buf node content)
  "In BUF, replace NODE text with CONTENT."
  (with-current-buffer buf
    (goto-char (treesit-node-start node))
    (delete-region (treesit-node-start node) (treesit-node-end node))
    (insert content)))

(defun pi-edit-execute (file operation target content envelope save)
  "Execute a structural edit on FILE.
OPERATION is a string (replace, insert-before, insert-after, kill, etc.).
TARGET is an alist with 'line and optional 'node_type.
CONTENT is replacement text. ENVELOPE is template name.
SAVE non-nil means save after edit."
  (let* ((line (alist-get 'line target))
         (node-type (alist-get 'node_type target))
         (buf (pi-buffer-open file)))
    (condition-case err
        (let ((node (pi-edit--find-node-at-target file line node-type)))
          (unless node
            (error "No node found at line %d with type %s" line (or node-type "any")))
          (pcase operation
            ("replace"
             (pi-edit--replace-node buf node content)
             (when save (pi-buffer-save file))
             `((success . t)))
            ("insert-before"
             (with-current-buffer buf
               (goto-char (treesit-node-start node))
               (insert content "\n"))
             (when save (pi-buffer-save file))
             `((success . t)))
            ("insert-after"
             (with-current-buffer buf
               (goto-char (treesit-node-end node))
               (insert "\n" content))
             (when save (pi-buffer-save file))
             `((success . t)))
            ("kill"
             (with-current-buffer buf
               (delete-region (treesit-node-start node) (treesit-node-end node)))
             (when save (pi-buffer-save file))
             `((success . t)))
            ;; Combobulate-backed operations
            ((or "splice" "splice-self" "splice-down" "drag-up" "drag-down" "clone" "envelope" "transpose")
             (if (and (boundp 'pi-emacs-combobulate-available)
                      pi-emacs-combobulate-available)
                 (pi-edit--combobulate-op buf node operation content envelope save)
               (error "Operation %s requires combobulate (not available)" operation)))
            (_ (error "Unknown operation: %s" operation))))
      (error
       `((success . :false)
         (error . ,(error-message-string err)))))))

(defun pi-edit--combobulate-op (buf node operation content envelope save)
  "Perform a combobulate OPERATION on NODE in BUF."
  (with-current-buffer buf
    ;; Activate combobulate mode if not already active.
    (unless (bound-and-true-p combobulate-mode)
      (combobulate-mode 1))
    (goto-char (treesit-node-start node))
    (pcase operation
      ("splice" (combobulate-splice-up))
      ("drag-up" (combobulate-drag-up))
      ("drag-down" (combobulate-drag-down))
      ("clone" (combobulate-clone-node-dwim))
      ("envelope"
       (when envelope
         (combobulate-envelope-wrap-dwim)))
      ("splice-self" (combobulate-splice-self))
      ("splice-down" (combobulate-splice-down))
      ("transpose" (combobulate-transpose-sexps)))
    (when save (pi-buffer-save (buffer-file-name buf)))
    `((success . t))))

(defun pi-navigate-execute (file action line column)
  "Execute a navigation ACTION on FILE at LINE/COLUMN."
  (let ((buf (pi-treesit-open-file file)))
    (unwind-protect
        (with-current-buffer buf
          (when line
            (goto-char (point-min))
            (forward-line (1- line))
            (when column (forward-char (1- column))))
          (pcase action
            ("defun-at"
             (let ((node (treesit-defun-at-point)))
               (if node
                   `((name . ,(or (pi-treesit-declaration-name node) "anonymous"))
                     (type . ,(pi-treesit-declaration-kind node))
                     (line . ,(line-number-at-pos (treesit-node-start node)))
                     (end-line . ,(line-number-at-pos (treesit-node-end node))))
                 `((error . t) (message . "No enclosing function found")))))
            ("parent"
             (let* ((pos (point))
                    (node (treesit-node-at pos))
                    (parent (when node (treesit-node-parent node))))
               (if parent
                   `((type . ,(treesit-node-type parent))
                     (line . ,(line-number-at-pos (treesit-node-start parent))))
                 `((error . t) (message . "No parent node")))))
            ("references-local"
             ;; Simple treesit-based local reference search (no LSP)
             (let* ((pos (point))
                    (node (treesit-node-at pos))
                    (name (when node (treesit-node-text node t)))
                    (root (treesit-buffer-root-node))
                    (refs '()))
               (when (and name root)
                 (treesit-search-subtree
                  root
                  (lambda (n)
                    (when (string= (treesit-node-text n t) name)
                      (push (line-number-at-pos (treesit-node-start n)) refs))
                    nil)
                  nil t 100))
               `((name . ,name) (references . ,(vconcat (nreverse refs))))))
            ("node-at"
             (let* ((pos (point))
                    (node (treesit-node-at pos))
                    (parent (when node (treesit-node-parent node)))
                    (text (when node
                            (let ((full (treesit-node-text node t)))
                              (car (split-string full "\n"))))))
               (if node
                   `((type . ,(treesit-node-type node))
                     (text . ,(if (> (length text) 80) (substring text 0 80) text))
                     (line . ,(line-number-at-pos (treesit-node-start node)))
                     (end_line . ,(line-number-at-pos (treesit-node-end node)))
                     ,@(when parent
                         `((parent . ((type . ,(treesit-node-type parent))
                                      (line . ,(line-number-at-pos (treesit-node-start parent))))))))
                 `((error . t) (message . "No node at position")))))
            ("siblings"
             (let* ((pos (point))
                    (node (treesit-node-at pos))
                    ;; Walk up past leaf/punctuation to nearest named node
                    (named (when node
                             (if (treesit-node-check node 'named)
                                 node
                               (treesit-node-parent node))))
                    (parent (when named (treesit-node-parent named)))
                    (children (when parent
                                (let ((kids '())
                                      (count (treesit-node-child-count parent t)))
                                  (dotimes (i count)
                                    (let ((child (treesit-node-child parent i t)))
                                      (push child kids)))
                                  (nreverse kids))))
                    (current-idx nil)
                    (sibling-list '()))
               (if (not children)
                   `((error . t) (message . "No siblings found"))
                 (let ((idx 0))
                   (dolist (child children)
                     (let ((entry `((type . ,(treesit-node-type child))
                                    (name . ,(or (pi-treesit-declaration-name child) ""))
                                    (line . ,(line-number-at-pos (treesit-node-start child)))
                                    (end_line . ,(line-number-at-pos (treesit-node-end child))))))
                       (when (and named (eq child named))
                         (setq current-idx idx)
                         (setq entry (append entry '((current . t)))))
                       (push entry sibling-list)
                       (setq idx (1+ idx)))))
                 `((current_index . ,(or current-idx -1))
                   (siblings . ,(vconcat (nreverse sibling-list)))))))
            ("children"
             (let* ((pos (point))
                    (node (treesit-node-at pos))
                    ;; Walk up to a node that has a body
                    (structural (when node
                                  (let ((n node))
                                    (while (and n (not (pi-treesit-find-body n)))
                                      (setq n (treesit-node-parent n)))
                                    n)))
                    (body (when structural (pi-treesit-find-body structural)))
                    (child-list '()))
               (if (not body)
                   `((error . t) (message . "Node has no children"))
                 (let ((count (treesit-node-child-count body t)))
                   (dotimes (i count)
                     (let ((child (treesit-node-child body i t)))
                       (push `((type . ,(treesit-node-type child))
                               (name . ,(or (pi-treesit-declaration-name child) ""))
                               (line . ,(line-number-at-pos (treesit-node-start child)))
                               (end_line . ,(line-number-at-pos (treesit-node-end child))))
                             child-list))))
                 `((parent_type . ,(treesit-node-type structural))
                   (parent_name . ,(or (pi-treesit-declaration-name structural) ""))
                   (children . ,(vconcat (nreverse child-list)))))))
            (_ `((error . t) (message . ,(format "Unknown action: %s" action))))))
      (kill-buffer buf))))

(provide 'pi-edit)
;;; pi-edit.el ends here
