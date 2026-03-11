;;; org-update-state.el --- MCP tool: org-update-state -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tool that wraps `org-tasks-update-state' from org-tasks.el.
;; Transitions an item's TODO state with validation of allowed transitions.
;; Automatically clocks in when transitioning TO DOING,
;; and clocks out when transitioning FROM DOING to DONE/BLOCKED.
;;; Code:

(require 'mcp-server-tools)
(require 'org-mcp-common)
(require 'org-clock)

(defun org-mcp--peek-state (file custom-id)
  "Peek at the current TODO state of CUSTOM-ID in FILE without modifying."
  (with-current-buffer (find-file-noselect file)
    (org-mode)
    (goto-char (point-min))
    (let ((pos (org-find-property "CUSTOM_ID" custom-id)))
      (when pos
        (goto-char pos)
        (org-get-todo-state)))))

(defun org-mcp--do-clock-in (file custom-id)
  "Clock in on CUSTOM-ID in FILE. Returns clock-info alist or nil."
  (condition-case nil
      (with-current-buffer (find-file-noselect file)
        (goto-char (point-min))
        (let ((pos (org-find-property "CUSTOM_ID" custom-id)))
          (when pos
            (goto-char pos)
            (org-clock-in)
            (save-buffer)
            `((auto_clock . "in")
              (clock_start . ,(format-time-string "%Y-%m-%dT%H:%M:%S%z"))))))
    (error nil)))

(defun org-mcp-update-state-handler (args)
  "Handle org-update-state tool call with ARGS.
ARGS is an alist with keys: file, custom_id, new_state.
Automatically clocks in/out on DOING transitions."
  (condition-case err
      (let* ((file (alist-get 'file args))
             (custom-id (alist-get 'custom_id args))
             (new-state (alist-get 'new_state args))
             (resolved-file (org-mcp--resolve-file file)))
        (unless custom-id
          (error "custom_id argument is required"))
        (unless new-state
          (error "new_state argument is required"))
        (unless (file-exists-p resolved-file)
          (error "File not found: %s" resolved-file))
        ;; Capture pre-transition clock state for DOING->X transitions
        (let* ((had-active-clock (and org-clock-marker
                                      (marker-buffer org-clock-marker)))
               (pre-clock-start (when (and had-active-clock org-clock-start-time)
                                  (format-time-string "%Y-%m-%dT%H:%M:%S%z"
                                                      org-clock-start-time)))
               ;; Peek at old state before transition
               (old-state-peek (org-mcp--peek-state resolved-file custom-id))
               ;; Perform the state transition (may auto-clock-out via org-todo)
               (result-json (org-tasks-update-state resolved-file custom-id new-state))
               (result (json-read-from-string result-json)))
          (if (not (cdr (assoc 'success result)))
              result-json
            ;; Handle auto-clock based on transition direction
            (cond
             ;; Transitioning TO DOING -> clock in
             ((and (equal new-state "DOING")
                   (not (equal old-state-peek "DOING")))
              (let ((clock-info (org-mcp--do-clock-in resolved-file custom-id)))
                (if clock-info
                    (json-encode (append result clock-info))
                  result-json)))
             ;; Transitioning FROM DOING to DONE/BLOCKED -> report clock-out
             ((and (equal old-state-peek "DOING")
                   (member new-state '("DONE" "BLOCKED")))
              (json-encode
               (append result
                       `((auto_clock . "out")
                         (clock_start . ,(or pre-clock-start ""))
                         (clock_end . ,(format-time-string "%Y-%m-%dT%H:%M:%S%z"))))))
             (t result-json)))))
    (error
     (let ((msg (error-message-string err)))
       (json-encode
        `((error . t)
          (code . ,(cond
                    ((string-match-p "not found" msg) "ITEM_NOT_FOUND")
                    ((string-match-p "Invalid transition" msg) "INVALID_TRANSITION")
                    ((string-match-p "Invalid state" msg) "INVALID_STATE")
                    (t "UPDATE_STATE_ERROR")))
          (message . ,msg)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-update-state"
  :title "Update Item State"
  :description "Transition a task item's TODO state. Valid transitions: ITEM->DOING/BLOCKED/DONE, DOING->REVIEW/DONE/BLOCKED/ITEM, REVIEW->DONE/DOING/BLOCKED, BLOCKED->ITEM/DOING, DONE->ITEM. Returns old and new state on success."
  :input-schema '((type . "object")
                  (properties
                   . ((file . ((type . "string")
                               (description . "Path to org file (absolute or relative to @tasks/)")))
                      (custom_id . ((type . "string")
                                    (description . "The CUSTOM_ID of the item to update")))
                      (new_state . ((type . "string")
                                    (description . "Target TODO state (ITEM, DOING, REVIEW, DONE, BLOCKED)")))))
                  (required . ["file" "custom_id" "new_state"]))
  :function #'org-mcp-update-state-handler))

(provide 'org-update-state)

;;; org-update-state.el ends here
