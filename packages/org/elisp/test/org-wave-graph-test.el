;;; org-wave-graph-test.el --- ERT tests for org wave/graph handlers -*- lexical-binding: t; -*-

;;; Commentary:

;; Run with:
;;   cd packages/org && emacs --batch \
;;     -l elisp/org-tasks.el \
;;     -l elisp/mcp-server-tools.el \
;;     -l elisp/tools/org-mcp-common.el \
;;     -l elisp/tools/org-dependency-graph.el \
;;     -l elisp/tools/org-next-wave.el \
;;     -l elisp/tools/org-compute-waves.el \
;;     -l elisp/test/org-wave-graph-test.el \
;;     -f ert-run-tests-batch-and-exit

;;; Code:

(require 'ert)
(require 'json)
(require 'cl-lib)

(defun test-owg--decode (json-str)
  "Decode JSON-STR into Lisp objects."
  (let ((json-object-type 'alist)
        (json-array-type 'list)
        (json-false nil)
        (json-null nil))
    (json-read-from-string json-str)))

(defmacro test-owg--with-temp-tasks (files &rest body)
  "Create temporary org FILES and evaluate BODY.
FILES is an alist of (filename . content) pairs relative to `org-tasks-directory'."
  (declare (indent 1))
  `(let ((test-dir (make-temp-file "org-wave-graph-test-" t)))
     (unwind-protect
         (let ((org-tasks-directory test-dir))
           (dolist (fc ,files)
             (let ((filepath (expand-file-name (car fc) test-dir)))
               (make-directory (file-name-directory filepath) t)
               (with-temp-file filepath
                 (insert (cdr fc)))))
           ,@body)
       (delete-directory test-dir t))))

(defun test-owg--task (id title &optional depends state)
  "Build a task heading for ID and TITLE with optional DEPENDS and STATE."
  (let ((properties (list (format ":CUSTOM_ID: %s" id))))
    (when depends
      (push (format ":DEPENDS: %s" (if (listp depends) (string-join depends " ") depends)) properties))
    (format "* %s %s\n:PROPERTIES:\n%s\n:END:\n\n"
            (or state "ITEM")
            title
            (string-join (nreverse properties) "\n"))))

(defun test-owg--sub-outline (id title &optional depends)
  "Build a sub-outline heading with CUSTOM_ID ID and optional DEPENDS."
  (let ((properties (list (format ":CUSTOM_ID: %s" id))))
    (when depends
      (push (format ":DEPENDS: %s" (if (listp depends) (string-join depends " ") depends)) properties))
    (format "** %s\n:PROPERTIES:\n%s\n:END:\n\n"
            title
            (string-join (nreverse properties) "\n"))))

(ert-deftest org-wave-graph-resolve-files-defaults-to-all-org-files ()
  "No target args should resolve to every org file under @tasks."
  (test-owg--with-temp-tasks
      '(("plans/plan-a.org" . "#+TITLE: A\n")
        ("features/feat-a.org" . "#+TITLE: B\n"))
    (should (equal (org-mcp--resolve-files nil)
                   (sort (list (expand-file-name "features/feat-a.org" org-tasks-directory)
                               (expand-file-name "plans/plan-a.org" org-tasks-directory))
                         #'string<)))))

(ert-deftest org-dependency-graph-no-args-merges-cross-file-edges ()
  "Dependency graph with no args should merge tasks across multiple org files."
  (let ((files `(("plans/foundation.org" . ,(test-owg--task "BUG-001" "Foundation" nil "DONE"))
                 ("features/follow-up.org" . ,(test-owg--task "FEAT-002" "Follow up" "BUG-001" "ITEM")))))
    (test-owg--with-temp-tasks files
      (let* ((result (test-owg--decode (org-mcp-dependency-graph-handler nil)))
             (nodes (alist-get 'nodes result))
             (edges (alist-get 'edges result)))
        (should (= (length nodes) 2))
        (should (= (length edges) 1))
        (should (equal (alist-get 'from (car edges)) "BUG-001"))
        (should (equal (alist-get 'to (car edges)) "FEAT-002"))))))

(ert-deftest org-next-wave-files-arg-scans-multi-file-set ()
  "The `files' arg should compute the next wave across multiple files."
  (let ((files `(("plans/foundation.org" . ,(test-owg--task "BUG-001" "Foundation" nil "DONE"))
                 ("features/follow-up.org" . ,(test-owg--task "FEAT-002" "Follow up" "BUG-001" "ITEM")))))
    (test-owg--with-temp-tasks files
      (let* ((result (test-owg--decode
                      (org-mcp-next-wave-handler
                       `((files . ["plans/foundation.org" "features/follow-up.org"])))))
             (items (alist-get 'items result)))
        (should (= (length items) 1))
        (should (equal (alist-get 'custom_id (car items)) "FEAT-002"))))))

(ert-deftest org-compute-waves-no-args-merges-sub-outlines-across-files ()
  "Wave computation with no args should merge dependent sub-outlines across files."
  (let ((files `(("features/part-a.org" . ,(concat "* ITEM Feature A\n"
                                                    ":PROPERTIES:\n:CUSTOM_ID: FEAT-001\n:END:\n\n"
                                                    (test-owg--sub-outline "FEAT-001::define-types" "Define types")))
                 ("features/part-b.org" . ,(concat "* ITEM Feature B\n"
                                                    ":PROPERTIES:\n:CUSTOM_ID: FEAT-002\n:END:\n\n"
                                                    (test-owg--sub-outline "FEAT-002::wire-parser"
                                                                           "Wire parser"
                                                                           "FEAT-001::define-types"))))))
    (test-owg--with-temp-tasks files
      (let* ((result (test-owg--decode (org-mcp-compute-waves-handler nil)))
             (waves (alist-get 'waves result)))
        (should (= (alist-get 'total_sub_outlines result) 2))
        (should (= (length waves) 2))
        (should (equal (alist-get 'custom_id (car (alist-get 'items (car waves))))
                       "FEAT-001::define-types"))
        (should (equal (alist-get 'custom_id (car (alist-get 'items (cadr waves))))
                       "FEAT-002::wire-parser"))))))

(provide 'org-wave-graph-test)

;;; org-wave-graph-test.el ends here
