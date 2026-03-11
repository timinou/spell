;;; pi-buffer.el --- Buffer management for pi-emacs -*- lexical-binding: t; -*-

;;; Code:

(require 'pi-treesit)

;; Registry: file path → buffer
(defvar pi-buffer--registry (make-hash-table :test 'equal)
  "Maps absolute file path → live buffer.")

(defun pi-buffer-open (file)
  "Open FILE in the registry, returning its buffer.
If already open, return the existing buffer."
  (let ((abs (expand-file-name file)))
    (or (gethash abs pi-buffer--registry)
        (let ((buf (find-file-noselect abs t)))
          (puthash abs buf pi-buffer--registry)
          buf))))

(defun pi-buffer-close (file)
  "Close the buffer for FILE and remove from registry."
  (let* ((abs (expand-file-name file))
         (buf (gethash abs pi-buffer--registry)))
    (when buf
      (remhash abs pi-buffer--registry)
      (when (buffer-live-p buf)
        (kill-buffer buf))
      t)))

(defun pi-buffer-list ()
  "Return list of buffer info alists for all open managed buffers."
  (let ((result '()))
    (maphash
     (lambda (file buf)
       (when (buffer-live-p buf)
         (push
          `((file . ,file)
            (modified . ,(if (buffer-modified-p buf) t :false))
            (size . ,(buffer-size buf))
            (language . ,(with-current-buffer buf
                           (symbol-name major-mode)))
            (lastAccessed . ,(float-time)))
          result)))
     pi-buffer--registry)
    (nreverse result)))

(defun pi-buffer-diff (file)
  "Return unified diff of unsaved changes in FILE's buffer."
  (let* ((abs (expand-file-name file))
         (buf (or (gethash abs pi-buffer--registry)
                  (find-file-noselect abs t))))
    (with-current-buffer buf
      (if (not (buffer-modified-p))
          ""
        ;; Generate diff against disk.
        (let ((tmp (make-temp-file "pi-emacs-diff")))
          (unwind-protect
              (progn
                (write-region (point-min) (point-max) tmp nil 'silent)
                (let ((result (shell-command-to-string
                               (format "diff -u %s %s"
                                       (shell-quote-argument file)
                                       (shell-quote-argument tmp)))))
                  result))
            (delete-file tmp)))))))

(defun pi-buffer-save (file)
  "Save the buffer for FILE to disk."
  (let* ((abs (expand-file-name file))
         (buf (gethash abs pi-buffer--registry)))
    (when (and buf (buffer-live-p buf))
      (with-current-buffer buf
        (save-buffer))
      t)))

(provide 'pi-buffer)
;;; pi-buffer.el ends here
