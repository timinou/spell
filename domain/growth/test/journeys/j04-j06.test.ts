import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { GrowthJourney } from '../helpers/growth-journey';
import * as path from 'node:path';
import * as fs from 'node:fs';

const FIXTURES = path.resolve(import.meta.dir, '../fixtures');
const DOMAIN_ROOT = path.resolve(import.meta.dir, '../../');

// ── J04: Client Proposal ──────────────────────────────────────────────────────
//
// Two-phase proposal flow: intel gathering in research workspace, then a mode
// transition to pitch for the client-facing deliverable.
// Data layer: workspace + mode state transitions are the primary assertions.

describe('J04: Client Proposal', () => {
  let journey: GrowthJourney;

  beforeAll(async () => {
    journey = new GrowthJourney();
    await journey.seedDatabase(path.join(FIXTURES, 'seed-pages.sql'));
    await journey.seedDatabase(path.join(FIXTURES, 'seed-ads.sql'));
  });
  afterAll(() => { journey.dispose(); });

  test('switch to strategy workspace', () => {
    journey.switchWorkspace('strategy');
    journey.expectWorkspace('strategy');
  });

  test('activate strategy mode', () => {
    journey.activateMode('strategy');
    journey.expectMode('strategy');
  });

  test('strategy workspace config exists and names correct panels', () => {
    const cfgPath = path.join(DOMAIN_ROOT, 'workspaces/strategy.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
      id: string;
      defaultMode: string;
      panels: Array<{ panelId: string; position: string }>;
    };
    expect(cfg.id).toBe('strategy');
    expect(cfg.defaultMode).toBe('strategy');
    const panelIds = cfg.panels.map(p => p.panelId);
    expect(panelIds).toContain('dashboard');
    expect(panelIds).toContain('chat');
  });

  test('strategy mode can query ad spend data for analysis', () => {
    // Simulate the data the strategy agent would read.
    const db = journey.getDatabase();
    const highSpend = db.query(
      `SELECT COUNT(*) as c FROM ads WHERE spend_range LIKE '$50,000%' OR spend_range LIKE '$25,000%'`,
    ).get() as { c: number };
    expect(highSpend.c).toBeGreaterThan(0);
  });

  test('transition from strategy to pitch mode', () => {
    journey.activateMode('pitch');
    journey.expectMode('pitch');
    // Workspace unchanged after mode transition.
    journey.expectWorkspace('strategy');
  });

  test('pitch mode: client-proposal template exists', () => {
    const typPath = path.join(DOMAIN_ROOT, 'templates/client-proposal.typ');
    const jsonPath = path.join(DOMAIN_ROOT, 'templates/client-proposal.json');
    expect(fs.existsSync(typPath)).toBe(true);
    expect(fs.existsSync(jsonPath)).toBe(true);
  });

  test('pitch mode: client-proposal template is non-empty Typst', () => {
    const content = fs.readFileSync(
      path.join(DOMAIN_ROOT, 'templates/client-proposal.typ'),
      'utf8',
    );
    expect(content.length).toBeGreaterThan(0);
    // A valid Typst template must reference the data source.
    expect(content).toContain('data.yaml');
  });
});

// ── J05: Quick Brief ──────────────────────────────────────────────────────────
//
// User enters /brief mode from the Create workspace to produce a brief document
// quickly. The data layer verifies workspace config and the template backing
// the brief mode.

describe('J05: Quick Brief', () => {
  let journey: GrowthJourney;

  beforeAll(() => { journey = new GrowthJourney(); });
  afterAll(() => { journey.dispose(); });

  test('switch to create workspace', () => {
    journey.switchWorkspace('create');
    journey.expectWorkspace('create');
  });

  test('create workspace config has editor as main panel', () => {
    const cfgPath = path.join(DOMAIN_ROOT, 'workspaces/create.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
      id: string;
      panels: Array<{ panelId: string; position: string }>;
    };
    const main = cfg.panels.find(p => p.position === 'main');
    expect(main?.panelId).toBe('editor');
  });

  test('activate brief mode', () => {
    journey.activateMode('brief');
    journey.expectMode('brief');
  });

  test('brief mode definition file exists', () => {
    const modePath = path.join(DOMAIN_ROOT, 'modes/brief.md');
    expect(fs.existsSync(modePath)).toBe(true);
    const content = fs.readFileSync(modePath, 'utf8');
    expect(content.length).toBeGreaterThan(0);
  });

  test('campaign-brief template backing brief mode exists', () => {
    const typPath = path.join(DOMAIN_ROOT, 'templates/campaign-brief.typ');
    const jsonPath = path.join(DOMAIN_ROOT, 'templates/campaign-brief.json');
    expect(fs.existsSync(typPath)).toBe(true);
    expect(fs.existsSync(jsonPath)).toBe(true);
  });

  test('campaign-brief template references data.yaml for hydration', () => {
    const content = fs.readFileSync(
      path.join(DOMAIN_ROOT, 'templates/campaign-brief.typ'),
      'utf8',
    );
    expect(content).toContain('data.yaml');
  });

  test('campaign-brief JSON schema has required variables', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(DOMAIN_ROOT, 'templates/campaign-brief.json'), 'utf8'),
    ) as { variables: Record<string, { required: boolean }> };
    const required = Object.entries(schema.variables)
      .filter(([, v]) => v.required)
      .map(([k]) => k);
    // A brief must at minimum capture a campaign name and objective.
    expect(required).toContain('campaign_name');
    expect(required).toContain('objective');
  });

  test('workspace state is stable after brief mode activation', () => {
    // Mode change must not clobber workspace.
    journey.expectWorkspace('create');
    journey.expectMode('brief');
  });
});

// ── J06: Performance Review ───────────────────────────────────────────────────
//
// User activates /review mode against live seed data to surface performance
// metrics. Data layer assertions cover metric correctness and per-page breakdowns.

describe('J06: Performance Review', () => {
  let journey: GrowthJourney;

  beforeAll(async () => {
    journey = new GrowthJourney();
    await journey.seedDatabase(path.join(FIXTURES, 'seed-pages.sql'));
    await journey.seedDatabase(path.join(FIXTURES, 'seed-ads.sql'));
  });
  afterAll(() => { journey.dispose(); });

  test('switch to review workspace', () => {
    // Review workspace exists alongside create/strategy/research.
    journey.switchWorkspace('review');
    journey.expectWorkspace('review');
  });

  test('activate review mode', () => {
    journey.activateMode('review');
    journey.expectMode('review');
  });

  test('review workspace config file is valid', () => {
    const cfgPath = path.join(DOMAIN_ROOT, 'workspaces/review.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { id: string };
    expect(cfg.id).toBe('review');
  });

  test('metric card: active_ads = 30', () => {
    journey.expectMetricCard('active_ads', 30);
  });

  test('metric card: total_ads = 50', () => {
    journey.expectMetricCard('total_ads', 50);
  });

  test('metric card: total_pages = 10', () => {
    journey.expectMetricCard('total_pages', 10);
  });

  test('per-page active ad counts are individually queryable', () => {
    const db = journey.getDatabase();
    const byPage = db.query(
      `SELECT page_id, COUNT(*) as active
         FROM ads
        WHERE is_active = 1
        GROUP BY page_id
        ORDER BY page_id`,
    ).all() as Array<{ page_id: string; active: number }>;

    // Every page in the fixture has at least 2 active ads.
    for (const row of byPage) {
      expect(row.active).toBeGreaterThanOrEqual(2);
    }
    // All 10 pages represented.
    expect(byPage.length).toBe(10);
  });

  test('high-spend ads (≥$25k) exist for analysis', () => {
    const db = journey.getDatabase();
    const count = db.query(
      `SELECT COUNT(*) as c FROM ads WHERE spend_range IN ('$25,000-$49,999','$50,000-$99,999')`,
    ).get() as { c: number };
    expect(count.c).toBeGreaterThan(0);
  });

  test('review mode definition file exists', () => {
    const modePath = path.join(DOMAIN_ROOT, 'modes/review.md');
    expect(fs.existsSync(modePath)).toBe(true);
  });
});
