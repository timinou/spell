;;; test-treesit.el --- ERT tests for pi-treesit -*- lexical-binding: t; -*-

;;; Code:

(require 'ert)
(require 'pi-treesit)

;; Sample TypeScript source used across tests.
(defconst test-treesit--ts-source
  "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n\nexport class Greeter {\n  constructor(private name: string) {}\n  greet(): string {\n    return `Hi, ${this.name}`;\n  }\n}\n"
  "Simple TypeScript source for testing.")

(defun test-treesit--make-ts-buffer (source)
  "Create a temp buffer with SOURCE in typescript-ts-mode."
  (let ((buf (generate-new-buffer " *test-treesit*")))
    (with-current-buffer buf
      (insert source)
      (when (treesit-language-available-p 'typescript)
        (typescript-ts-mode)))
    buf))

(ert-deftest test-treesit-top-level-nodes ()
  "Top-level nodes are extracted from a TypeScript buffer."
  (skip-unless (treesit-language-available-p 'typescript))
  (let ((buf (test-treesit--make-ts-buffer test-treesit--ts-source)))
    (unwind-protect
        (with-current-buffer buf
          (let ((nodes (pi-treesit-top-level-nodes)))
            ;; Should find at least 2 top-level nodes (function + class)
            (should (>= (length nodes) 2))))
      (kill-buffer buf))))

(ert-deftest test-treesit-declaration-name ()
  "Declaration names are correctly extracted."
  (skip-unless (treesit-language-available-p 'typescript))
  (let ((buf (test-treesit--make-ts-buffer test-treesit--ts-source)))
    (unwind-protect
        (with-current-buffer buf
          (let* ((nodes (pi-treesit-top-level-nodes))
                 (names (delq nil (mapcar #'pi-treesit-declaration-name nodes))))
            ;; Must find at least "greet" and "Greeter"
            (should (member "greet" names))
            (should (member "Greeter" names))))
      (kill-buffer buf))))

(ert-deftest test-treesit-find-body ()
  "Function body node is found for a function declaration."
  (skip-unless (treesit-language-available-p 'typescript))
  (let ((buf (test-treesit--make-ts-buffer test-treesit--ts-source)))
    (unwind-protect
        (with-current-buffer buf
          (let* ((nodes (pi-treesit-top-level-nodes))
                 ;; First top-level node: export_statement wrapping function
                 (fn-node (car nodes))
                 (body (pi-treesit-find-body fn-node)))
            (should body)
            (should (member (treesit-node-type body)
                            '("statement_block" "class_body" "block")))))
      (kill-buffer buf))))

(provide 'test-treesit)
;;; test-treesit.el ends here
