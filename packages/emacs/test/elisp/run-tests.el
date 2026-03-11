;;; run-tests.el --- ERT test runner for pi-emacs -*- lexical-binding: t; -*-
;;
;; Run with: emacs --batch -l packages/emacs/test/elisp/run-tests.el

;;; Code:

;; Add elisp dirs to load-path.
(let ((root (expand-file-name "../../.." (file-name-directory load-file-name))))
  ;; MCP server infrastructure (from org package).
  (add-to-list 'load-path (expand-file-name "packages/org/elisp" root))
  ;; Pi-emacs modules.
  (add-to-list 'load-path (expand-file-name "packages/emacs/elisp" root))
  ;; Vendored combobulate.
  (add-to-list 'load-path
               (expand-file-name "packages/emacs/elisp/vendor/combobulate" root)))

;; Load test files.
(load (expand-file-name "test-treesit.el" (file-name-directory load-file-name)))
(load (expand-file-name "test-resolution.el" (file-name-directory load-file-name)))
(load (expand-file-name "test-outline.el" (file-name-directory load-file-name)))
(load (expand-file-name "test-buffer.el" (file-name-directory load-file-name)))

;; Run tests.
(ert-run-tests-batch-and-exit t)

;;; run-tests.el ends here
