import type { Database } from "bun:sqlite";
import type { AdDetail, AdFilter } from "./types.ts";

// ─── Schema ───────────────────────────────────────────────────────────────────

/**
 * Ensures the `ad_annotations` table exists.
 * Called inline before every annotation write so callers need not manage DDL.
 */
function ensureAnnotationsSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ad_annotations (
      ad_id   TEXT PRIMARY KEY,
      tags    TEXT,
      notes   TEXT,
      starred INTEGER NOT NULL DEFAULT 0
    );
  `);
}

// ─── Ad query ─────────────────────────────────────────────────────────────────

interface RawAdRow {
  ad_id: string;
  page_id: string;
  page_name: string;
  creative_body: string;
  delivery_start_time: string;
  is_active: number;
  ad_format: string;
  spend_range: string | null;
  impressions_range: string | null;
  snapshot_url: string | null;
  // annotation columns (may be null when no annotation exists)
  tags: string | null;
  notes: string | null;
  starred: number | null;
}

/**
 * Queries ads with optional filtering and pagination.
 *
 * Filter semantics:
 * - `advertiser`: LIKE match on `page_name` (case-insensitive via LOWER)
 * - `keywords`: LIKE match across `page_name` and `creative_body`
 * - `dateRange`: inclusive range on `delivery_start_time` (ISO strings)
 * - `formats`: IN clause on `ad_format`
 * - `isActive`: exact match on `is_active` (0 or 1)
 *
 * Pagination defaults: offset 0, limit 50.
 */
export function queryAds(
  db: Database,
  filter: AdFilter,
  pagination?: { offset: number; limit: number },
): { ads: AdDetail[]; total: number } {
  const { offset = 0, limit = 50 } = pagination ?? {};

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.advertiser !== undefined) {
    conditions.push(`LOWER(p.page_name) LIKE LOWER(?)`);
    params.push(`%${filter.advertiser}%`);
  }

  if (filter.keywords !== undefined) {
    conditions.push(
      `(LOWER(p.page_name) LIKE LOWER(?) OR LOWER(a.creative_body) LIKE LOWER(?))`,
    );
    params.push(`%${filter.keywords}%`, `%${filter.keywords}%`);
  }

  if (filter.dateRange !== undefined) {
    conditions.push(
      `a.delivery_start_time >= ? AND a.delivery_start_time <= ?`,
    );
    params.push(filter.dateRange.from, filter.dateRange.to);
  }

  if (filter.formats !== undefined && filter.formats.length > 0) {
    const placeholders = filter.formats.map(() => "?").join(", ");
    conditions.push(`a.ad_format IN (${placeholders})`);
    params.push(...filter.formats);
  }

  if (filter.isActive !== undefined) {
    conditions.push(`a.is_active = ?`);
    params.push(filter.isActive ? 1 : 0);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sourceTable = hasView(db, "latest_ads") ? "latest_ads" : "ads";

  const baseQuery = `
    FROM ${sourceTable} a
    LEFT JOIN pages p ON a.page_id = p.page_id
    LEFT JOIN ad_annotations ann ON a.ad_id = ann.ad_id
    ${where}
  `;

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n ${baseQuery}`)
      .get(...(params as Parameters<ReturnType<Database["prepare"]>["get"]>)) as {
      n: number;
    }
  ).n;

  const rows = db
    .prepare(
      `SELECT
         a.ad_id,
         a.page_id,
         COALESCE(p.page_name, '') AS page_name,
         COALESCE(a.creative_body, '') AS creative_body,
         COALESCE(a.delivery_start_time, '') AS delivery_start_time,
         a.is_active,
         a.ad_format,
         a.spend_range,
         a.impressions_range,
         a.snapshot_url,
         ann.tags,
         ann.notes,
         ann.starred
       ${baseQuery}
       ORDER BY a.scraped_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(
      ...(params as Parameters<ReturnType<Database["prepare"]>["all"]>),
      limit,
      offset,
    ) as RawAdRow[];

  return { ads: rows.map(rowToAdDetail), total };
}

// ─── Annotation ───────────────────────────────────────────────────────────────

/**
 * Upserts an annotation record for the given ad.
 * Partial updates are supported: only supplied fields are written.
 * Fields not present in `annotation` are left unchanged on conflict.
 */
export function annotateAd(
  db: Database,
  adId: string,
  annotation: { tag?: string; note?: string; starred?: boolean },
): void {
  ensureAnnotationsSchema(db);

  // Build a tags JSON array: append the new tag to any existing array.
  // Notes are replaced wholesale; starred is a simple boolean toggle.
  const cols: string[] = ["ad_id"];
  const insertVals: unknown[] = [adId];
  const updateClauses: string[] = [];

  if (annotation.tag !== undefined) {
    // Tags are stored as a JSON array string for portability without json1 requirement.
    // On INSERT: start a new single-element array.
    // On UPDATE conflict: append to existing array via string manipulation is brittle;
    // instead we read, merge, write in application code.
    const existing = db
      .prepare(`SELECT tags FROM ad_annotations WHERE ad_id = ?`)
      .get(adId) as { tags: string | null } | null;

    const currentTags: string[] =
      existing?.tags != null ? (JSON.parse(existing.tags) as string[]) : [];

    if (!currentTags.includes(annotation.tag)) {
      currentTags.push(annotation.tag);
    }

    const tagsJson = JSON.stringify(currentTags);
    cols.push("tags");
    insertVals.push(tagsJson);
    updateClauses.push(`tags = excluded.tags`);
  }

  if (annotation.note !== undefined) {
    cols.push("notes");
    insertVals.push(annotation.note);
    updateClauses.push(`notes = excluded.notes`);
  }

  if (annotation.starred !== undefined) {
    cols.push("starred");
    insertVals.push(annotation.starred ? 1 : 0);
    updateClauses.push(`starred = excluded.starred`);
  }

  // Nothing to write beyond the ad_id itself — skip.
  if (updateClauses.length === 0) return;

  const placeholders = cols.map(() => "?").join(", ");
  const onConflict =
    updateClauses.length > 0
      ? `ON CONFLICT(ad_id) DO UPDATE SET ${updateClauses.join(", ")}`
      : `ON CONFLICT(ad_id) DO NOTHING`;

  db.prepare(
    `INSERT INTO ad_annotations (${cols.join(", ")}) VALUES (${placeholders}) ${onConflict}`,
  ).run(...(insertVals as Parameters<ReturnType<Database["prepare"]>["run"]>));
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function hasView(db: Database, name: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ? LIMIT 1`,
    )
    .get(name);
  return row !== null;
}

function rowToAdDetail(row: RawAdRow): AdDetail {
  const detail: AdDetail = {
    adId: row.ad_id,
    pageId: row.page_id,
    pageName: row.page_name,
    creativeBody: row.creative_body,
    deliveryStartTime: row.delivery_start_time,
    isActive: row.is_active === 1,
    adFormat: row.ad_format,
  };

  if (row.spend_range !== null) detail.spendRange = row.spend_range;
  if (row.impressions_range !== null)
    detail.impressionsRange = row.impressions_range;
  if (row.snapshot_url !== null) detail.snapshotUrl = row.snapshot_url;
  if (row.tags !== null) detail.tags = JSON.parse(row.tags) as string[];
  if (row.notes !== null) detail.notes = row.notes;
  if (row.starred !== null) detail.starred = row.starred === 1;

  return detail;
}
