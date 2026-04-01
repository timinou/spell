import type { SourceMapEntry } from "./wasm-compiler";

export type { SourceMapEntry };

/**
 * Build a source map from rendered SVG content.
 *
 * typst-ts embeds `data-source-line` (and optionally `data-source-col`)
 * attributes on SVG elements that correspond to source positions.
 * An `id` attribute on the same element links it back to the rendered output.
 *
 * Returns an empty array when the SVG is empty or contains no annotated elements.
 */
export function createSourceMap(svgContent: string): SourceMapEntry[] {
  if (!svgContent) return [];

  const entries: SourceMapEntry[] = [];
  // Match opening tags that carry at least data-source-line.
  // The regex handles attribute ordering variations.
  const tagRe = /<[a-zA-Z][^>]*\bdata-source-line="(\d+)"[^>]*>/g;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(svgContent)) !== null) {
    const tag = m[0];
    const sourceLine = parseInt(m[1], 10);

    const idMatch = /\bid="([^"]+)"/.exec(tag);
    if (!idMatch) continue; // No id — can't link back to an SVG element.

    const colMatch = /\bdata-source-col(?:umn)?="(\d+)"/.exec(tag);

    entries.push({
      svgElementId: idMatch[1],
      sourceLine,
      sourceColumn: colMatch ? parseInt(colMatch[1], 10) : undefined,
    });
  }

  return entries;
}

/**
 * Look up the source line for a given SVG element id.
 * Returns `null` when the element is not present in the map.
 */
export function findSourceLine(
  map: SourceMapEntry[],
  svgElementId: string
): number | null {
  const entry = map.find((e) => e.svgElementId === svgElementId);
  return entry?.sourceLine ?? null;
}
