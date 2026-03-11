;;; pi-prelude.el --- Tree-sitter grammar bootstrap for Pi Emacs daemon -*- lexical-binding: t; -*-

;;; Commentary:

;; Ensures all required tree-sitter grammars are available before the MCP
;; server starts.  Grammar resolution order (first match wins):
;;
;;   1. Repo-local vendor/tree-sitter/  — committed or locally placed .so files
;;   2. Pi-managed  ~/.local/share/omp/tree-sitter/  — compiled on first run
;;   3. Compile from source into (2) via treesit-install-language-grammar
;;
;; Grammars that fail to load are recorded in `pi-prelude--unavailable' so
;; pi-treesit.el can produce actionable error messages instead of cryptic
;; "no parser" failures.

;;; Code:

;; ---------------------------------------------------------------------------
;; Directories
;; ---------------------------------------------------------------------------

(defvar pi-prelude--vendor-dir
  (expand-file-name "vendor/tree-sitter"
                    (file-name-directory (or load-file-name buffer-file-name)))
  "Repo-local grammar directory.  Place pre-compiled .so files here to skip
compilation.  Path: packages/emacs/elisp/vendor/tree-sitter/")

(defvar pi-prelude--managed-dir
  (expand-file-name "omp/tree-sitter"
                    (or (getenv "XDG_DATA_HOME")
                        (expand-file-name ".local/share" (getenv "HOME"))))
  "Pi-managed grammar directory.  Grammars are compiled here on first use
and reused on subsequent daemon starts.")

;; ---------------------------------------------------------------------------
;; Grammar sources
;; Covers every language in pi-treesit--mode-for-file / pi-treesit--lang-for-file.
;; Format: (LANG URL &optional REVISION SOURCE-DIR) — matches treesit-language-source-alist.
;; ---------------------------------------------------------------------------

(defvar pi-prelude--sources
  '((typescript "https://github.com/tree-sitter/tree-sitter-typescript"
                "master" "typescript/src")
    (tsx        "https://github.com/tree-sitter/tree-sitter-typescript"
                "master" "tsx/src")
    (javascript "https://github.com/tree-sitter/tree-sitter-javascript")
    (python     "https://github.com/tree-sitter/tree-sitter-python")
    (rust       "https://github.com/tree-sitter/tree-sitter-rust")
    (go         "https://github.com/tree-sitter/tree-sitter-go")
    (json       "https://github.com/tree-sitter/tree-sitter-json")
    (css        "https://github.com/tree-sitter/tree-sitter-css")
    (html       "https://github.com/tree-sitter/tree-sitter-html")
    (yaml       "https://github.com/ikatyang/tree-sitter-yaml")
    (toml       "https://github.com/ikatyang/tree-sitter-toml")
    (bash       "https://github.com/tree-sitter/tree-sitter-bash")
    (c          "https://github.com/tree-sitter/tree-sitter-c")
    (cpp        "https://github.com/tree-sitter/tree-sitter-cpp")
    (elm        "https://github.com/elm-tooling/tree-sitter-elm"))
  "Grammar sources for all languages supported by pi-emacs code intelligence.")

;; ---------------------------------------------------------------------------
;; Failure tracking — read by pi-treesit.el for user-facing errors
;; ---------------------------------------------------------------------------

(defvar pi-prelude--unavailable '()
  "List of language symbols whose grammars could not be loaded or compiled.
Each entry is (LANG . REASON-STRING).  Read by pi-treesit-open-file to
produce actionable error messages.")

(defun pi-prelude-grammar-unavailable-p (lang)
  "Return the failure reason string if LANG grammar is unavailable, else nil."
  (cdr (assq lang pi-prelude--unavailable)))

;; ---------------------------------------------------------------------------
;; Bootstrap
;; ---------------------------------------------------------------------------

(defun pi-prelude--ensure-grammars ()
  "Ensure all required grammars are present.

Adds both the vendor dir and managed dir to treesit-extra-load-path, then
compiles any grammar still missing into the managed dir.  Records failures
in `pi-prelude--unavailable'."
  ;; 1. Register search paths (vendor first — no compilation needed if .so present).
  (make-directory pi-prelude--managed-dir t)
  (add-to-list 'treesit-extra-load-path pi-prelude--vendor-dir)
  (add-to-list 'treesit-extra-load-path pi-prelude--managed-dir)

  ;; 2. Point treesit at our sources for compilation.
  (setq treesit-language-source-alist pi-prelude--sources)

  ;; 3. Compile any missing grammar; record failures for user-facing errors.
  (dolist (entry pi-prelude--sources)
    (let ((lang (car entry)))
      (unless (treesit-language-available-p lang)
        (message "[pi-prelude] Compiling tree-sitter grammar: %s …" lang)
        (condition-case err
            (progn
              (treesit-install-language-grammar lang pi-prelude--managed-dir)
              ;; Reload load-path so the freshly compiled grammar is found.
              (unless (treesit-language-available-p lang)
                (let ((reason "compiled but still not loadable — check ~/.omp/logs/"))
                  (push (cons lang reason) pi-prelude--unavailable)
                  (message "[pi-prelude] WARNING: grammar for %s %s" lang reason))))
          (error
           (let ((reason (error-message-string err)))
             (push (cons lang reason) pi-prelude--unavailable)
             (message "[pi-prelude] WARNING: failed to compile grammar for %s: %s"
                      lang reason))))))))

(pi-prelude--ensure-grammars)

(provide 'pi-prelude)
;;; pi-prelude.el ends here
