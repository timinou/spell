;;; org-mcp-common.el --- Shared utilities for org MCP tools -*- lexical-binding: t; -*-

;;; Commentary:

;; Common utility functions used by all org-mode MCP tools.

;;; Code:

(require 'cl-lib)
(require 'org-tasks)

(defun org-mcp--arg (args key)
  "Read KEY from ARGS supporting both symbol and JSON string keys."
  (or (alist-get key args)
      (alist-get (symbol-name key) args nil nil #'string=)))

(defun org-mcp--resolve-file (file)
  "Resolve FILE path for org-tasks operations.
If FILE is a relative path, resolve against @tasks directory."
  (if (file-name-absolute-p file)
      file
    (expand-file-name file (org-tasks--directory))))

(defun org-mcp--expand-target-file (target)
  "Expand TARGET into a list of org files.
TARGET may be a file path or a category directory path."
  (let ((resolved (org-mcp--resolve-file target)))
    (cond
     ((file-directory-p resolved)
      (directory-files-recursively resolved "\\.org$"))
     ((file-exists-p resolved)
      (list resolved))
     (t
      (error "File not found: %s" resolved)))))

(defun org-mcp--resolve-files (args)
  "Resolve target org files from ARGS.
Supports `file', `files', or no target args (all @tasks org files)."
  (let* ((file (org-mcp--arg args 'file))
         (files (org-mcp--arg args 'files))
         (targets (cond
                   (file (list file))
                   ((vectorp files) (append files nil))
                   ((and files (listp files)) files)
                   (t (org-tasks--all-org-files)))))
    (sort
     (cl-remove-duplicates
      (cl-loop for target in targets append (org-mcp--expand-target-file target))
      :test #'string=)
     #'string<)))

(provide 'org-mcp-common)

;;; org-mcp-common.el ends here
