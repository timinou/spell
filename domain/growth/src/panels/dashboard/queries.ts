import type { Database } from "bun:sqlite";
import { getPipelineSummary, getUpcomingDeadlines } from "../../pipeline/queries.ts";
import type { DashboardData, DashboardMetrics, AdSummary } from "./types.ts";

// ─── Terminal deliverable states (excluded from pending count) ────────────────
// SENT is the only fully-delivered state; everything else is still in-flight.
const TERMINAL_STATES = ["SENT"];

/**
 * Counts new ads since `lastSessionTimestamp`, pending deliverables, and
 * active campaigns (distinct pages with at least one active ad).
 *
 * When `lastSessionTimestamp` is omitted, `newAds` counts all ads.
 */
export function getDashboardMetrics(
  db: Database,
  lastSessionTimestamp?: string,
): DashboardMetrics {
  const newAds = lastSessionTimestamp
    ? (
        db
          .prepare(`SELECT COUNT(*) AS n FROM ads WHERE scraped_at > ?`)
          .get(lastSessionTimestamp) as { n: number }
      ).n
    : (
        db.prepare(`SELECT COUNT(*) AS n FROM ads`).get() as { n: number }
      ).n;

  const placeholders = TERMINAL_STATES.map(() => "?").join(", ");
  const pendingDeliverables = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM deliverables WHERE state NOT IN (${placeholders})`,
      )
      .get(...(TERMINAL_STATES as [string, ...string[]])) as { n: number }
  ).n;

  const activeCampaigns = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT page_id) AS n FROM ads WHERE is_active = 1`,
      )
      .get() as { n: number }
  ).n;

  return { newAds, pendingDeliverables, activeCampaigns };
}

/**
 * Returns the most recently scraped ads from the `latest_ads` deduplication
 * view, joined with `pages` to surface the advertiser name.
 *
 * Requires the `latest_ads` view to exist (created by ScraperDatabase when the
 * ads entity schema includes `platform_id` and `scraped_at` columns).
 * Falls back gracefully to `ads` when the view is absent (development / tests).
 *
 * Default limit: 10.
 */
export function getRecentAds(db: Database, limit = 10): AdSummary[] {
  // Probe for the latest_ads view; fall back to the base table in test environments
  // where the ScraperDatabase view layer may not have run.
  const sourceTable = hasView(db, "latest_ads") ? "latest_ads" : "ads";

  const rows = db
    .prepare(
      `SELECT a.ad_id,
              COALESCE(p.page_name, '') AS page_name,
              COALESCE(a.creative_body, '') AS creative_body,
              COALESCE(a.delivery_start_time, '') AS delivery_start_time,
              a.is_active,
              a.ad_format
       FROM ${sourceTable} a
       LEFT JOIN pages p ON a.page_id = p.page_id
       ORDER BY a.scraped_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    ad_id: string;
    page_name: string;
    creative_body: string;
    delivery_start_time: string;
    is_active: number;
    ad_format: string;
  }>;

  return rows.map((row) => ({
    adId: row.ad_id,
    pageName: row.page_name,
    creativeBody: row.creative_body,
    deliveryStartTime: row.delivery_start_time,
    isActive: row.is_active === 1,
    adFormat: row.ad_format,
  }));
}

/**
 * Combines metrics, recent ads, pipeline summary, and upcoming deadlines into
 * a single dashboard payload.
 */
export function getDashboardData(
  db: Database,
  opts?: { lastSession?: string; adsLimit?: number },
): DashboardData {
  const metrics = getDashboardMetrics(db, opts?.lastSession);
  const recentAds = getRecentAds(db, opts?.adsLimit);
  const pipeline = getPipelineSummary(db);
  const deadlineItems = getUpcomingDeadlines(db);

  return {
    metrics,
    recentAds,
    pipeline,
    deadlines: deadlineItems.map((d) => ({
      title: d.title,
      dueDate: d.dueDate,
      state: d.state,
    })),
  };
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
