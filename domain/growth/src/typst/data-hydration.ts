import type { TypstCompiler } from "./wasm-compiler";

/**
 * Serialize `data` into both YAML and JSON and add both to the compiler's
 * virtual filesystem so templates can use either:
 *   #yaml("data.yaml")
 *   #json("data.json")
 *
 * We produce YAML manually rather than pulling in a full yaml library —
 * the data is always agent-controlled so the subset is predictable.
 * For complex nested objects, JSON is always available as a fallback.
 */
export function hydrateTemplate(
  compiler: TypstCompiler,
  _templatePath: string,
  data: Record<string, unknown>
): void {
  compiler.addSource("data.json", JSON.stringify(data, null, 2));
  compiler.addSource("data.yaml", serializeYaml(data));
}

// ── minimal YAML serializer ─────────────────────────────────────────────────
// Handles the subset we actually produce: string/number/boolean/null/array/object.
// Not a general-purpose serializer — general YAML has edge cases this covers.

function serializeYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);

  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);

  if (typeof value === "string") {
    // Multi-line strings use block scalar style.
    if (value.includes("\n")) {
      const lines = value.split("\n");
      return "|\n" + lines.map((l) => `${pad}  ${l}`).join("\n");
    }
    // Strings that look like YAML keywords or contain special chars are quoted.
    if (needsQuoting(value)) {
      return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => `\n${pad}- ${serializeYaml(item, indent + 1)}`)
      .join("");
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return "{}";
    return keys
      .map((k) => {
        const v = obj[k];
        const serialized = serializeYaml(v, indent + 1);
        // If the serialized value starts with a newline it's a block scalar/sequence.
        if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          return `\n${pad}${k}:\n${pad}  ${serialized.trimStart()}`;
        }
        if (Array.isArray(v)) {
          return `\n${pad}${k}:${serialized}`;
        }
        return `\n${pad}${k}: ${serialized}`;
      })
      .join("");
  }

  return String(value);
}

const YAML_KEYWORDS = new Set(["true", "false", "null", "yes", "no", "on", "off"]);

function needsQuoting(s: string): boolean {
  if (YAML_KEYWORDS.has(s.toLowerCase())) return true;
  // Starts with a YAML indicator or contains characters with special meaning.
  return /^[{[\-?:,#&*!|>'"%@`]/.test(s) || s.includes(": ") || s.includes(" #");
}
