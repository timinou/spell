import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { GrowthJourney } from '../helpers/growth-journey';
import * as path from 'node:path';

const FIXTURES = path.resolve(import.meta.dir, '../fixtures');

// ── J01: First Launch (empty state) ──────────────────────────────────────────
//
// Exercises the zero-data state: fresh :memory: database with no seeds applied.
// All data assertions must resolve to 0 / absent.

describe('J01: First Launch (empty state)', () => {
  let journey: GrowthJourney;

  beforeAll(() => { journey = new GrowthJourney(); });
  afterAll(() => { journey.dispose(); });

  test('database has no tables initially', () => {
    const db = journey.getDatabase();
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all();
    // Fresh :memory: DB with only PRAGMA statements applied has no user tables.
    expect(tables.length).toBe(0);
  });

  test('default workspace is general', () => {
    journey.switchWorkspace('general');
    journey.expectWorkspace('general');
  });

  test('all metrics resolve to 0 on empty DB', () => {
    // GrowthJourney.#countWhere guards against missing tables; all must be 0.
    journey.expectMetricCard('active_ads', 0);
    journey.expectMetricCard('total_ads', 0);
    journey.expectMetricCard('total_pages', 0);
    journey.expectMetricCard('inactive_ads', 0);
  });

  test('empty state assertion passes with no ads table', () => {
    // expectEmptyState must not throw when the table does not yet exist.
    expect(() => journey.expectEmptyState()).not.toThrow();
  });
});

// ── J02: Morning Dashboard Review ────────────────────────────────────────────
//
// Simulates the user opening the app after an overnight scrape: full fixture
// dataset is loaded and metric cards reflect the seed totals.

describe('J02: Morning Dashboard Review', () => {
  let journey: GrowthJourney;

  beforeAll(async () => {
    journey = new GrowthJourney();
    await journey.seedDatabase(path.join(FIXTURES, 'seed-pages.sql'));
    await journey.seedDatabase(path.join(FIXTURES, 'seed-ads.sql'));
  });
  afterAll(() => { journey.dispose(); });

  test('seeded data contains 10 pages', () => {
    const db = journey.getDatabase();
    const count = db.query('SELECT COUNT(*) as c FROM pages').get() as { c: number };
    expect(count.c).toBe(10);
  });

  test('seeded data contains 50 ads', () => {
    const db = journey.getDatabase();
    const count = db.query('SELECT COUNT(*) as c FROM ads').get() as { c: number };
    expect(count.c).toBe(50);
  });

  test('30 ads are active', () => {
    const db = journey.getDatabase();
    const count = db.query('SELECT COUNT(*) as c FROM ads WHERE is_active = 1').get() as { c: number };
    expect(count.c).toBe(30);
  });

  test('20 ads are inactive', () => {
    const db = journey.getDatabase();
    const count = db.query('SELECT COUNT(*) as c FROM ads WHERE is_active = 0').get() as { c: number };
    expect(count.c).toBe(20);
  });

  test('metric cards match seed totals', () => {
    journey.expectMetricCard('active_ads', 30);
    journey.expectMetricCard('total_ads', 50);
    journey.expectMetricCard('total_pages', 10);
    journey.expectMetricCard('inactive_ads', 20);
  });

  test('ad cards exist for boundary ads', () => {
    // First and last ad in the fixture set.
    journey.expectAdCard('ad_001');
    journey.expectAdCard('ad_050');
  });

  test('FK integrity: all ads reference valid pages', () => {
    const db = journey.getDatabase();
    const orphans = db.query(
      'SELECT COUNT(*) as c FROM ads WHERE page_id NOT IN (SELECT page_id FROM pages)',
    ).get() as { c: number };
    expect(orphans.c).toBe(0);
  });

  test('ad format distribution: 25 image / 15 video / 10 carousel', () => {
    // Validates the fixture comment at the top of seed-ads.sql.
    const db = journey.getDatabase();
    const formats = db.query(
      "SELECT ad_format, COUNT(*) as c FROM ads GROUP BY ad_format ORDER BY ad_format",
    ).all() as Array<{ ad_format: string; c: number }>;
    const byFormat = Object.fromEntries(formats.map(r => [r.ad_format, r.c]));
    expect(byFormat['carousel']).toBe(10);
    expect(byFormat['image']).toBe(25);
    expect(byFormat['video']).toBe(15);
  });
});

// ── J03: Competitive Scan ─────────────────────────────────────────────────────
//
// User switches to the Research workspace to run an intel scan.
// workspace → research, mode → intel, data queries reflect seeded ads.

describe('J03: Competitive Scan', () => {
  let journey: GrowthJourney;

  beforeAll(async () => {
    journey = new GrowthJourney();
    await journey.seedDatabase(path.join(FIXTURES, 'seed-pages.sql'));
    await journey.seedDatabase(path.join(FIXTURES, 'seed-ads.sql'));
  });
  afterAll(() => { journey.dispose(); });

  test('switch to research workspace', () => {
    journey.switchWorkspace('research');
    journey.expectWorkspace('research');
  });

  test('activate intel mode', () => {
    journey.activateMode('intel');
    journey.expectMode('intel');
  });

  test('intel query returns 10 most-recently scraped active ads', () => {
    const db = journey.getDatabase();
    const ads = db.query(
      'SELECT * FROM ads WHERE is_active = 1 ORDER BY scraped_at DESC LIMIT 10',
    ).all();
    expect(ads.length).toBe(10);
  });

  test('ad_format filter returns only matching rows', () => {
    journey.setFilter('ad_format', 'video');
    // 15 video ads in total; all are either active or inactive — filter is format-only.
    journey.expectFilteredCount('ad_format', 15);
    journey.clearFilters();
  });

  test('research workspace ads belong to known pages', () => {
    // Any page referenced by an active ad must exist in the pages table.
    const db = journey.getDatabase();
    const missing = db.query(
      `SELECT COUNT(*) as c
         FROM ads a
        WHERE a.is_active = 1
          AND a.page_id NOT IN (SELECT page_id FROM pages)`,
    ).get() as { c: number };
    expect(missing.c).toBe(0);
  });

  test('mode state is preserved across filter operations', () => {
    // setFilter/clearFilters must not mutate mode or workspace state.
    journey.setFilter('active', '1');
    journey.clearFilters();
    journey.expectWorkspace('research');
    journey.expectMode('intel');
  });
});
