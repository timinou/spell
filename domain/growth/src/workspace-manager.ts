import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { WorkspaceLayout } from "./workspaces/types";

export class WorkspaceManager {
  readonly #workspacesDir: string;
  #workspaces: Map<string, WorkspaceLayout> = new Map();
  #current: WorkspaceLayout | null = null;
  #onSwitch?: (layout: WorkspaceLayout) => void;

  constructor(opts: {
    workspacesDir: string;
    onSwitch?: (layout: WorkspaceLayout) => void;
  }) {
    this.#workspacesDir = opts.workspacesDir;
    this.#onSwitch = opts.onSwitch;
  }

  async loadWorkspaces(dir?: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(dir ?? this.#workspacesDir, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) {
        // No workspace directory yet — start empty.
        return;
      }
      throw err;
    }

    const jsonFiles = entries.filter(
      (e) => e.isFile() && e.name.endsWith(".json")
    );

    await Promise.all(
      jsonFiles.map(async (entry) => {
        const filePath = path.join(dir ?? this.#workspacesDir, entry.name)
        try {
          const layout = (await Bun.file(filePath).json()) as WorkspaceLayout;
          if (layout?.id) {
            this.#workspaces.set(layout.id, layout);
          }
        } catch {
          // Malformed workspace file — skip rather than abort the whole load.
        }
      })
    );
  }

  getWorkspaces(): WorkspaceLayout[] {
    return [...this.#workspaces.values()];
  }

  getCurrentWorkspace(): WorkspaceLayout | null {
    return this.#current;
  }

  async switchWorkspace(id: string): Promise<void> {
    const ws = this.#workspaces.get(id);
    if (!ws) throw new Error(`Workspace not found: ${id}`);
    this.#current = ws;
    this.#onSwitch?.(ws);
  }
}
