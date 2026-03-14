;;; org-ql-query.el --- MCP tool for org-ql queries -*- lexical-binding: t; -*-
;;
;; Registers the `org-ql-query` MCP tool, which runs org-ql-select over
;; a list of org files and returns matching items as JSON.
;;
;; Custom predicates:
;;   (confidence-above THRESHOLD) — matches entries where the CONFIDENCE
;;   property is a number greater than THRESHOLD.
;;
;;; Code:

(require 'mcp-server-tools)
(require 'org)
(require 'org-element)

;; org-ql is loaded via vendor bootstrap; guard against missing
(require 'load-org-ql nil t)

;; ---------------------------------------------------------------------------
;; Custom predicates
;; ---------------------------------------------------------------------------

(when (fboundp 'org-ql-defpred)
  (org-ql-defpred confidence-above (threshold)
    "Match entries whose CONFIDENCE property is above THRESHOLD (numeric)."
    :body (when-let ((val (org-entry-get (point) "CONFIDENCE")))
            (> (string-to-number val) (string-to-number (format "%s" threshold))))))

;; ---------------------------------------------------------------------------
;; Helpers
;; ---------------------------------------------------------------------------

(defun org-ql-query--entry-to-plist ()
  "Return a plist of fields for the heading at point."
  (let* ((el     (org-element-at-point))
         (title  (org-get-heading t t t t))
         (id     (org-entry-get (point) "CUSTOM_ID"))
         (state  (org-get-todo-state))
         (tags   (org-get-tags nil t))
         (props  (org-entry-properties nil 'standard))
         (body   (save-excursion
                   (org-end-of-meta-data t)
                   (let ((beg (point))
                         (end (save-excursion
                                (outline-next-heading)
                                (point))))
                     (string-trim (buffer-substring-no-properties beg end))))))
    (list :id    (or id "")
          :title (or title "")
          :state (or state "")
          :tags  tags
          :file  (buffer-file-name)
          :line  (org-element-property :begin el)
          :properties (mapcar (lambda (p) (list :key (car p) :value (cdr p))) props)
          :body  body)))

(defun org-ql-query--plist-to-alist (plist)
  "Recursively convert a PLIST to an alist suitable for `json-encode'."
  (let (result)
    (while plist
      (let* ((key   (car plist))
             (val   (cadr plist))
             (kname (substring (symbol-name key) 1)))
        (push (cons kname
                    (cond
                     ((listp val)
                      (if (and val (listp (car val)) (not (listp (caar val))))
                          ;; list of plists
                          (mapcar #'org-ql-query--plist-to-alist val)
                        val))
                     (t val)))
              result))
      (setq plist (cddr plist)))
    (nreverse result)))

;; ---------------------------------------------------------------------------
;; Tool handler
;; ---------------------------------------------------------------------------

(defun org-ql-query--handler (params)
  "Handle an org-ql-query MCP tool call with PARAMS alist."
  (unless (fboundp 'org-ql-select)
    (error "org-ql not available — vendor bootstrap failed"))

  (let* ((files   (alist-get "files"  params nil nil #'string=))
         (query   (alist-get "query"  params nil nil #'string=))
         (sort    (alist-get "sort"   params nil nil #'string=)))

    (unless (and files query)
      (error "org-ql-query requires 'files' and 'query' parameters"))

    (when (stringp files)
      (setq files (list files)))

    (let* ((query-sexp (car (read-from-string query)))
           (sort-sym   (when sort (intern sort)))
           (results
            (org-ql-select
              files
              query-sexp
              :action #'org-ql-query--entry-to-plist
              :sort (when sort-sym (list sort-sym)))))

      (json-encode (mapcar #'org-ql-query--plist-to-alist results)))))

;; ---------------------------------------------------------------------------
;; Tool registration
;; ---------------------------------------------------------------------------

(mcp-server-register-tool
 "org-ql-query"
 "Query org files using org-ql sexp syntax. Returns matching items as JSON."
 '(("files" . "string or array of strings: absolute paths to .org files")
   ("query" . "string: org-ql sexp query, e.g. \"(todo \\\"DOING\\\")\"")
   ("sort"  . "string (optional): sort key, e.g. \"priority\", \"date\", \"todo\""))
 #'org-ql-query--handler)

(provide 'org-ql-query)

;;; org-ql-query.el ends here
