import { loadScraperConfig } from "./config-loader.ts";
import { ScraperDatabase } from "./persistence.ts";
import { RateLimiter } from "./rate-limiter.ts";

/**
 * Summary returned after a scraper run.
 *
 * - `itemsScraped`: count of rows successfully inserted into the database
 * - `errors`: human-readable descriptions of non-fatal errors encountered
 * - `duration`: wall-clock duration of the run in milliseconds
 */
export interface ScraperRunResult {
  itemsScraped: number;
  errors: string[];
  duration: number;
}

/**
 * Orchestrate a full scraper run from a config file.
 *
 * This is a structured scaffold. The actual Puppeteer browser automation is
 * injected at a later phase — this function establishes the wiring:
 *   1. Load + validate config
 *   2. Initialise the database from the schema manifest
 *   3. Initialise rate limiting
 *   4. (Placeholder) Launch browser, navigate, paginate, extract, persist
 *   5. Return result summary
 *
 * When Puppeteer integration is added, replace the `// TODO: Puppeteer` blocks
 * with the real automation. Everything else (config, DB, rate limiter lifecycle)
 * is production-ready.
 *
 * @param configPath - Absolute or cwd-relative path to the YAML scraper config.
 * @param options - Template variables and runtime overrides passed to the config loader.
 */
export async function runScraper(
  configPath: string,
  options: Record<string, unknown>,
): Promise<ScraperRunResult> {
  const startMs = Date.now();
  const errors: string[] = [];
  let itemsScraped = 0;

  // ── 1. Load config ──────────────────────────────────────────────────────
  const config = await loadScraperConfig(configPath, options);

  // ── 2. Initialise database ──────────────────────────────────────────────
  const dbPath =
    typeof options["dbPath"] === "string"
      ? options["dbPath"]
      : `./${config.name}.db`;

  const db = new ScraperDatabase({
    dbPath,
    manifest: config.schemaManifest,
  });

  // ── 3. Initialise rate limiter ──────────────────────────────────────────
  const rateLimiter = config.rateLimit
    ? new RateLimiter(config.rateLimit)
    : new RateLimiter({ requestsPerMinute: 60 });

  try {
    // ── 4. Browser automation (scaffold) ─────────────────────────────────
    //
    // To integrate Puppeteer:
    //   const browser = await puppeteer.launch({ headless: true });
    //   const page = await browser.newPage();
    //
    // Setup actions:
    //   for (const action of config.setupActions ?? []) { ... }
    //
    // For each container:
    //   const items = await page.$$(container.selector);
    //   for (const item of items) {
    //     await rateLimiter.acquire(new URL(config.url).hostname);
    //     const extracted = extractFieldsFromElement(item, container.fields);
    //     db.insert(config.name, extracted);
    //     itemsScraped++;
    //   }
    //
    // Pagination:
    //   if (config.pagination) {
    //     const strategy = resolvePaginationStrategy(config.pagination);
    //     for await (const pageState of strategy(page, config.pagination)) {
    //       // extract + persist per page
    //     }
    //   }
    //
    // await browser.close();

    errors.push(
      "Puppeteer integration pending: scaffold complete, browser automation not yet wired.",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Unhandled error during scrape: ${msg}`);
    if (config.rateLimit) {
      const hostname = (() => {
        try {
          return new URL(config.url).hostname;
        } catch {
          return config.url;
        }
      })();
      rateLimiter.reportError(hostname);
    }
  } finally {
    rateLimiter.dispose();
  }

  return {
    itemsScraped,
    errors,
    duration: Date.now() - startMs,
  };
}
