;;; pi-emacs-mcp.el --- Bootstrap for Pi Emacs code intelligence MCP server -*- lexical-binding: t; -*-

;;; Code:

;; Add vendored combobulate to load-path.
(let ((vendor-dir (expand-file-name "vendor/combobulate"
                                    (file-name-directory (or load-file-name
                                                             buffer-file-name)))))
  (add-to-list 'load-path vendor-dir))

;; Add vendored MCP server infrastructure to load-path.
;; This is a self-contained copy that does not pull in org-mode tools.
(let ((vendor-dir (expand-file-name "vendor/mcp"
                                    (file-name-directory (or load-file-name
                                                             buffer-file-name)))))
  (add-to-list 'load-path vendor-dir))

;; Load combobulate (optional — degrade gracefully if not available).
(defvar pi-emacs-combobulate-available nil
  "Non-nil if combobulate loaded successfully.")

(condition-case err
    (progn
      (require 'combobulate)
      (setq pi-emacs-combobulate-available t))
  (error
   (message "[pi-emacs] combobulate not available: %s" (error-message-string err))))

;; Require MCP infrastructure from vendor (no org tools).
(require 'mcp-server)

;; Require pi-emacs modules.
(require 'pi-treesit)
(require 'pi-buffer)
(require 'pi-resolution)
(require 'pi-outline)
(require 'pi-edit)
(require 'pi-emacs-tools)

(provide 'pi-emacs-mcp)
;;; pi-emacs-mcp.el ends here
