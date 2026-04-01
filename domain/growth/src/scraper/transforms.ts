import type { TransformDef } from "./types.ts";

/**
 * Apply a single transform to `input`.
 *
 * - `regex`: match `pattern`, return capture at `group` (default 1). Returns `null` on no match.
 * - `replace`: replace all occurrences of `find` with `replaceWith`.
 * - `exists`: return `true` when input is non-empty, `false` otherwise.
 * - `chain`: apply transforms left-to-right, casting intermediate results to string.
 *   Stops early and returns `null` when any step returns `null`.
 */
export function applyTransform(
  input: string,
  transform: TransformDef,
): string | number | boolean | null {
  switch (transform.type) {
    case "regex": {
      const flags = ""; // caller controls flags via pattern syntax if needed
      let re: RegExp;
      try {
        re = new RegExp(transform.pattern, flags);
      } catch {
        throw new Error(
          `Invalid regex pattern in transform: ${transform.pattern}`,
        );
      }
      const match = re.exec(input);
      if (match === null) return null;
      const group = transform.group ?? 1;
      // group 0 = full match; groups ≥ 1 are capture groups
      return match[group] ?? null;
    }

    case "replace": {
      // Replace all occurrences — String.replaceAll requires ES2021, available in Bun.
      return input.replaceAll(transform.find, transform.replaceWith);
    }

    case "exists": {
      return input !== "" && input !== null;
    }

    case "chain": {
      return applyTransformChain(input, transform.transforms);
    }
  }
}

/**
 * Apply a sequence of transforms left-to-right, threading each result into the
 * next step as a string. Returns `null` immediately if any step returns `null`.
 *
 * The final value may be a `string | number | boolean | null` — whatever the
 * last transform in the chain returns.
 */
export function applyTransformChain(
  input: string,
  transforms: TransformDef[],
): string | number | boolean | null {
  let current: string | number | boolean | null = input;

  for (const transform of transforms) {
    if (current === null) return null;

    // Cast to string between steps so each transform always receives a string.
    const asString =
      typeof current === "string" ? current : String(current);

    current = applyTransform(asString, transform);
  }

  return current;
}
