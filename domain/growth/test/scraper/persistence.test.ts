import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ScraperDatabase } from "../../src/scraper/persistence.ts";
import type { SchemaManifest } from "../../src/scraper/types.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Minimal manifest: a pages table and an ads table with a FK to pages. */
const MANIFEST: SchemaManifest = {
  entities: [
    {
      name: "page",
      tableName: "pages",
      columns: [
        { name: "id", type: "INTEGER", primary: true },
        { name: "platform_id", type: "TEXT" },
        { name: "scraped_at", type: "TEXT" },
        { name: "url", type: "TEXT" },
      ],
      indexes: [["platform_id"]],
    },
    {
      name: "ad",
      tableName: "ads",
      columns: [
        { name: "id", type: "INTEGER", primary: true },
        { name: "platform_id", type: "TEXT" },
        { name: "scraped_at", type: "TEXT" },
        { name: "page_id", type: "INTEGER", fk: { table: "pages", column: "id" } },
        { name: "body", type: "TEXT" },
      ],
    },
  ],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Open a fresh in-memory ScraperDatabase for each test. */
function makeDb(): ScraperDatabase {
  return new ScraperDatabase({ dbPath: ":memory:", manifest: MANIFEST });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ScraperDatabase", () => {
  describe("schema creation", () => {
    test("creates all tables declared in the manifest", () => {
      // Access the underlying SQLite directly through a second in-memory handle
      // is not possible here (separate :memory: DBs are independent).
      // Instead, verify indirectly: insert and query succeed (table exists).
      const db = makeDb();
      expect(() =>
        db.insert("page", {
          platform_id: "p1",
          scraped_at: "2024-01-01T00:00:00Z",
          url: "https://example.com",
        }),
      ).not.toThrow();
    });

    test("creates indexes without throwing", () => {
      // Schema creation is idempotent (CREATE TABLE/INDEX IF NOT EXISTS).
      expect(() => makeDb()).not.toThrow();
      expect(() => makeDb()).not.toThrow();
    });

    test("WAL mode is enabled on the connection", () => {
      // We cannot reach #db directly, so we open a temp file DB, check the pragma,
      // then clean up.
      const tmpPath = `/tmp/spell-test-wal-${Date.now()}.db`;
      try {
        new ScraperDatabase({ dbPath: tmpPath, manifest: MANIFEST });
        const probe = new Database(tmpPath);
        const row = probe.prepare("PRAGMA journal_mode").get() as {
          journal_mode: string;
        };
        probe.close();
        expect(row.journal_mode).toBe("wal");
      } finally {
        // Best-effort cleanup — ignore if unlink fails.
        try {
          const { unlinkSync } = require("fs");
          unlinkSync(tmpPath);
          unlinkSync(`${tmpPath}-wal`);
          unlinkSync(`${tmpPath}-shm`);
        } catch {
          /* ignore */
        }
      }
    });
  });

  describe("insert and query", () => {
    test("insert() adds a row retrievable by query()", () => {
      const db = makeDb();
      db.insert("page", {
        platform_id: "p1",
        scraped_at: "2024-01-01T00:00:00Z",
        url: "https://example.com",
      });

      const rows = db.query("page");
      expect(rows).toHaveLength(1);
      const row = rows[0] as Record<string, unknown>;
      expect(row.platform_id).toBe("p1");
      expect(row.url).toBe("https://example.com");
    });

    test("query() filters by equality condition", () => {
      const db = makeDb();
      db.insert("page", {
        platform_id: "p1",
        scraped_at: "2024-01-01T00:00:00Z",
        url: "https://a.com",
      });
      db.insert("page", {
        platform_id: "p2",
        scraped_at: "2024-01-01T00:00:00Z",
        url: "https://b.com",
      });

      const rows = db.query("page", { platform_id: "p1" });
      expect(rows).toHaveLength(1);
      expect((rows[0] as Record<string, unknown>).url).toBe("https://a.com");
    });

    test("query() respects limit parameter", () => {
      const db = makeDb();
      for (let i = 0; i < 5; i++) {
        db.insert("page", {
          platform_id: `p${i}`,
          scraped_at: "2024-01-01T00:00:00Z",
          url: `https://example.com/${i}`,
        });
      }

      const rows = db.query("page", undefined, 3);
      expect(rows).toHaveLength(3);
    });

    test("throws when querying unknown entity", () => {
      const db = makeDb();
      expect(() => db.query("nonexistent")).toThrow("no entity");
    });
  });

  describe("deduplication", () => {
    test("duplicate platform_id + scraped_at is silently ignored", () => {
      const db = makeDb();
      const row = {
        platform_id: "dup1",
        scraped_at: "2024-01-01T00:00:00Z",
        url: "https://first.com",
      };

      db.insert("page", row);
      // Second insert: same platform_id + scraped_at, different url — should be skipped.
      db.insert("page", { ...row, url: "https://second.com" });

      const rows = db.query("page") as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      // First row survives; second was ignored.
      expect(rows[0].url).toBe("https://first.com");
    });

    test("same platform_id with different scraped_at creates two rows", () => {
      const db = makeDb();
      db.insert("page", {
        platform_id: "p1",
        scraped_at: "2024-01-01T00:00:00Z",
        url: "https://v1.com",
      });
      db.insert("page", {
        platform_id: "p1",
        scraped_at: "2024-01-02T00:00:00Z",
        url: "https://v2.com",
      });

      expect(db.query("page")).toHaveLength(2);
    });
  });

  describe("foreign key enforcement", () => {
    test("FK constraint: ad without matching page_id is rejected", () => {
      const db = makeDb();
      // FK pragma is ON — inserting an ad referencing a non-existent page must fail.
      expect(() =>
        db.insert("ad", {
          platform_id: "ad1",
          scraped_at: "2024-01-01T00:00:00Z",
          // page_id 999 does not exist in pages
          page_id: 999,
          body: "Buy now",
        }),
      ).toThrow();
    });

    test("ad referencing an existing page inserts successfully", () => {
      const db = makeDb();

      // Insert a page first, capture its auto-assigned id via a query.
      db.insert("page", {
        platform_id: "pg1",
        scraped_at: "2024-01-01T00:00:00Z",
        url: "https://example.com",
      });
      const pages = db.query("page") as Array<Record<string, unknown>>;
      const pageId = pages[0].id as number;

      expect(() =>
        db.insert("ad", {
          platform_id: "ad1",
          scraped_at: "2024-01-01T00:00:00Z",
          page_id: pageId,
          body: "Buy now",
        }),
      ).not.toThrow();

      expect(db.query("ad")).toHaveLength(1);
    });
  });
});
