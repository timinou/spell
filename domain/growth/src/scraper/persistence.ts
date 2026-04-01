import { Database } from "bun:sqlite";
import type { SchemaManifest } from "./types.ts";

interface ScraperDatabaseOptions {
  dbPath: string;
  manifest: SchemaManifest;
}

/**
 * SQLite-backed persistence layer for scraped entities.
 *
 * Schema is derived from the `SchemaManifest` supplied at construction.
 * Each entity gets:
 *   - A base table `<tableName>`
 *   - A `latest_<tableName>` view that surfaces only the most recently scraped
 *     row per `platform_id` (deduplicated via ROW_NUMBER).
 *
 * Deduplication strategy: before inserting a row, check for an existing row
 * with the same `platform_id` and `scraped_at`. If one exists, skip the insert.
 * This is intentionally lightweight — deep content diffing is a higher-level concern.
 *
 * WAL mode and foreign keys are enabled on every connection open.
 */
export class ScraperDatabase {
  readonly #db: Database;
  readonly #manifest: SchemaManifest;

  constructor({ dbPath, manifest }: ScraperDatabaseOptions) {
    this.#manifest = manifest;
    this.#db = new Database(dbPath, { create: true });
    this.#db.exec("PRAGMA journal_mode=WAL;");
    this.#db.exec("PRAGMA foreign_keys=ON;");
    this.#ensureSchema();
  }

  /**
   * Insert `data` into the entity table identified by `entityName`.
   * Silently skips the insert when a row with the same `platform_id` + `scraped_at` exists.
   */
  insert(entityName: string, data: Record<string, unknown>): void {
    const entity = this.#requireEntity(entityName);
    const columns = entity.columns.map((c) => c.name);

    // Deduplication guard: only applies when both columns are present in the schema.
    if (
      columns.includes("platform_id") &&
      columns.includes("scraped_at") &&
      data["platform_id"] !== undefined &&
      data["scraped_at"] !== undefined
    ) {
      const exists = this.#db
        .prepare(
          `SELECT 1 FROM ${entity.tableName} WHERE platform_id = ? AND scraped_at = ? LIMIT 1`,
        )
        .get(data["platform_id"] as string, data["scraped_at"] as string);
      if (exists !== null) return;
    }

    const presentColumns = columns.filter((c) => data[c] !== undefined);
    if (presentColumns.length === 0) return;

    const placeholders = presentColumns.map(() => "?").join(", ");
    const values = presentColumns.map((c) => data[c] ?? null);

    this.#db
      .prepare(
        `INSERT INTO ${entity.tableName} (${presentColumns.join(", ")}) VALUES (${placeholders})`,
      )
      .run(...(values as Parameters<ReturnType<Database["prepare"]>["run"]>));
  }

  /**
   * Query rows from the entity table.
   * `filters` are applied as equality AND conditions.
   * `limit` defaults to 1000 when omitted.
   */
  query(
    entityName: string,
    filters?: Record<string, unknown>,
    limit = 1_000,
  ): unknown[] {
    const entity = this.#requireEntity(entityName);

    const conditions: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(filters ?? {})) {
      conditions.push(`${key} = ?`);
      values.push(value);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM ${entity.tableName} ${where} LIMIT ?`;
    values.push(limit);

    return this.#db
      .prepare(sql)
      .all(...(values as Parameters<ReturnType<Database["prepare"]>["all"]>));
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /** Build all tables, indexes, and latest_* views from the manifest. */
  #ensureSchema(): void {
    for (const entity of this.#manifest.entities) {
      // Build column definitions
      const columnDefs = entity.columns
        .map((col) => {
          const parts: string[] = [`${col.name} ${col.type}`];
          if (col.primary) parts.push("PRIMARY KEY");
          if (col.fk) {
            parts.push(
              `REFERENCES ${col.fk.table}(${col.fk.column})`,
            );
          }
          return parts.join(" ");
        })
        .join(",\n  ");

      this.#db.exec(
        `CREATE TABLE IF NOT EXISTS ${entity.tableName} (\n  ${columnDefs}\n);`,
      );

      // Create requested indexes (composite allowed)
      for (const indexCols of entity.indexes ?? []) {
        const indexName = `idx_${entity.tableName}_${indexCols.join("_")}`;
        this.#db.exec(
          `CREATE INDEX IF NOT EXISTS ${indexName} ON ${entity.tableName} (${indexCols.join(", ")});`,
        );
      }

      // Create latest_* view if the table has a scraped_at column.
      // The view surfaces the most recently scraped row per platform_id.
      const hasScrapedAt = entity.columns.some((c) => c.name === "scraped_at");
      const hasPlatformId = entity.columns.some((c) => c.name === "platform_id");
      if (hasScrapedAt && hasPlatformId) {
        this.#db.exec(`
          CREATE VIEW IF NOT EXISTS latest_${entity.tableName} AS
          SELECT * FROM (
            SELECT *,
              ROW_NUMBER() OVER (
                PARTITION BY platform_id ORDER BY scraped_at DESC
              ) AS rn
            FROM ${entity.tableName}
          ) WHERE rn = 1;
        `);
      }
    }
  }

  #requireEntity(entityName: string) {
    const entity = this.#manifest.entities.find((e) => e.name === entityName);
    if (entity === undefined) {
      throw new Error(
        `ScraperDatabase: no entity "${entityName}" in manifest. ` +
          `Known entities: ${this.#manifest.entities.map((e) => e.name).join(", ")}`,
      );
    }
    return entity;
  }
}
