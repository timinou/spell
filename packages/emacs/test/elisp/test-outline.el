;;; test-outline.el --- ERT tests for pi-outline -*- lexical-binding: t; -*-

;;; Code:

(require 'ert)
(require 'pi-outline)

(defconst test-outline--ts-source
  "export function standalone(): void {}\n\nexport class Widget {\n  label: string;\n  render(): string { return this.label; }\n  update(val: string): void { this.label = val; }\n}\n")

(defun test-outline--with-tmp-file (source suffix fn)
  (let ((tmp (make-temp-file "pi-emacs-test" nil suffix)))
    (unwind-protect
        (progn (write-region source nil tmp nil 'silent) (funcall fn tmp))
      (delete-file tmp))))

(ert-deftest test-outline-top-level-entries ()
  "Outline returns entries for top-level declarations."
  (skip-unless (treesit-language-available-p 'typescript))
  (test-outline--with-tmp-file test-outline--ts-source ".ts"
    (lambda (file)
      (let ((entries (pi-outline-get file)))
        (should (listp entries))
        (should (>= (length entries) 2))
        ;; Names in entries
        (let ((names (mapcar (lambda (e) (alist-get 'name e)) entries)))
          (should (member "standalone" names))
          (should (member "Widget" names)))))))

(ert-deftest test-outline-class-members ()
  "Outline includes class members as children."
  (skip-unless (treesit-language-available-p 'typescript))
  (test-outline--with-tmp-file test-outline--ts-source ".ts"
    (lambda (file)
      (let* ((entries (pi-outline-get file))
             (widget (cl-find-if (lambda (e) (string= (alist-get 'name e) "Widget")) entries)))
        (should widget)
        (let ((children (alist-get 'children widget)))
          (should children)
          (let ((member-names (mapcar (lambda (c) (alist-get 'name c)) children)))
            (should (member "render" member-names))
            (should (member "update" member-names))))))))

(ert-deftest test-outline-line-numbers ()
  "Outline entries have line numbers."
  (skip-unless (treesit-language-available-p 'typescript))
  (test-outline--with-tmp-file test-outline--ts-source ".ts"
    (lambda (file)
      (let ((entries (pi-outline-get file)))
        (dolist (entry entries)
          (should (numberp (alist-get 'line entry)))
          (should (> (alist-get 'line entry) 0)))))))

(provide 'test-outline)
;;; test-outline.el ends here
