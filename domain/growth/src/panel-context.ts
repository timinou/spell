export class PanelContextManager {
  #contexts: Map<string, Record<string, unknown>> = new Map();

  updateContext(panelId: string, context: Record<string, unknown>): void {
    const existing = this.#contexts.get(panelId) ?? {};
    this.#contexts.set(panelId, { ...existing, ...context });
  }

  getContext(panelId: string): Record<string, unknown> | null {
    return this.#contexts.get(panelId) ?? null;
  }

  getAllContexts(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const [panelId, ctx] of this.#contexts) {
      result[panelId] = ctx;
    }
    return result;
  }

  /**
   * Builds a human-readable summary of all active panel contexts suitable for
   * injection into an agent prompt. Each panel emits a section with its key/value
   * pairs; empty contexts are omitted so the prompt stays concise.
   */
  buildContextSummary(): string {
    const sections: string[] = [];

    for (const [panelId, ctx] of this.#contexts) {
      const entries = Object.entries(ctx);
      if (entries.length === 0) continue;

      const lines = entries.map(([k, v]) => {
        const display =
          typeof v === "object" ? JSON.stringify(v) : String(v);
        return `  ${k}: ${display}`;
      });

      sections.push(`[${panelId}]\n${lines.join("\n")}`);
    }

    return sections.length > 0
      ? `Active panel contexts:\n${sections.join("\n\n")}`
      : "";
  }
}
