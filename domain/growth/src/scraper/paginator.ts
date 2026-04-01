import type { PaginationConfig } from "./types.ts";

/**
 * Opaque page-state token yielded by a pagination strategy each time a new
 * page's worth of content is ready for extraction.
 *
 * - `pageIndex`: 0-based page counter
 * - `itemsCollected`: running total of items seen so far (best-effort; may be 0
 *   for strategies that cannot count without access to the DOM)
 * - `done`: set to `true` on the final yield to signal the iterator has finished
 */
export interface PageState {
  pageIndex: number;
  itemsCollected: number;
  done: boolean;
}

/**
 * A pagination strategy is an `AsyncGenerator` that yields one `PageState` per
 * page and returns when pagination is exhausted or `maxItems` is reached.
 *
 * The generator receives a Puppeteer Page-like context at construction time.
 * Because the Puppeteer dependency is external to this module, the factory
 * functions accept an opaque `page` parameter typed as `unknown` — callers
 * cast to the appropriate Puppeteer type.
 */
export type PaginationStrategy = AsyncGenerator<PageState, void, unknown>;

// ─── Strategy factories ───────────────────────────────────────────────────────

/**
 * Scroll the page downward until no new content loads or `maxItems` is reached.
 * Requires runtime Puppeteer access — throws in headless/unit-test mode.
 */
export async function* infiniteScrollStrategy(
  _page: unknown,
  _config: PaginationConfig,
): PaginationStrategy {
  throw new Error(
    "infiniteScrollStrategy: Not implemented in headless mode. " +
      "Provide a Puppeteer Page instance via the scraper engine.",
  );
}

/**
 * Follow a cursor-based API (e.g., a `?cursor=` query parameter) through pages.
 * Requires runtime Puppeteer access — throws in headless/unit-test mode.
 */
export async function* cursorStrategy(
  _page: unknown,
  _config: PaginationConfig,
): PaginationStrategy {
  throw new Error(
    "cursorStrategy: Not implemented in headless mode. " +
      "Provide a Puppeteer Page instance via the scraper engine.",
  );
}

/**
 * Click a "Next" button repeatedly until it disappears or `maxItems` is reached.
 * Requires runtime Puppeteer access — throws in headless/unit-test mode.
 */
export async function* nextButtonStrategy(
  _page: unknown,
  _config: PaginationConfig,
): PaginationStrategy {
  throw new Error(
    "nextButtonStrategy: Not implemented in headless mode. " +
      "Provide a Puppeteer Page instance via the scraper engine.",
  );
}

/**
 * Resolve the appropriate strategy factory for `config.type`.
 * Returns the factory function — callers invoke it with `(page, config)`.
 */
export function resolvePaginationStrategy(
  config: PaginationConfig,
): (
  page: unknown,
  config: PaginationConfig,
) => PaginationStrategy {
  switch (config.type) {
    case "infinite_scroll":
      return infiniteScrollStrategy;
    case "cursor":
      return cursorStrategy;
    case "next_button":
      return nextButtonStrategy;
  }
}
