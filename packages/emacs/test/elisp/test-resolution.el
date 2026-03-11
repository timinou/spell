;;; test-resolution.el --- ERT tests for pi-resolution -*- lexical-binding: t; -*-

;;; Code:

(require 'ert)
(require 'pi-resolution)

(defconst test-resolution--ts-source
  "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport class Calculator {\n  value: number = 0;\n  add(n: number): Calculator {\n    this.value += n;\n    return this;\n  }\n  reset(): void {\n    this.value = 0;\n  }\n}\n")

(defun test-resolution--with-tmp-file (source suffix fn)
  "Write SOURCE to a temp file with SUFFIX, call FN with the path, then delete."
  (let ((tmp (make-temp-file "pi-emacs-test" nil suffix)))
    (unwind-protect
        (progn
          (write-region source nil tmp nil 'silent)
          (funcall fn tmp))
      (delete-file tmp))))

(ert-deftest test-resolution-0-names ()
  "Resolution 0 returns only declaration names."
  (skip-unless (treesit-language-available-p 'typescript))
  (test-resolution--with-tmp-file test-resolution--ts-source ".ts"
    (lambda (file)
      (let ((result (pi-resolution-read file 0)))
        (should (stringp result))
        ;; Should mention 'add' and 'Calculator' but NOT implementation details
        (should (string-match-p "add" result))
        (should (string-match-p "Calculator" result))
        ;; Should NOT contain the body
        (should-not (string-match-p "return a \\+ b" result))))))

(ert-deftest test-resolution-1-signatures ()
  "Resolution 1 shows signatures with bodies stubbed."
  (skip-unless (treesit-language-available-p 'typescript))
  (test-resolution--with-tmp-file test-resolution--ts-source ".ts"
    (lambda (file)
      (let ((result (pi-resolution-read file 1)))
        (should (stringp result))
        (should (string-match-p "add" result))
        ;; Body is stubbed
        (should (string-match-p "\.\.\." result))
        ;; Implementation not shown
        (should-not (string-match-p "return a \\+ b" result))))))

(ert-deftest test-resolution-3-full ()
  "Resolution 3 returns full source."
  (skip-unless (treesit-language-available-p 'typescript))
  (test-resolution--with-tmp-file test-resolution--ts-source ".ts"
    (lambda (file)
      (let ((result (pi-resolution-read file 3)))
        (should (stringp result))
        (should (string-match-p "return a \\+ b" result))
        (should (string-match-p "this\\.value \\+= n" result))))))

(ert-deftest test-resolution-3-offset-limit ()
  "Resolution 3 with offset and limit returns the correct lines."
  (skip-unless (treesit-language-available-p 'typescript))
  (test-resolution--with-tmp-file test-resolution--ts-source ".ts"
    (lambda (file)
      ;; Line 1 is the function declaration
      (let ((result (pi-resolution-read file 3 1 1)))
        (should (stringp result))
        (should (string-match-p "add" result))
        ;; Only 1 line, not the class body
        (should-not (string-match-p "Calculator" result))))))

(ert-deftest test-resolution-invalid ()
  "Invalid resolution raises an error."
  (skip-unless (treesit-language-available-p 'typescript))
  (test-resolution--with-tmp-file test-resolution--ts-source ".ts"
    (lambda (file)
      (should-error (pi-resolution-read file 5)))))

(provide 'test-resolution)
;;; test-resolution.el ends here
