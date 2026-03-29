;;; loop-predicates.el --- Loop-specific org-ql predicates -*- lexical-binding: t; -*-

(require 'org)
(require 'org-element)

(defun spell-loop--children-for-id (target-id)
  "Return LOOP_CHILDREN for TARGET-ID in the current buffer."
  (let ((children nil))
    (org-map-entries
     (lambda ()
       (when (string= (or (org-entry-get (point) "CUSTOM_ID") "") target-id)
         (setq children (split-string (or (org-entry-get (point) "LOOP_CHILDREN") "") "," t))))
     nil 'file)
    children))

(defun spell-loop--dependency-chain (target-id)
  "Return transitive LOOP_CHILDREN ids for TARGET-ID in the current buffer."
  (let ((queue (copy-sequence (spell-loop--children-for-id target-id)))
        (seen '())
        (result '()))
    (while queue
      (let ((current (pop queue)))
        (unless (member current seen)
          (push current seen)
          (push current result)
          (setq queue (append queue (copy-sequence (spell-loop--children-for-id current)))))))
    (nreverse result)))

(when (fboundp 'org-ql-defpred)
  (org-ql-defpred loop-status (status)
    "Match entries whose LOOP_STATE property equals STATUS."
    :body (let ((value (org-entry-get (point) "LOOP_STATE")))
            (and value (string= value status))))

  (org-ql-defpred loop-blocked ()
    "Match loop entries blocked in paused or failed states."
    :body (let ((value (org-entry-get (point) "LOOP_STATE")))
            (member value '("paused" "failed" "killed" "cancelled"))))

  (org-ql-defpred acceptance-failed ()
    "Match loop entries whose LAST_GATE_OUTCOME property is fail."
    :body (string= (org-entry-get (point) "LAST_GATE_OUTCOME") "fail"))

  (org-ql-defpred dependency-chain (target-id)
    "Match entries that are in the transitive dependency chain of TARGET-ID."
    :body (let ((current-id (org-entry-get (point) "CUSTOM_ID")))
            (and current-id (member current-id (spell-loop--dependency-chain target-id)))))

  (org-ql-defpred loop-depth (depth)
    "Match loop entries whose DEPTH property equals DEPTH."
    :body (let ((value (org-entry-get (point) "DEPTH")))
            (and value (= (string-to-number value) (string-to-number (format "%s" depth)))))))

(provide 'loop-predicates)
;;; loop-predicates.el ends here
