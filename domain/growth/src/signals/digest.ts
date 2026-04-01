import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { DigestEntry, DiffResult } from "./types.ts";

interface DigestManagerOptions {
  dbPath: string;
}

/**
 * SQLite-backed store for digest entries produced by the signal diff pipeline.
 *
 * Each `DiffResult` is summarised into a single `DigestEntry` row so the UI
 * can surface unread change notifications without loading raw diff data.
 */
export class DigestManager {
  readonly #db: Database;

  constructor({ dbPath }: DigestManagerOptions) {
    this.#db = new Database(dbPath, { create: true });
    this.#db.exec("PRAGMA journal_mode=WAL;");
    this.#db.exec("PRAGMA foreign_keys=ON;");
    this.#ensureSchema();
  }

  // ─── Schema ─────────────────────────────────────────────────────────────────

  #ensureSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS digests (
        id        TEXT PRIMARY KEY,
        sourceId  TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        summary   TEXT NOT NULL,
        diffCount INTEGER NOT NULL,
        read      INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.#db.exec(
      `CREATE INDEX IF NOT EXISTS idx_digests_sourceId ON digests (sourceId);`,
    );
    this.#db.exec(
      `CREATE INDEX IF NOT EXISTS idx_digests_read ON digests (read);`,
    );
  }

  // ─── Write ──────────────────────────────────────────────────────────────────

  /**
   * Persist a summary of `diff` as a new digest entry.
   * Returns the persisted entry (always unread on creation).
   */
  addEntry(diff: DiffResult): DigestEntry {
    const id = randomUUID();
    const diffCount = diff.diffs.length;
    const summary = buildSummary(diff);

    this.#db
      .prepare(
        `INSERT INTO digests (id, sourceId, timestamp, summary, diffCount, read)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .run(id, diff.sourceId, diff.timestamp, summary, diffCount);

    return {
      id,
      sourceId: diff.sourceId,
      timestamp: diff.timestamp,
      summary,
      diffCount,
      read: false,
    };
  }

  // ─── Read ────────────────────────────────────────────────────────────────────

  /** Return all unread digest entries, ordered oldest-first. */
  getUnread(): DigestEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT id, sourceId, timestamp, summary, diffCount, read
         FROM digests
         WHERE read = 0
         ORDER BY timestamp ASC`,
      )
      .all() as RawRow[];
    return rows.map(rowToEntry);
  }

  /** Number of unread digest entries. */
  getUnreadCount(): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM digests WHERE read = 0`)
      .get() as { n: number };
    return row.n;
  }

  // ─── Mutations ───────────────────────────────────────────────────────────────

  /** Mark a single entry as read. No-op when `id` does not exist. */
  markRead(id: string): void {
    this.#db.prepare(`UPDATE digests SET read = 1 WHERE id = ?`).run(id);
  }

  /** Mark all entries as read. */
  markAllRead(): void {
    this.#db.prepare(`UPDATE digests SET read = 1 WHERE read = 0`).run();
  }

  /** Close the underlying database connection. */
  dispose(): void {
    this.#db.close();
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface RawRow {
  id: string;
  sourceId: string;
  timestamp: string;
  summary: string;
  diffCount: number;
  // SQLite stores booleans as integers (0/1)
  read: number;
}

function rowToEntry(row: RawRow): DigestEntry {
  return {
    id: row.id,
    sourceId: row.sourceId,
    timestamp: row.timestamp,
    summary: row.summary,
    diffCount: row.diffCount,
    read: row.read !== 0,
  };
}

/**
 * Build a human-readable one-line summary from a `DiffResult`.
 * Format: "3 new, 1 removed, 2 changed" — zero-counts are omitted.
 */
function buildSummary(diff: DiffResult): string {
  const parts: string[] = [];
  if (diff.summary.new > 0) parts.push(`${diff.summary.new} new`);
  if (diff.summary.removed > 0) parts.push(`${diff.summary.removed} removed`);
  if (diff.summary.changed > 0) parts.push(`${diff.summary.changed} changed`);
  return parts.length > 0 ? parts.join(", ") : "no changes";
}
