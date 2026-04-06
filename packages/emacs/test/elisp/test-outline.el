;;; test-outline.el --- ERT tests for pi-outline -*- lexical-binding: t; -*-

;;; Code:

(require 'ert)
(require 'pi-outline)

(defconst test-outline--ts-source
  "export function standalone(): void {}\n\nexport class Widget {\n  label: string;\n  render(): string { return this.label; }\n  update(val: string): void { this.label = val; }\n}\n")

(defconst test-outline--md-source
  "# Intro\n\n## Background\n\n```elisp\n(print \"hello\")\n```\n")

(defconst test-outline--yaml-source
  "foo: 1\nbar: 2\n")

(defconst test-outline--toml-source
  "[table]\nitem = \"value\"\nother = 1\n")

(defconst test-outline--json-source
  "{\"name\": \"app\", \"version\": \"1.0\"}\n")

(defconst test-outline--elixir-source
  "defmodule MyApp.Greeter do\n  def greet(name) do\n    \"Hello, \\\\ #{name}!\"\n  end\n\n  defp helper do\n    :ok\n  end\nend\n")

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

(ert-deftest test-outline-markdown-headings ()
  "Outline includes markdown headings with level prefixes."
  (skip-unless (and (treesit-language-available-p 'markdown)
                    (fboundp 'markdown-ts-mode)))
  (test-outline--with-tmp-file test-outline--md-source ".md"
    (lambda (file)
      (let* ((entries (pi-outline-get file))
             (names (mapcar (lambda (entry) (alist-get 'name entry)) entries)))
        (should (member "h1: Intro" names))
        (should (member "h2: Background" names))
        (should-not (member "print" names))
        (should (string= (alist-get 'type (car entries)) "heading"))
        (should (eq (alist-get 'line (cadr entries)) 3))))))

(ert-deftest test-outline-yaml-entries ()
  "Outline includes top-level YAML mapping keys."
  (skip-unless (treesit-language-available-p 'yaml))
  (test-outline--with-tmp-file test-outline--yaml-source ".yaml"
    (lambda (file)
      (let* ((entries (pi-outline-get file))
             (names (mapcar (lambda (entry) (alist-get 'name entry)) entries))
             (types (mapcar (lambda (entry) (alist-get 'type entry)) entries)))
        (should (member "foo" names))
        (should (member "bar" names))
        (should (member "key" types))
        (should-not (member "heading" types))
        ))))

(ert-deftest test-outline-toml-entries ()
  "Outline includes TOML table and key pairs."
  (skip-unless (treesit-language-available-p 'toml))
  (test-outline--with-tmp-file test-outline--toml-source ".toml"
    (lambda (file)
      (let* ((entries (pi-outline-get file))
             (names (mapcar (lambda (entry) (alist-get 'name entry)) entries))
             (types (mapcar (lambda (entry) (alist-get 'type entry)) entries)))
        (should (member "[table]" names))
        (should (member "item" names))
        (should (member "other" names))
        (should (member "table" types))
        (should (member "key" types))))))

(ert-deftest test-outline-json-entries ()
  "Outline includes top-level JSON object key pairs."
  (skip-unless (treesit-language-available-p 'json))
  (test-outline--with-tmp-file test-outline--json-source ".json"
    (lambda (file)
      (let* ((entries (pi-outline-get file))
             (names (mapcar (lambda (entry) (alist-get 'name entry)) entries))
             (types (mapcar (lambda (entry) (alist-get 'type entry)) entries)))
        (should (member "name" names))
        (should (member "version" names))
        (should (member "key" types))))
    ))

(ert-deftest test-outline-elixir-entries ()
  "Outline returns entries for Elixir declarations."
  (skip-unless (treesit-language-available-p 'elixir))
  (test-outline--with-tmp-file test-outline--elixir-source ".ex"
    (lambda (file)
      (let* ((entries (pi-outline-get file))
             (names (mapcar (lambda (e) (alist-get 'name e)) entries)))
        (should (listp entries))
        (should (>= (length entries) 1))
        (should (member "MyApp.Greeter" names))))))

(provide 'test-outline)
;;; test-outline.el ends here
