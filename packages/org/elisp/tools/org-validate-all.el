;;; org-validate-all.el --- MCP tool: org-validate-all -*- lexical-binding: t; -*-

;;; Commentary:

;; MCP tool that wraps `org-tasks-validate-all' from org-tasks.el.
;; Validates all org files in @tasks/ directory against the schema.

;;; Code:

(require 'mcp-server-tools)
(require 'org-mcp-common)

(defun org-mcp-validate-all-handler (args)
  "Handle org-validate-all tool call with ARGS.
ARGS is an empty alist (no required arguments)."
  (condition-case err
      (let* ((result-json (org-tasks-validate-all))
             (result (json-read-from-string result-json))
             (all-errors (or (cdr (assoc 'errors result)) []))
             (all-warnings (or (cdr (assoc 'warnings result)) []))
             (total-files (cdr (assoc 'total_files result)))
             (files-map (make-hash-table :test 'equal)))
        ;; Collect all unique files from errors and warnings
        (seq-do (lambda (err)
                  (let ((file (cdr (assoc 'file err))))
                    (unless (gethash file files-map)
                      (puthash file `((file . ,file)
                                     (valid . t)
                                     (errors . [])
                                     (warnings . []))
                               files-map))))
                all-errors)
        (seq-do (lambda (warn)
                  (let ((file (cdr (assoc 'file warn))))
                    (unless (gethash file files-map)
                      (puthash file `((file . ,file)
                                     (valid . t)
                                     (errors . [])
                                     (warnings . []))
                               files-map))))
                all-warnings)
        ;; Add all org files to map (even if no errors)
        (dolist (file (org-tasks--all-org-files))
          (unless (gethash file files-map)
            (puthash file `((file . ,file)
                           (valid . t)
                           (errors . [])
                           (warnings . []))
                    files-map)))
        ;; Populate errors for each file
        (seq-do (lambda (err)
                  (let* ((file (cdr (assoc 'file err)))
                         (file-data (gethash file files-map)))
                    (when file-data
                      (setf (cdr (assoc 'valid file-data)) nil)
                      (setf (cdr (assoc 'errors file-data))
                            (vconcat (cdr (assoc 'errors file-data)) (vector err))))))
                all-errors)
        ;; Populate warnings for each file
        (seq-do (lambda (warn)
                  (let* ((file (cdr (assoc 'file warn)))
                         (file-data (gethash file files-map)))
                    (when file-data
                      (setf (cdr (assoc 'warnings file-data))
                            (vconcat (cdr (assoc 'warnings file-data)) (vector warn))))))
                all-warnings)
        ;; Build files array
        (let ((files-array []))
          (maphash (lambda (file file-data)
                     (setq files-array (vconcat files-array (vector file-data))))
                   files-map)
          ;; Count valid/invalid
          (let ((valid-count 0)
                (invalid-count 0)
                (total-errors 0)
                (total-warnings 0))
            (seq-do (lambda (file-data)
                      (if (cdr (assoc 'valid file-data))
                          (cl-incf valid-count)
                        (cl-incf invalid-count))
                      (cl-incf total-errors (length (cdr (assoc 'errors file-data))))
                      (cl-incf total-warnings (length (cdr (assoc 'warnings file-data)))))
                    files-array)
            (json-encode
             `((files . ,files-array)
               (summary . ((total_files . ,total-files)
                           (valid_count . ,valid-count)
                           (invalid_count . ,invalid-count)
                           (total_errors . ,total-errors)
                           (total_warnings . ,total-warnings))))))))
    (error
     (json-encode
      `((error . t)
        (code . "VALIDATE_ALL_ERROR")
        (message . ,(error-message-string err)))))))

(mcp-server-register-tool
 (make-mcp-server-tool
  :name "org-validate-all"
  :title "Validate All Org Files"
  :description "Validate all org task files in @tasks/ directory against the schema. Returns validation results with per-file breakdown and summary statistics."
  :input-schema '((type . "object")
                  (properties
                   . ((directory . ((type . "string")
                                    (description . "Optional @tasks/ directory path (default: auto-detect)")))))
                  (required . []))
  :function #'org-mcp-validate-all-handler))

(provide 'org-validate-all)

;;; org-validate-all.el ends here
