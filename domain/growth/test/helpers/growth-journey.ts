import { Database } from 'bun:sqlite';

/**
 * Growth-specific test journey helper.
 *
 * Models the semantic actions a user takes inside the Growth shell:
 * switching workspaces, activating modes, setting filters, and asserting
 * domain-level outcomes against the backing SQLite database.
 *
 * This is intentionally DB-only — visual assertions belong in QmlJourney.
 * The two work in tandem: QmlJourney for rendered state, GrowthJourney for
 * data-layer truth.
 */
export class GrowthJourney {
  #db: Database;
  #currentWorkspace: string | null = null;
  #currentMode: string | null = null;
  #filters: Map<string, string> = new Map();

  constructor(opts: { dbPath?: string } = {}) {
    this.#db = new Database(opts.dbPath ?? ':memory:');
    this.#db.run('PRAGMA journal_mode=WAL');
    this.#db.run('PRAGMA foreign_keys=ON');
  }

  // ── Fixture loading ──────────────────────────────────────────────────────

  /** Seed the in-memory database from a SQL fixture file. */
  async seedDatabase(sqlFilePath: string): Promise<void> {
    const sql = await Bun.file(sqlFilePath).text();
    this.#db.run(sql);
  }

  // ── Navigation simulation ────────────────────────────────────────────────

  /** Record a workspace switch. Use expectWorkspace() to assert. */
  switchWorkspace(name: string): void {
    this.#currentWorkspace = name;
  }

  /** Record a mode activation. Use expectMode() to assert. */
  activateMode(name: string): void {
    this.#currentMode = name;
  }

  /** Store a filter value for later assertion or query construction. */
  setFilter(field: string, value: string): void {
    this.#filters.set(field, value);
  }

  /** Clear all active filters. */
  clearFilters(): void {
    this.#filters.clear();
  }

  // ── Domain assertions ────────────────────────────────────────────────────

  /** Assert the last recorded workspace matches. */
  expectWorkspace(name: string): void {
    if (this.#currentWorkspace !== name) {
      throw new Error(
        `Expected workspace "${name}", got "${this.#currentWorkspace}"`,
      );
    }
  }

  /** Assert the last recorded mode matches. */
  expectMode(name: string): void {
    if (this.#currentMode !== name) {
      throw new Error(
        `Expected mode "${name}", got "${this.#currentMode}"`,
      );
    }
  }

  /**
   * Assert a named metric equals expectedValue.
   *
   * Metrics are resolved by querying the `ads` table:
   *   - "active_ads"   → COUNT(*) WHERE is_active = 1
   *   - "total_ads"    → COUNT(*)
   *   - "total_pages"  → COUNT(*) FROM pages
   *   - "inactive_ads" → COUNT(*) WHERE is_active = 0
   *
   * Extend as the schema grows; unknown labels throw immediately so tests
   * fail loudly rather than silently asserting 0 === 0.
   */
  expectMetricCard(label: string, expectedValue: number): void {
    const actual = this.#resolveMetric(label);
    if (actual !== expectedValue) {
      throw new Error(
        `Metric "${label}": expected ${expectedValue}, got ${actual}`,
      );
    }
  }

  /**
   * Assert an ad row exists for the given adId.
   * Reflects what AdCard would render; throws if the row is absent.
   */
  expectAdCard(adId: string): void {
    const row = this.#db
      .query('SELECT ad_id FROM ads WHERE ad_id = ?')
      .get(adId);
    if (!row) {
      throw new Error(`Ad card not found for adId: ${adId}`);
    }
  }

  /**
   * Assert no ads exist in the database (empty-state scenario).
   * Matches what the dashboard renders on first launch.
   */
  expectEmptyState(): void {
    // On a fresh DB with no schema applied, the ads table may not exist yet.
    // Both cases (no table, or table with 0 rows) represent empty state.
    const tableExists = this.#db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name=?`,
      )
      .get('ads');
    if (!tableExists || tableExists.n === 0) return;

    const row = this.#db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM ads')
      .get();
    const count = row?.count ?? 0;
    if (count !== 0) {
      throw new Error(`Expected empty state but found ${count} ads`);
    }
  }

  /**
   * Assert that a filter stored via setFilter() would produce exactly
   * expectedCount matching rows in the ads table.
   *
   * Only the "ad_format" field is currently mapped; extend as needed.
   */
  expectFilteredCount(field: string, expectedCount: number): void {
    const value = this.#filters.get(field);
    if (value === undefined) {
      throw new Error(`No filter set for field "${field}"`);
    }
    const row = this.#db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) as count FROM ads WHERE ${this.#mapFilterColumn(field)} = ?`,
      )
      .get(value);
    const actual = row?.count ?? 0;
    if (actual !== expectedCount) {
      throw new Error(
        `Filter ${field}=${value}: expected ${expectedCount} rows, got ${actual}`,
      );
    }
  }

  // ── Direct DB access ─────────────────────────────────────────────────────

  /** Expose the underlying database for one-off queries in test bodies. */
  getDatabase(): Database {
    return this.#db;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Release the database connection. Call in afterEach/afterAll. */
  dispose(): void {
    this.#db.close();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  #resolveMetric(label: string): number {
    switch (label) {
      case 'active_ads':
        return this.#countWhere('ads', 'is_active = 1');
      case 'inactive_ads':
        return this.#countWhere('ads', 'is_active = 0');
      case 'total_ads':
        return this.#countWhere('ads');
      case 'total_pages':
        return this.#countWhere('pages');
      default:
        throw new Error(
          `Unknown metric label "${label}". ` +
          'Add it to GrowthJourney.#resolveMetric() when the schema supports it.',
        );
    }
  }

  /**
   * COUNT(*) from a table, returning 0 if the table does not yet exist.
   * Prevents metric assertions from throwing on a pre-migration database.
   */
  #countWhere(table: string, where?: string): number {
    const exists = this.#db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name=?`,
      )
      .get(table);
    if (!exists || exists.n === 0) return 0;

    const sql = where
      ? `SELECT COUNT(*) as count FROM ${table} WHERE ${where}`
      : `SELECT COUNT(*) as count FROM ${table}`;
    const row = this.#db.query<{ count: number }, []>(sql).get();
    return row?.count ?? 0;
  }

  #mapFilterColumn(field: string): string {
    const map: Record<string, string> = {
      ad_format: 'ad_format',
      format:    'ad_format',
      is_active: 'is_active',
      active:    'is_active',
      page_id:   'page_id',
    };
    const col = map[field];
    if (!col) {
      throw new Error(`Unknown filter field "${field}"`);
    }
    return col;
  }
}
