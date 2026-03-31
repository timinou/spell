;;; mcp-server-emacs-tools.el --- OMO Org-Mode MCP Tools -*- lexical-binding: t; -*-

;; Based on rhblind/emacs-mcp-server (GPL-3.0)
;; Stripped of default tools (eval-elisp, get-diagnostics)
;; Org-mode tools are registered by org-tasks-mcp.el

;;; Code:

(require 'mcp-server-tools)

(defgroup mcp-server-emacs-tools nil
  "MCP tools configuration for OMO."
  :group 'mcp-server
  :prefix "mcp-server-emacs-tools-")

(defcustom mcp-server-emacs-tools-enabled 'all
  "Which MCP tools to enable.
Can be `all' to enable all available tools, or a list of tool
names (symbols) to enable selectively."
  :type '(choice (const :tag "All tools" all)
                 (repeat :tag "Selected tools" symbol))
  :group 'mcp-server-emacs-tools)

(defconst mcp-server-emacs-tools--available
  '((org-get-items . org-get-items)
    (org-get-item . org-get-item)
    (org-update-state . org-update-state)
    (org-add-todo . org-add-todo)
    (org-edit-body . org-edit-body)
    (org-edit-section . org-edit-section)
    (org-validate . org-validate)
    (org-get-progress . org-get-progress)
    (org-next-ids . org-next-ids)
    (org-dependency-graph . org-dependency-graph)
    (org-next-wave . org-next-wave)
    (org-create-item . org-create-item)
    (org-agenda . org-agenda-tool)
    (org-clock-in . org-clock-tool)
    (org-clock-out . org-clock-tool)
    (org-clock-report . org-clock-report)
    (org-validate-all . org-validate-all)
    ;; Wave 3 tools
    (org-dashboard . org-dashboard)
    (org-velocity-report . org-velocity-report)
    (org-burndown . org-burndown)
    (org-column-view . org-column-view)
    (org-search . org-search)
    (org-get-links . org-links)
    (org-sync-backlinks . org-links)
    (org-get-property . org-property)
    (org-set-property . org-property)
    (org-archive-item . org-archive-tool)
    (org-capture . org-capture-tool)
    ;; org-ql query tool
    (org-ql-query . org-ql-query)
    ;; Loop tools
    (loop-jump-to-linked . loop-navigation)
    (loop-show-dep-graph . loop-navigation)
    (loop-highlight-acceptance . loop-navigation)
    (loop-show-gate-results . loop-navigation))
  "Alist mapping tool names (symbols) to their feature names.")

;; Add vendor/org-ql directory to load-path for org-ql and its dependencies
(let* ((this-file (or load-file-name buffer-file-name))
       (vendor-dir (and this-file
                        (expand-file-name "vendor/org-ql" (file-name-directory this-file)))))
  (when vendor-dir
    (add-to-list 'load-path vendor-dir)))


(let* ((this-file (or load-file-name buffer-file-name))
       (tools-dir (and this-file
                       (expand-file-name "tools" (file-name-directory this-file)))))
  (when tools-dir
    (add-to-list 'load-path tools-dir)))

;; Add parent elisp/ dir to load-path for org-tasks.el
(let* ((this-file (or load-file-name buffer-file-name))
       (elisp-dir (and this-file
                       (file-name-directory (directory-file-name (file-name-directory this-file))))))
  (when elisp-dir
    (add-to-list 'load-path elisp-dir)))

;; Load org-mode MCP tools (each self-registers via mcp-server-register-tool)
(require 'org-get-items)
(require 'org-get-item)
(require 'org-update-state)
;; This vendored copy only ships a subset of upstream tool modules. Load optional
;; modules softly so the unix socket server can boot with the tools that exist.
(require 'org-add-todo nil t)
(require 'org-edit-body)
(require 'org-edit-section)
(require 'org-validate nil t)
(require 'org-get-progress nil t)
(require 'org-next-ids)
(require 'org-dependency-graph)
(require 'org-next-wave)
(require 'org-compute-waves)
(require 'org-create-item)
(require 'org-agenda-tool nil t)
(require 'org-clock-tool nil t)
(require 'org-clock-report nil t)
(require 'org-validate-all)

;; Wave 3 tools
(require 'org-dashboard)
(require 'org-velocity-report nil t)
(require 'org-burndown nil t)
(require 'org-column-view nil t)
(require 'org-search)
(require 'org-links nil t)
(require 'org-property)
(require 'org-archive-tool)
(require 'org-capture-tool nil t)
(ignore-errors (require 'org-ql-query))

;; Loop orchestration tools
(require 'loop-navigation)
(require 'loop-predicates nil t)

(defun mcp-server-emacs-tools--tool-enabled-p (tool-name)
  "Return non-nil if TOOL-NAME is enabled."
  (let ((name-sym (if (stringp tool-name) (intern tool-name) tool-name)))
    (or (eq mcp-server-emacs-tools-enabled 'all)
        (memq name-sym mcp-server-emacs-tools-enabled))))

(setq mcp-server-tools-filter #'mcp-server-emacs-tools--tool-enabled-p)

(provide 'mcp-server-emacs-tools)

;;; mcp-server-emacs-tools.el ends here
