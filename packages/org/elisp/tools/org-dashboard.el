;;; org-dashboard.el --- MCP tool: org-dashboard -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tool that aggregates progress, clock, blocked items, priority/layer
;; distributions, and recent activity into a single dashboard response.

;;; Code:

(require 'mcp-server-tools)
(require 'org-mcp-common)

(defun org-mcp--recent-state-changes (file max-entries)
  "Extract up to MAX-ENTRIES recent state changes from LOGBOOK drawers in FILE."
  (let ((changes '()))
    (with-temp-buffer
      (insert-file-contents file)
      (goto-char (point-min))
      (while (re-search-forward
              "- State \"\\([A-Z]+\\)\"\\s-+from \"\\([A-Z]+\\)\"\\s-+\\[\\([^]]+\\)\\]"
              nil t)
        (push `((new_state . ,(match-string 1))
                (old_state . ,(match-string 2))
                (timestamp . ,(match-string 3)))
              changes)))
    (seq-take (nreverse changes) max-entries)))

(defun org-mcp-dashboard-handler (args)
  "Handle org-dashboard tool call with ARGS.
ARGS is an alist with optional key: file."
  (condition-case err
      (let* ((file (alist-get 'file args))
             (resolved-files
              (if file
                  (list (org-mcp--resolve-file file))
                (org-tasks--all-org-files))))
        (when (null resolved-files)
          (error "No org files found in @tasks/"))
        (org-mcp--build-dashboard resolved-files))
    (error
     (json-encode
      `((error . t)
        (code . "DASHBOARD_ERROR")
        (message . ,(error-message-string err)))))))

(defun org-mcp--build-dashboard (files)
  "Build aggregated dashboard JSON across FILES."
  (let ((total 0)
        (by-state (make-hash-table :test 'equal))
        (by-priority (make-hash-table :test 'equal))
        (by-layer (make-hash-table :test 'equal))
        (blocked-items '())
        (doing-items '())
        (recent '())
        (clock-estimated 0)
        (clock-actual 0))
    (dolist (kw org-tasks-todo-keywords)
      (puthash kw 0 by-state))
    (dolist (file files)
      (when (file-exists-p file)
        (with-temp-buffer
          (insert-file-contents file)
          (let ((buffer-file-name file))
            (org-mode)
            (org-tasks--setup-keywords)
            (let ((ast (org-element-parse-buffer)))
              (org-element-map ast 'headline
                (lambda (hl)
                  (when-let ((todo (org-element-property :todo-keyword hl)))
                    (when (member todo org-tasks-todo-keywords)
                      (cl-incf total)
                      (puthash todo (1+ (gethash todo by-state 0)) by-state)
                      (let* ((custom-id (or (org-tasks--extract-property hl "CUSTOM_ID") ""))
                             (title (org-element-property :raw-value hl))
                             (pri-val (org-element-property :priority hl))
                             (pri (if pri-val (char-to-string pri-val) "none"))
                             (layer (or (org-tasks--extract-property hl "LAYER") "unset"))
                             (effort-str (org-tasks--extract-property hl "EFFORT"))
                             (effort-mins (org-mcp--effort-to-minutes effort-str))
                             (actual-mins (org-mcp--sum-clock-minutes hl)))
                        (puthash pri (1+ (gethash pri by-priority 0)) by-priority)
                        (puthash layer (1+ (gethash layer by-layer 0)) by-layer)
                        (when effort-mins (cl-incf clock-estimated effort-mins))
                        (cl-incf clock-actual actual-mins)
                        (when (string= todo "BLOCKED")
                          (push `((custom_id . ,custom-id) (title . ,title)) blocked-items))
                        (when (string= todo "DOING")
                          (push `((custom_id . ,custom-id) (title . ,title)) doing-items))))))))))
        (setq recent (append recent (org-mcp--recent-state-changes file 5)))))
    (let* ((completed (gethash "DONE" by-state 0))
           (percentage (if (> total 0)
                          (round (* 100.0 (/ (float completed) total)))
                        0))
           (state-alist '())
           (pri-alist '())
           (layer-alist '()))
      (maphash (lambda (k v) (push (cons (intern k) v) state-alist)) by-state)
      (maphash (lambda (k v) (push (cons (intern k) v) pri-alist)) by-priority)
      (maphash (lambda (k v) (push (cons (intern k) v) layer-alist)) by-layer)
      (json-encode
       `((progress . ((total . ,total)
                      (completed . ,completed)
                      (percentage . ,percentage)
                      (by_state . ,state-alist)))
         (clock . ((estimated_minutes . ,clock-estimated)
                   (actual_minutes . ,clock-actual)))
         (blocked . ,(vconcat (nreverse blocked-items)))
         (doing . ,(vconcat (nreverse doing-items)))
         (by_priority . ,pri-alist)
         (by_layer . ,layer-alist)
         (recent_activity . ,(vconcat (seq-take recent 5))))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-dashboard"
  :title "Project Dashboard"
  :description "Aggregated project dashboard: progress counts, clock totals, blocked/doing items, priority and layer distributions, recent state changes. Omit file to aggregate across all @tasks/ org files."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string")
                               (description . "Path to org file (optional, omit for all files)")))))
                  (required . []))
  :function #'org-mcp-dashboard-handler))

(provide 'org-dashboard)

;;; org-dashboard.el ends here
