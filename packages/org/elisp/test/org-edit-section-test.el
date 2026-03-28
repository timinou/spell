;;; org-edit-section-test.el --- ERT tests for org-tasks-edit-section -*- lexical-binding: t; -*-

;;; Commentary:

;; Focused tests for section-targeted edits in `org-tasks-edit-section'.

;;; Code:

(require 'ert)
(require 'json)
(require 'org-tasks)

(defmacro org-edit-section-test--with-org-file (content &rest body)
  "Evaluate BODY with a temp org file containing CONTENT.
Binds `test-file' to the temp file path."
  (declare (indent 1))
  `(let ((test-file (make-temp-file "org-edit-section-test-" nil ".org")))
     (unwind-protect
         (progn
           (with-temp-file test-file
             (insert ,content))
           ,@body)
       (delete-file test-file))))

(defun org-edit-section-test--decode (json-str)
  "Decode JSON-STR to a Lisp alist."
  (let ((json-object-type 'alist)
        (json-array-type 'list)
        (json-false nil)
        (json-null nil))
    (json-read-from-string json-str)))

(defun org-edit-section-test--read-file (file)
  "Return FILE contents as string."
  (with-temp-buffer
    (insert-file-contents file)
    (buffer-string)))

(defconst org-edit-section-test--fixture
  "* ITEM FEAT-004-section-edits
:PROPERTIES:
:CUSTOM_ID: FEAT-004-section-edits
:EFFORT: 1h
:END:

Parent intro text.

** Summary
Old summary.

** Details :tag:
:PROPERTIES:
:OWNER: team-a
:END:
Details line 1.

*** Nested detail
Nested text.

** Empty Section

** Summary
Second summary content.
"
  "Fixture with repeated section names and nested headings.")

(defconst org-edit-section-test--file-level-fixture
  "#+TITLE: Plan item
#+STATE: ITEM
#+CUSTOM_ID: PLAN-008-org-section-level-editing

* Context
Old plan context.

* Verification
- Existing check
"
  "Fixture for file-level org items with section headings.")

(ert-deftest org-edit-section-test/file-level-item-sections-edit-successfully ()
  "File-level CUSTOM_ID items can update a named section body."
  (org-edit-section-test--with-org-file
      org-edit-section-test--file-level-fixture
    (let* ((raw (org-tasks-edit-section test-file "PLAN-008-org-section-level-editing" "Context" "Revised plan context." "replace"))
           (result (org-edit-section-test--decode raw))
           (contents (org-edit-section-test--read-file test-file)))
      (should (cdr (assoc 'success result)))
      (should (string-match-p "Revised plan context\\." contents))
      (should (string-match-p "- Existing check" contents))
      (should-not (string-match-p "Old plan context\\." contents)))))


(ert-deftest org-edit-section-test/replace-targeted-section-only ()
  "Replace updates only the matching section body and preserves siblings." 
  (org-edit-section-test--with-org-file
      org-edit-section-test--fixture
    (let* ((raw (org-tasks-edit-section test-file "FEAT-004-section-edits" "Details" "Replaced details." "replace"))
           (result (org-edit-section-test--decode raw))
           (contents (org-edit-section-test--read-file test-file)))
      (should (cdr (assoc 'success result)))
      (should (string-match-p "\\*\\* Details" contents))
      (should (string-match-p "Replaced details\\." contents))
      (should (string-match-p "Old summary\\." contents))
      (should-not (string-match-p "Details line 1\\." contents)))))

(ert-deftest org-edit-section-test/append-adds-blank-line-when-existing-content ()
  "Append keeps existing content and inserts a blank line before new text." 
  (org-edit-section-test--with-org-file
      org-edit-section-test--fixture
    (org-tasks-edit-section test-file "FEAT-004-section-edits" "Summary" "Appended summary." "append")
    (let ((contents (org-edit-section-test--read-file test-file)))
      (should (string-match-p "Old summary\\." contents))
      (should (string-match-p "Appended summary\\." contents))
      (should (string-match-p "Old summary\\.\\(\n\\)+Appended summary\\." contents)))))

(ert-deftest org-edit-section-test/missing-section-returns-error-and-no-change ()
  "Missing section returns SECTION_NOT_FOUND and leaves file untouched." 
  (org-edit-section-test--with-org-file
      org-edit-section-test--fixture
    (let* ((before (org-edit-section-test--read-file test-file))
           (raw (org-tasks-edit-section test-file "FEAT-004-section-edits" "Not Present" "text" "replace"))
           (result (org-edit-section-test--decode raw))
           (after (org-edit-section-test--read-file test-file)))
      (should (cdr (assoc 'error result)))
      (should (equal "SECTION_NOT_FOUND" (cdr (assoc 'code result))))
      (should (equal before after)))))

(ert-deftest org-edit-section-test/missing-item-returns-error-and-no-change ()
  "Missing item returns ITEM_NOT_FOUND and leaves file untouched." 
  (org-edit-section-test--with-org-file
      org-edit-section-test--fixture
    (let* ((before (org-edit-section-test--read-file test-file))
           (raw (org-tasks-edit-section test-file "FEAT-999-missing" "Summary" "text" "replace"))
           (result (org-edit-section-test--decode raw))
           (after (org-edit-section-test--read-file test-file)))
      (should (cdr (assoc 'error result)))
      (should (equal "ITEM_NOT_FOUND" (cdr (assoc 'code result))))
      (should (equal before after)))))

(ert-deftest org-edit-section-test/replace-preserves-nested-heading-in-target-section ()
  "Replacing a section body preserves nested headings beneath that section."
  (org-edit-section-test--with-org-file
      org-edit-section-test--fixture
    (org-tasks-edit-section test-file "FEAT-004-section-edits" "Details" "Updated details." "replace")
    (let ((contents (org-edit-section-test--read-file test-file)))
      (should (string-match-p "Updated details\\." contents))
      (should-not (string-match-p "Details line 1\\." contents))
      (should (string-match-p "\\*\\*\\* Nested detail" contents))
      (should (string-match-p "Nested text\\." contents)))))

(ert-deftest org-edit-section-test/append-to-empty-section-inserts-content ()
  "Appending to an empty section inserts content without mutating sibling section text." 
  (org-edit-section-test--with-org-file
      org-edit-section-test--fixture
    (org-tasks-edit-section test-file "FEAT-004-section-edits" "Empty Section" "First line." "append")
    (let ((contents (org-edit-section-test--read-file test-file)))
      (should (string-match-p "\\*\\* Empty Section" contents))
      (should (string-match-p "First line\\." contents))
      (should (string-match-p "Second summary content\\." contents)))))

(ert-deftest org-edit-section-test/first-match-wins-for-duplicate-headings ()
  "When section names repeat, only the first matching section is edited." 
  (org-edit-section-test--with-org-file
      org-edit-section-test--fixture
    (org-tasks-edit-section test-file "FEAT-004-section-edits" "Summary" "First-only update." "replace")
    (let ((contents (org-edit-section-test--read-file test-file)))
      (should (string-match-p "First-only update\\." contents))
      (should (string-match-p "Second summary content\\." contents))
      (should-not (string-match-p "\\*\\* Summary\\nOld summary\\." contents)))))

(provide 'org-edit-section-test)

;;; org-edit-section-test.el ends here
