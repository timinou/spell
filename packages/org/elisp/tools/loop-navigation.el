;;; loop-navigation.el --- Loop navigation helpers -*- lexical-binding: t; -*-

(require 'org)
(require 'org-element)

(defun spell-loop-jump-to-linked (target-id)
  "Jump to the first entry with CUSTOM_ID TARGET-ID in the current buffer."
  (let ((line nil))
    (org-map-entries
     (lambda ()
       (when (and (not line) (string= (or (org-entry-get (point) "CUSTOM_ID") "") target-id))
         (setq line (line-number-at-pos))))
     nil 'file)
    line))

(defun spell-loop-show-dep-graph ()
  "Return a simple textual dependency graph for LOOP_CHILDREN in the current buffer."
  (let ((lines '()))
    (org-map-entries
     (lambda ()
       (let ((id (or (org-entry-get (point) "CUSTOM_ID") ""))
             (children (or (org-entry-get (point) "LOOP_CHILDREN") "")))
         (push (format "%s -> %s" id children) lines)))
     nil 'file)
    (mapconcat #'identity (nreverse lines) "\n")))

(defun spell-loop-highlight-acceptance ()
  "Return non-nil when the current buffer contains an Acceptance Criteria section."
  (save-excursion
    (goto-char (point-min))
    (re-search-forward "Acceptance Criteria" nil t)))

(defun spell-loop-show-gate-results ()
  "Return the LAST_GATE_OUTCOME property for the current item."
  (or (org-entry-get (point) "LAST_GATE_OUTCOME") ""))

(provide 'loop-navigation)
;;; loop-navigation.el ends here
