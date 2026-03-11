;;; pi-prelude.el --- Tree-sitter grammar bootstrap for Pi Emacs daemon -*- lexical-binding: t; -*-

;;; Commentary:

;; Ensures all required tree-sitter grammars are available before the MCP
;; server starts.  Grammar resolution order (first match wins):
;;
;;   1. Project-local  <root>/.omp/tree-sitter/  or  <root>/.pi/tree-sitter/
;;   2. Repo-local     packages/emacs/elisp/vendor/tree-sitter/
;;   3. Pi-managed     ~/.local/share/omp/tree-sitter/  — compiled on first run
;;   4. Compile from source into (3) via treesit-install-language-grammar
;;
;; Per-project configuration lives in treesitter.json, searched in priority order:
;;
;;   <root>/.omp/treesitter.json
;;   <root>/.pi/treesitter.json
;;   <root>/treesitter.json
;;
;; Config format:
;;
;;   {
;;     "grammars": {
;;       "mylang": {
;;         "url": "https://github.com/me/tree-sitter-mylang",
;;         "revision": "main",
;;         "sourceDir": "src"
;;       }
;;     },
;;     "extensions": {
;;       "ml":  "mylang",
;;       "mli": "mylang"
;;     },
;;     "modes": {
;;       "ml": "mylang-ts-mode"
;;     }
;;   }
;;
;; Grammars that fail to load are recorded in `pi-prelude--unavailable' so
;; pi-treesit.el can produce actionable error messages instead of cryptic
;; "no parser" failures.

;;; Code:

(require 'cl-lib)
(require 'json)
(require 'treesit)

;; ---------------------------------------------------------------------------
;; Directories
;; ---------------------------------------------------------------------------

(defvar pi-prelude--vendor-dir
  (expand-file-name "vendor/tree-sitter"
                    (file-name-directory (or load-file-name buffer-file-name)))
  "Repo-local grammar directory shipped with the emacs package.
Path: packages/emacs/elisp/vendor/tree-sitter/")

(defvar pi-prelude--managed-dir
  (expand-file-name "omp/tree-sitter"
                    (or (getenv "XDG_DATA_HOME")
                        (expand-file-name ".local/share" (getenv "HOME"))))
  "Pi-managed grammar directory.  Compiled grammars land here on first run.")

;; pi-project-root is set by the daemon spawn args before (require 'pi-prelude).
(defvar pi-project-root nil
  "Absolute path to the project root, set by the Pi daemon before loading this file.")

;; ---------------------------------------------------------------------------
;; Built-in grammar sources
;; Covers every language in pi-treesit--mode-for-file / pi-treesit--lang-for-file.
;; Format matches treesit-language-source-alist: (LANG URL &optional REV SRC-DIR).
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
  "Grammar sources for all languages built into pi-emacs code intelligence.")

;; ---------------------------------------------------------------------------
;; Failure tracking — read by pi-treesit.el for user-facing errors
;; ---------------------------------------------------------------------------

(defvar pi-prelude--unavailable '()
  "Alist of (LANG . REASON-STRING) for grammars that failed to load or compile.
Populated during bootstrap; read by pi-treesit-open-file for error messages.")

(defun pi-prelude-grammar-unavailable-p (lang)
  "Return the failure reason string if LANG grammar is unavailable, else nil."
  (cdr (assq lang pi-prelude--unavailable)))

;; ---------------------------------------------------------------------------
;; Project-local extension/mode overrides — populated from treesitter.json
;; ---------------------------------------------------------------------------

(defvar pi-treesit--project-lang-map '()
  "Alist of (EXT-STRING . LANG-SYMBOL) for project-defined file extensions.
Populated by pi-prelude from treesitter.json; consulted by pi-treesit-open-file
before the built-in extension table.")

(defvar pi-treesit--project-mode-map '()
  "Alist of (EXT-STRING . MODE-SYMBOL) for project-defined major modes.
Populated by pi-prelude from treesitter.json; consulted before the built-in table.
Optional: if absent for an extension, pi-treesit activates the parser directly.")

;; ---------------------------------------------------------------------------
;; Project config loading
;; ---------------------------------------------------------------------------

(defun pi-prelude--find-project-config ()
  "Return path to the first treesitter.json found under the project root, or nil."
  (when pi-project-root
    (cl-find-if #'file-readable-p
                (list (expand-file-name ".omp/treesitter.json" pi-project-root)
                      (expand-file-name ".pi/treesitter.json"  pi-project-root)
                      (expand-file-name "treesitter.json"      pi-project-root)))))

(defun pi-prelude--load-project-config ()
  "Read treesitter.json and return (EXTRA-SOURCES EXT-LANG-MAP EXT-MODE-MAP).
Returns nil if no config file is found or if parsing fails."
  (let ((config-file (pi-prelude--find-project-config)))
    (when config-file
      (condition-case err
          (let* ((json-object-type 'alist)
                 (json-array-type  'list)
                 (json-key-type    'string)
                 (config (with-temp-buffer
                           (insert-file-contents config-file)
                           (json-read)))
                 (grammars-raw (cdr (assoc "grammars"   config)))
                 (exts-raw     (cdr (assoc "extensions" config)))
                 (modes-raw    (cdr (assoc "modes"      config)))
                 ;; Build treesit-language-source-alist entries from grammar specs.
                 (extra-sources
                  (mapcar
                   (lambda (entry)
                     (let* ((lang-str (car entry))
                            (lang     (intern lang-str))
                            (spec     (cdr entry))
                            (url      (cdr (assoc "url"       spec)))
                            (rev      (cdr (assoc "revision"  spec)))
                            (src      (cdr (assoc "sourceDir" spec))))
                       (if src
                           (list lang url rev src)
                         (if rev
                             (list lang url rev)
                           (list lang url)))))
                   grammars-raw))
                 ;; ext → lang-symbol alist.
                 (ext-lang-map
                  (mapcar (lambda (e) (cons (car e) (intern (cdr e)))) exts-raw))
                 ;; ext → mode-symbol alist.
                 (ext-mode-map
                  (mapcar (lambda (e) (cons (car e) (intern (cdr e)))) modes-raw)))
            (message "[pi-prelude] Loaded project config from %s" config-file)
            (list extra-sources ext-lang-map ext-mode-map))
        (error
         (message "[pi-prelude] WARNING: failed to parse %s: %s"
                  config-file (error-message-string err))
         nil)))))

;; ---------------------------------------------------------------------------
;; Grammar installation helpers
;; ---------------------------------------------------------------------------

(defun pi-prelude--install-grammar (lang)
  "Compile the tree-sitter grammar for LANG into the managed directory.
Records failure in `pi-prelude--unavailable'."
  (message "[pi-prelude] Compiling tree-sitter grammar: %s ..." lang)
  (condition-case err
      (progn
        (treesit-install-language-grammar lang pi-prelude--managed-dir)
        (unless (treesit-language-available-p lang)
          (let ((reason "compiled but still not loadable — check ~/.omp/logs/"))
            (push (cons lang reason) pi-prelude--unavailable)
            (message "[pi-prelude] WARNING: grammar for %s %s" lang reason))))
    (error
     (let ((reason (error-message-string err)))
       (push (cons lang reason) pi-prelude--unavailable)
       (message "[pi-prelude] WARNING: failed to compile grammar for %s: %s"
                lang reason)))))

;; ---------------------------------------------------------------------------
;; Bootstrap (runs once at daemon init)
;; ---------------------------------------------------------------------------

(defun pi-prelude--ensure-grammars ()
  "Ensure all required grammars are available.

Load-path priority:
  1. Project-local dirs (.omp/tree-sitter/, .pi/tree-sitter/)
  2. Repo vendor dir
  3. Pi-managed dir (compiled here if missing)

Grammar sources are merged: built-ins + any project-defined grammars.
The project config also populates `pi-treesit--project-lang-map' and
`pi-treesit--project-mode-map' for extension resolution."
  ;; 1. Load project config (may add extra grammar sources and extension maps).
  (let* ((project-cfg   (pi-prelude--load-project-config))
         (extra-sources (nth 0 project-cfg))
         (ext-lang-map  (nth 1 project-cfg))
         (ext-mode-map  (nth 2 project-cfg)))

    ;; Expose extension maps for pi-treesit.el.
    (setq pi-treesit--project-lang-map ext-lang-map)
    (setq pi-treesit--project-mode-map ext-mode-map)

    ;; 2. Register search paths (checked in order; first match wins).
    (make-directory pi-prelude--managed-dir t)
    (when pi-project-root
      (dolist (subdir '(".omp/tree-sitter" ".pi/tree-sitter"))
        (let ((dir (expand-file-name subdir pi-project-root)))
          (when (file-directory-p dir)
            (add-to-list 'treesit-extra-load-path dir)))))
    (add-to-list 'treesit-extra-load-path pi-prelude--vendor-dir)
    (add-to-list 'treesit-extra-load-path pi-prelude--managed-dir)

    ;; 3. Merge grammar sources: built-ins + project extras (project wins on conflict).
    (setq treesit-language-source-alist
          (append extra-sources pi-prelude--sources))

    ;; 4. Compile any missing grammar.
    (dolist (entry treesit-language-source-alist)
      (let ((lang (car entry)))
        (unless (treesit-language-available-p lang)
          (pi-prelude--install-grammar lang))))))

(pi-prelude--ensure-grammars)

(provide 'pi-prelude)
;;; pi-prelude.el ends here
