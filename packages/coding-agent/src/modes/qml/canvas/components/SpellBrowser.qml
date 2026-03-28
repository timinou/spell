import QtQuick 2.15
import QtQuick.Controls 2.15
import QtWebEngine
import "../.." as SpellUI

Item {
    id: root

    signal protocolEvent(var payload)

    property var browserProfile: null
    property string initialUrl: ""
    property bool autoLoadInitialUrl: true
    property int defaultTimeoutMs: 30000
    property int waitPollIntervalMs: 100
    property bool allowJavascriptConsoleEvents: true
    property var allowedSchemes: ({
        "about": true,
        "blob": true,
        "data": true,
        "http": true,
        "https": true
    })

    readonly property url currentUrl: webView.url
    readonly property string currentUrlString: webView.url ? webView.url.toString() : ""
    readonly property string pageTitle: webView.title || ""
    readonly property bool canGoBack: webView.canGoBack
    readonly property bool canGoForward: webView.canGoForward
    readonly property bool loading: webView.loading
    readonly property int isolatedWorldId: WebEngineScript.ApplicationWorld

    property string browserState: "idle"
    property string statusText: "Idle"
    property string lastError: ""
    property string lastConsoleMessage: ""
    property var lastObservation: ({})
    property var commandQueue: []
    property var activeCommand: null
    property int commandSequence: 0
    property bool commandRunning: false
    property bool helperReady: false
    property var loadStateHistory: []
    property bool recoveryActive: false
    property string recoveryStatusText: ""
    property int recoveryWindowMs: 3000
    property int recoveryPairThreshold: 3
    property int recoveryDelayMs: 1000
    property int maxLoadStateHistoryEntries: 10

    WebEngineProfile {
        id: ephemeralProfile
        offTheRecord: true
        persistentCookiesPolicy: WebEngineProfile.NoPersistentCookies
    }

    readonly property var activeProfile: root.browserProfile ? root.browserProfile : ephemeralProfile

    readonly property string browserCoreScript: `
(function() {
  if (window.__spellBrowser && window.__spellBrowser.__installed) {
    return true;
  }

  const INTERACTIVE_ROLES = new Set([
    "button",
    "checkbox",
    "combobox",
    "link",
    "listbox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "textbox",
    "treeitem"
  ]);

  const state = {
    nextObservedId: 1,
    observedElements: new Map()
  };

  function clip(value, maxLength) {
    const text = String(value == null ? "" : value);
    if (text.length <= maxLength) {
      return text;
    }
    return text.slice(0, Math.max(0, maxLength - 1)) + "…";
  }

  function compact(value) {
    return String(value == null ? "" : value).replace(/\\s+/g, " ").trim();
  }

  function ok(value) {
    return { ok: true, value: value === undefined ? null : value };
  }

  function fail(code, message, detail) {
    return {
      ok: false,
      error: {
        code,
        message,
        detail: detail === undefined ? null : detail
      }
    };
  }

  function resetObservedElements() {
    state.nextObservedId = 1;
    state.observedElements = new Map();
  }

  function rememberElement(element) {
    const id = state.nextObservedId++;
    state.observedElements.set(id, element);
    return id;
  }

  function resolveObservedElement(id) {
    const numericId = Number(id);
    if (!Number.isFinite(numericId)) {
      return null;
    }
    const element = state.observedElements.get(numericId);
    if (!(element instanceof Element) || !document.contains(element)) {
      return null;
    }
    return element;
  }

  function normalizeSelector(selector) {
    const raw = String(selector == null ? "" : selector).trim();
    if (!raw) {
      return "";
    }
    if (raw.indexOf("p-text/") === 0) {
      return "text/" + raw.slice("p-text/".length);
    }
    if (raw.indexOf("p-xpath/") === 0) {
      return "xpath/" + raw.slice("p-xpath/".length);
    }
    if (raw.indexOf("p-pierce/") === 0) {
      return "pierce/" + raw.slice("p-pierce/".length);
    }
    if (raw.indexOf("p-aria/") === 0) {
      const rest = raw.slice("p-aria/".length).trim();
      const marker = "[name=";
      if (rest.indexOf(marker) === 0) {
        let cleaned = rest.slice(marker.length);
        if (cleaned.charAt(cleaned.length - 1) === "]") {
          cleaned = cleaned.slice(0, -1);
        }
        if ((cleaned.charAt(0) === '"' && cleaned.charAt(cleaned.length - 1) === '"') || (cleaned.charAt(0) === "'" && cleaned.charAt(cleaned.length - 1) === "'")) {
          cleaned = cleaned.slice(1, -1);
        }
        return "aria/" + cleaned.trim();
      }
      return "aria/" + rest;
    }
    return raw;
  }

  function visibleRect(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left
    };
  }

  function isVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const style = getComputedStyle(element);
    if (!style) {
      return false;
    }
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 && rect.height < 1) {
      return false;
    }
    return true;
  }

  function intersectsViewport(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
  }

  function inferRole(element) {
    if (!(element instanceof Element)) {
      return "generic";
    }
    const explicitRole = compact(element.getAttribute("role") || "");
    if (explicitRole) {
      return explicitRole;
    }

    const tagName = element.tagName.toLowerCase();
    if (tagName === "a" && element.getAttribute("href")) {
      return "link";
    }
    if (tagName === "button") {
      return "button";
    }
    if (tagName === "summary") {
      return "button";
    }
    if (tagName === "textarea") {
      return "textbox";
    }
    if (tagName === "select") {
      return "combobox";
    }
    if (tagName === "option") {
      return "option";
    }
    if (tagName === "img") {
      return "img";
    }
    if (/^h[1-6]$/.test(tagName)) {
      return "heading";
    }
    if (tagName === "input") {
      const type = String(element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") {
        return "checkbox";
      }
      if (type === "radio") {
        return "radio";
      }
      if (type === "range") {
        return "slider";
      }
      if (type === "button" || type === "submit" || type === "reset") {
        return "button";
      }
      return "textbox";
    }
    if (element.hasAttribute("contenteditable")) {
      return "textbox";
    }
    return "generic";
  }

  function accessibleName(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    const ariaLabel = compact(element.getAttribute("aria-label") || "");
    if (ariaLabel) {
      return clip(ariaLabel, 180);
    }

    const labelledBy = compact(element.getAttribute("aria-labelledby") || "");
    if (labelledBy) {
      const text = labelledBy
        .split(/\\s+/)
        .map(id => {
          const label = document.getElementById(id);
          return label ? compact(label.textContent || "") : "";
        })
        .filter(Boolean)
        .join(" ");
      if (text) {
        return clip(text, 180);
      }
    }

    if (element instanceof HTMLInputElement) {
      const placeholder = compact(element.placeholder || "");
      if (placeholder) {
        return clip(placeholder, 180);
      }
      const value = compact(element.value || "");
      if (value) {
        return clip(value, 180);
      }
    }

    if (element instanceof HTMLImageElement) {
      const alt = compact(element.alt || "");
      if (alt) {
        return clip(alt, 180);
      }
    }

    const title = compact(element.getAttribute("title") || "");
    if (title) {
      return clip(title, 180);
    }

    const text = compact(element.innerText || element.textContent || "");
    return clip(text, 180);
  }

  function elementText(element) {
    if (!(element instanceof Element)) {
      return "";
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      return clip(compact(element.value || ""), 400);
    }
    return clip(compact(element.innerText || element.textContent || ""), 400);
  }

  function elementValue(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      return clip(String(element.value || ""), 240);
    }
    return "";
  }

  function cssPath(element) {
    if (!(element instanceof Element)) {
      return "";
    }
    if (element.id) {
      return "#" + element.id;
    }

    const parts = [];
    let node = element;
    let depth = 0;
    while (node && node instanceof Element && depth < 6) {
      let part = node.tagName.toLowerCase();
      if (node.classList && node.classList.length > 0) {
        part += "." + Array.from(node.classList).slice(0, 2).join(".");
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(child => child.tagName === node.tagName);
        if (siblings.length > 1) {
          part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
        }
      }
      parts.unshift(part);
      node = parent;
      depth += 1;
    }
    return parts.join(" > ");
  }

  function collectStates(element) {
    const states = [];
    if (!isVisible(element)) {
      states.push("hidden");
    }
    if (document.activeElement === element) {
      states.push("focused");
    }
    if (element.hasAttribute("disabled") || element.disabled === true) {
      states.push("disabled");
    }
    if (element.hasAttribute("readonly") || element.readOnly === true) {
      states.push("readonly");
    }
    if (element.checked !== undefined) {
      states.push("checked=" + String(Boolean(element.checked)));
    }
    const expanded = element.getAttribute("aria-expanded");
    if (expanded !== null) {
      states.push("expanded=" + expanded);
    }
    const selected = element.getAttribute("aria-selected");
    if (selected !== null) {
      states.push("selected=" + selected);
    }
    return states;
  }

  function isInteractive(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const role = inferRole(element);
    if (INTERACTIVE_ROLES.has(role)) {
      return true;
    }
    if (element.tabIndex >= 0) {
      return true;
    }
    if (element.hasAttribute("contenteditable")) {
      return true;
    }
    const tagName = element.tagName.toLowerCase();
    return tagName === "details" || tagName === "summary";
  }

  function serializeObservedElement(element) {
    const rect = visibleRect(element);
    return {
      id: rememberElement(element),
      tag: element.tagName.toLowerCase(),
      role: inferRole(element),
      name: accessibleName(element),
      text: elementText(element),
      value: elementValue(element),
      description: clip(compact(element.getAttribute("aria-description") || element.getAttribute("title") || ""), 180),
      selector: cssPath(element),
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      },
      states: collectStates(element)
    };
  }

  function serializeTarget(element) {
    if (!(element instanceof Element)) {
      return null;
    }
    const rect = visibleRect(element);
    return {
      tag: element.tagName.toLowerCase(),
      role: inferRole(element),
      name: accessibleName(element),
      text: elementText(element),
      selector: cssPath(element),
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      }
    };
  }

  function allElements() {
    const root = document.body || document.documentElement;
    if (!root) {
      return [];
    }
    return Array.from(root.querySelectorAll("*"));
  }

  function chooseBestTextCandidate(candidates, query) {
    if (!candidates.length) {
      return null;
    }
    const needle = query.toLowerCase();
    let best = null;
    let bestScore = -1;

    for (const element of candidates) {
      const name = accessibleName(element);
      const text = elementText(element);
      const haystack = (name || text || "").toLowerCase();
      if (!haystack) {
        continue;
      }

      let score = 1;
      if (haystack === needle) {
        score += 100;
      } else if (haystack.startsWith(needle)) {
        score += 50;
      } else if (haystack.indexOf(needle) >= 0) {
        score += 10;
      } else {
        continue;
      }
      if (isInteractive(element)) {
        score += 5;
      }
      const rect = element.getBoundingClientRect();
      score -= Math.min(20, Math.round(rect.top / 100));

      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }

    return best;
  }

  function queryByText(query) {
    const needle = compact(query);
    if (!needle) {
      return null;
    }
    const visible = allElements().filter(element => isVisible(element));
    return chooseBestTextCandidate(visible, needle);
  }

  function queryByAria(query) {
    const needle = compact(query).toLowerCase();
    if (!needle) {
      return null;
    }

    let exact = null;
    let partial = null;
    for (const element of allElements()) {
      if (!isVisible(element)) {
        continue;
      }
      const name = accessibleName(element).toLowerCase();
      const role = inferRole(element).toLowerCase();
      if (!name && !role) {
        continue;
      }
      const exactName = name === needle;
      const exactRole = role === needle;
      if (exactName || exactRole) {
        exact = element;
        break;
      }
      if (!partial && (name.indexOf(needle) >= 0 || role.indexOf(needle) >= 0)) {
        partial = element;
      }
    }
    return exact || partial;
  }

  function queryPierce(root, selector) {
    if (!root || typeof root.querySelector !== "function") {
      return null;
    }

    const direct = root.querySelector(selector);
    if (direct instanceof Element) {
      return direct;
    }

    const children = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
    for (const element of children) {
      if (element.shadowRoot) {
        const nested = queryPierce(element.shadowRoot, selector);
        if (nested instanceof Element) {
          return nested;
        }
      }
    }
    return null;
  }

  function queryByXPath(expression) {
    try {
      const result = document.evaluate(expression, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
    } catch (_err) {
      return null;
    }
  }

  function resolveSelector(selector) {
    const normalized = normalizeSelector(selector);
    if (!normalized) {
      return fail("invalid_payload", "A selector is required.");
    }

    let element = null;
    if (normalized.indexOf("text/") === 0) {
      element = queryByText(normalized.slice("text/".length));
    } else if (normalized.indexOf("aria/") === 0) {
      element = queryByAria(normalized.slice("aria/".length));
    } else if (normalized.indexOf("xpath/") === 0) {
      element = queryByXPath(normalized.slice("xpath/".length));
    } else if (normalized.indexOf("pierce/") === 0) {
      element = queryPierce(document, normalized.slice("pierce/".length));
    } else {
      try {
        element = document.querySelector(normalized);
      } catch (err) {
        return fail("invalid_payload", "Selector parsing failed.", { selector: normalized, error: String(err) });
      }
    }

    if (!(element instanceof Element)) {
      return fail("selector_not_found", "No element matched the selector.", { selector: normalized });
    }

    return ok({ element, selector: normalized });
  }

  function resolveTargetFromId(elementId) {
    const element = resolveObservedElement(elementId);
    if (!(element instanceof Element)) {
      return fail("stale_element", "Observed element is stale. Run observe again.", { elementId: Number(elementId) });
    }
    return ok({ element, elementId: Number(elementId) });
  }

  function findEditableTarget(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      return element;
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      return element;
    }
    const nested = element.querySelector("input, textarea, select, [contenteditable='true'], [contenteditable='']");
    if (nested instanceof HTMLElement || nested instanceof HTMLInputElement || nested instanceof HTMLTextAreaElement || nested instanceof HTMLSelectElement) {
      return nested;
    }
    return element;
  }

  function dispatchMouseSequence(target, point) {
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      buttons: 1,
      clientX: point.x,
      clientY: point.y
    };
    target.dispatchEvent(new PointerEvent("pointerdown", eventInit));
    target.dispatchEvent(new MouseEvent("mousedown", eventInit));
    target.dispatchEvent(new PointerEvent("pointerup", eventInit));
    target.dispatchEvent(new MouseEvent("mouseup", eventInit));
  }

  function clickableTarget(element) {
    if (!(element instanceof Element)) {
      return null;
    }
    const target = element.closest("a, button, summary, label, [role='button'], [role='link'], input[type='button'], input[type='submit'], input[type='checkbox'], input[type='radio']");
    return target || element;
  }

  function clickTarget(element) {
    if (!(element instanceof Element)) {
      return fail("selector_not_found", "No clickable element was resolved.");
    }
    const target = clickableTarget(element);
    if (!(target instanceof Element)) {
      return fail("selector_not_found", "No clickable element was resolved.");
    }
    if (!isVisible(target)) {
      return fail("selector_not_found", "The target element is not visible.", { selector: cssPath(target) });
    }

    target.scrollIntoView({ block: "center", inline: "center" });
    const rect = target.getBoundingClientRect();
    const point = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };

    if (target instanceof HTMLElement) {
      target.focus();
    }
    dispatchMouseSequence(target, point);
    if (typeof target.click === "function") {
      target.click();
    }

    return ok({
      point,
      target: serializeTarget(target)
    });
  }

  function setEditableValue(target, text, replace) {
    const value = String(text == null ? "" : text);
    const editable = findEditableTarget(target);

    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
      editable.focus();
      editable.value = replace ? value : String(editable.value || "") + value;
      editable.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: value,
        inputType: replace ? "insertReplacementText" : "insertText"
      }));
      editable.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return ok({ target: serializeTarget(editable), value: editable.value });
    }

    if (editable instanceof HTMLSelectElement) {
      editable.focus();
      editable.value = value;
      editable.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      editable.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return ok({ target: serializeTarget(editable), value: editable.value });
    }

    if (editable instanceof HTMLElement && editable.isContentEditable) {
      editable.focus();
      if (replace) {
        editable.textContent = value;
      } else {
        editable.textContent = String(editable.textContent || "") + value;
      }
      editable.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: value,
        inputType: replace ? "insertReplacementText" : "insertText"
      }));
      editable.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return ok({ target: serializeTarget(editable), value: compact(editable.textContent || "") });
    }

    return fail("invalid_payload", "The resolved target is not editable.", { selector: cssPath(target) });
  }

  function normalizeKey(key) {
    const raw = String(key == null ? "" : key);
    if (!raw) {
      return { key: "", code: "" };
    }
    const aliases = {
      Return: "Enter",
      Esc: "Escape",
      Spacebar: " ",
      Del: "Delete"
    };
    const normalizedKey = aliases[raw] || raw;
    const codeMap = {
      Enter: "Enter",
      Escape: "Escape",
      Tab: "Tab",
      Backspace: "Backspace",
      Delete: "Delete",
      ArrowUp: "ArrowUp",
      ArrowDown: "ArrowDown",
      ArrowLeft: "ArrowLeft",
      ArrowRight: "ArrowRight",
      " ": "Space"
    };
    return { key: normalizedKey, code: codeMap[normalizedKey] || normalizedKey };
  }

  function focusableElements() {
    return allElements().filter(element => {
      if (!isVisible(element)) {
        return false;
      }
      if (element instanceof HTMLElement) {
        return element.tabIndex >= 0 || /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(element.tagName) || element.isContentEditable;
      }
      return false;
    });
  }

  function moveFocusForward() {
    const focusables = focusableElements();
    if (focusables.length === 0) {
      return null;
    }
    const active = document.activeElement;
    const index = focusables.indexOf(active instanceof Element ? active : null);
    const next = focusables[(index + 1 + focusables.length) % focusables.length];
    if (next instanceof HTMLElement) {
      next.focus();
      return next;
    }
    return null;
  }

  function pressKey(key) {
    const normalized = normalizeKey(key);
    if (!normalized.key) {
      return fail("invalid_payload", "A key is required.");
    }

    let target = document.activeElement instanceof Element ? document.activeElement : document.body;
    if (!(target instanceof Element)) {
      return fail("unavailable", "No active element is available.");
    }

    if (normalized.key === "Tab") {
      const next = moveFocusForward();
      if (next instanceof Element) {
        target = next;
      }
    }

    const eventInit = {
      key: normalized.key,
      code: normalized.code,
      bubbles: true,
      cancelable: true,
      composed: true
    };
    target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    target.dispatchEvent(new KeyboardEvent("keypress", eventInit));
    target.dispatchEvent(new KeyboardEvent("keyup", eventInit));

    if (normalized.key === "Enter") {
      const clickable = clickableTarget(target);
      if (clickable && typeof clickable.click === "function") {
        clickable.click();
      }
    }

    return ok({ key: normalized.key, target: serializeTarget(target) });
  }

  function scrollWindowBy(deltaX, deltaY) {
    const dx = Number(deltaX || 0);
    const dy = Number(deltaY || 0);
    window.scrollBy(dx, dy);
    return ok({
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      scrollWidth: document.documentElement ? document.documentElement.scrollWidth : window.innerWidth,
      scrollHeight: document.documentElement ? document.documentElement.scrollHeight : window.innerHeight
    });
  }

  function scrollElementBy(target, deltaX, deltaY) {
    target.scrollLeft += Number(deltaX || 0);
    target.scrollTop += Number(deltaY || 0);
    return ok({
      target: serializeTarget(target),
      scrollLeft: target.scrollLeft,
      scrollTop: target.scrollTop
    });
  }

  function createDragEvent(type, point) {
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.x,
      clientY: point.y
    };
    try {
      if (typeof DataTransfer === "function") {
        init.dataTransfer = new DataTransfer();
      }
      return new DragEvent(type, init);
    } catch (_err) {
      return new Event(type, { bubbles: true, cancelable: true, composed: true });
    }
  }

  function dragBetween(source, target) {
    if (!(source instanceof Element) || !(target instanceof Element)) {
      return fail("selector_not_found", "Drag endpoints were not resolved.");
    }
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const sourcePoint = { x: sourceRect.left + sourceRect.width / 2, y: sourceRect.top + sourceRect.height / 2 };
    const targetPoint = { x: targetRect.left + targetRect.width / 2, y: targetRect.top + targetRect.height / 2 };

    source.dispatchEvent(createDragEvent("dragstart", sourcePoint));
    target.dispatchEvent(createDragEvent("dragenter", targetPoint));
    target.dispatchEvent(createDragEvent("dragover", targetPoint));
    target.dispatchEvent(createDragEvent("drop", targetPoint));
    source.dispatchEvent(createDragEvent("dragend", targetPoint));

    return ok({
      from: serializeTarget(source),
      to: serializeTarget(target)
    });
  }

  function currentViewport() {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      deviceScaleFactor: window.devicePixelRatio || 1
    };
  }

  function currentScroll() {
    const doc = document.documentElement || document.body;
    return {
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      scrollWidth: doc ? doc.scrollWidth : window.innerWidth,
      scrollHeight: doc ? doc.scrollHeight : window.innerHeight
    };
  }

  function observe(options) {
    const includeAll = Boolean(options && options.includeAll);
    const viewportOnly = Boolean(options && options.viewportOnly);
    const rawLimit = Number(options && options.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(1000, rawLimit) : (includeAll ? 250 : 120);

    resetObservedElements();
    const entries = [];
    for (const element of allElements()) {
      if (!isVisible(element)) {
        continue;
      }
      if (!includeAll && !isInteractive(element)) {
        continue;
      }
      if (viewportOnly && !intersectsViewport(element)) {
        continue;
      }
      entries.push(serializeObservedElement(element));
      if (entries.length >= limit) {
        break;
      }
    }

    return ok({
      url: location.href,
      title: document.title,
      viewport: currentViewport(),
      scroll: currentScroll(),
      elements: entries
    });
  }

  function selectorExists(selector, visibleOnly) {
    const resolved = resolveSelector(selector);
    if (!resolved.ok) {
      return ok({ found: false });
    }
    const element = resolved.value.element;
    if (visibleOnly && !isVisible(element)) {
      return ok({ found: false });
    }
    return ok({ found: true, target: serializeTarget(element) });
  }

  function evaluateScript(scriptSource) {
    const source = String(scriptSource == null ? "" : scriptSource);
    if (!source.trim()) {
      return fail("invalid_payload", "A script is required.");
    }
    try {
      return ok(eval(source));
    } catch (err) {
      return fail("script_error", String(err));
    }
  }

  function clickSelector(selector) {
    const resolved = resolveSelector(selector);
    if (!resolved.ok) {
      return resolved;
    }
    return clickTarget(resolved.value.element);
  }

  function clickElementId(elementId) {
    const resolved = resolveTargetFromId(elementId);
    if (!resolved.ok) {
      return resolved;
    }
    return clickTarget(resolved.value.element);
  }

  function clickPoint(x, y) {
    const element = document.elementFromPoint(Number(x || 0), Number(y || 0));
    if (!(element instanceof Element)) {
      return fail("selector_not_found", "No element exists at the requested coordinates.", { x: Number(x || 0), y: Number(y || 0) });
    }
    return clickTarget(element);
  }

  function typeSelector(selector, text) {
    const resolved = resolveSelector(selector);
    if (!resolved.ok) {
      return resolved;
    }
    return setEditableValue(resolved.value.element, text, false);
  }

  function typeElementId(elementId, text) {
    const resolved = resolveTargetFromId(elementId);
    if (!resolved.ok) {
      return resolved;
    }
    return setEditableValue(resolved.value.element, text, false);
  }

  function fillSelector(selector, value) {
    const resolved = resolveSelector(selector);
    if (!resolved.ok) {
      return resolved;
    }
    return setEditableValue(resolved.value.element, value, true);
  }

  function fillElementId(elementId, value) {
    const resolved = resolveTargetFromId(elementId);
    if (!resolved.ok) {
      return resolved;
    }
    return setEditableValue(resolved.value.element, value, true);
  }

  function scrollSelector(selector, deltaX, deltaY) {
    const resolved = resolveSelector(selector);
    if (!resolved.ok) {
      return resolved;
    }
    return scrollElementBy(resolved.value.element, deltaX, deltaY);
  }

  function scrollElementId(elementId, deltaX, deltaY) {
    const resolved = resolveTargetFromId(elementId);
    if (!resolved.ok) {
      return resolved;
    }
    return scrollElementBy(resolved.value.element, deltaX, deltaY);
  }

  function dragSelectors(fromSelector, toSelector) {
    const fromResolved = resolveSelector(fromSelector);
    if (!fromResolved.ok) {
      return fromResolved;
    }
    const toResolved = resolveSelector(toSelector);
    if (!toResolved.ok) {
      return toResolved;
    }
    return dragBetween(fromResolved.value.element, toResolved.value.element);
  }

  function dragElementIds(fromId, toId) {
    const fromResolved = resolveTargetFromId(fromId);
    if (!fromResolved.ok) {
      return fromResolved;
    }
    const toResolved = resolveTargetFromId(toId);
    if (!toResolved.ok) {
      return toResolved;
    }
    return dragBetween(fromResolved.value.element, toResolved.value.element);
  }

  function dragPoints(fromX, fromY, toX, toY) {
    const fromElement = document.elementFromPoint(Number(fromX || 0), Number(fromY || 0));
    const toElement = document.elementFromPoint(Number(toX || 0), Number(toY || 0));
    if (!(fromElement instanceof Element) || !(toElement instanceof Element)) {
      return fail("selector_not_found", "Drag endpoints were not resolved.", {
        from: { x: Number(fromX || 0), y: Number(fromY || 0) },
        to: { x: Number(toX || 0), y: Number(toY || 0) }
      });
    }
    return dragBetween(fromElement, toElement);
  }

  function getText(requests) {
    return ok(requests.map(request => {
      const resolved = resolveSelector(request.selector);
      if (!resolved.ok) {
        return { selector: request.selector, error: resolved.error };
      }
      return {
        selector: request.selector,
        text: elementText(resolved.value.element)
      };
    }));
  }

  function getHtml(requests) {
    return ok(requests.map(request => {
      const resolved = resolveSelector(request.selector);
      if (!resolved.ok) {
        return { selector: request.selector, error: resolved.error };
      }
      return {
        selector: request.selector,
        html: resolved.value.element.outerHTML || ""
      };
    }));
  }

  function getAttribute(requests) {
    return ok(requests.map(request => {
      const resolved = resolveSelector(request.selector);
      if (!resolved.ok) {
        return { selector: request.selector, attribute: request.attribute, error: resolved.error };
      }
      return {
        selector: request.selector,
        attribute: request.attribute,
        value: resolved.value.element.getAttribute(String(request.attribute || ""))
      };
    }));
  }

  function readableRoot() {
    return document.querySelector("article, main, [role='main'], .article, .post, .content") || document.body || document.documentElement;
  }

  function readableByline() {
    const candidate = document.querySelector("[rel='author'], .byline, [itemprop='author']");
    if (!(candidate instanceof Element)) {
      return "";
    }
    return clip(compact(candidate.textContent || ""), 180);
  }

  function readableBlocks(root) {
    const blocks = [];
    const selector = "h1, h2, h3, h4, h5, h6, p, li, blockquote, pre";
    const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : [];
    for (const element of nodes) {
      const text = compact(element.innerText || element.textContent || "");
      if (!text) {
        continue;
      }
      blocks.push({ tag: element.tagName.toLowerCase(), text: clip(text, 1200) });
      if (blocks.length >= 240) {
        break;
      }
    }
    if (blocks.length === 0) {
      const fallback = compact(root.innerText || root.textContent || "");
      if (fallback) {
        blocks.push({ tag: "p", text: clip(fallback, 6000) });
      }
    }
    return blocks;
  }

  function blocksToText(blocks) {
    return blocks.map(block => block.text).join("\\n\\n");
  }

  function blocksToMarkdown(blocks) {
    return blocks.map(block => {
      if (/^h[1-6]$/.test(block.tag)) {
        const level = Number(block.tag.slice(1));
        return "#".repeat(Math.max(1, Math.min(6, level))) + " " + block.text;
      }
      if (block.tag === "li") {
        return "- " + block.text;
      }
      if (block.tag === "blockquote") {
        return "> " + block.text;
      }
      if (block.tag === "pre") {
        return "~~~\\n" + block.text + "\\n~~~";
      }
      return block.text;
    }).join("\\n\\n");
  }

  function extractReadable(_format) {
    const root = readableRoot();
    const blocks = readableBlocks(root);
    const text = blocksToText(blocks);
    const markdown = blocksToMarkdown(blocks);
    return ok({
      url: location.href,
      title: document.title,
      byline: readableByline(),
      excerpt: clip(text, 240),
      contentLength: text.length,
      text,
      markdown
    });
  }

  window.__spellBrowser = {
    __installed: true,
    observe,
    selectorExists,
    evaluateScript,
    clickSelector,
    clickElementId,
    clickPoint,
    typeSelector,
    typeElementId,
    fillSelector,
    fillElementId,
    pressKey,
    scrollWindowBy,
    scrollSelector,
    scrollElementId,
    dragSelectors,
    dragElementIds,
    dragPoints,
    getText,
    getHtml,
    getAttribute,
    extractReadable,
    resetObservedElements
  };

  return true;
})();`

    function sendProtocol(payload) {
        root.protocolEvent(payload)
    }

    function emitState(silent) {
        sendProtocol({
            action: "browser:state",
            state: browserState,
            url: currentUrlString,
            title: pageTitle,
            loading: loading,
            statusText: statusText,
            lastError: lastError,
            canGoBack: canGoBack,
            canGoForward: canGoForward,
            silent: silent !== false
        })
    }

    function emitUrlChanged() {
        sendProtocol({
            action: "browser:url_changed",
            url: currentUrlString,
            title: pageTitle,
            silent: true
        })
    }

    function makeResultPayload(command, ok, result, error) {
        return {
            action: "browser:result",
            _rid: command.rid,
            command: command.action,
            ok: ok,
            result: result === undefined ? null : result,
            error: error === undefined ? null : error,
            url: currentUrlString,
            title: pageTitle,
            state: browserState
        }
    }

    function completeActiveCommand(result) {
        if (!activeCommand || activeCommand.completed) {
            return
        }

        var command = activeCommand
        command.completed = true
        commandTimeout.stop()
        waitPollTimer.stop()
        commandRunning = false
        activeCommand = null

        if (command.rid) {
            sendProtocol(makeResultPayload(command, true, result, undefined))
        }
        processQueue()
    }

    function failActiveCommand(code, message, detail) {
        if (!activeCommand || activeCommand.completed) {
            return
        }

        var command = activeCommand
        command.completed = true
        commandTimeout.stop()
        waitPollTimer.stop()
        commandRunning = false
        activeCommand = null

        if (command.rid) {
            sendProtocol(makeResultPayload(command, false, undefined, {
                code: code,
                message: message,
                detail: detail === undefined ? null : detail
            }))
        }
        processQueue()
    }

    function isFiniteNumber(value) {
        return typeof value === "number" && isFinite(value)
    }

    function fieldValue(payload, names) {
        for (var i = 0; i < names.length; i++) {
            var name = names[i]
            if (payload[name] !== undefined && payload[name] !== null) {
                return payload[name]
            }
        }
        return null
    }

    function stringField(payload, names) {
        var value = fieldValue(payload, names)
        if (typeof value === "string") {
            var trimmed = value.trim()
            return trimmed.length > 0 ? trimmed : ""
        }
        return ""
    }

    function numberField(payload, names) {
        var value = fieldValue(payload, names)
        if (isFiniteNumber(value)) {
            return value
        }
        if (typeof value === "string" && value.trim().length > 0) {
            var parsed = Number(value)
            if (isFinite(parsed)) {
                return parsed
            }
        }
        return null
    }

    function booleanField(payload, names) {
        var value = fieldValue(payload, names)
        if (typeof value === "boolean") {
            return value
        }
        return false
    }

    function normalizeNavigationTarget(rawValue) {
        var trimmed = String(rawValue == null ? "" : rawValue).trim()
        if (!trimmed) {
            return ""
        }

        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
            return trimmed
        }
        if (trimmed.indexOf("//") === 0) {
            return "https:" + trimmed
        }

        if (currentUrlString) {
            try {
                return new URL(trimmed, currentUrlString).toString()
            } catch (_err) {
            }
        }

        if (/^[^\\s]+\.[^\\s]+/.test(trimmed)) {
            return "https://" + trimmed
        }
        return trimmed
    }

    function parseScheme(value) {
        var match = String(value || "").match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)
        return match ? match[1].toLowerCase() : ""
    }

    function isAllowedNavigationTarget(value) {
        var scheme = parseScheme(value)
        if (!scheme) {
            return false
        }
        return allowedSchemes[scheme] === true
    }

    function normalizedTimeoutMs(payload) {
        var explicitMs = numberField(payload, ["timeout_ms", "timeoutMs"])
        if (explicitMs !== null) {
            return Math.max(100, Math.min(120000, explicitMs))
        }
        var explicitSeconds = numberField(payload, ["timeout"])
        if (explicitSeconds !== null) {
            return Math.max(100, Math.min(120000, explicitSeconds * 1000))
        }
        return defaultTimeoutMs
    }

    function normalizeCommandPayload(payload) {
        var action = typeof payload.action === "string" ? payload.action : ""
        if (action.indexOf("browser:") !== 0) {
            return null
        }

        var allowed = {
            "browser:sync": true,
            "browser:goto": true,
            "browser:force_reload": true,
            "browser:evaluate": true,
            "browser:observe": true,
            "browser:click": true,
            "browser:type": true,
            "browser:fill": true,
            "browser:press": true,
            "browser:scroll": true,
            "browser:drag": true,
            "browser:wait_for_selector": true,
            "browser:get_text": true,
            "browser:get_html": true,
            "browser:get_attribute": true,
            "browser:extract_readable": true,
            "browser:screenshot": true
        }

        if (!allowed[action]) {
            return {
                error: {
                    code: "invalid_action",
                    message: "Unsupported browser action: " + action
                }
            }
        }

        return {
            sequence: ++commandSequence,
            action: action,
            rid: typeof payload._rid === "string" ? payload._rid : "",
            payload: payload,
            timeoutMs: normalizedTimeoutMs(payload),
            completed: false,
            waitPollStartedAt: 0
        }
    }

    function enqueueCommand(payload) {
        var command = normalizeCommandPayload(payload)
        if (!command) {
            return
        }

        if (command.error) {
            if (typeof payload._rid === "string" && payload._rid.length > 0) {
                sendProtocol({
                    action: "browser:result",
                    _rid: payload._rid,
                    command: typeof payload.action === "string" ? payload.action : "browser:unknown",
                    ok: false,
                    result: null,
                    error: command.error,
                    url: currentUrlString,
                    title: pageTitle,
                    state: browserState
                })
            }
            return
        }

        commandQueue = commandQueue.concat([command])
        processQueue()
    }

    function processQueue() {
        if (commandRunning) {
            return
        }
        if (!commandQueue || commandQueue.length === 0) {
            return
        }

        var next = commandQueue[0]
        commandQueue = commandQueue.slice(1)
        activeCommand = next
        commandRunning = true
        commandTimeout.interval = next.timeoutMs
        commandTimeout.start()
        executeActiveCommand(next)
    }

    function ensureBrowserHelper(callback) {
        if (helperReady) {
            callback(true)
            return
        }
        webView.runJavaScript(browserCoreScript, isolatedWorldId, function(result) {
            helperReady = result === true
            callback(helperReady)
        })
    }

    function helperCall(methodName, argsExpression, callback) {
        ensureBrowserHelper(function(ok) {
            if (!ok) {
                callback({ ok: false, error: { code: "unavailable", message: "SpellBrowser helper is unavailable." } })
                return
            }
            var script = "(function(){" +
                "if (!window.__spellBrowser || typeof window.__spellBrowser." + methodName + " !== 'function') {" +
                "return { ok: false, error: { code: 'unavailable', message: 'SpellBrowser helper is unavailable.' } };" +
                "}" +
                "return window.__spellBrowser." + methodName + "(" + argsExpression + ");" +
                "})()"
            webView.runJavaScript(script, isolatedWorldId, callback)
        })
    }

    function handleHelperResult(result) {
        if (!result || typeof result !== "object") {
            return {
                ok: false,
                error: {
                    code: "unavailable",
                    message: "Browser helper returned no result."
                }
            }
        }
        if (result.ok === true) {
            return {
                ok: true,
                value: result.value
            }
        }
        return {
            ok: false,
            error: result.error || {
                code: "unavailable",
                message: "Browser helper returned an invalid error."
            }
        }
    }

    function requestList(payload) {
        if (Array.isArray(payload.args) && payload.args.length > 0) {
            return payload.args
        }

        var selector = stringField(payload, ["selector"])
        if (!selector) {
            return []
        }

        if (payload.action === "browser:get_attribute") {
            return [{ selector: selector, attribute: stringField(payload, ["attribute"]) }]
        }

        return [{ selector: selector }]
    }

    function executeActiveCommand(command) {
        var payload = command.payload
        switch (command.action) {
        case "browser:sync":
            completeActiveCommand({
                url: currentUrlString,
                title: pageTitle,
                state: browserState,
                statusText: statusText,
                lastError: lastError,
                canGoBack: canGoBack,
                canGoForward: canGoForward,
                loading: loading,
                lastObservation: lastObservation
            })
            return
        case "browser:goto":
            startNavigationCommand(command)
            return
        case "browser:force_reload":
            executeForceReloadCommand()
            return
        case "browser:evaluate":
            executeEvaluateCommand(payload)
            return
        case "browser:observe":
            executeObserveCommand(payload)
            return
        case "browser:click":
            executeClickCommand(payload)
            return
        case "browser:type":
            executeTypeCommand(payload)
            return
        case "browser:fill":
            executeFillCommand(payload)
            return
        case "browser:press":
            executePressCommand(payload)
            return
        case "browser:scroll":
            executeScrollCommand(payload)
            return
        case "browser:drag":
            executeDragCommand(payload)
            return
        case "browser:wait_for_selector":
            startWaitForSelectorCommand(command)
            return
        case "browser:get_text":
            executeGetCommand("getText", payload)
            return
        case "browser:get_html":
            executeGetCommand("getHtml", payload)
            return
        case "browser:get_attribute":
            executeGetCommand("getAttribute", payload)
            return
        case "browser:extract_readable":
            executeReadableCommand(payload)
            return
        case "browser:screenshot":
            executeScreenshotCommand(payload)
            return
        default:
            failActiveCommand("invalid_action", "Unsupported browser action: " + command.action)
            return
        }
    }

    function isPageLoadCommand(command) {
        return !!command && (command.action === "browser:goto" || command.action === "browser:force_reload")
    }

    function startNavigationCommand(command) {
        var target = normalizeNavigationTarget(stringField(command.payload, ["url"]))
        if (!target) {
            failActiveCommand("invalid_payload", "A URL is required for browser:goto.")
            return
        }
        if (!isAllowedNavigationTarget(target)) {
            failActiveCommand("navigation_blocked", "Navigation target is blocked by scheme policy.", {
                url: target,
                scheme: parseScheme(target)
            })
            return
        }

        lastError = ""
        statusText = "Loading " + target
        browserState = "loading"
        finishRecovery()
        emitState(true)
        webView.url = target
    }

    function executeForceReloadCommand() {
        finishRecovery()
        startRecovery("Force reloading...", 1)
        webView.stop()
        recoveryTimer.restart()
    }

    function executeEvaluateCommand(payload) {
        var script = stringField(payload, ["script", "expression"])
        if (!script) {
            failActiveCommand("invalid_payload", "A script is required for browser:evaluate.")
            return
        }
        var wrapped = "(function(){ try { return eval(" + JSON.stringify(script) + "); } catch (err) { return { __spellBrowserEvalError: String(err) }; } })()"
        webView.runJavaScript(wrapped, function(result) {
            if (result && typeof result === "object" && result.__spellBrowserEvalError) {
                failActiveCommand("script_error", String(result.__spellBrowserEvalError))
                return
            }
            completeActiveCommand(result)
        })
    }

    function executeObserveCommand(payload) {
        var options = {
            includeAll: booleanField(payload, ["include_all", "includeAll"]),
            viewportOnly: booleanField(payload, ["viewport_only", "viewportOnly"]),
            limit: numberField(payload, ["limit"])
        }
        helperCall("observe", JSON.stringify(options), function(result) {
            var response = handleHelperResult(result)
            if (response.ok) {
                lastObservation = response.value
                completeActiveCommand(response.value)
            } else {
                failActiveCommand(response.error.code || "unavailable", response.error.message || "Observe failed.", response.error.detail)
            }
        })
    }

    function executeClickCommand(payload) {
        var elementId = numberField(payload, ["element_id", "elementId"])
        if (elementId !== null) {
            helperCall("clickElementId", JSON.stringify(elementId), function(result) {
                var response = handleHelperResult(result)
                if (response.ok) {
                    completeActiveCommand(response.value)
                } else {
                    failActiveCommand(response.error.code || "stale_element", response.error.message || "Click failed.", response.error.detail)
                }
            })
            return
        }

        var selector = stringField(payload, ["selector"])
        if (selector) {
            helperCall("clickSelector", JSON.stringify(selector), function(result) {
                var response = handleHelperResult(result)
                if (response.ok) {
                    completeActiveCommand(response.value)
                } else {
                    failActiveCommand(response.error.code || "selector_not_found", response.error.message || "Click failed.", response.error.detail)
                }
            })
            return
        }

        var x = numberField(payload, ["x"])
        var y = numberField(payload, ["y"])
        if (x !== null && y !== null) {
            helperCall("clickPoint", JSON.stringify(x) + "," + JSON.stringify(y), function(result) {
                var response = handleHelperResult(result)
                if (response.ok) {
                    completeActiveCommand(response.value)
                } else {
                    failActiveCommand(response.error.code || "selector_not_found", response.error.message || "Click failed.", response.error.detail)
                }
            })
            return
        }

        failActiveCommand("invalid_payload", "browser:click requires selector, element_id, or x/y coordinates.")
    }

    function executeTypeCommand(payload) {
        var text = String(fieldValue(payload, ["text"]) || "")
        if (!text.length) {
            failActiveCommand("invalid_payload", "browser:type requires non-empty text.")
            return
        }

        var elementId = numberField(payload, ["element_id", "elementId"])
        if (elementId !== null) {
            helperCall("typeElementId", JSON.stringify(elementId) + "," + JSON.stringify(text), function(result) {
                var response = handleHelperResult(result)
                if (response.ok) {
                    completeActiveCommand(response.value)
                } else {
                    failActiveCommand(response.error.code || "stale_element", response.error.message || "Type failed.", response.error.detail)
                }
            })
            return
        }

        var selector = stringField(payload, ["selector"])
        if (!selector) {
            failActiveCommand("invalid_payload", "browser:type requires selector or element_id.")
            return
        }
        helperCall("typeSelector", JSON.stringify(selector) + "," + JSON.stringify(text), function(result) {
            var response = handleHelperResult(result)
            if (response.ok) {
                completeActiveCommand(response.value)
            } else {
                failActiveCommand(response.error.code || "selector_not_found", response.error.message || "Type failed.", response.error.detail)
            }
        })
    }

    function executeFillCommand(payload) {
        var value = String(fieldValue(payload, ["value", "text"]) || "")
        var elementId = numberField(payload, ["element_id", "elementId"])
        if (elementId !== null) {
            helperCall("fillElementId", JSON.stringify(elementId) + "," + JSON.stringify(value), function(result) {
                var response = handleHelperResult(result)
                if (response.ok) {
                    completeActiveCommand(response.value)
                } else {
                    failActiveCommand(response.error.code || "stale_element", response.error.message || "Fill failed.", response.error.detail)
                }
            })
            return
        }

        var selector = stringField(payload, ["selector"])
        if (!selector) {
            failActiveCommand("invalid_payload", "browser:fill requires selector or element_id.")
            return
        }
        helperCall("fillSelector", JSON.stringify(selector) + "," + JSON.stringify(value), function(result) {
            var response = handleHelperResult(result)
            if (response.ok) {
                completeActiveCommand(response.value)
            } else {
                failActiveCommand(response.error.code || "selector_not_found", response.error.message || "Fill failed.", response.error.detail)
            }
        })
    }

    function executePressCommand(payload) {
        var key = stringField(payload, ["key"])
        if (!key) {
            failActiveCommand("invalid_payload", "browser:press requires a key.")
            return
        }
        helperCall("pressKey", JSON.stringify(key), function(result) {
            var response = handleHelperResult(result)
            if (response.ok) {
                completeActiveCommand(response.value)
            } else {
                failActiveCommand(response.error.code || "invalid_payload", response.error.message || "Key press failed.", response.error.detail)
            }
        })
    }

    function executeScrollCommand(payload) {
        var deltaX = numberField(payload, ["delta_x", "deltaX"])
        var deltaY = numberField(payload, ["delta_y", "deltaY"])
        var dx = deltaX === null ? 0 : deltaX
        var dy = deltaY === null ? 0 : deltaY

        var elementId = numberField(payload, ["element_id", "elementId"])
        if (elementId !== null) {
            helperCall("scrollElementId", JSON.stringify(elementId) + "," + JSON.stringify(dx) + "," + JSON.stringify(dy), function(result) {
                var response = handleHelperResult(result)
                if (response.ok) {
                    completeActiveCommand(response.value)
                } else {
                    failActiveCommand(response.error.code || "stale_element", response.error.message || "Scroll failed.", response.error.detail)
                }
            })
            return
        }

        var selector = stringField(payload, ["selector"])
        if (selector) {
            helperCall("scrollSelector", JSON.stringify(selector) + "," + JSON.stringify(dx) + "," + JSON.stringify(dy), function(result) {
                var response = handleHelperResult(result)
                if (response.ok) {
                    completeActiveCommand(response.value)
                } else {
                    failActiveCommand(response.error.code || "selector_not_found", response.error.message || "Scroll failed.", response.error.detail)
                }
            })
            return
        }

        helperCall("scrollWindowBy", JSON.stringify(dx) + "," + JSON.stringify(dy), function(result) {
            var response = handleHelperResult(result)
            if (response.ok) {
                completeActiveCommand(response.value)
            } else {
                failActiveCommand(response.error.code || "unavailable", response.error.message || "Scroll failed.", response.error.detail)
            }
        })
    }

    function executeDragCommand(payload) {
        var fromElementId = numberField(payload, ["from_element_id", "fromElementId"])
        var toElementId = numberField(payload, ["to_element_id", "toElementId"])
        if (fromElementId !== null && toElementId !== null) {
            helperCall("dragElementIds", JSON.stringify(fromElementId) + "," + JSON.stringify(toElementId), function(result) {
                var response = handleHelperResult(result)
                if (response.ok) {
                    completeActiveCommand(response.value)
                } else {
                    failActiveCommand(response.error.code || "stale_element", response.error.message || "Drag failed.", response.error.detail)
                }
            })
            return
        }

        var fromSelector = stringField(payload, ["from_selector", "fromSelector"])
        var toSelector = stringField(payload, ["to_selector", "toSelector"])
        if (fromSelector && toSelector) {
            helperCall("dragSelectors", JSON.stringify(fromSelector) + "," + JSON.stringify(toSelector), function(result) {
                var response = handleHelperResult(result)
                if (response.ok) {
                    completeActiveCommand(response.value)
                } else {
                    failActiveCommand(response.error.code || "selector_not_found", response.error.message || "Drag failed.", response.error.detail)
                }
            })
            return
        }

        var fromX = numberField(payload, ["from_x", "fromX"])
        var fromY = numberField(payload, ["from_y", "fromY"])
        var toX = numberField(payload, ["to_x", "toX"])
        var toY = numberField(payload, ["to_y", "toY"])
        if (fromX !== null && fromY !== null && toX !== null && toY !== null) {
            helperCall(
                "dragPoints",
                JSON.stringify(fromX) + "," + JSON.stringify(fromY) + "," + JSON.stringify(toX) + "," + JSON.stringify(toY),
                function(result) {
                    var response = handleHelperResult(result)
                    if (response.ok) {
                        completeActiveCommand(response.value)
                    } else {
                        failActiveCommand(response.error.code || "selector_not_found", response.error.message || "Drag failed.", response.error.detail)
                    }
                }
            )
            return
        }

        failActiveCommand("invalid_payload", "browser:drag requires from/to selectors, element ids, or coordinates.")
    }

    function startWaitForSelectorCommand(command) {
        var selector = stringField(command.payload, ["selector"])
        if (!selector) {
            failActiveCommand("invalid_payload", "browser:wait_for_selector requires a selector.")
            return
        }
        command.waitPollStartedAt = Date.now()
        waitPollTimer.start()
        pollWaitForSelector()
    }

    function pollWaitForSelector() {
        if (!activeCommand || activeCommand.action !== "browser:wait_for_selector") {
            return
        }

        var selector = stringField(activeCommand.payload, ["selector"])
        var visibleOnly = booleanField(activeCommand.payload, ["visible", "visible_only", "visibleOnly"])
        helperCall("selectorExists", JSON.stringify(selector) + "," + JSON.stringify(visibleOnly), function(result) {
            var response = handleHelperResult(result)
            if (!activeCommand || activeCommand.action !== "browser:wait_for_selector") {
                return
            }
            if (!response.ok) {
                failActiveCommand(response.error.code || "selector_not_found", response.error.message || "wait_for_selector failed.", response.error.detail)
                return
            }
            if (response.value && response.value.found) {
                completeActiveCommand(response.value)
                return
            }
            waitPollTimer.start()
        })
    }

    function executeGetCommand(methodName, payload) {
        var requests = requestList(payload)
        if (!requests.length) {
            failActiveCommand("invalid_payload", payload.action + " requires selector or args.")
            return
        }
        helperCall(methodName, JSON.stringify(requests), function(result) {
            var response = handleHelperResult(result)
            if (response.ok) {
                var value = response.value
                if (requests.length === 1 && value && typeof value !== "string" && typeof value.length === "number") {
                    completeActiveCommand(value[0])
                } else {
                    completeActiveCommand(value)
                }
            } else {
                failActiveCommand(response.error.code || "selector_not_found", response.error.message || "Browser getter failed.", response.error.detail)
            }
        })
    }

    function executeReadableCommand(payload) {
        var format = stringField(payload, ["format"]) || "markdown"
        helperCall("extractReadable", JSON.stringify(format), function(result) {
            var response = handleHelperResult(result)
            if (!response.ok) {
                failActiveCommand(response.error.code || "unavailable", response.error.message || "extract_readable failed.", response.error.detail)
                return
            }
            if (format === "text") {
                completeActiveCommand({
                    url: response.value.url,
                    title: response.value.title,
                    byline: response.value.byline,
                    excerpt: response.value.excerpt,
                    contentLength: response.value.contentLength,
                    text: response.value.text
                })
            } else {
                completeActiveCommand(response.value)
            }
        })
    }

    function executeScreenshotCommand(payload) {
        if (fieldValue(payload, ["full_page", "fullPage"]) === true) {
            failActiveCommand("unsupported", "SpellBrowser screenshots capture the visible viewport only.")
            return
        }

        var outputPath = stringField(payload, ["path"])
        if (!outputPath) {
            outputPath = "/tmp/spell-browser-screenshot-" + Date.now() + ".png"
        }

        webView.grabToImage(function(result) {
            if (!result) {
                failActiveCommand("unavailable", "Screenshot capture returned no image result.")
                return
            }
            var saved = false
            try {
                saved = result.saveToFile(outputPath)
            } catch (err) {
                failActiveCommand("unavailable", "Saving screenshot failed.", { path: outputPath, error: String(err) })
                return
            }
            if (!saved) {
                failActiveCommand("unavailable", "Saving screenshot failed.", { path: outputPath })
                return
            }
            completeActiveCommand({
                path: outputPath,
                url: currentUrlString,
                title: pageTitle
            })
        })
    }

    function clearObservedElements() {
        helperReady = false
        lastObservation = ({})
    }

    function navigate(urlValue) {
        enqueueCommand({ action: "browser:goto", url: urlValue })
    }

    function goBack() {
        webView.goBack()
    }

    function goForward() {
        webView.goForward()
    }

    function reloadPage() {
        webView.reload()
    }

    function stopLoading() {
        webView.stop()
    }

    function resetLoadStateHistory() {
        loadStateHistory = []
    }

    function pushLoadState(statusName) {
        var now = Date.now()
        var next = loadStateHistory.concat([{ status: statusName, timestamp: now }])
        if (next.length > maxLoadStateHistoryEntries) {
            next = next.slice(next.length - maxLoadStateHistoryEntries)
        }
        loadStateHistory = next
    }

    function recentStartedStoppedPairCount() {
        var now = Date.now()
        var lowerBound = now - recoveryWindowMs
        var pairs = 0
        var sawStarted = false

        for (var i = 0; i < loadStateHistory.length; i++) {
            var entry = loadStateHistory[i]
            if (!entry || typeof entry.timestamp !== "number" || entry.timestamp < lowerBound) {
                continue
            }
            if (entry.status === "started") {
                sawStarted = true
                continue
            }
            if (entry.status === "stopped" && sawStarted) {
                pairs += 1
                sawStarted = false
            }
        }

        return pairs
    }

    function startRecovery(statusMessage, delayMs) {
        recoveryActive = true
        recoveryStatusText = statusMessage
        browserState = "loading"
        statusText = statusMessage
        clearObservedElements()
        lastError = ""
        recoveryTimer.interval = Math.max(1, delayMs)
        emitState(true)
    }

    function maybeStartRecovery() {
        if (recoveryActive) {
            return false
        }
        if (recentStartedStoppedPairCount() < recoveryPairThreshold) {
            return false
        }

        startRecovery("Recovering from server restart...", recoveryDelayMs)
        webView.stop()
        recoveryTimer.restart()
        return true
    }

    function finishRecovery() {
        recoveryActive = false
        recoveryStatusText = ""
        recoveryTimer.stop()
        resetLoadStateHistory()
    }

    function handleMessage(payload) {
        if (!payload || typeof payload !== "object") {
            return
        }
        enqueueCommand(payload)
    }

    Component.onCompleted: {
        if (autoLoadInitialUrl && initialUrl && initialUrl.trim().length > 0) {
            navigate(initialUrl)
        }
    }

    Timer {
        id: commandTimeout
        repeat: false
        onTriggered: {
            if (activeCommand) {
                failActiveCommand("timeout", "Browser command timed out after " + activeCommand.timeoutMs + "ms.")
            }
        }
    }

    Timer {
        id: waitPollTimer
        interval: root.waitPollIntervalMs
        repeat: false
        onTriggered: root.pollWaitForSelector()
    }

    Timer {
        id: recoveryTimer
        interval: root.recoveryDelayMs
        repeat: false
        onTriggered: {
            if (!recoveryActive) {
                return
            }
            clearObservedElements()
            lastError = ""
            browserState = "loading"
            statusText = recoveryStatusText
            emitState(true)
            webView.reloadAndBypassCache()
        }
    }

    Rectangle {
        anchors.fill: parent
        radius: SpellUI.SpellTheme.cornerRadiusSmall
        color: SpellUI.SpellTheme.surface0
        border.width: 1
        border.color: SpellUI.SpellTheme.borderDefault
        clip: true

        WebEngineView {
            id: webView
            anchors.fill: parent
            profile: activeProfile
            settings.javascriptEnabled: true
            settings.autoLoadImages: true
            settings.localStorageEnabled: true
            settings.localContentCanAccessRemoteUrls: false
            settings.localContentCanAccessFileUrls: false
            settings.errorPageEnabled: true
            settings.pdfViewerEnabled: true
            settings.playbackRequiresUserGesture: false

            onUrlChanged: function() {
                emitUrlChanged()
            }

            onTitleChanged: function() {
                emitState(true)
            }

            onNavigationRequested: function(request) {
                var nextUrl = request.url ? request.url.toString() : ""
                if (isAllowedNavigationTarget(nextUrl)) {
                    return
                }

                if (typeof request.reject === "function") {
                    request.reject()
                } else if (typeof request.action !== "undefined") {
                    request.action = WebEngineNavigationRequest.IgnoreRequest
                }

                var detail = {
                    url: nextUrl,
                    scheme: parseScheme(nextUrl)
                }
                sendProtocol({
                    action: "browser:navigation_blocked",
                    url: nextUrl,
                    reason: "blocked_scheme",
                    detail: detail,
                    silent: false
                })

                if (activeCommand && activeCommand.action === "browser:goto") {
                    failActiveCommand("navigation_blocked", "Navigation target is blocked by scheme policy.", detail)
                }
            }

            onLoadingChanged: function(loadRequest) {
                var requestUrl = loadRequest.url ? loadRequest.url.toString() : currentUrlString
                if (loadRequest.status === WebEngineView.LoadStartedStatus) {
                    pushLoadState("started")
                    clearObservedElements()
                    lastError = ""
                    browserState = "loading"
                    statusText = recoveryActive ? recoveryStatusText : "Loading " + requestUrl
                    emitState(true)
                    return
                }

                if (loadRequest.status === WebEngineView.LoadSucceededStatus) {
                    ensureBrowserHelper(function(ok) {
                        if (!ok) {
                            finishRecovery()
                            browserState = "error"
                            lastError = "SpellBrowser helper injection failed."
                            statusText = "Page loaded without browser helper"
                            emitState(true)
                            if (isPageLoadCommand(activeCommand)) {
                                failActiveCommand("unavailable", lastError)
                            }
                            return
                        }
                        finishRecovery()
                        browserState = "interactive"
                        statusText = pageTitle && pageTitle.length > 0 ? pageTitle : requestUrl
                        emitState(true)
                        if (isPageLoadCommand(activeCommand)) {
                            completeActiveCommand({
                                url: currentUrlString,
                                title: pageTitle,
                                state: browserState
                            })
                        }
                    })
                    return
                }

                if (loadRequest.status === WebEngineView.LoadStoppedStatus) {
                    pushLoadState("stopped")
                    if (maybeStartRecovery()) {
                        return
                    }
                    if (recoveryActive) {
                        browserState = "loading"
                        statusText = recoveryStatusText
                        emitState(true)
                        return
                    }
                    browserState = currentUrlString && currentUrlString.length > 0 ? "interactive" : "idle"
                    statusText = "Load stopped"
                    emitState(true)
                    if (isPageLoadCommand(activeCommand)) {
                        failActiveCommand("navigation_failed", "Navigation was stopped before the page finished loading.", {
                            url: requestUrl
                        })
                    }
                    return
                }

                if (loadRequest.status === WebEngineView.LoadFailedStatus) {
                    clearObservedElements()
                    finishRecovery()
                    browserState = "error"
                    lastError = loadRequest.errorString || "WebEngine load failure"
                    statusText = "Page load failed"
                    emitState(true)
                    if (isPageLoadCommand(activeCommand)) {
                        failActiveCommand("navigation_failed", lastError, {
                            url: requestUrl,
                            errorCode: loadRequest.errorCode
                        })
                    } else {
                        sendProtocol({
                            action: "browser:navigation_failed",
                            url: requestUrl,
                            error: lastError,
                            errorCode: loadRequest.errorCode,
                            silent: false
                        })
                    }
                }
            }

            onJavaScriptConsoleMessage: function(level, message, lineNumber, sourceId) {
                var text = String(message || "").trim()
                if (!text.length) {
                    return
                }
                lastConsoleMessage = text
                if (!allowJavascriptConsoleEvents) {
                    return
                }

                var levelName = String(level)
                var looksLikeError = /TypeError|SyntaxError|ReferenceError|RangeError|URIError|EvalError|Unhandled|Exception/.test(text)
                if (!looksLikeError && levelName.indexOf("Error") < 0) {
                    return
                }

                sendProtocol({
                    action: "browser:console",
                    level: levelName,
                    message: text,
                    lineNumber: lineNumber,
                    sourceId: sourceId,
                    silent: false
                })
            }
        }

        Rectangle {
            anchors.fill: parent
            color: SpellUI.SpellTheme.background
            opacity: browserState === "loading" ? 0.14 : 0
            visible: opacity > 0
        }

        BusyIndicator {
            anchors.centerIn: parent
            running: browserState === "loading"
            visible: running
        }

        Rectangle {
            anchors {
                left: parent.left
                right: parent.right
                bottom: parent.bottom
                margins: SpellUI.SpellTheme.spacingS
            }
            visible: browserState === "error"
            radius: SpellUI.SpellTheme.cornerRadiusSmall
            color: SpellUI.SpellTheme.surface1
            border.width: 1
            border.color: SpellUI.SpellTheme.borderStrong
            implicitHeight: errorColumn.implicitHeight + SpellUI.SpellTheme.spacingM * 2

            Column {
                id: errorColumn
                anchors {
                    fill: parent
                    margins: SpellUI.SpellTheme.spacingM
                }
                spacing: SpellUI.SpellTheme.spacingXS

                Text {
                    text: "Browser error"
                    color: SpellUI.SpellTheme.textPrimary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeM
                    font.weight: SpellUI.SpellTheme.fontWeightBold
                }

                Text {
                    text: lastError
                    visible: lastError.length > 0
                    color: SpellUI.SpellTheme.textSecondary
                    font.family: SpellUI.SpellTheme.fontFamily
                    font.pixelSize: SpellUI.SpellTheme.fontSizeS
                    wrapMode: Text.Wrap
                    width: parent.width
                }
            }
        }
    }
}
