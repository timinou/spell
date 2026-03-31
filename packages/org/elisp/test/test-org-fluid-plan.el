;;; test-org-fluid-plan.el --- ERT tests for org-fluid-plan -*- lexical-binding: t; -*-

;;; Commentary:

;; Tests for the org-fluid-plan MCP tool: union-find, cycle detection,
;; connected components, wave computation, and full FluidPlan generation.
;;
;; Run with:
;;   cd packages/org && emacs --batch \
;;     -l elisp/org-tasks.el \
;;     -l elisp/mcp-server-tools.el \
;;     -l elisp/tools/org-mcp-common.el \
;;     -l elisp/tools/org-fluid-plan.el \
;;     -l elisp/test/test-org-fluid-plan.el \
;;     -f ert-run-tests-batch-and-exit

;;; Code:

(require 'ert)
(require 'json)
(require 'cl-lib)

;; ---------------------------------------------------------------------------
;; Helpers
;; ---------------------------------------------------------------------------

(defun test-fp--decode (json-str)
  "Decode JSON-STR to Lisp."
  (let ((json-object-type 'alist)
        (json-array-type 'list)
        (json-false nil)
        (json-null nil))
    (json-read-from-string json-str)))

(defun test-fp--make-org-item (id title &optional depends state effort priority)
  "Generate an org heading string for item ID with TITLE."
  (let ((state-kw (or state "ITEM"))
        (props (list (format ":CUSTOM_ID: %s" id))))
    (when depends
      (push (format ":DEPENDS: %s" (if (listp depends)
                                        (string-join depends " ")
                                      depends))
            props))
    (when effort
      (push (format ":EFFORT: %s" effort) props))
    (when priority
      (push (format ":PRIORITY: %s" priority) props))
    (format "* %s %s\n:PROPERTIES:\n%s\n:END:\n\n"
            state-kw title (string-join (nreverse props) "\n"))))

(defun test-fp--make-plan (plan-id title child-ids &optional body-extra)
  "Generate a PLAN org heading linking to CHILD-IDS."
  (let ((links (mapconcat (lambda (id) (format "- [[id:%s]]" id)) child-ids "\n")))
    (format "* DOING %s\n:PROPERTIES:\n:CUSTOM_ID: %s\n:END:\n\n%s\n%s\n"
            title plan-id links (or body-extra ""))))

(defmacro test-fp--with-temp-tasks (files &rest body)
  "Create temporary org files from FILES alist and evaluate BODY.
FILES is a list of (filename . content) pairs.
Binds `test-dir' to the temp directory."
  (declare (indent 1))
  `(let ((test-dir (make-temp-file "org-fluid-plan-test-" t)))
     (unwind-protect
         (progn
           (let ((org-tasks-directory test-dir))
             (dolist (fc ,files)
               (let ((filepath (expand-file-name (car fc) test-dir)))
                 (with-temp-file filepath
                   (insert (cdr fc)))))
             ,@body))
       (delete-directory test-dir t))))

;; ---------------------------------------------------------------------------
;; Unit tests: Union-Find
;; ---------------------------------------------------------------------------

(ert-deftest test-fp-union-find-basic ()
  "Union-find: basic find/union operations."
  (let ((uf (org-fluid-plan--make-union-find '("a" "b" "c" "d"))))
    ;; Initially each element is its own root
    (should (equal (org-fluid-plan--find uf "a") "a"))
    (should (equal (org-fluid-plan--find uf "b") "b"))
    ;; Union a and b
    (org-fluid-plan--union uf "a" "b")
    (should (equal (org-fluid-plan--find uf "a")
                   (org-fluid-plan--find uf "b")))
    ;; c and d still separate
    (should-not (equal (org-fluid-plan--find uf "a")
                       (org-fluid-plan--find uf "c")))
    ;; Union c with a's group
    (org-fluid-plan--union uf "a" "c")
    (should (equal (org-fluid-plan--find uf "b")
                   (org-fluid-plan--find uf "c")))))

;; ---------------------------------------------------------------------------
;; Unit tests: Cycle detection
;; ---------------------------------------------------------------------------

(ert-deftest test-fp-cycle-detection-acyclic ()
  "Cycle detection: no cycle in linear DAG."
  (let ((adj (make-hash-table :test 'equal)))
    (puthash "a" '("b") adj)
    (puthash "b" '("c") adj)
    (puthash "c" '() adj)
    (should (null (org-fluid-plan--detect-cycle adj '("a" "b" "c"))))))

(ert-deftest test-fp-cycle-detection-cyclic ()
  "Cycle detection: detects A->B->C->A cycle."
  (let ((adj (make-hash-table :test 'equal)))
    (puthash "a" '("b") adj)
    (puthash "b" '("c") adj)
    (puthash "c" '("a") adj)
    (should (org-fluid-plan--detect-cycle adj '("a" "b" "c")))))

;; ---------------------------------------------------------------------------
;; Unit tests: Wave computation
;; ---------------------------------------------------------------------------

(ert-deftest test-fp-wave-computation-linear ()
  "Waves: linear chain A->B->C gives 3 waves."
  (let ((adj (make-hash-table :test 'equal)))
    ;; adj-forward: a has B as successor, B has C as successor
    (puthash "a" '("b") adj)
    (puthash "b" '("c") adj)
    (puthash "c" '() adj)
    (let ((waves (org-fluid-plan--compute-waves '("a" "b" "c") adj)))
      (should (= (length waves) 3))
      (should (equal (cdr (assoc 'items (nth 0 waves))) ["a"]))
      (should (equal (cdr (assoc 'items (nth 1 waves))) ["b"]))
      (should (equal (cdr (assoc 'items (nth 2 waves))) ["c"])))))

(ert-deftest test-fp-wave-computation-diamond ()
  "Waves: diamond A->{B,C}->D gives 3 waves with B+C parallel."
  (let ((adj (make-hash-table :test 'equal)))
    (puthash "a" '("b" "c") adj)
    (puthash "b" '("d") adj)
    (puthash "c" '("d") adj)
    (puthash "d" '() adj)
    (let ((waves (org-fluid-plan--compute-waves '("a" "b" "c" "d") adj)))
      (should (= (length waves) 3))
      (should (equal (cdr (assoc 'items (nth 0 waves))) ["a"]))
      ;; Wave 2: b and c in parallel (sorted alphabetically)
      (should (equal (cdr (assoc 'items (nth 1 waves))) ["b" "c"]))
      (should (equal (cdr (assoc 'items (nth 2 waves))) ["d"])))))

(ert-deftest test-fp-wave-computation-all-roots ()
  "Waves: all leaf items (no deps) go in wave 1."
  (let ((adj (make-hash-table :test 'equal)))
    (puthash "a" '() adj)
    (puthash "b" '() adj)
    (puthash "c" '() adj)
    (let ((waves (org-fluid-plan--compute-waves '("a" "b" "c") adj)))
      (should (= (length waves) 1))
      (should (equal (cdr (assoc 'items (nth 0 waves))) ["a" "b" "c"])))))

;; ---------------------------------------------------------------------------
;; Integration tests: Full FluidPlan generation
;; ---------------------------------------------------------------------------

(ert-deftest test-fp-single-connected-dag ()
  "Single connected DAG: A->B->C produces one component."
  (let* ((items (concat
                 (test-fp--make-org-item "item-a" "Task A" nil "ITEM" "2h" "#A")
                 (test-fp--make-org-item "item-b" "Task B" '("item-a") "ITEM" "3h" "#B")
                 (test-fp--make-org-item "item-c" "Task C" '("item-b") "ITEM" "1h")))
         (plan (test-fp--make-plan "test-plan-1" "Test Plan" '("item-a" "item-b" "item-c")))
         (files `(("plan.org" . ,plan) ("items.org" . ,items))))
    (test-fp--with-temp-tasks files
      (let* ((result (org-fluid-plan--build-fluid-plan
                      (org-tasks--all-org-files) "test-plan-1"))
             (components (cdr (assoc 'components result)))
             (warnings (cdr (assoc 'warnings result))))
        ;; One component
        (should (= (length components) 1))
        ;; 3 agents in the component
        (let ((agents (cdr (assoc 'agents (aref components 0)))))
          (should (= (length agents) 3)))
        ;; 3 waves
        (let ((waves (cdr (assoc 'waves (aref components 0)))))
          (should (= (length waves) 3)))
        ;; No warnings
        (should (= (length warnings) 0))))))

(ert-deftest test-fp-two-disconnected-components ()
  "Two disconnected components: {A->B} and {C->D}."
  (let* ((items (concat
                 (test-fp--make-org-item "item-a" "Task A")
                 (test-fp--make-org-item "item-b" "Task B" '("item-a"))
                 (test-fp--make-org-item "item-c" "Task C")
                 (test-fp--make-org-item "item-d" "Task D" '("item-c"))))
         (plan (test-fp--make-plan "test-plan-2" "Test Plan"
                                  '("item-a" "item-b" "item-c" "item-d")))
         (files `(("plan.org" . ,plan) ("items.org" . ,items))))
    (test-fp--with-temp-tasks files
      (let* ((result (org-fluid-plan--build-fluid-plan
                      (org-tasks--all-org-files) "test-plan-2"))
             (components (cdr (assoc 'components result))))
        ;; Two components
        (should (= (length components) 2))
        ;; Each component has 2 agents
        (should (= (length (cdr (assoc 'agents (aref components 0)))) 2))
        (should (= (length (cdr (assoc 'agents (aref components 1)))) 2))))))

(ert-deftest test-fp-diamond-dependency ()
  "Diamond: A->{B,C}->D in one component with correct waves."
  (let* ((items (concat
                 (test-fp--make-org-item "item-a" "Task A")
                 (test-fp--make-org-item "item-b" "Task B" '("item-a"))
                 (test-fp--make-org-item "item-c" "Task C" '("item-a"))
                 (test-fp--make-org-item "item-d" "Task D" '("item-b" "item-c"))))
         (plan (test-fp--make-plan "test-plan-3" "Test Plan"
                                  '("item-a" "item-b" "item-c" "item-d")))
         (files `(("plan.org" . ,plan) ("items.org" . ,items))))
    (test-fp--with-temp-tasks files
      (let* ((result (org-fluid-plan--build-fluid-plan
                      (org-tasks--all-org-files) "test-plan-3"))
             (components (cdr (assoc 'components result)))
             (waves (cdr (assoc 'waves (aref components 0)))))
        (should (= (length components) 1))
        (should (= (length waves) 3))
        ;; Wave 1: A, Wave 2: B+C, Wave 3: D
        (should (equal (cdr (assoc 'items (aref waves 0))) ["item-a"]))
        (should (equal (cdr (assoc 'items (aref waves 1))) ["item-b" "item-c"]))
        (should (equal (cdr (assoc 'items (aref waves 2))) ["item-d"]))))))

(ert-deftest test-fp-cycle-error ()
  "Cycle A->B->C->A produces an error."
  (let* ((items (concat
                 (test-fp--make-org-item "item-a" "Task A" '("item-c"))
                 (test-fp--make-org-item "item-b" "Task B" '("item-a"))
                 (test-fp--make-org-item "item-c" "Task C" '("item-b"))))
         (plan (test-fp--make-plan "test-plan-4" "Test Plan"
                                  '("item-a" "item-b" "item-c")))
         (files `(("plan.org" . ,plan) ("items.org" . ,items))))
    (test-fp--with-temp-tasks files
      (should-error
       (org-fluid-plan--build-fluid-plan
        (org-tasks--all-org-files) "test-plan-4")
       :type 'error))))

(ert-deftest test-fp-leaf-items-no-deps ()
  "All leaf items (no deps) -> all in wave 1."
  (let* ((items (concat
                 (test-fp--make-org-item "item-a" "Task A")
                 (test-fp--make-org-item "item-b" "Task B")
                 (test-fp--make-org-item "item-c" "Task C")))
         (plan (test-fp--make-plan "test-plan-5" "Test Plan"
                                  '("item-a" "item-b" "item-c")))
         (files `(("plan.org" . ,plan) ("items.org" . ,items))))
    (test-fp--with-temp-tasks files
      (let* ((result (org-fluid-plan--build-fluid-plan
                      (org-tasks--all-org-files) "test-plan-5"))
             (components (cdr (assoc 'components result))))
        ;; Each isolated node is its own component (no shared edges)
        (should (= (length components) 3))))))

(ert-deftest test-fp-cross-file-resolution ()
  "Items in different files are resolved correctly."
  (let* ((plan (test-fp--make-plan "test-plan-6" "Test Plan"
                                  '("item-a" "item-b")))
         (file-a (test-fp--make-org-item "item-a" "Task A"))
         (file-b (test-fp--make-org-item "item-b" "Task B" '("item-a")))
         (files `(("plan.org" . ,plan)
                  ("projects.org" . ,file-a)
                  ("features.org" . ,file-b))))
    (test-fp--with-temp-tasks files
      (let* ((result (org-fluid-plan--build-fluid-plan
                      (org-tasks--all-org-files) "test-plan-6"))
             (components (cdr (assoc 'components result))))
        (should (= (length components) 1))
        (let ((agents (cdr (assoc 'agents (aref components 0)))))
          (should (= (length agents) 2)))))))

(ert-deftest test-fp-missing-depends-target ()
  "Missing DEPENDS target produces warning, item treated as root."
  (let* ((items (concat
                 (test-fp--make-org-item "item-a" "Task A" '("nonexistent-item"))
                 (test-fp--make-org-item "item-b" "Task B")))
         (plan (test-fp--make-plan "test-plan-7" "Test Plan"
                                  '("item-a" "item-b")))
         (files `(("plan.org" . ,plan) ("items.org" . ,items))))
    (test-fp--with-temp-tasks files
      (let* ((result (org-fluid-plan--build-fluid-plan
                      (org-tasks--all-org-files) "test-plan-7"))
             (warnings (cdr (assoc 'warnings result))))
        ;; Should have a warning about the missing dep
        (should (> (length warnings) 0))
        (should (cl-some (lambda (w) (string-match-p "nonexistent-item" w))
                         warnings))))))

(ert-deftest test-fp-empty-plan-error ()
  "Plan with no child links produces an error."
  (let* ((plan "* DOING Empty Plan\n:PROPERTIES:\n:CUSTOM_ID: test-plan-8\n:END:\n\nNo links here.\n")
         (files `(("plan.org" . ,plan))))
    (test-fp--with-temp-tasks files
      (should-error
       (org-fluid-plan--build-fluid-plan
        (org-tasks--all-org-files) "test-plan-8")
       :type 'error))))

(ert-deftest test-fp-single-item-plan ()
  "Single item plan -> one component, no dependencies."
  (let* ((items (test-fp--make-org-item "item-solo" "Solo Task" nil "ITEM" "1h"))
         (plan (test-fp--make-plan "test-plan-10" "Solo Plan" '("item-solo")))
         (files `(("plan.org" . ,plan) ("items.org" . ,items))))
    (test-fp--with-temp-tasks files
      (let* ((result (org-fluid-plan--build-fluid-plan
                      (org-tasks--all-org-files) "test-plan-10"))
             (components (cdr (assoc 'components result)))
             (agents (cdr (assoc 'agents (aref components 0)))))
        (should (= (length components) 1))
        (should (= (length agents) 1))
        (should (equal (cdr (assoc 'id (aref agents 0))) "item-solo"))))))

(ert-deftest test-fp-mcp-handler-success ()
  "MCP handler returns valid JSON for a valid plan."
  (let* ((items (concat
                 (test-fp--make-org-item "item-x" "Task X")
                 (test-fp--make-org-item "item-y" "Task Y" '("item-x"))))
         (plan (test-fp--make-plan "test-plan-mcp" "MCP Test" '("item-x" "item-y")))
         (files `(("plan.org" . ,plan) ("items.org" . ,items))))
    (test-fp--with-temp-tasks files
      (let* ((json-str (org-mcp-fluid-plan-handler '((plan_id . "test-plan-mcp"))))
             (result (test-fp--decode json-str)))
        ;; Should NOT have error field
        (should-not (cdr (assoc 'error result)))
        ;; Should have components
        (should (cdr (assoc 'components result)))))))

(ert-deftest test-fp-mcp-handler-error ()
  "MCP handler returns error JSON for missing plan."
  (let* ((files `(("empty.org" . "* ITEM Filler\n:PROPERTIES:\n:CUSTOM_ID: filler\n:END:\n"))))
    (test-fp--with-temp-tasks files
      (let* ((json-str (org-mcp-fluid-plan-handler '((plan_id . "nonexistent-plan"))))
             (result (test-fp--decode json-str)))
        (should (eq (cdr (assoc 'error result)) t))
        (should (cdr (assoc 'message result)))))))

(provide 'test-org-fluid-plan)

;;; test-org-fluid-plan.el ends here
