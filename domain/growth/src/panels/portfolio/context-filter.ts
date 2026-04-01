import type { ClientConfig } from "./types.ts";

/**
 * Tracks the active client context for panel queries.
 *
 * `buildSqlFilter()` produces a self-contained WHERE clause fragment that
 * callers splice into a larger query. The fragment references `page_name` and
 * `creative_body` columns, which are standard across ad-related views.
 *
 * When no client is active, `buildSqlFilter()` returns an empty string and
 * callers should omit the WHERE clause entirely rather than appending a
 * vacuous condition.
 */
export class ClientContextFilter {
  #activeClient: ClientConfig | null = null;

  setClient(client: ClientConfig | null): void {
    this.#activeClient = client;
  }

  getClient(): ClientConfig | null {
    return this.#activeClient;
  }

  isActive(): boolean {
    return this.#activeClient !== null;
  }

  /**
   * Returns a SQL WHERE clause fragment (without the leading "WHERE") that
   * restricts results to rows mentioning at least one of the client's keywords
   * in `page_name` or `creative_body`.
   *
   * Returns an empty string when no client is set or the client has no keywords.
   *
   * The caller is responsible for injecting the returned literal into a
   * prepared statement context. Because keywords come from trusted
   * configuration (not user input), this approach is acceptable; if keywords
   * ever become user-supplied they must be parameterised instead.
   */
  buildSqlFilter(): string {
    if (this.#activeClient === null || this.#activeClient.keywords.length === 0) {
      return "";
    }

    const terms = this.#activeClient.keywords.map((kw) => {
      // Escape SQL LIKE wildcards in the keyword itself.
      const safe = kw.replace(/[%_\\]/g, "\\$&");
      return `(LOWER(page_name) LIKE LOWER('%${safe}%') OR LOWER(creative_body) LIKE LOWER('%${safe}%'))`;
    });

    return `(${terms.join(" OR ")})`;
  }
}
