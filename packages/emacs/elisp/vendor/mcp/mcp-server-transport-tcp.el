;;; mcp-server-transport-tcp.el --- TCP Socket Transport -*- lexical-binding: t; -*-

;; Source: https://github.com/rhblind/emacs-mcp-server (GPL-3.0)
;; TCP transport — planned for future implementation.

;;; Code:

(require 'mcp-server-transport)

(defvar mcp-server-transport-tcp--server-process nil)
(defvar mcp-server-transport-tcp--port nil)
(defvar mcp-server-transport-tcp--host "localhost")
(defvar mcp-server-transport-tcp--running nil)

(defun mcp-server-transport-tcp--start (message-handler &optional host port)
  (error "TCP transport not yet implemented; use Unix socket transport"))
(defun mcp-server-transport-tcp--stop ()
  (error "TCP transport not yet implemented"))
(defun mcp-server-transport-tcp--send (client-id message)
  (error "TCP transport not yet implemented"))
(defun mcp-server-transport-tcp--status ()
  `((running . ,mcp-server-transport-tcp--running) (implemented . nil)))
(defun mcp-server-transport-tcp--list-clients () '())
(defun mcp-server-transport-tcp--disconnect-client (client-id)
  (error "TCP transport not yet implemented"))

(mcp-server-transport-register
 "tcp"
 (make-mcp-server-transport
  :name "TCP Socket"
  :start-fn #'mcp-server-transport-tcp--start
  :stop-fn #'mcp-server-transport-tcp--stop
  :send-fn #'mcp-server-transport-tcp--send
  :status-fn #'mcp-server-transport-tcp--status
  :list-clients-fn #'mcp-server-transport-tcp--list-clients
  :disconnect-client-fn #'mcp-server-transport-tcp--disconnect-client))

(provide 'mcp-server-transport-tcp)
;;; mcp-server-transport-tcp.el ends here
