;;; org-tasks.el --- Org-mode Task Management Engine -*- lexical-binding: t; -*-

;; Author: oh-my-opencode
;; Version: 1.0.0
;; Package-Requires: ((emacs "29.1") (org "9.6"))
;; Keywords: org-mode, task-management, validation
;; Based on: prd-tasks.el from backdesk (v3.0.0)

;;; Commentary:

;; Generalized org-mode task management engine for OMO.
;; Provides parsing, validation, and query functions for @tasks/ org files.
;; Designed to be called by MCP tool handlers.
;;
;; Entry points (all return JSON strings):
;;   - `org-tasks-get-items'     - List items with optional filters
;;   - `org-tasks-get-item'      - Single item by CUSTOM_ID (with body)
;;   - `org-tasks-get-progress'  - Progress counts by state
;;   - `org-tasks-validate-file' - Validate single file
;;   - `org-tasks-validate-all'  - Validate all @tasks files
;;   - `org-tasks-dashboard'     - Aggregate metrics

;;; Code:

(require 'org)
(require 'org-element)
(require 'json)
(require 'cl-lib)
(require 'seq)

;;; Customization

(defgroup org-tasks nil
  "Org-mode Task Management Engine."
  :group 'org
  :prefix "org-tasks-")

(defcustom org-tasks-directory nil
  "Directory containing @tasks files.
If nil, auto-detected from project root."
  :type '(choice (const nil) directory)
  :group 'org-tasks)

(defcustom org-tasks-required-properties
  '("CUSTOM_ID" "EFFORT")
  "Properties required for every task heading."
  :type '(repeat string)
  :group 'org-tasks)

(defcustom org-tasks-effort-regexp
  "^[0-9]+[hmd]$"
  "Regexp for valid EFFORT format (e.g., 1h, 30m, 2d)."
  :type 'regexp
  :group 'org-tasks)

(defcustom org-tasks-item-id-regexp
  "^[A-Z]+-[0-9]+"
  "Regexp for valid CUSTOM_ID format."
  :type 'regexp
  :group 'org-tasks)

(defcustom org-tasks-category-prefixes
  '("PROJ" "BUG" "IMP" "CICD" "SPIKE")
  "Prefixes for category identifiers."
  :type '(repeat string)
  :group 'org-tasks)

(defcustom org-tasks-todo-keywords
  '("ITEM" "DOING" "REVIEW" "DONE" "BLOCKED")
  "TODO keywords used in @tasks files."
  :type '(repeat string)
  :group 'org-tasks)

(defcustom org-tasks-valid-layers
  '("backend" "frontend" "data" "prompt" "infra" "test" "docs")
  "Valid values for the LAYER property."
  :type '(repeat string)
  :group 'org-tasks)

;;; Internal Data Structures

(cl-defstruct (org-tasks-error
               (:constructor org-tasks-make-error))
  "A validation error."
  file line rule severity message hint context)

;;; Directory Management

(defun org-tasks--find-directory ()
  "Find the @tasks directory."
  (or org-tasks-directory
      (when-let ((current (or buffer-file-name default-directory)))
        (when-let ((parent (locate-dominating-file current "@tasks")))
          (expand-file-name "@tasks" parent)))
      (let ((git-root (locate-dominating-file default-directory ".git")))
        (when git-root
          (expand-file-name "@tasks" git-root)))))

(defun org-tasks--directory ()
  "Return the @tasks directory path, ensuring it exists."
  (let ((dir (org-tasks--find-directory)))
    (if (and dir (file-directory-p dir))
        (file-name-as-directory dir)
      (error "Cannot find @tasks directory"))))

(defun org-tasks--all-org-files ()
  "Return list of all org files in @tasks directory tree."
  (let ((dir (org-tasks--directory)))
    (directory-files-recursively dir "\\.org$")))

;;; Org Element Extraction

(defun org-tasks--extract-property (element property)
  "Extract PROPERTY from org ELEMENT (headline).
Checks both direct properties and property drawers."
  (or (org-element-property (intern (concat ":" property)) element)
      (when-let ((drawer (org-tasks--find-properties-drawer element)))
        (org-tasks--property-from-drawer drawer property))))

(defun org-tasks--find-properties-drawer (headline)
  "Find properties drawer in HEADLINE contents."
  (let ((contents (org-element-contents headline)))
    (seq-find (lambda (el)
                (eq (org-element-type el) 'property-drawer))
              contents)))

(defun org-tasks--property-from-drawer (drawer property)
  "Extract PROPERTY value from property DRAWER."
  (let ((nodes (org-element-contents drawer)))
    (cl-loop for node in nodes
             when (and (eq (org-element-type node) 'node-property)
                       (string= (org-element-property :key node) property))
             return (org-element-property :value node))))

(defun org-tasks--extract-all-properties (headline)
  "Extract all properties from HEADLINE as alist."
  (let ((props '()))
    (org-element-map headline 'node-property
      (lambda (node)
        (let ((key (org-element-property :key node))
              (val (org-element-property :value node)))
          (when (and key val (not (string-empty-p val)))
            (push (cons key val) props)))))
    (nreverse props)))

(defun org-tasks--extract-body (headline)
  "Extract the body text content of HEADLINE (excluding property drawer)."
  (let ((contents (org-element-contents headline))
        (body-parts '()))
    (dolist (el contents)
      (unless (memq (org-element-type el) '(property-drawer headline))
        (let ((text (org-element-interpret-data el)))
          (when (and text (not (string-empty-p (string-trim text))))
            (push (string-trim text) body-parts)))))
    (string-join (nreverse body-parts) "\n")))

(defun org-tasks--parse-csv (value)
  "Parse comma-separated VALUE into trimmed list."
  (when (and value (not (string-empty-p value)))
    (mapcar #'string-trim (split-string value "," t "[ \t]+"))))

(defun org-tasks--extract-tags (headline)
  "Extract tags from HEADLINE."
  (let ((tags (org-element-property :tags headline)))
    (when tags
      (if (listp tags) tags (split-string tags ":" t)))))

;;; Setup

(defun org-tasks--setup-keywords ()
  "Set up org-mode to recognize task TODO keywords."
  (save-excursion
    (goto-char (point-min))
    (unless (re-search-forward "^#\\+TODO:" nil t)
      (goto-char (point-min))
      (while (looking-at "^#\\+")
        (forward-line 1))
      (insert "#+TODO: ITEM(i) DOING(d) REVIEW(r) | DONE(D) BLOCKED(b)\n")))
  (setq-local org-todo-keywords
              '((sequence "ITEM(i)" "DOING(d)" "REVIEW(r)" "|" "DONE(D)" "BLOCKED(b)")))
  (org-set-regexps-and-options))

;;; Core Query Functions

(defun org-tasks-get-items (file &optional filters)
  "Return items from FILE as JSON string.
FILTERS is an optional alist: ((state . (\"DOING\" \"ITEM\")) (layer . \"backend\") (tags . (\"urgent\")))."
  (with-temp-buffer
    (insert-file-contents file)
    (let ((buffer-file-name file))
      (org-mode)
      (org-tasks--setup-keywords)
      (let ((ast (org-element-parse-buffer))
            (items '())
            (state-filter (cdr (assoc 'state filters)))
            (layer-filter (cdr (assoc 'layer filters)))
            (tag-filter (cdr (assoc 'tags filters))))
        (org-element-map ast 'headline
          (lambda (hl)
            (when-let ((todo (org-element-property :todo-keyword hl)))
              (when (member todo org-tasks-todo-keywords)
                (let* ((custom-id (org-tasks--extract-property hl "CUSTOM_ID"))
                       (title (org-element-property :raw-value hl))
                       (priority-val (org-element-property :priority hl))
                       (effort (org-tasks--extract-property hl "EFFORT"))
                       (agent (org-tasks--extract-property hl "AGENT"))
                       (layer (org-tasks--extract-property hl "LAYER"))
                       (depends (org-tasks--extract-property hl "DEPENDS"))
                       (blocks (org-tasks--extract-property hl "BLOCKS"))
                       (tags (org-tasks--extract-tags hl)))
                  ;; Apply filters
                  (when (and (or (null state-filter)
                                 (member todo state-filter))
                             (or (null layer-filter)
                                 (and layer (string-match-p
                                             (regexp-quote layer-filter)
                                             layer)))
                             (or (null tag-filter)
                                 (seq-some (lambda (t) (member t tags))
                                           tag-filter)))
                    (push `((custom_id . ,(or custom-id ""))
                            (title . ,title)
                            (state . ,todo)
                            (priority . ,(if priority-val
                                            (char-to-string priority-val)
                                          ""))
                            (effort . ,(or effort ""))
                            (agent . ,(or agent ""))
                            (layer . ,(or layer ""))
                            (depends . ,(or depends ""))
                            (blocks . ,(or blocks ""))
                            (tags . ,(or tags []))
                            (file . ,file))
                          items)))))))
        (json-encode (vconcat (nreverse items)))))))

(defun org-tasks-get-item (file custom-id)
  "Return single item from FILE by CUSTOM-ID as JSON string.
Includes body text."
  (with-temp-buffer
    (insert-file-contents file)
    (let ((buffer-file-name file))
      (org-mode)
      (org-tasks--setup-keywords)
      (let ((ast (org-element-parse-buffer))
            (result nil))
        (org-element-map ast 'headline
          (lambda (hl)
            (when (equal (org-tasks--extract-property hl "CUSTOM_ID") custom-id)
              (let* ((todo (org-element-property :todo-keyword hl))
                     (title (org-element-property :raw-value hl))
                     (priority-val (org-element-property :priority hl))
                     (effort (org-tasks--extract-property hl "EFFORT"))
                     (agent (org-tasks--extract-property hl "AGENT"))
                     (layer (org-tasks--extract-property hl "LAYER"))
                     (depends (org-tasks--extract-property hl "DEPENDS"))
                     (blocks (org-tasks--extract-property hl "BLOCKS"))
                     (tags (org-tasks--extract-tags hl))
                     (body (org-tasks--extract-body hl))
                     (all-props (org-tasks--extract-all-properties hl)))
                (setq result
                      `((custom_id . ,custom-id)
                        (title . ,title)
                        (state . ,(or todo ""))
                        (priority . ,(if priority-val
                                        (char-to-string priority-val)
                                      ""))
                        (effort . ,(or effort ""))
                        (agent . ,(or agent ""))
                        (layer . ,(or layer ""))
                        (depends . ,(or depends ""))
                        (blocks . ,(or blocks ""))
                        (tags . ,(or tags []))
                        (body . ,(or body ""))
                        (properties . ,all-props)
                        (file . ,file)))))))
        (if result
            (json-encode result)
          (json-encode `((error . t)
                         (code . "NOT_FOUND")
                         (message . ,(format "Item %s not found in %s" custom-id file)))))))))

(defun org-tasks-get-progress (file)
  "Return progress counts from FILE as JSON string."
  (with-temp-buffer
    (insert-file-contents file)
    (let ((buffer-file-name file))
      (org-mode)
      (org-tasks--setup-keywords)
      (let ((ast (org-element-parse-buffer))
            (total 0)
            (by-state (make-hash-table :test 'equal)))
        ;; Initialize all known states to 0
        (dolist (kw org-tasks-todo-keywords)
          (puthash kw 0 by-state))
        (org-element-map ast 'headline
          (lambda (hl)
            (when-let ((todo (org-element-property :todo-keyword hl)))
              (when (member todo org-tasks-todo-keywords)
                (cl-incf total)
                (puthash todo (1+ (gethash todo by-state 0)) by-state)))))
        (let* ((completed (gethash "DONE" by-state 0))
               (percentage (if (> total 0)
                              (round (* 100.0 (/ (float completed) total)))
                            0))
               (state-alist '()))
          (maphash (lambda (k v) (push (cons (intern k) v) state-alist)) by-state)
          (json-encode
           `((total . ,total)
             (by_state . ,state-alist)
             (completed . ,completed)
             (percentage . ,percentage))))))))

;;; Validation

(defun org-tasks--validate-item-props (file line title props)
  "Validate required properties for item at FILE:LINE with TITLE and PROPS."
  (let ((errors '()))
    (dolist (prop org-tasks-required-properties)
      (unless (cdr (assoc prop props))
        (push (org-tasks-make-error
               :file file :line line
               :rule "required-properties"
               :severity 'error
               :message (format "Missing required property: %s" prop)
               :hint (format "Add :%s: property" prop)
               :context title)
              errors)))
    ;; Validate CUSTOM_ID format
    (when-let ((id (cdr (assoc "CUSTOM_ID" props))))
      (unless (string-match org-tasks-item-id-regexp id)
        (push (org-tasks-make-error
               :file file :line line
               :rule "custom-id-format"
               :severity 'warning
               :message (format "Invalid CUSTOM_ID format: %s" id)
               :hint "Use format PREFIX-NNN (e.g., ITEM-001)"
               :context title)
              errors)))
    ;; Validate EFFORT format
    (when-let ((effort (cdr (assoc "EFFORT" props))))
      (unless (string-match org-tasks-effort-regexp effort)
        (push (org-tasks-make-error
               :file file :line line
               :rule "effort-format"
               :severity 'warning
               :message (format "Invalid effort format: %s" effort)
               :hint "Use format Xh, Xm, or Xd (e.g., 1h, 30m, 2d)"
               :context title)
              errors)))
    (nreverse errors)))

(defun org-tasks-validate-file (file)
  "Validate FILE and return JSON string with results."
  (with-temp-buffer
    (insert-file-contents file)
    (let ((buffer-file-name file))
      (org-mode)
      (org-tasks--setup-keywords)
      (let ((ast (org-element-parse-buffer))
            (errors '()))
        (org-element-map ast 'headline
          (lambda (hl)
            (when-let ((todo (org-element-property :todo-keyword hl)))
              (when (member todo org-tasks-todo-keywords)
                (let* ((title (org-element-property :raw-value hl))
                       (begin (org-element-property :begin hl))
                       (line (line-number-at-pos begin))
                       (props (org-tasks--extract-all-properties hl)))
                  (setq errors (append errors
                                       (org-tasks--validate-item-props
                                        file line title props))))))))
        (let ((err-list (seq-filter (lambda (e)
                                      (eq (org-tasks-error-severity e) 'error))
                                    errors))
              (warn-list (seq-filter (lambda (e)
                                       (eq (org-tasks-error-severity e) 'warning))
                                     errors)))
          (json-encode
           `((valid . ,(if err-list :json-false t))
             (errors . ,(mapcar #'org-tasks--error-to-alist err-list))
             (warnings . ,(mapcar #'org-tasks--error-to-alist warn-list))
             (file . ,file))))))))

(defun org-tasks-validate-all ()
  "Validate all @tasks files and return JSON string."
  (let ((all-errors '()))
    (dolist (file (org-tasks--all-org-files))
      (with-temp-buffer
        (insert-file-contents file)
        (let ((buffer-file-name file))
          (org-mode)
          (org-tasks--setup-keywords)
          (let ((ast (org-element-parse-buffer)))
            (org-element-map ast 'headline
              (lambda (hl)
                (when-let ((todo (org-element-property :todo-keyword hl)))
                  (when (member todo org-tasks-todo-keywords)
                    (let* ((title (org-element-property :raw-value hl))
                           (begin (org-element-property :begin hl))
                           (line (line-number-at-pos begin))
                           (props (org-tasks--extract-all-properties hl)))
                      (setq all-errors
                            (append all-errors
                                    (org-tasks--validate-item-props
                                     file line title props))))))))))))
    (let ((err-list (seq-filter (lambda (e)
                                  (eq (org-tasks-error-severity e) 'error))
                                all-errors))
          (warn-list (seq-filter (lambda (e)
                                   (eq (org-tasks-error-severity e) 'warning))
                                 all-errors)))
      (json-encode
       `((valid . ,(if err-list :json-false t))
         (total_files . ,(length (org-tasks--all-org-files)))
         (errors . ,(mapcar #'org-tasks--error-to-alist err-list))
         (warnings . ,(mapcar #'org-tasks--error-to-alist warn-list)))))))

(defun org-tasks--error-to-alist (err)
  "Convert ERR to alist for JSON serialization."
  `((file . ,(org-tasks-error-file err))
    (line . ,(org-tasks-error-line err))
    (rule . ,(org-tasks-error-rule err))
    (severity . ,(symbol-name (org-tasks-error-severity err)))
    (message . ,(org-tasks-error-message err))
    (hint . ,(or (org-tasks-error-hint err) ""))
    (context . ,(or (org-tasks-error-context err) ""))))

;;; Dashboard

(defun org-tasks-dashboard ()
  "Generate aggregate metrics dashboard as JSON string."
  (let ((total 0) (by-state (make-hash-table :test 'equal))
        (by-agent (make-hash-table :test 'equal))
        (by-layer (make-hash-table :test 'equal)))
    (dolist (kw org-tasks-todo-keywords)
      (puthash kw 0 by-state))
    (dolist (file (org-tasks--all-org-files))
      (with-temp-buffer
        (insert-file-contents file)
        (let ((buffer-file-name file))
          (org-mode)
          (org-tasks--setup-keywords)
          (let ((ast (org-element-parse-buffer)))
            (org-element-map ast 'headline
              (lambda (hl)
                (when-let ((todo (org-element-property :todo-keyword hl)))
                  (when (member todo org-tasks-todo-keywords)
                    (cl-incf total)
                    (puthash todo (1+ (gethash todo by-state 0)) by-state)
                    (when-let ((agent (org-tasks--extract-property hl "AGENT")))
                      (let ((data (or (gethash agent by-agent)
                                      (puthash agent (cons 0 0) by-agent))))
                        (cl-incf (car data))
                        (when (string= todo "DONE")
                          (cl-incf (cdr data)))))
                    (when-let ((layer (org-tasks--extract-property hl "LAYER")))
                      (dolist (l (org-tasks--parse-csv layer))
                        (let ((data (or (gethash l by-layer)
                                        (puthash l (cons 0 0) by-layer))))
                          (cl-incf (car data))
                          (when (string= todo "DONE")
                            (cl-incf (cdr data))))))))))))))
    (let ((completed (gethash "DONE" by-state 0))
          (state-alist '()) (agent-alist '()) (layer-alist '()))
      (maphash (lambda (k v) (push (cons (intern k) v) state-alist)) by-state)
      (maphash (lambda (k v) (push `(,(intern k) . ((assigned . ,(car v))
                                                      (complete . ,(cdr v))))
                                    agent-alist)) by-agent)
      (maphash (lambda (k v) (push `(,(intern k) . ((total . ,(car v))
                                                      (complete . ,(cdr v))))
                                    layer-alist)) by-layer)
      (json-encode
       `((timestamp . ,(format-time-string "%Y-%m-%dT%H:%M:%SZ"))
         (total . ,total)
         (completed . ,completed)
         (percentage . ,(if (> total 0)
                           (round (* 100.0 (/ (float completed) total)))
                         0))
         (by_state . ,state-alist)
         (by_agent . ,agent-alist)
         (by_layer . ,layer-alist))))))

;;; Mutation Functions

(defconst org-tasks-valid-transitions
  '(("ITEM"    . ("DOING" "BLOCKED" "DONE"))
    ("DOING"   . ("REVIEW" "DONE" "BLOCKED" "ITEM"))
    ("REVIEW"  . ("DONE" "DOING" "BLOCKED"))
    ("BLOCKED" . ("ITEM" "DOING"))
    ("DONE"    . ("ITEM")))
  "Alist of valid state transitions. Key=current state, value=list of allowed target states.")

(defun org-tasks-update-state (file custom-id new-state)
  "Update TODO state of item CUSTOM-ID in FILE to NEW-STATE.
Returns JSON string with result."
  (let ((abs-file (expand-file-name file)))
    (unless (file-exists-p abs-file)
      (error "File not found: %s" abs-file))
    (with-current-buffer (find-file-noselect abs-file)
      (org-mode)
      (org-tasks--setup-keywords)
      (goto-char (point-min))
      (let ((pos (org-find-property "CUSTOM_ID" custom-id)))
        (unless pos
          (error "Item %s not found in %s" custom-id abs-file))
        (goto-char pos)
        (let ((old-state (org-get-todo-state)))
          (unless old-state
            (error "Heading at %s has no TODO state" custom-id))
          (unless (member new-state org-tasks-todo-keywords)
            (error "Invalid state: %s (valid: %s)" new-state
                   (string-join org-tasks-todo-keywords ", ")))
          (let ((allowed (cdr (assoc old-state org-tasks-valid-transitions))))
            (unless (member new-state allowed)
              (error "Invalid transition: %s -> %s (allowed: %s)"
                     old-state new-state
                     (if allowed (string-join allowed ", ") "none"))))
          (org-todo new-state)
          (save-buffer)
          (json-encode
           `((success . t)
             (custom_id . ,custom-id)
             (old_state . ,old-state)
             (new_state . ,new-state)
             (file . ,abs-file))))))))

(defun org-tasks-add-todo (file title &optional properties)
  "Add new TODO item to FILE with TITLE and PROPERTIES alist.
Returns JSON string with result."
  (let ((abs-file (expand-file-name file)))
    (unless (file-exists-p abs-file)
      (error "File not found: %s" abs-file))
    ;; Validate effort format if provided
    (when-let ((effort (cdr (assoc "EFFORT" properties))))
      (unless (string-match org-tasks-effort-regexp effort)
        (error "Invalid EFFORT format: %s (expected Xh, Xm, or Xd)" effort)))
    ;; Validate layer if provided
    (when-let ((layer (cdr (assoc "LAYER" properties))))
      (unless (member layer org-tasks-valid-layers)
        (error "Invalid LAYER: %s (valid: %s)" layer
               (string-join org-tasks-valid-layers ", "))))
    (with-current-buffer (find-file-noselect abs-file)
      (org-mode)
      (org-tasks--setup-keywords)
      (goto-char (point-max))
      ;; Ensure newline before new heading
      (unless (bolp) (insert "\n"))
      (unless (= (char-before) ?\n) (insert "\n"))
      ;; Insert heading
      (let ((custom-id (or (cdr (assoc "CUSTOM_ID" properties))
                           (org-tasks--generate-id title))))
        (insert (format "* ITEM %s\n" title))
        (insert ":PROPERTIES:\n")
        (insert (format ":CUSTOM_ID: %s\n" custom-id))
        ;; Insert remaining properties
        (dolist (prop properties)
          (unless (string= (car prop) "CUSTOM_ID")
            (insert (format ":%s: %s\n" (car prop) (cdr prop)))))
        (insert ":END:\n")
        (save-buffer)
        (json-encode
         `((success . t)
           (custom_id . ,custom-id)
           (title . ,title)
           (file . ,abs-file)))))))

(defun org-tasks--generate-id (title)
  "Generate a CUSTOM_ID from TITLE.
Converts title to uppercase prefix + 3-digit number."
  (let* ((prefix (upcase (replace-regexp-in-string
                          "[^a-zA-Z0-9]" "-"
                          (substring title 0 (min 20 (length title))))))
         (num (format "%03d" (random 999))))
    (format "%s-%s" prefix num)))

(defun org-tasks-edit-body (file custom-id body mode)
  "Edit body text of item CUSTOM-ID in FILE.
BODY is the new text. MODE is \"replace\" or \"append\".
Returns JSON string with result."
  (let ((abs-file (expand-file-name file)))
    (unless (file-exists-p abs-file)
      (error "File not found: %s" abs-file))
    (unless (member mode '("replace" "append"))
      (error "Invalid mode: %s (must be \"replace\" or \"append\")" mode))
    (with-current-buffer (find-file-noselect abs-file)
      (org-mode)
      (org-tasks--setup-keywords)
      (goto-char (point-min))
      (let ((pos (org-find-property "CUSTOM_ID" custom-id)))
        (unless pos
          (error "Item %s not found in %s" custom-id abs-file))
        (goto-char pos)
        ;; Find body region: after property drawer, before next heading
        (let* ((elem (org-element-at-point))
               (contents-begin (org-element-property :contents-begin elem))
               (contents-end (org-element-property :contents-end elem))
               body-start body-end)
          ;; Skip past property drawer
          (goto-char (or contents-begin pos))
          (when (re-search-forward ":END:" contents-end t)
            (forward-line 1))
          (setq body-start (point))
          ;; Body ends at next heading or element content end
          (setq body-end (or contents-end (point-max)))
          ;; Find first sub-heading if any
          (save-excursion
            (when (re-search-forward "^\\*+ " body-end t)
              (setq body-end (line-beginning-position))))
          (if (string= mode "replace")
              (progn
                (delete-region body-start body-end)
                (goto-char body-start)
                (insert body "\n"))
            ;; append mode
            (goto-char body-end)
            (unless (bolp) (insert "\n"))
            (insert body "\n"))
          (save-buffer)
          (json-encode
           `((success . t)
             (custom_id . ,custom-id)
             (mode . ,mode)
             (file . ,abs-file))))))))

;;; CLI Entry Points

(defun org-tasks-validate-file-cli (file)
  "Validate FILE and print JSON to stdout."
  (princ (org-tasks-validate-file file)))

(defun org-tasks-validate-all-cli ()
  "Validate all files and print JSON to stdout."
  (princ (org-tasks-validate-all)))

(defun org-tasks-dashboard-cli ()
  "Print dashboard JSON to stdout."
  (princ (org-tasks-dashboard)))

(provide 'org-tasks)

;;; org-tasks.el ends here
