;;; test-buffer.el --- ERT tests for pi-buffer -*- lexical-binding: t; -*-

;;; Code:

(require 'ert)
(require 'pi-buffer)

(defconst test-buffer--source "const x = 1;\n")

(defmacro test-buffer--with-tmp-file (source &rest body)
  "Execute BODY with tmp-file bound to a temp file containing SOURCE."
  (declare (indent 1))
  `(let ((tmp-file (make-temp-file "pi-emacs-test" nil ".ts")))
     (unwind-protect
         (progn
           (write-region ,source nil tmp-file nil 'silent)
           ,@body)
       ;; Clean up registry and buffer.
       (pi-buffer-close tmp-file)
       (delete-file tmp-file))))

(ert-deftest test-buffer-open-returns-buffer ()
  "pi-buffer-open returns a live buffer."
  (test-buffer--with-tmp-file test-buffer--source
    (let ((buf (pi-buffer-open tmp-file)))
      (should buf)
      (should (buffer-live-p buf)))))

(ert-deftest test-buffer-open-idempotent ()
  "Multiple calls to pi-buffer-open return the same buffer."
  (test-buffer--with-tmp-file test-buffer--source
    (let ((buf1 (pi-buffer-open tmp-file))
          (buf2 (pi-buffer-open tmp-file)))
      (should (eq buf1 buf2)))))

(ert-deftest test-buffer-list-shows-open-buffer ()
  "pi-buffer-list shows the opened buffer."
  (test-buffer--with-tmp-file test-buffer--source
    (pi-buffer-open tmp-file)
    (let* ((lst (pi-buffer-list))
           (entry (cl-find-if
                   (lambda (e) (string= (alist-get 'file e) (expand-file-name tmp-file)))
                   lst)))
      (should entry)
      (should (alist-get 'size entry)))))

(ert-deftest test-buffer-close-removes-from-list ()
  "Closing a buffer removes it from pi-buffer-list."
  (test-buffer--with-tmp-file test-buffer--source
    (pi-buffer-open tmp-file)
    (pi-buffer-close tmp-file)
    (let* ((lst (pi-buffer-list))
           (entry (cl-find-if
                   (lambda (e) (string= (alist-get 'file e) (expand-file-name tmp-file)))
                   lst)))
      (should-not entry))))

(provide 'test-buffer)
;;; test-buffer.el ends here
