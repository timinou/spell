import { applyTransformChain } from "./transforms.ts";
import type { FieldExtractor } from "./types.ts";

/**
 * Thrown when a required field cannot be extracted from the provided HTML.
 */
export class ScraperExtractionError extends Error {
  readonly fieldName: string;
  readonly selector: string;

  constructor(fieldName: string, selector: string, reason: string) {
    super(
      `Required field "${fieldName}" (selector: "${selector}") could not be extracted: ${reason}`,
    );
    this.name = "ScraperExtractionError";
    this.fieldName = fieldName;
    this.selector = selector;
  }
}

/**
 * Extract a single field from a raw HTML string.
 *
 * This function is intentionally Puppeteer-free so it can be used in unit tests.
 * It uses lightweight regex-based extraction — sufficient for deterministic test
 * fixtures but not a replacement for a proper DOM parser in production.
 *
 * Extraction order:
 *   1. Locate the first element matching `config.selector` (tag + optional class/id).
 *   2. Read `config.attribute` if specified; otherwise read element text content.
 *   3. Apply `config.transforms` chain.
 *   4. If the result is empty/null and `config.required` is true, throw.
 *
 * Selector support (subset):
 *   - `div`, `span`, `a`, etc. — bare tag
 *   - `.class-name` — first element with that class
 *   - `#id-value` — element with that id
 *   - `tag.class` — tag + class
 *   - `[attr=value]` — attribute equality (used for extraction target, not nesting)
 *
 * This is a best-effort fallback. Complex CSS selectors are not supported.
 */
export function extractField(
  html: string,
  config: FieldExtractor,
): string | number | boolean | null {
  const raw = extractRaw(html, config.selector, config.attribute);

  if (raw === null) {
    if (config.required === true) {
      throw new ScraperExtractionError(
        config.name,
        config.selector,
        "no element matched the selector",
      );
    }
    return null;
  }

  const transformed =
    config.transforms && config.transforms.length > 0
      ? applyTransformChain(raw, config.transforms)
      : raw;

  if (
    transformed === null ||
    (typeof transformed === "string" && transformed === "")
  ) {
    if (config.required === true) {
      throw new ScraperExtractionError(
        config.name,
        config.selector,
        "element was found but value is empty after transforms",
      );
    }
    return null;
  }

  return transformed;
}

// ─── Internal regex-based extraction ─────────────────────────────────────────

/**
 * Extract a raw string value from `html` matching the simplified CSS selector.
 * Returns `null` when nothing matches.
 */
function extractRaw(
  html: string,
  selector: string,
  attribute?: string,
): string | null {
  const { tag, className, id, attrName, attrValue } = parseSelector(selector);

  // Build a regex that finds the opening tag matching the selector constraints.
  // This is deliberately simple: it handles flat HTML well enough for test fixtures.
  const tagPattern = tag ?? "[a-zA-Z][a-zA-Z0-9]*";
  const openTagRe = new RegExp(
    `<(${tagPattern})(?:\\s[^>]*)?>`,
    "i",
  );

  // Walk through all matching opening tags to find one that satisfies attribute filters.
  const globalTagRe = new RegExp(
    `<(${tagPattern})((?:\\s[^>]*)?)\\/?>`,
    "gi",
  );

  let match: RegExpExecArray | null;
  while ((match = globalTagRe.exec(html)) !== null) {
    const fullTag = match[0];
    const tagName = match[1];
    const attrsPart = match[2] ?? "";

    if (!meetsConstraints(attrsPart, { className, id, attrName, attrValue })) {
      continue;
    }

    // Found matching element — extract value.
    if (attribute !== undefined) {
      return readAttribute(fullTag, attribute);
    }

    // Extract inner text content up to the matching close tag.
    const afterOpen = html.slice(globalTagRe.lastIndex);
    return extractInnerText(afterOpen, tagName);
  }

  // Suppress unused variable warning — openTagRe was intentional design note.
  void openTagRe;

  return null;
}

interface SelectorParts {
  tag: string | null;
  className: string | null;
  id: string | null;
  attrName: string | null;
  attrValue: string | null;
}

function parseSelector(selector: string): SelectorParts {
  let remaining = selector.trim();
  let tag: string | null = null;
  let className: string | null = null;
  let id: string | null = null;
  let attrName: string | null = null;
  let attrValue: string | null = null;

  // [attr=value]
  const attrMatch = /\[([^=\]]+)=["']?([^"'\]]+)["']?\]/.exec(remaining);
  if (attrMatch) {
    attrName = attrMatch[1];
    attrValue = attrMatch[2];
    remaining = remaining.replace(attrMatch[0], "");
  }

  // #id
  const idMatch = /^([a-zA-Z]*)?#([a-zA-Z0-9_-]+)/.exec(remaining);
  if (idMatch) {
    tag = idMatch[1] || null;
    id = idMatch[2];
  } else {
    // tag.class or .class
    const classMatch = /^([a-zA-Z]*)?\.([a-zA-Z0-9_-]+)/.exec(remaining);
    if (classMatch) {
      tag = classMatch[1] || null;
      className = classMatch[2];
    } else if (/^[a-zA-Z]/.test(remaining)) {
      tag = remaining.split(/[.#\[]/)[0];
    }
  }

  return { tag, className, id, attrName, attrValue };
}

function meetsConstraints(
  attrsPart: string,
  {
    className,
    id,
    attrName,
    attrValue,
  }: Pick<SelectorParts, "className" | "id" | "attrName" | "attrValue">,
): boolean {
  if (id !== null && !new RegExp(`\\bid=["']?${id}["']?`).test(attrsPart)) {
    return false;
  }
  if (
    className !== null &&
    !new RegExp(`\\bclass=["'][^"']*\\b${className}\\b`).test(attrsPart)
  ) {
    return false;
  }
  if (
    attrName !== null &&
    attrValue !== null &&
    !new RegExp(`\\b${attrName}=["']?${attrValue}["']?`).test(attrsPart)
  ) {
    return false;
  }
  return true;
}

function readAttribute(openTag: string, attribute: string): string | null {
  // Match attr="value", attr='value', or attr=value
  const re = new RegExp(`\\b${attribute}=["']?([^"'\\s>]+)["']?`);
  const m = re.exec(openTag);
  return m ? m[1] : null;
}

/**
 * Extract the inner text of an element given the HTML that follows its opening tag.
 * Handles basic nesting by tracking open/close tag depth.
 * Strips inner HTML tags from the result.
 */
function extractInnerText(htmlAfterOpen: string, tagName: string): string {
  const openRe = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "gi");
  const closeRe = new RegExp(`<\\/${tagName}>`, "gi");

  let depth = 1;
  let pos = 0;
  let end = htmlAfterOpen.length;

  while (pos < htmlAfterOpen.length) {
    const nextOpen = openRe.exec(htmlAfterOpen);
    const nextClose = closeRe.exec(htmlAfterOpen);

    if (nextClose === null) break;

    if (nextOpen !== null && nextOpen.index < nextClose.index) {
      depth += 1;
      pos = nextOpen.index + nextOpen[0].length;
      openRe.lastIndex = pos;
      closeRe.lastIndex = pos;
    } else {
      depth -= 1;
      if (depth === 0) {
        end = nextClose.index;
        break;
      }
      pos = nextClose.index + nextClose[0].length;
      openRe.lastIndex = pos;
      closeRe.lastIndex = pos;
    }
  }

  const inner = htmlAfterOpen.slice(0, end);
  // Strip tags and decode basic HTML entities.
  return inner
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}
