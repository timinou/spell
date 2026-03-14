;;; load-org-ql.el --- Bootstrap vendored org-ql for Spell -*- lexical-binding: t; -*-
;;
;; Adds vendored dependencies to load-path and requires org-ql core.
;; Designed to be loaded from mcp-server-emacs-tools.el.
;;
;; Vendored packages (stripped of interactive UI):
;;   - dash.el      (list manipulation)
;;   - ts.el        (timestamp library)
;;   - compat.el    (compatibility shims for Emacs 29+)
;;   - org-ql.el    (core query engine)
;;
;; Built-in (Emacs 28+): peg, map, seq, cl-lib, subr-x
;;
;;; Code:

(let* ((this-file (or load-file-name buffer-file-name))
       (vendor-dir (and this-file (file-name-directory this-file))))
  (when vendor-dir
    (add-to-list 'load-path vendor-dir)))

(require 'dash)
(require 'ts)
(require 'compat nil t)  ;; optional shim — Emacs 30 may not need it
(require 'org-ql)

(provide 'load-org-ql)

;;; load-org-ql.el ends here
