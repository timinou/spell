;;; manifest-predicates.el --- Manifest-specific org-ql predicates -*- lexical-binding: t; -*-

;;; Commentary:

;; org-ql predicates for querying manifest ticket state, blockers,
;; gates, readiness, and effort.

;;; Code:

(require 'org)
(require 'org-element)

(when (fboundp 'org-ql-defpred)
  ;; Match entries by ticket state (ITEM, DOING, DONE, BLOCKED, HOLD)
  (org-ql-defpred ticket-state (state)
    "Match entries whose TODO keyword equals STATE (case-insensitive)."
    :body (let ((current (org-get-todo-state)))
            (and current (string= (upcase current) (upcase state)))))

  ;; Match entries blocked by a specific ticket
  (org-ql-defpred ticket-blocked-by (blocker-id)
    "Match entries whose BLOCKER property contains BLOCKER-ID."
    :body (let ((blockers (org-entry-get (point) "BLOCKER")))
            (and blockers (member blocker-id (split-string blockers)))))

  ;; Match entries that have at least one gate property
  (org-ql-defpred has-gate ()
    "Match entries that have at least one GATE_* property."
    :body (or (org-entry-get (point) "GATE_CMD")
              (org-entry-get (point) "GATE_ARTIFACT")
              (org-entry-get (point) "GATE_LLM")))

  ;; Match entries ready to work on (ITEM state with all blockers DONE)
  (org-ql-defpred ticket-ready ()
    "Match entries in ITEM state whose blockers are all DONE."
    :body (and (string= (org-get-todo-state) "ITEM")
               (let ((blockers-str (org-entry-get (point) "BLOCKER")))
                 (or (not blockers-str)
                     (string-empty-p blockers-str)
                     (let ((blocker-ids (split-string blockers-str))
                           (all-done t))
                       (org-map-entries
                        (lambda ()
                          (let ((id (org-entry-get (point) "CUSTOM_ID"))
                                (state (org-get-todo-state)))
                            (when (and id (member id blocker-ids))
                              (unless (string= state "DONE")
                                (setq all-done nil)))))
                        nil 'file)
                       all-done)))))

  ;; Match entries with specific effort level using comparison operator
  (org-ql-defpred ticket-effort (op value)
    "Match entries whose EFFORT compares to VALUE using OP.
OP is a string like \"<\", \">\", \"<=\", \">=\", \"=\".
VALUE is a duration string like \"2h\" or \"30min\"."
    :body (let ((effort (org-entry-get (point) "EFFORT")))
            (and effort
                 (let ((effort-mins (org-duration-to-minutes effort))
                       (value-mins (org-duration-to-minutes (format "%s" value))))
                   (funcall (intern op) effort-mins value-mins))))))

(provide 'manifest-predicates)
;;; manifest-predicates.el ends here
