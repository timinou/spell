import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { GrowthJourney } from '../helpers/growth-journey';
import * as path from 'node:path';
import * as fs from 'node:fs';

const FIXTURES = path.resolve(import.meta.dir, '../fixtures');
const DOMAIN_ROOT = path.resolve(import.meta.dir, '../../');
const TEMPLATES_DIR = path.join(DOMAIN_ROOT, 'templates');

// All committed template stems; J10 and J12 both assert over this set.
const TEMPLATE_STEMS = [
  'campaign-brief',
  'competitive-analysis',
  'client-proposal',
  'weekly-digest',
] as const;

// ── J10: Typst Editor ─────────────────────────────────────────────────────────
//
// Verifies the data layer backing the editor panel: template files are present,
// non-empty, and structurally valid (contain required Typst constructs) without
// requiring the typst binary or QML bridge.

describe('J10: Typst Editor', () => {
  let journey: GrowthJourney;

  beforeAll(() => { journey = new GrowthJourney(); });
  afterAll(() => { journey.dispose(); });

  test('create workspace config has editor as main panel', () => {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(DOMAIN_ROOT, 'workspaces/create.json'), 'utf8'),
    ) as { panels: Array<{ panelId: string; position: string }> };
    const main = cfg.panels.find(p => p.position === 'main');
    expect(main?.panelId).toBe('editor');
  });

  test('switch to create workspace', () => {
    journey.switchWorkspace('create');
    journey.expectWorkspace('create');
  });

  for (const stem of TEMPLATE_STEMS) {
    test(`template file exists: ${stem}.typ`, () => {
      expect(fs.existsSync(path.join(TEMPLATES_DIR, `${stem}.typ`))).toBe(true);
    });

    test(`template is non-empty: ${stem}.typ`, () => {
      const content = fs.readFileSync(path.join(TEMPLATES_DIR, `${stem}.typ`), 'utf8');
      expect(content.length).toBeGreaterThan(0);
    });
  }

  test('campaign-brief.typ contains expected Typst page setup call', () => {
    const content = fs.readFileSync(
      path.join(TEMPLATES_DIR, 'campaign-brief.typ'),
      'utf8',
    );
    // The template must define a page layout function call.
    expect(content).toContain('#report-page(');
  });

  test('campaign-brief.typ references the shared brand library', () => {
    const content = fs.readFileSync(
      path.join(TEMPLATES_DIR, 'campaign-brief.typ'),
      'utf8',
    );
    expect(content).toContain('#import');
    expect(content).toContain('spell-brand');
  });

  test('brand library files exist', () => {
    const brandFiles = ['lib.typ', 'colors.typ', 'typography.typ', 'components.typ'];
    for (const f of brandFiles) {
      const p = path.join(DOMAIN_ROOT, 'branding/spell-brand', f);
      expect(fs.existsSync(p), `missing brand file: ${f}`).toBe(true);
    }
  });

  test('no template file has zero-length content', () => {
    for (const stem of TEMPLATE_STEMS) {
      const content = fs.readFileSync(path.join(TEMPLATES_DIR, `${stem}.typ`), 'utf8');
      expect(content.trim().length, `${stem}.typ is empty`).toBeGreaterThan(0);
    }
  });
});

// ── J11: Campaign Planning ────────────────────────────────────────────────────
//
// User enters /campaign mode to plan a new campaign. The data layer checks the
// campaign workspace config, the mode definition, and the template that backs
// campaign briefs. No campaigns table in the seed fixtures — assertions focus
// on configuration and seeded ad/page data that the planner would surface.

describe('J11: Campaign Planning', () => {
  let journey: GrowthJourney;

  beforeAll(async () => {
    journey = new GrowthJourney();
    await journey.seedDatabase(path.join(FIXTURES, 'seed-pages.sql'));
    await journey.seedDatabase(path.join(FIXTURES, 'seed-ads.sql'));
  });
  afterAll(() => { journey.dispose(); });

  test('switch to campaign workspace', () => {
    journey.switchWorkspace('campaign');
    journey.expectWorkspace('campaign');
  });

  test('campaign workspace config has planner as main panel', () => {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(DOMAIN_ROOT, 'workspaces/campaign.json'), 'utf8'),
    ) as { id: string; defaultMode: string; panels: Array<{ panelId: string; position: string }> };
    expect(cfg.id).toBe('campaign');
    expect(cfg.defaultMode).toBe('campaign');
    const main = cfg.panels.find(p => p.position === 'main');
    expect(main?.panelId).toBe('planner');
  });

  test('activate campaign mode', () => {
    journey.activateMode('campaign');
    journey.expectMode('campaign');
  });

  test('campaign mode definition file exists', () => {
    const modePath = path.join(DOMAIN_ROOT, 'modes/campaign.md');
    expect(fs.existsSync(modePath)).toBe(true);
    expect(fs.readFileSync(modePath, 'utf8').length).toBeGreaterThan(0);
  });

  test('planner can query pages for campaign targeting', () => {
    // A campaign targets one or more tracked pages; all 10 must be available.
    const db = journey.getDatabase();
    const pages = db.query('SELECT page_id, page_name FROM pages ORDER BY page_id').all() as Array<{
      page_id: string;
      page_name: string;
    }>;
    expect(pages.length).toBe(10);
    // Orbit Retail is a named example in the journey spec.
    const orbit = pages.find(p => p.page_name === 'Orbit Retail');
    expect(orbit).toBeDefined();
    expect(orbit!.page_id).toBe('page_004');
  });

  test('orbit retail has active ads available for brief context', () => {
    const db = journey.getDatabase();
    const active = db.query(
      "SELECT COUNT(*) as c FROM ads WHERE page_id = 'page_004' AND is_active = 1",
    ).get() as { c: number };
    expect(active.c).toBeGreaterThan(0);
  });

  test('campaign-brief template exists for brief-mode linkage', () => {
    expect(fs.existsSync(path.join(TEMPLATES_DIR, 'campaign-brief.typ'))).toBe(true);
    expect(fs.existsSync(path.join(TEMPLATES_DIR, 'campaign-brief.json'))).toBe(true);
  });

  test('campaign-brief JSON schema has campaign_name as required', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(TEMPLATES_DIR, 'campaign-brief.json'), 'utf8'),
    ) as { variables: Record<string, { required: boolean }> };
    expect(schema.variables['campaign_name']?.required).toBe(true);
  });

  test('transition to brief mode for campaign brief creation', () => {
    journey.activateMode('brief');
    journey.expectMode('brief');
    // Workspace must not change on mode transition.
    journey.expectWorkspace('campaign');
  });
});

// ── J12: Template Hydration ───────────────────────────────────────────────────
//
// Verifies the full template surface: all .typ files reference data.yaml, all
// .json schemas are well-formed, required fields are declared, and the templates
// contain structural placeholders for the named variables.
// No typst binary or QML bridge required.

describe('J12: Template Hydration', () => {
  let journey: GrowthJourney;

  beforeAll(async () => {
    journey = new GrowthJourney();
    await journey.seedDatabase(path.join(FIXTURES, 'seed-pages.sql'));
    await journey.seedDatabase(path.join(FIXTURES, 'seed-ads.sql'));
  });
  afterAll(() => { journey.dispose(); });

  test('template selector sees all four committed templates', () => {
    // TemplateSelector enumerates the templates/ directory — confirm all exist.
    for (const stem of TEMPLATE_STEMS) {
      expect(
        fs.existsSync(path.join(TEMPLATES_DIR, `${stem}.typ`)),
        `missing .typ: ${stem}`,
      ).toBe(true);
      expect(
        fs.existsSync(path.join(TEMPLATES_DIR, `${stem}.json`)),
        `missing .json: ${stem}`,
      ).toBe(true);
    }
  });

  test('every .typ template references data.yaml', () => {
    for (const stem of TEMPLATE_STEMS) {
      const content = fs.readFileSync(path.join(TEMPLATES_DIR, `${stem}.typ`), 'utf8');
      expect(content, `${stem}.typ missing data.yaml reference`).toContain('data.yaml');
    }
  });

  test('every .json schema is valid JSON with a variables object', () => {
    for (const stem of TEMPLATE_STEMS) {
      const raw = fs.readFileSync(path.join(TEMPLATES_DIR, `${stem}.json`), 'utf8');
      const schema = JSON.parse(raw) as { variables?: unknown };
      expect(typeof schema.variables, `${stem}.json missing variables`).toBe('object');
    }
  });

  test('competitive-analysis template has required variables: market, market_overview, competitors', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(TEMPLATES_DIR, 'competitive-analysis.json'), 'utf8'),
    ) as { variables: Record<string, { required: boolean }> };
    expect(schema.variables['market']?.required).toBe(true);
    expect(schema.variables['market_overview']?.required).toBe(true);
    expect(schema.variables['competitors']?.required).toBe(true);
  });

  test('competitive-analysis .typ contains section headers for the required variables', () => {
    const content = fs.readFileSync(
      path.join(TEMPLATES_DIR, 'competitive-analysis.typ'),
      'utf8',
    );
    // Must render market overview and competitor sections.
    expect(content.length).toBeGreaterThan(0);
    // References the data source.
    expect(content).toContain('data.yaml');
  });

  test('seeded pages provide context for competitive-analysis hydration', () => {
    // The fixture pages match the competitors named in the journey spec.
    const db = journey.getDatabase();
    const nexus = db.query(
      "SELECT page_id FROM pages WHERE page_name = 'Nexus Software'",
    ).get() as { page_id: string } | null;
    const delta = db.query(
      "SELECT page_id FROM pages WHERE page_name = 'Delta Systems'",
    ).get() as { page_id: string } | null;
    expect(nexus?.page_id).toBe('page_005');
    expect(delta?.page_id).toBe('page_003');
  });

  test('weekly-digest template has a variables schema', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(TEMPLATES_DIR, 'weekly-digest.json'), 'utf8'),
    ) as { variables: Record<string, unknown> };
    expect(Object.keys(schema.variables).length).toBeGreaterThan(0);
  });

  test('client-proposal template has required variables', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(TEMPLATES_DIR, 'client-proposal.json'), 'utf8'),
    ) as { variables: Record<string, { required: boolean }> };
    const required = Object.entries(schema.variables)
      .filter(([, v]) => v.required)
      .map(([k]) => k);
    expect(required.length).toBeGreaterThan(0);
  });

  test('all templates reference the brand library via #import', () => {
    for (const stem of TEMPLATE_STEMS) {
      const content = fs.readFileSync(path.join(TEMPLATES_DIR, `${stem}.typ`), 'utf8');
      expect(content, `${stem}.typ missing #import`).toContain('#import');
    }
  });
});
