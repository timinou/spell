import * as path from "node:path";
import * as fs from "node:fs/promises";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

export class PanelStateManager {
  #states: Map<string, Record<string, unknown>> = new Map();
  #statePath: string;

  constructor(statePath: string) {
    this.#statePath = statePath;
  }

  async load(): Promise<void> {
    try {
      const raw = (await Bun.file(this.#statePath).json()) as Record<
        string,
        Record<string, unknown>
      >;
      for (const [panelId, state] of Object.entries(raw)) {
        this.#states.set(panelId, state);
      }
    } catch (err) {
      if (isEnoent(err)) {
        // No persisted state yet — start fresh.
        return;
      }
      throw err;
    }
  }

  async save(): Promise<void> {
    const serialized: Record<string, Record<string, unknown>> = {};
    for (const [panelId, state] of this.#states) {
      serialized[panelId] = state;
    }
    // Ensure parent directory exists before writing.
    await fs.mkdir(path.dirname(this.#statePath), { recursive: true });
    await Bun.write(
      Bun.file(this.#statePath),
      JSON.stringify(serialized, null, 2)
    );
  }

  getState(panelId: string): Record<string, unknown> | null {
    return this.#states.get(panelId) ?? null;
  }

  setState(panelId: string, state: Record<string, unknown>): void {
    this.#states.set(panelId, state);
    // Fire-and-forget persist; callers that need durability guarantees should await save() directly.
    void this.save().catch((err) =>
      logger.warn("panel-state: save failed", { error: String(err) }),
    );
  }
}
