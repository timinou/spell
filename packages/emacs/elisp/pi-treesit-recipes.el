;;; pi-treesit-recipes.el --- Tree-sitter grammar recipes for Pi -*- lexical-binding: t; -*-

;;; Commentary:

;; Recipe metadata adapted from treesit-auto (GPLv3):
;; https://github.com/renzmann/treesit-auto
;;
;; Pi stores recipes as plists instead of `cl-defstruct' records and uses simple
;; extension string lists instead of treesit-auto's regex-based `:ext' field.

;;; Code:

(require 'cl-lib)
(require 'treesit)

(defvar pi-treesit-recipes
  '((awk
     :ts-mode awk-ts-mode
     :url "https://github.com/Beaglefoot/tree-sitter-awk"
     :exts ("awk"))
    (bash
     :ts-mode bash-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-bash"
     :abi14-revision "v0.23.3"
     :exts ("sh" "bash"))
    (bibtex
     :ts-mode bibtex-ts-mode
     :url "https://github.com/latex-lsp/tree-sitter-bibtex"
     :exts ("bib"))
    (c
     :ts-mode c-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-c"
     :requires cpp
     :exts ("c" "h"))
    (c-sharp
     :ts-mode csharp-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-c-sharp"
     :exts ("cs"))
    (clojure
     :ts-mode clojure-ts-mode
     :url "https://github.com/sogaiu/tree-sitter-clojure"
     :exts ("clj" "cljs" "cljc" "cljd"))
    (cmake
     :ts-mode cmake-ts-mode
     :url "https://github.com/uyha/tree-sitter-cmake"
     :exts ("cmake"))
    (cpp
     :ts-mode c++-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-cpp"
     :revision "v0.22.0"
     :requires c
     :exts ("cpp" "cc" "cxx" "hpp" "hxx"))
    (css
     :ts-mode css-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-css"
     :exts ("css"))
    (dart
     :ts-mode dart-ts-mode
     :url "https://github.com/UserNobody14/tree-sitter-dart"
     :exts ("dart"))
    (dockerfile
     :ts-mode dockerfile-ts-mode
     :url "https://github.com/camdencheek/tree-sitter-dockerfile"
     :exts ("Dockerfile" "Containerfile"))
    (elm
     :url "https://github.com/elm-tooling/tree-sitter-elm"
     :exts ("elm"))
    (elixir
     :ts-mode elixir-ts-mode
     :url "https://github.com/elixir-lang/tree-sitter-elixir"
     :requires heex
     :exts ("ex" "exs"))
    (glsl
     :ts-mode glsl-ts-mode
     :url "https://github.com/tree-sitter-grammars/tree-sitter-glsl")
    (go
     :ts-mode go-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-go"
     :abi14-revision "v0.23.4"
     :requires gomod
     :exts ("go"))
    (gomod
     :ts-mode go-mod-ts-mode
     :url "https://github.com/camdencheek/tree-sitter-go-mod"
     :abi14-revision "v1.1.0"
     :requires go
     :exts ("mod"))
    (haskell
     :ts-mode haskell-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-haskell"
     :exts ("hs"))
    (heex
     :ts-mode heex-ts-mode
     :url "https://github.com/phoenixframework/tree-sitter-heex"
     :exts ("heex"))
    (html
     :ts-mode html-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-html"
     :exts ("html" "htm"))
    (java
     :ts-mode java-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-java"
     :exts ("java"))
    (javascript
     :ts-mode js-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-javascript"
     :revision "master"
     :source-dir "src"
     :exts ("js" "jsx" "mjs"))
    (json
     :ts-mode json-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-json"
     :exts ("json"))
    (julia
     :ts-mode julia-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-julia"
     :exts ("jl"))
    (kotlin
     :ts-mode kotlin-ts-mode
     :url "https://github.com/fwcd/tree-sitter-kotlin"
     :exts ("kt" "kts"))
    (lua
     :ts-mode lua-ts-mode
     :url "https://github.com/tree-sitter-grammars/tree-sitter-lua"
     :exts ("lua"))
    (make
     :ts-mode makefile-ts-mode
     :url "https://github.com/tree-sitter-grammars/tree-sitter-make"
     :exts ("mk" "make" "Makefile" "makefile"))
    (markdown
     :ts-mode markdown-ts-mode
     :url "https://github.com/tree-sitter-grammars/tree-sitter-markdown"
     :source-dir "tree-sitter-markdown/src"
     :exts ("md"))
    (nix
     :ts-mode nix-ts-mode
     :url "https://github.com/nix-community/tree-sitter-nix"
     :exts ("nix"))
    (nu
     :ts-mode nushell-ts-mode
     :url "https://github.com/nushell/tree-sitter-nu"
     :exts ("nu"))
    (perl
     :ts-mode perl-ts-mode
     :url "https://github.com/ganezdragon/tree-sitter-perl"
     :exts ("pl" "pm"))
    (php
     :ts-mode php-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-php"
     :source-dir "php/src"
     :exts ("php" "phtml" "php4" "php5" "php7" "php8"))
    (proto
     :ts-mode protobuf-ts-mode
     :url "https://github.com/mitchellh/tree-sitter-proto"
     :exts ("proto"))
    (python
     :ts-mode python-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-python"
     :abi14-revision "v0.23.6"
     :exts ("py" "pyi" "pyw"))
    (r
     :ts-mode r-ts-mode
     :url "https://github.com/r-lib/tree-sitter-r"
     :exts ("r" "R"))
    (ruby
     :ts-mode ruby-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-ruby"
     :exts ("rb" "rbw" "rake" "gemspec" "ru" "thor" "jbuilder" "rabl" "podspec" "Gemfile" "Rakefile" "Capfile" "Thorfile" "Puppetfile" "Berksfile" "Brewfile" "Vagrantfile" "Guardfile" "Podfile"))
    (rust
     :ts-mode rust-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-rust"
     :exts ("rs"))
    (scala
     :ts-mode scala-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-scala"
     :exts ("scala" "sbt"))
    (sql
     :ts-mode sql-ts-mode
     :url "https://github.com/DerekStride/tree-sitter-sql"
     :revision "gh-pages"
     :exts ("sql"))
    (surface
     :ts-mode surface-ts-mode
     :url "https://github.com/connorlay/tree-sitter-surface")
    (swift
     :ts-mode swift-ts-mode
     :url "https://github.com/alex-pinkus/tree-sitter-swift")
    (toml
     :ts-mode toml-ts-mode
     :url "https://github.com/tree-sitter-grammars/tree-sitter-toml"
     :exts ("toml"))
    (tsx
     :ts-mode tsx-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-typescript"
     :revision "master"
     :source-dir "tsx/src"
     :requires typescript
     :exts ("tsx"))
    (typescript
     :ts-mode typescript-ts-mode
     :url "https://github.com/tree-sitter/tree-sitter-typescript"
     :revision "master"
     :source-dir "typescript/src"
     :requires tsx
     :exts ("ts"))
    (typst
     :ts-mode typst-ts-mode
     :url "https://github.com/uben0/tree-sitter-typst"
     :revision "master"
     :source-dir "src"
     :exts ("typ"))
    (verilog
     :ts-mode verilog-ts-mode
     :url "https://github.com/gmlarumbe/tree-sitter-systemverilog"
     :exts ("sv" "svh" "v" "vh"))
    (vhdl
     :ts-mode vhdl-ts-mode
     :url "https://github.com/alemuller/tree-sitter-vhdl"
     :exts ("vhd" "vhdl"))
    (vue
     :ts-mode vue-ts-mode
     :url "https://github.com/tree-sitter-grammars/tree-sitter-vue"
     :exts ("vue"))
    (wgsl
     :ts-mode wgsl-ts-mode
     :url "https://github.com/mehmetoguzderin/tree-sitter-wgsl"
     :exts ("wgsl"))
    (yaml
     :ts-mode yaml-ts-mode
     :url "https://github.com/tree-sitter-grammars/tree-sitter-yaml"
     :abi14-revision "v0.7.2"
     :exts ("yaml" "yml"))
    (zig
     :ts-mode zig-ts-mode
     :url "https://github.com/maxxnino/tree-sitter-zig"
     :exts ("zig")))
  "Tree-sitter grammar recipes keyed by language symbol.")

(defun pi-treesit--recipe-prop (recipe prop)
  "Return PROP from RECIPE plist."
  (plist-get (cdr recipe) prop))

(defun pi-treesit--find-recipe (lang)
  "Return recipe entry for LANG, or nil."
  (assq lang pi-treesit-recipes))

(defun pi-treesit-recipe-sources ()
  "Return grammar sources in treesit-language-source-alist format.
Respects :abi14-revision when treesit ABI < 15."
  (let ((abi14-p (< (or (and (fboundp 'treesit-library-abi-version)
                             (treesit-library-abi-version))
                        15)
                    15)))
    (mapcar
     (lambda (recipe)
       (let* ((lang (car recipe))
              (url (pi-treesit--recipe-prop recipe :url))
              (revision (or (and abi14-p (pi-treesit--recipe-prop recipe :abi14-revision))
                            (pi-treesit--recipe-prop recipe :revision)))
              (source-dir (pi-treesit--recipe-prop recipe :source-dir)))
         (cond
          (source-dir (list lang url revision source-dir))
          (revision (list lang url revision))
          (t (list lang url)))))
     pi-treesit-recipes)))

(defun pi-treesit-recipe-lang-for-ext (ext)
  "Return lang symbol for file extension EXT, or nil."
  (when ext
    (car
     (cl-find-if
      (lambda (recipe)
        (member ext (pi-treesit--recipe-prop recipe :exts)))
      pi-treesit-recipes))))

(defun pi-treesit-recipe-mode-for-ext (ext)
  "Return ts-mode symbol for file extension EXT, or nil."
  (when-let* ((recipe (and ext
                           (cl-find-if
                            (lambda (entry)
                              (member ext (pi-treesit--recipe-prop entry :exts)))
                            pi-treesit-recipes))))
    (pi-treesit--recipe-prop recipe :ts-mode)))

(defun pi-treesit-recipe-deps (lang)
  "Return list of required grammar symbols for LANG, or nil."
  (when-let* ((recipe (pi-treesit--find-recipe lang))
              (deps (pi-treesit--recipe-prop recipe :requires)))
    (ensure-list deps)))

(provide 'pi-treesit-recipes)
;;; pi-treesit-recipes.el ends here
