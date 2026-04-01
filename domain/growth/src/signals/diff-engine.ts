import type { AdDiff, DiffResult } from "./types.ts";

/**
 * Compute a structural diff between two snapshots of ad records.
 *
 * Records are identified by `idField`. The function classifies each ad as:
 * - `new`: present in `currentAds` but absent in `previousAds`
 * - `removed`: present in `previousAds` but absent in `currentAds`
 * - `changed`: present in both but one or more field values differ
 *
 * Only scalar-serializable fields are compared (via String coercion).
 * Missing fields on either side are treated as empty strings.
 */
export function computeDiff(
  currentAds: Record<string, unknown>[],
  previousAds: Record<string, unknown>[],
  idField: string,
): DiffResult {
  const currentMap = indexById(currentAds, idField);
  const previousMap = indexById(previousAds, idField);

  const diffs: AdDiff[] = [];

  // New: in current but not in previous.
  for (const id of currentMap.keys()) {
    if (!previousMap.has(id)) {
      diffs.push({ adId: id, type: "new" });
    }
  }

  // Removed: in previous but not in current.
  for (const id of previousMap.keys()) {
    if (!currentMap.has(id)) {
      diffs.push({ adId: id, type: "removed" });
    }
  }

  // Changed: in both, but fields differ.
  for (const [id, current] of currentMap.entries()) {
    const previous = previousMap.get(id);
    if (previous === undefined) continue; // already handled as "new"

    const changedFields = diffFields(previous, current);
    if (changedFields.length > 0) {
      diffs.push({ adId: id, type: "changed", fields: changedFields });
    }
  }

  const summary = {
    new: diffs.filter((d) => d.type === "new").length,
    removed: diffs.filter((d) => d.type === "removed").length,
    changed: diffs.filter((d) => d.type === "changed").length,
  };

  return {
    // sourceId is unknown at this level — callers must fill it in.
    sourceId: "",
    timestamp: new Date().toISOString(),
    diffs,
    summary,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a Map keyed by the value of `idField` in each record.
 * Records missing the id field are silently skipped.
 */
function indexById(
  ads: Record<string, unknown>[],
  idField: string,
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const ad of ads) {
    const id = ad[idField];
    if (id !== undefined && id !== null) {
      map.set(String(id), ad);
    }
  }
  return map;
}

/**
 * Return field-level diffs between `prev` and `curr`.
 * The union of both records' keys is compared; missing keys on either side
 * are treated as empty strings so additions and removals surface as changes.
 */
function diffFields(
  prev: Record<string, unknown>,
  curr: Record<string, unknown>,
): { field: string; before: string; after: string }[] {
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  const changes: { field: string; before: string; after: string }[] = [];

  for (const key of allKeys) {
    const before = prev[key] !== undefined && prev[key] !== null ? String(prev[key]) : "";
    const after = curr[key] !== undefined && curr[key] !== null ? String(curr[key]) : "";
    if (before !== after) {
      changes.push({ field: key, before, after });
    }
  }

  return changes;
}
