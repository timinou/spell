;;; org-mcp-common.el --- Shared utilities for org MCP tools -*- lexical-binding: t; -*-

;;; Commentary:

;; Common utility functions used by all org-mode MCP tools.

;;; Code:

(require 'org-tasks)

(defun org-mcp--resolve-file (file)
  "Resolve FILE path for org-tasks operations.
If FILE is nil, signal an error (file is required).
If FILE is a relative path, resolve against @tasks directory."
  (unless file
    (error "file argument is required"))
  (if (file-name-absolute-p file)
      file
    (expand-file-name file (org-tasks--directory))))

(provide 'org-mcp-common)

;;; org-mcp-common.el ends here
