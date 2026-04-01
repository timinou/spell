import { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import type { DiffResult, SignalConfig } from "./types.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal interface for whatever runs a scrape and returns raw ad records. */
export interface ScraperRunner {
  run(scraperConfig: string, url: string): Promise<Record<string, unknown>[]>;
}

interface SchedulerOptions {
  config: SignalConfig;
  scraperRunner: ScraperRunner;
  dbPath: string;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Timer-based signal scheduler.
 *
 * For each enabled source, `start()` computes the time until the next cron
 * firing and sets a `setTimeout`. When the timer fires, the source is scraped
 * immediately and a new timer is queued for the following firing.
 *
 * Last-run timestamps are persisted in SQLite so restarts do not re-scrape
 * sources that ran recently.
 */
export class SignalScheduler {
  readonly #config: SignalConfig;
  readonly #scraperRunner: ScraperRunner;
  readonly #db: Database;
  // Map of sourceId → active timer handle
  readonly #timers = new Map<string, NodeJS.Timeout>();
  // Registered diff-result listeners
  readonly #listeners: Array<(result: DiffResult) => void> = [];

  constructor({ config, scraperRunner, dbPath }: SchedulerOptions) {
    this.#config = config;
    this.#scraperRunner = scraperRunner;
    this.#db = new Database(dbPath, { create: true });
    this.#db.exec("PRAGMA journal_mode=WAL;");
    this.#ensureSchema();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Register a callback that is invoked after every successful scrape+diff.
   * Call before `start()` to ensure no results are missed.
   */
  onDiff(listener: (result: DiffResult) => void): void {
    this.#listeners.push(listener);
  }

  /** Schedule all enabled sources based on their cron expressions. */
  start(): void {
    for (const source of this.#config.sources) {
      if (!source.enabled) continue;
      this.#schedule(source.id);
    }
  }

  /** Cancel all pending timers. In-flight scrapes are not interrupted. */
  stop(): void {
    for (const [id, timer] of this.#timers.entries()) {
      clearTimeout(timer);
      this.#timers.delete(id);
    }
  }

  /** Release all resources: cancel pending timers and close the database. */
  dispose(): void {
    this.stop();
    this.#db.close();
  }

  /**
   * Trigger an immediate scrape for `sourceId`, bypassing the schedule.
   * Updates the persisted last-run timestamp on completion.
   * Throws when `sourceId` is not found in the config.
   */
  async runNow(sourceId: string): Promise<DiffResult> {
    const source = this.#config.sources.find((s) => s.id === sourceId);
    if (source === undefined) {
      throw new Error(`SignalScheduler: unknown source "${sourceId}"`);
    }
    return this.#scrapeSource(sourceId, source.scraperConfig, source.url);
  }

  // ─── Scheduling internals ───────────────────────────────────────────────────

  /**
   * Compute the delay to the next cron firing for `sourceId` and arm a timer.
   * When the timer fires, the source is scraped and the timer is re-armed.
   */
  #schedule(sourceId: string): void {
    const source = this.#config.sources.find((s) => s.id === sourceId);
    if (source === undefined || !source.enabled) return;

    const delayMs = msUntilNextCron(source.schedule);
    const timer = setTimeout(async () => {
      this.#timers.delete(sourceId);
      try {
        const result = await this.#scrapeSource(sourceId, source.scraperConfig, source.url);
        for (const listener of this.#listeners) {
          listener(result);
        }
      } catch (err) {
        logger.error("Signal scrape failed", { sourceId, err: String(err) });
      }
      // Re-arm for the next firing — only if stop() hasn't been called.
      if (!this.#timers.has(sourceId)) {
        this.#schedule(sourceId);
      }
    }, delayMs);

    this.#timers.set(sourceId, timer);
    logger.info("Signal source scheduled", {
      sourceId,
      nextRunIn: `${Math.round(delayMs / 1000)}s`,
    });
  }

  /**
   * Run the scraper for one source, compute the diff against the previous
   * snapshot, persist the last-run timestamp, and return the `DiffResult`.
   */
  async #scrapeSource(
    sourceId: string,
    scraperConfig: string,
    url: string,
  ): Promise<DiffResult> {
    const previous = this.#loadPreviousSnapshot(sourceId);
    const current = await this.#scraperRunner.run(scraperConfig, url);

    // Inline diff computation — importable from diff-engine, but kept here to
    // avoid a circular dependency between scheduler and diff-engine at the module
    // level. Callers that need richer control use computeDiff directly.
    const { computeDiff } = await import("./diff-engine.ts");
    const result = computeDiff(current, previous, "id");

    // Fill in the sourceId that computeDiff leaves blank (it has no concept of source).
    const stamped: DiffResult = { ...result, sourceId };

    this.#persistSnapshot(sourceId, current);
    this.#persistLastRun(sourceId, stamped.timestamp);

    return stamped;
  }

  // ─── Persistence helpers ─────────────────────────────────────────────────────

  #ensureSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS signal_runs (
        sourceId   TEXT PRIMARY KEY,
        lastRun    TEXT NOT NULL,
        snapshot   TEXT NOT NULL DEFAULT '[]'
      );
    `);
  }

  #loadPreviousSnapshot(sourceId: string): Record<string, unknown>[] {
    const row = this.#db
      .prepare(`SELECT snapshot FROM signal_runs WHERE sourceId = ?`)
      .get(sourceId) as { snapshot: string } | null;
    if (row === null) return [];
    try {
      const parsed = JSON.parse(row.snapshot);
      return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
    } catch {
      return [];
    }
  }

  #persistSnapshot(sourceId: string, ads: Record<string, unknown>[]): void {
    const snapshot = JSON.stringify(ads);
    this.#db
      .prepare(
        `INSERT INTO signal_runs (sourceId, lastRun, snapshot)
         VALUES (?, ?, ?)
         ON CONFLICT (sourceId) DO UPDATE SET snapshot = excluded.snapshot`,
      )
      .run(sourceId, new Date().toISOString(), snapshot);
  }

  #persistLastRun(sourceId: string, timestamp: string): void {
    this.#db
      .prepare(
        `INSERT INTO signal_runs (sourceId, lastRun, snapshot)
         VALUES (?, ?, '[]')
         ON CONFLICT (sourceId) DO UPDATE SET lastRun = excluded.lastRun`,
      )
      .run(sourceId, timestamp);
  }
}

// ─── Cron parser ─────────────────────────────────────────────────────────────

/**
 * Compute milliseconds until the next firing of a 5-field cron expression.
 *
 * Field order: minute  hour  day-of-month  month  day-of-week
 * Supported syntax per field:
 *   - `*`        — any value
 *   - `N`        — exact value
 *   - `*\/N`     — every N steps (step syntax)
 *   - `A-B`      — range (inclusive)
 *   - `A,B,C`    — list
 *
 * The search is limited to the next 366 days. Throws when no firing is found
 * within that window (e.g. an impossible expression like `31 * 31 2 *`).
 */
export function msUntilNextCron(cron: string): number {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression (expected 5 fields): "${cron}"`);
  }

  const [minuteExpr, hourExpr, domExpr, monthExpr, dowExpr] = fields as [
    string, string, string, string, string,
  ];

  // Advance by one minute from now to avoid firing at the current minute.
  const from = new Date();
  from.setSeconds(0, 0);
  from.setMinutes(from.getMinutes() + 1);

  const candidate = new Date(from);
  const limit = new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000);

  while (candidate < limit) {
    // month is 1-indexed in cron; Date.getMonth() is 0-indexed.
    if (!matchField(monthExpr, candidate.getMonth() + 1, 1, 12)) {
      // Advance to the 1st of the next month.
      candidate.setDate(1);
      candidate.setHours(0);
      candidate.setMinutes(0);
      candidate.setMonth(candidate.getMonth() + 1);
      continue;
    }

    if (!matchField(domExpr, candidate.getDate(), 1, 31)) {
      candidate.setHours(0);
      candidate.setMinutes(0);
      candidate.setDate(candidate.getDate() + 1);
      continue;
    }

    // day-of-week: 0 = Sunday in cron and in JS
    if (!matchField(dowExpr, candidate.getDay(), 0, 6)) {
      candidate.setHours(0);
      candidate.setMinutes(0);
      candidate.setDate(candidate.getDate() + 1);
      continue;
    }

    if (!matchField(hourExpr, candidate.getHours(), 0, 23)) {
      candidate.setMinutes(0);
      candidate.setHours(candidate.getHours() + 1);
      continue;
    }

    if (!matchField(minuteExpr, candidate.getMinutes(), 0, 59)) {
      candidate.setMinutes(candidate.getMinutes() + 1);
      continue;
    }

    // All fields match.
    return candidate.getTime() - Date.now();
  }

  throw new Error(`Cron expression "${cron}" has no firing in the next 366 days`);
}

/**
 * Return `true` when `value` matches the cron field expression `expr`.
 * `min`/`max` define the valid range for step expansion.
 */
function matchField(expr: string, value: number, min: number, max: number): boolean {
  // List: split on comma and check each part recursively.
  if (expr.includes(",")) {
    return expr.split(",").some((part) => matchField(part, value, min, max));
  }

  // Wildcard.
  if (expr === "*") return true;

  // Step: `*/N` or `A-B/N`.
  if (expr.includes("/")) {
    const [rangeExpr, stepStr] = expr.split("/", 2) as [string, string];
    const step = parseInt(stepStr, 10);
    if (Number.isNaN(step) || step <= 0) return false;
    let rangeMin = min;
    let rangeMax = max;
    if (rangeExpr !== "*") {
      const [a, b] = rangeExpr.split("-").map(Number);
      rangeMin = a ?? min;
      rangeMax = b ?? a ?? max;
    }
    if (value < rangeMin || value > rangeMax) return false;
    return (value - rangeMin) % step === 0;
  }

  // Range: `A-B`.
  if (expr.includes("-")) {
    const [a, b] = expr.split("-").map(Number);
    return value >= (a ?? min) && value <= (b ?? max);
  }

  // Exact value.
  return value === parseInt(expr, 10);
}
