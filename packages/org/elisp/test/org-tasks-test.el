;;; org-tasks-test.el --- ERT tests for org-tasks.el -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Tests for the pure parsing, validation, query, and dashboard functions in
;; org-tasks.el. These tests do not require a running MCP server.
;;
;; Run with:
;;   emacs --batch -l ert \
;;         -l packages/org/elisp/org-tasks.el \
;;         -l packages/org/elisp/test/org-tasks-test.el \
;;         -f ert-run-tests-batch-and-exit

;;; Code:

(require 'ert)
(require 'json)

;; ---------------------------------------------------------------------------
;; Helpers
;; ---------------------------------------------------------------------------

(defmacro org-tasks-test--with-org-file (content &rest body)
  "Evaluate BODY with a temp org file containing CONTENT.
Binds `test-file' to the temp file path."
  (declare (indent 1))
  `(let ((test-file (make-temp-file "org-tasks-test-" nil ".org")))
     (unwind-protect
         (progn
           (with-temp-file test-file
             (insert ,content))
           ,@body)
       (delete-file test-file))))

(defun org-tasks-test--decode (json-str)
  "Decode JSON-STR to a Lisp value."
  (let ((json-object-type 'alist)
        (json-array-type 'list)
        (json-false nil)
        (json-null nil))
    (json-read-from-string json-str)))

;; ---------------------------------------------------------------------------
;; Sample org content fixtures
;; ---------------------------------------------------------------------------

(defconst org-tasks-test--valid-item
  "* ITEM PROJ-001-auth-refactor
:PROPERTIES:
:CUSTOM_ID: PROJ-001-auth-refactor
:EFFORT: 2h
:LAYER: backend
:END:

Refactor authentication flow to use JWT.
"
  "A minimal valid task item.")

(defconst org-tasks-test--doing-item
  "* DOING PROJ-002-add-tests
:PROPERTIES:
:CUSTOM_ID: PROJ-002-add-tests
:EFFORT: 1h
:END:
"
  "A DOING state task.")

(defconst org-tasks-test--done-item
  "* DONE PROJ-003-cleanup
:PROPERTIES:
:CUSTOM_ID: PROJ-003-cleanup
:EFFORT: 30m
:END:
"
  "A DONE state task.")

(defconst org-tasks-test--missing-effort-item
  "* ITEM PROJ-004-no-effort
:PROPERTIES:
:CUSTOM_ID: PROJ-004-no-effort
:END:
"
  "Item missing the EFFORT property (required).")

(defconst org-tasks-test--bad-effort-item
  "* ITEM PROJ-005-bad-effort
:PROPERTIES:
:CUSTOM_ID: PROJ-005-bad-effort
:EFFORT: half-day
:END:
"
  "Item with invalid EFFORT value.")

(defconst org-tasks-test--bad-id-item
  "* ITEM lowercase-id
:PROPERTIES:
:CUSTOM_ID: lowercase-id
:EFFORT: 1h
:END:
"
  "Item with invalid CUSTOM_ID format.")

;; ---------------------------------------------------------------------------
;; org-tasks-item-id-regexp
;; ---------------------------------------------------------------------------

(ert-deftest org-tasks-test/id-regexp-matches-valid-ids ()
  "Standard PREFIX-NNN and PREFIX-NNN-slug forms must match."
  (should (string-match org-tasks-item-id-regexp "PROJ-001"))
  (should (string-match org-tasks-item-id-regexp "BUG-042-crash-on-start"))
  (should (string-match org-tasks-item-id-regexp "FEAT-100-new-feature")))

(ert-deftest org-tasks-test/id-regexp-rejects-invalid-ids ()
  "Lowercase prefix or missing numeric suffix must not match at start."
  (should-not (string-match (concat "^" org-tasks-item-id-regexp "$") "proj-001"))
  (should-not (string-match (concat "^" org-tasks-item-id-regexp "$") "PROJ"))
  (should-not (string-match (concat "^" org-tasks-item-id-regexp "$") "001-proj")))

;; ---------------------------------------------------------------------------
;; org-tasks-effort-regexp
;; ---------------------------------------------------------------------------

(ert-deftest org-tasks-test/effort-regexp-matches-valid-formats ()
  "Integers followed by h, m, or d are valid effort values."
  (should (string-match org-tasks-effort-regexp "1h"))
  (should (string-match org-tasks-effort-regexp "30m"))
  (should (string-match org-tasks-effort-regexp "2d"))
  (should (string-match org-tasks-effort-regexp "120m")))

(ert-deftest org-tasks-test/effort-regexp-rejects-invalid-formats ()
  "Non-numeric or missing unit must not match."
  (should-not (string-match org-tasks-effort-regexp "half-day"))
  (should-not (string-match org-tasks-effort-regexp "1 hour"))
  (should-not (string-match org-tasks-effort-regexp "h"))
  (should-not (string-match org-tasks-effort-regexp ""))
  (should-not (string-match org-tasks-effort-regexp "1.5h")))

;; ---------------------------------------------------------------------------
;; org-tasks-get-items
;; ---------------------------------------------------------------------------

(ert-deftest org-tasks-test/get-items-returns-all-todo-items ()
  "All headings with recognized TODO keywords appear in results."
  (org-tasks-test--with-org-file
      (concat org-tasks-test--valid-item
              org-tasks-test--doing-item
              org-tasks-test--done-item)
    (let* ((raw (org-tasks-get-items test-file))
           (items (org-tasks-test--decode raw)))
      (should (= 3 (length items)))
      (should (equal "PROJ-001-auth-refactor"
                     (cdr (assoc 'custom_id (car items))))))))

(ert-deftest org-tasks-test/get-items-state-filter ()
  "State filter limits results to matching TODO keywords."
  (org-tasks-test--with-org-file
      (concat org-tasks-test--valid-item
              org-tasks-test--doing-item
              org-tasks-test--done-item)
    (let* ((raw (org-tasks-get-items test-file '((state . ("DOING")))))
           (items (org-tasks-test--decode raw)))
      (should (= 1 (length items)))
      (should (equal "DOING" (cdr (assoc 'state (car items))))))))

(ert-deftest org-tasks-test/get-items-layer-filter ()
  "Layer filter restricts results to items with the given LAYER value."
  (org-tasks-test--with-org-file
      (concat org-tasks-test--valid-item
              org-tasks-test--doing-item)
    (let* ((raw (org-tasks-get-items test-file '((layer . "backend"))))
           (items (org-tasks-test--decode raw)))
      (should (= 1 (length items)))
      (should (equal "backend" (cdr (assoc 'layer (car items))))))))

(ert-deftest org-tasks-test/get-items-empty-file ()
  "A file with no task headings returns an empty JSON array."
  (org-tasks-test--with-org-file
      "#+TITLE: Empty\n\nSome prose, no tasks.\n"
    (let* ((raw (org-tasks-get-items test-file))
           (items (org-tasks-test--decode raw)))
      (should (null items)))))

;; ---------------------------------------------------------------------------
;; org-tasks-get-item
;; ---------------------------------------------------------------------------

(ert-deftest org-tasks-test/get-item-returns-body ()
  "get-item includes body text for the requested CUSTOM_ID."
  (org-tasks-test--with-org-file
      org-tasks-test--valid-item
    (let* ((raw (org-tasks-get-item test-file "PROJ-001-auth-refactor"))
           (item (org-tasks-test--decode raw)))
      (should (equal "PROJ-001-auth-refactor" (cdr (assoc 'custom_id item))))
      (should (string-match-p "JWT" (cdr (assoc 'body item)))))))

(ert-deftest org-tasks-test/get-item-not-found-returns-error ()
  "Requesting a non-existent CUSTOM_ID returns an error alist."
  (org-tasks-test--with-org-file
      org-tasks-test--valid-item
    (let* ((raw (org-tasks-get-item test-file "PROJ-999-does-not-exist"))
           (result (org-tasks-test--decode raw)))
      (should (cdr (assoc 'error result))))))

;; ---------------------------------------------------------------------------
;; org-tasks-get-progress
;; ---------------------------------------------------------------------------

(ert-deftest org-tasks-test/get-progress-counts-states ()
  "get-progress returns correct total and per-state counts."
  (org-tasks-test--with-org-file
      (concat org-tasks-test--valid-item   ; ITEM
              org-tasks-test--doing-item   ; DOING
              org-tasks-test--done-item)   ; DONE
    (let* ((raw (org-tasks-get-progress test-file))
           (progress (org-tasks-test--decode raw)))
      (should (= 3 (cdr (assoc 'total progress))))
      (should (= 1 (cdr (assoc 'completed progress))))
      (let ((by-state (cdr (assoc 'by_state progress))))
        (should (= 1 (cdr (assoc 'ITEM by-state))))
        (should (= 1 (cdr (assoc 'DOING by-state))))
        (should (= 1 (cdr (assoc 'DONE by-state))))))))

(ert-deftest org-tasks-test/get-progress-percentage-all-done ()
  "100% when all items are DONE."
  (org-tasks-test--with-org-file
      org-tasks-test--done-item
    (let* ((raw (org-tasks-get-progress test-file))
           (progress (org-tasks-test--decode raw)))
      (should (= 100 (cdr (assoc 'percentage progress)))))))

(ert-deftest org-tasks-test/get-progress-empty-file ()
  "Empty file produces total=0, percentage=0."
  (org-tasks-test--with-org-file
      "#+TITLE: No tasks\n"
    (let* ((raw (org-tasks-get-progress test-file))
           (progress (org-tasks-test--decode raw)))
      (should (= 0 (cdr (assoc 'total progress))))
      (should (= 0 (cdr (assoc 'percentage progress)))))))

;; ---------------------------------------------------------------------------
;; org-tasks-validate-file
;; ---------------------------------------------------------------------------

(ert-deftest org-tasks-test/validate-file-valid-item-passes ()
  "A fully valid item produces no errors and no warnings."
  (org-tasks-test--with-org-file
      org-tasks-test--valid-item
    (let* ((raw (org-tasks-validate-file test-file))
           (result (org-tasks-test--decode raw)))
      (should (cdr (assoc 'valid result)))
      (should (null (cdr (assoc 'errors result)))))))

(ert-deftest org-tasks-test/validate-file-missing-effort-is-error ()
  "Missing EFFORT property is a validation error (required property)."
  (org-tasks-test--with-org-file
      org-tasks-test--missing-effort-item
    (let* ((raw (org-tasks-validate-file test-file))
           (result (org-tasks-test--decode raw)))
      (should-not (cdr (assoc 'valid result)))
      (should (> (length (cdr (assoc 'errors result))) 0)))))

(ert-deftest org-tasks-test/validate-file-bad-effort-is-warning ()
  "Invalid EFFORT format (e.g., 'half-day') is a validation warning, not error."
  (org-tasks-test--with-org-file
      org-tasks-test--bad-effort-item
    (let* ((raw (org-tasks-validate-file test-file))
           (result (org-tasks-test--decode raw)))
      ;; The item has EFFORT present (satisfies required check) but wrong format.
      (should (> (length (cdr (assoc 'warnings result))) 0)))))

(ert-deftest org-tasks-test/validate-file-bad-id-is-warning ()
  "CUSTOM_ID with invalid format produces a warning."
  (org-tasks-test--with-org-file
      org-tasks-test--bad-id-item
    (let* ((raw (org-tasks-validate-file test-file))
           (result (org-tasks-test--decode raw)))
      (should (> (length (cdr (assoc 'warnings result))) 0)))))

(ert-deftest org-tasks-test/validate-file-returns-file-path ()
  "Validation result includes the file path that was validated."
  (org-tasks-test--with-org-file
      org-tasks-test--valid-item
    (let* ((raw (org-tasks-validate-file test-file))
           (result (org-tasks-test--decode raw)))
      (should (equal test-file (cdr (assoc 'file result)))))))

;;; org-tasks-test.el ends here
