import { Value } from "@sinclair/typebox/value";
import * as yaml from "js-yaml";
import { ScraperConfig } from "./types.ts";

/**
 * Load, parse, and validate a scraper YAML config from `configPath`.
 *
 * Template variables of the form `{{ key.path }}` in string values are resolved
 * against `options` using dot-notation paths (e.g., `{{ env.baseUrl }}`).
 * Unknown paths resolve to an empty string rather than throwing, so callers can
 * supply partial options without crashing on optional template vars.
 *
 * Throws a descriptive `Error` when:
 *   - The file cannot be read
 *   - The YAML is malformed
 *   - The parsed document fails TypeBox validation
 */
export async function loadScraperConfig(
  configPath: string,
  options?: Record<string, unknown>,
): Promise<ScraperConfig> {
  let rawText: string;
  try {
    rawText = await Bun.file(configPath).text();
  } catch (err) {
    throw new Error(
      `Failed to read scraper config at "${configPath}": ${String(err)}`,
    );
  }

  if (rawText.trim() === "") {
    throw new Error(
      `Scraper config at "${configPath}" is empty. A valid YAML document is required.`,
    );
  }

  // Resolve template variables before YAML parsing so the YAML remains valid.
  const interpolated =
    options !== undefined ? resolveTemplates(rawText, options) : rawText;

  let parsed: unknown;
  try {
    parsed = yaml.load(interpolated);
  } catch (err) {
    throw new Error(
      `Failed to parse YAML in "${configPath}": ${String(err)}`,
    );
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new Error(
      `Scraper config at "${configPath}" must be a YAML mapping, got: ${typeof parsed}`,
    );
  }

  if (!Value.Check(ScraperConfig, parsed)) {
    const errors = [...Value.Errors(ScraperConfig, parsed)];
    const details = errors
      .slice(0, 10)
      .map((e) => `  ${e.path}: ${e.message}`)
      .join("\n");
    throw new Error(
      `Scraper config at "${configPath}" failed validation:\n${details}`,
    );
  }

  return parsed as ScraperConfig;
}

// ─── Template resolution ──────────────────────────────────────────────────────

const TEMPLATE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Replace all `{{ key.path }}` occurrences in `text` with values from `ctx`.
 * Uses dot-path traversal. Unresolvable paths become empty strings.
 */
function resolveTemplates(text: string, ctx: Record<string, unknown>): string {
  return text.replace(TEMPLATE_RE, (_match, path: string) => {
    const value = dotGet(ctx, path);
    return value !== undefined && value !== null ? String(value) : "";
  });
}

/**
 * Traverse a dot-notation `path` through `obj`.
 * Returns `undefined` when any segment is missing.
 */
function dotGet(obj: unknown, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = obj;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
