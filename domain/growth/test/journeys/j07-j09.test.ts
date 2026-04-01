import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { GrowthJourney } from '../helpers/growth-journey';
import * as path from 'node:path';
import * as fs from 'node:fs';

const FIXTURES = path.resolve(import.meta.dir, '../fixtures');
const DOMAIN_ROOT = path.resolve(import.meta.dir, '../../');

// ── J07: Workspace Switching ──────────────────────────────────────────────────
//
// User cycles research → strategy → create → general and back.
// Each switch must land on the declared workspace, and prior state must be
// unaffected (data isolation between GrowthJourney instances is :memory: based;
// state within a single instance must persist across workspace switches).

describe('J07: Workspace Switching', () => {
  let journey: GrowthJourney;

  beforeAll(async () => {
    journey = new GrowthJourney();
    await journey.seedDatabase(path.join(FIXTURES, 'seed-pages.sql'));
    await journey.seedDatabase(path.join(FIXTURES, 'seed-ads.sql'));
  });
  afterAll(() => { journey.dispose(); });

  test('start on general workspace', () => {
    journey.switchWorkspace('general');
    journey.expectWorkspace('general');
  });

  test('switch to research workspace', () => {
    journey.switchWorkspace('research');
    journey.expectWorkspace('research');
  });

  test('data persists after switching to research', () => {
    // The :memory: DB is shared within a single GrowthJourney instance.
    journey.expectMetricCard('total_ads', 50);
  });

  test('switch to strategy workspace', () => {
    journey.switchWorkspace('strategy');
    journey.expectWorkspace('strategy');
  });

  test('data persists after switching to strategy', () => {
    journey.expectMetricCard('active_ads', 30);
  });

  test('switch to create workspace', () => {
    journey.switchWorkspace('create');
    journey.expectWorkspace('create');
  });

  test('switch back to general workspace', () => {
    journey.switchWorkspace('general');
    journey.expectWorkspace('general');
  });

  test('all workspace configs exist on disk', () => {
    const workspaces = ['general', 'research', 'strategy', 'create', 'review', 'campaign'];
    for (const ws of workspaces) {
      const p = path.join(DOMAIN_ROOT, `workspaces/${ws}.json`);
      expect(fs.existsSync(p), `missing workspace config: ${ws}.json`).toBe(true);
    }
  });

  test('each workspace config has required fields', () => {
    const workspaces = ['research', 'strategy', 'create', 'review', 'campaign'];
    for (const ws of workspaces) {
      const cfg = JSON.parse(
        fs.readFileSync(path.join(DOMAIN_ROOT, `workspaces/${ws}.json`), 'utf8'),
      ) as { id: string; panels: unknown[]; defaultMode: string };
      expect(cfg.id).toBe(ws);
      expect(Array.isArray(cfg.panels)).toBe(true);
      expect(cfg.panels.length).toBeGreaterThan(0);
      expect(typeof cfg.defaultMode).toBe('string');
    }
  });

  test('mode state survives workspace switch (not reset by switchWorkspace)', () => {
    journey.activateMode('intel');
    journey.switchWorkspace('research');
    // switchWorkspace records workspace; it does not reset mode.
    journey.expectMode('intel');
    journey.expectWorkspace('research');
  });
});

// ── J08: Multi-Agent Chat / Data Persistence ──────────────────────────────────
//
// User performs several workspace switches while the DB accumulates queries.
// Verifies that multiple sequential workspace changes do not corrupt the data
// layer state and that filters set in one workspace do not bleed into another.

describe('J08: Multi-Agent Chat', () => {
  let journey: GrowthJourney;

  beforeAll(async () => {
    journey = new GrowthJourney();
    await journey.seedDatabase(path.join(FIXTURES, 'seed-pages.sql'));
    await journey.seedDatabase(path.join(FIXTURES, 'seed-ads.sql'));
  });
  afterAll(() => { journey.dispose(); });

  test('set filter in research workspace, then switch to strategy', () => {
    journey.switchWorkspace('research');
    journey.activateMode('intel');
    journey.setFilter('ad_format', 'image');
    // 25 image ads across all pages.
    journey.expectFilteredCount('ad_format', 25);

    // Switch workspace — filter context conceptually belongs to research.
    journey.switchWorkspace('strategy');
    journey.expectWorkspace('strategy');
  });

  test('clearing filters after workspace switch leaves data intact', () => {
    journey.clearFilters();
    // Full dataset still accessible.
    journey.expectMetricCard('total_ads', 50);
  });

  test('switch through all workspaces; metrics remain consistent', () => {
    const steps: Array<[string, string]> = [
      ['general', 'pitch'],
      ['research', 'intel'],
      ['strategy', 'strategy'],
      ['create', 'brief'],
      ['review', 'review'],
      ['campaign', 'campaign'],
    ];

    for (const [ws, mode] of steps) {
      journey.switchWorkspace(ws);
      journey.activateMode(mode);
      journey.expectWorkspace(ws);
      journey.expectMode(mode);
      // Data integrity must hold regardless of active workspace.
      journey.expectMetricCard('total_pages', 10);
    }
  });

  test('video ads count is stable across workspace switches', () => {
    journey.switchWorkspace('research');
    journey.setFilter('ad_format', 'video');
    journey.expectFilteredCount('ad_format', 15);
    journey.clearFilters();

    journey.switchWorkspace('strategy');
    journey.setFilter('ad_format', 'video');
    journey.expectFilteredCount('ad_format', 15);
    journey.clearFilters();
  });

  test('each page has exactly 5 ads in the dataset', () => {
    const db = journey.getDatabase();
    const counts = db.query(
      'SELECT page_id, COUNT(*) as c FROM ads GROUP BY page_id',
    ).all() as Array<{ page_id: string; c: number }>;
    for (const row of counts) {
      expect(row.c).toBe(5);
    }
    expect(counts.length).toBe(10);
  });
});

// ── J09: Mode Escalation ──────────────────────────────────────────────────────
//
// /review mode surfaces a strategic issue; user accepts the escalation and
// the system transitions to /strategy.
// Data layer: mode transitions are assertable; DB state survives the transition.

describe('J09: Mode Escalation', () => {
  let journey: GrowthJourney;

  beforeAll(async () => {
    journey = new GrowthJourney();
    await journey.seedDatabase(path.join(FIXTURES, 'seed-pages.sql'));
    await journey.seedDatabase(path.join(FIXTURES, 'seed-ads.sql'));
  });
  afterAll(() => { journey.dispose(); });

  test('start in review workspace and activate review mode', () => {
    journey.switchWorkspace('review');
    journey.activateMode('review');
    journey.expectWorkspace('review');
    journey.expectMode('review');
  });

  test('review mode can query data that would trigger an escalation', () => {
    // Delta Systems (page_003) runs 4 active video ads — unusual concentration.
    const db = journey.getDatabase();
    const deltaActive = db.query(
      `SELECT COUNT(*) as c FROM ads WHERE page_id = 'page_003' AND is_active = 1`,
    ).get() as { c: number };
    expect(deltaActive.c).toBe(4);

    const deltaVideo = db.query(
      `SELECT COUNT(*) as c FROM ads WHERE page_id = 'page_003' AND ad_format = 'video' AND is_active = 1`,
    ).get() as { c: number };
    expect(deltaVideo.c).toBe(4);
  });

  test('escalate: switch workspace to strategy', () => {
    // Simulate user accepting the escalation suggestion.
    journey.switchWorkspace('strategy');
    journey.expectWorkspace('strategy');
  });

  test('escalate: activate strategy mode', () => {
    journey.activateMode('strategy');
    journey.expectMode('strategy');
  });

  test('DB data intact after escalation transition', () => {
    // The mode+workspace switch must not affect the backing database.
    journey.expectMetricCard('total_ads', 50);
    journey.expectMetricCard('active_ads', 30);
    journey.expectMetricCard('total_pages', 10);
  });

  test('strategy stub response fixture exists for follow-up', () => {
    const stubPath = path.join(FIXTURES, 'stub-responses/strategy-response.json');
    expect(fs.existsSync(stubPath)).toBe(true);
    const stub = JSON.parse(fs.readFileSync(stubPath, 'utf8')) as Record<string, unknown>;
    // Stub must be non-empty.
    expect(Object.keys(stub).length).toBeGreaterThan(0);
  });

  test('strategy mode can query competitor spend for counter-strategy', () => {
    // Simulate the data a strategy agent would use after escalation.
    const db = journey.getDatabase();
    const deltaSpend = db.query(
      `SELECT spend_range FROM ads WHERE page_id = 'page_003' ORDER BY delivery_start_time DESC LIMIT 1`,
    ).get() as { spend_range: string } | null;
    expect(deltaSpend).not.toBeNull();
    expect(typeof deltaSpend!.spend_range).toBe('string');
  });

  test('mode file for strategy exists', () => {
    const modePath = path.join(DOMAIN_ROOT, 'modes/strategy.md');
    expect(fs.existsSync(modePath)).toBe(true);
    const content = fs.readFileSync(modePath, 'utf8');
    expect(content.length).toBeGreaterThan(0);
  });
});
