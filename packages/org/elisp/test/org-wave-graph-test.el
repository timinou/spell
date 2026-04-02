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

(defun test-owg--file-level-task (title custom-id state &optional props)
  "Build file-level task content string.
PROPS is alist of extra #+KEY: value properties."
  (let ((lines (list (format "#+TITLE: %s" title)
                     (format "#+STATE: %s" state)
                     (format "#+CUSTOM_ID: %s" custom-id))))
    (dolist (prop props)
      (setq lines (append lines (list (format "#+%s: %s" (car prop) (cdr prop))))))
    (concat (mapconcat #'identity lines "\n") "\n")))

;;; File-level frontmatter parsing tests

(ert-deftest file-level/frontmatter-parse ()
  "Parse a file-level item and verify all fields extracted."
  (test-owg--with-temp-tasks
      `(("features/feat-a.org" . ,(test-owg--file-level-task
                                    "My Feature" "FEAT-100-my-feature" "ITEM"
                                    '(("EFFORT" . "2h")
                                      ("PRIORITY" . "#A")
                                      ("LAYER" . "backend")
                                      ("DEPENDS" . "BUG-001 BUG-002")
                                      ("AGENT" . "code")))))
    (let* ((file (expand-file-name "features/feat-a.org" org-tasks-directory))
           (parsed (org-tasks--parse-file-frontmatter file))
           (item (car parsed)))
      (should item)
      (should (equal (cdr (assoc 'custom_id item)) "FEAT-100-my-feature"))
      (should (equal (cdr (assoc 'title item)) "My Feature"))
      (should (equal (cdr (assoc 'state item)) "ITEM"))
      (should (equal (cdr (assoc 'priority item)) "A"))
      (should (equal (cdr (assoc 'effort item)) "2h"))
      (should (equal (cdr (assoc 'layer item)) "backend"))
      (should (equal (cdr (assoc 'depends item)) "BUG-001 BUG-002"))
      (should (equal (cdr (assoc 'agent item)) "code")))))

(ert-deftest file-level/no-custom-id-skipped ()
  "Files without #+CUSTOM_ID produce no items."
  (test-owg--with-temp-tasks
      '(("features/no-id.org" . "#+TITLE: No ID\n#+STATE: ITEM\n"))
    (let* ((file (expand-file-name "features/no-id.org" org-tasks-directory))
           (parsed (org-tasks--parse-file-frontmatter file))
           (item (car parsed)))
      (should-not item))))

(ert-deftest file-level/init-state-recognized ()
  "INIT state items appear correctly from file-level parsing."
  (test-owg--with-temp-tasks
      `(("features/init-feat.org" . ,(test-owg--file-level-task
                                       "Init Feature" "FEAT-200-init" "INIT"
                                       '(("EFFORT" . "1h")))))
    (let* ((items (org-tasks--collect-items-from-file
                   (expand-file-name "features/init-feat.org" org-tasks-directory))))
      (should (= (length items) 1))
      (should (equal (cdr (assoc 'state (car items))) "INIT")))))

(ert-deftest file-level/wave-includes-file-items ()
  "Wave computation includes file-level ITEM items."
  (test-owg--with-temp-tasks
      `(("features/feat-a.org" . ,(test-owg--file-level-task
                                    "Feature A" "FEAT-101" "ITEM"
                                    '(("PRIORITY" . "#B")))))
    (let* ((result (test-owg--decode (org-mcp-next-wave-handler nil)))
           (items (alist-get 'items result)))
      (should (= (length items) 1))
      (should (equal (alist-get 'custom_id (car items)) "FEAT-101"))
      (should (= (alist-get 'total_count result) 1)))))

(ert-deftest file-level/wave-excludes-done ()
  "File-level DONE items excluded from wave."
  (test-owg--with-temp-tasks
      `(("features/done.org" . ,(test-owg--file-level-task
                                  "Done Feature" "FEAT-102" "DONE")))
    (let* ((result (test-owg--decode (org-mcp-next-wave-handler nil)))
           (items (alist-get 'items result)))
      (should (= (length items) 0))
      (should (= (alist-get 'completed_count result) 1)))))

(ert-deftest file-level/depends-creates-edges ()
  "#+DEPENDS on file-level items creates correct edges."
  (test-owg--with-temp-tasks
      `(("bugs/bug-a.org" . ,(test-owg--file-level-task
                               "Bug A" "BUG-010" "DONE"))
        ("features/feat-b.org" . ,(test-owg--file-level-task
                                    "Feature B" "FEAT-110" "ITEM"
                                    '(("DEPENDS" . "BUG-010")))))
    (let* ((result (test-owg--decode (org-mcp-dependency-graph-handler nil)))
           (edges (alist-get 'edges result)))
      (should (= (length edges) 1))
      (should (equal (alist-get 'from (car edges)) "BUG-010"))
      (should (equal (alist-get 'to (car edges)) "FEAT-110")))))

(ert-deftest file-level/wave-respects-depends ()
  "Item with unresolved deps is blocked, not in wave."
  (test-owg--with-temp-tasks
      `(("bugs/bug-a.org" . ,(test-owg--file-level-task
                               "Bug A" "BUG-011" "ITEM"))
        ("features/feat-c.org" . ,(test-owg--file-level-task
                                    "Feature C" "FEAT-111" "ITEM"
                                    '(("DEPENDS" . "BUG-011")))))
    (let* ((result (test-owg--decode (org-mcp-next-wave-handler nil)))
           (items (alist-get 'items result))
           (blocked (alist-get 'blocked_items result)))
      ;; BUG-011 should be in wave (no deps), FEAT-111 should be blocked
      (should (= (length items) 1))
      (should (equal (alist-get 'custom_id (car items)) "BUG-011"))
      (should (= (length blocked) 1))
      (should (equal (alist-get 'custom_id (car blocked)) "FEAT-111")))))

(ert-deftest file-level/graph-nodes-include-file-items ()
  "Dependency graph shows file-level nodes."
  (test-owg--with-temp-tasks
      `(("features/feat-a.org" . ,(test-owg--file-level-task
                                    "Feature A" "FEAT-120" "ITEM"))
        ("features/feat-b.org" . ,(test-owg--file-level-task
                                    "Feature B" "FEAT-121" "DOING")))
    (let* ((result (test-owg--decode (org-mcp-dependency-graph-handler nil)))
           (nodes (alist-get 'nodes result)))
      (should (= (length nodes) 2))
      (should (cl-find "FEAT-120" nodes :key (lambda (n) (alist-get 'custom_id n)) :test #'equal))
      (should (cl-find "FEAT-121" nodes :key (lambda (n) (alist-get 'custom_id n)) :test #'equal)))))

(ert-deftest file-level/mixed-heading-and-file ()
  "File with file-level item + heading-level children (plan pattern)."
  (test-owg--with-temp-tasks
      `(("plans/plan-a.org" . ,(concat
                                 (test-owg--file-level-task
                                  "Plan A" "PLAN-001" "DOING"
                                  '(("EFFORT" . "4h")))
                                 "\n"
                                 (test-owg--task "FEAT-130" "Sub Feature" nil "ITEM"))))
    (let* ((items (org-tasks--collect-items-from-file
                   (expand-file-name "plans/plan-a.org" org-tasks-directory))))
      ;; Should have both file-level and heading-level items
      (should (= (length items) 2))
      (should (cl-find "PLAN-001" items :key (lambda (i) (cdr (assoc 'custom_id i))) :test #'equal))
      (should (cl-find "FEAT-130" items :key (lambda (i) (cdr (assoc 'custom_id i))) :test #'equal)))))

(ert-deftest file-level/priority-sort ()
  "Wave sorts file-level items by priority."
  (test-owg--with-temp-tasks
      `(("features/feat-low.org" . ,(test-owg--file-level-task
                                      "Low Pri" "FEAT-140" "ITEM"
                                      '(("PRIORITY" . "#C"))))
        ("features/feat-high.org" . ,(test-owg--file-level-task
                                       "High Pri" "FEAT-141" "ITEM"
                                       '(("PRIORITY" . "#A")))))
    (let* ((result (test-owg--decode (org-mcp-next-wave-handler nil)))
           (items (alist-get 'items result)))
      (should (= (length items) 2))
      ;; A priority should come first
      (should (equal (alist-get 'custom_id (car items)) "FEAT-141"))
      (should (equal (alist-get 'custom_id (cadr items)) "FEAT-140")))))

(ert-deftest file-level/graph-edges-from-depends ()
  "Graph edges from #+DEPENDS on file-level items."
  (test-owg--with-temp-tasks
      `(("features/base.org" . ,(test-owg--file-level-task
                                  "Base" "FEAT-150" "DONE"))
        ("features/mid.org" . ,(test-owg--file-level-task
                                 "Mid" "FEAT-151" "ITEM"
                                 '(("DEPENDS" . "FEAT-150"))))
        ("features/top.org" . ,(test-owg--file-level-task
                                 "Top" "FEAT-152" "ITEM"
                                 '(("DEPENDS" . "FEAT-151")))))
    (let* ((result (test-owg--decode (org-mcp-dependency-graph-handler nil)))
           (edges (alist-get 'edges result)))
      ;; Should have 2 edges: FEAT-150->FEAT-151, FEAT-151->FEAT-152
      (should (= (length edges) 2))
      (should (cl-find-if (lambda (e) (and (equal (alist-get 'from e) "FEAT-150")
                                            (equal (alist-get 'to e) "FEAT-151")))
                          edges))
      (should (cl-find-if (lambda (e) (and (equal (alist-get 'from e) "FEAT-151")
                                            (equal (alist-get 'to e) "FEAT-152")))
                          edges)))))

;;; Existing heading-level tests

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
