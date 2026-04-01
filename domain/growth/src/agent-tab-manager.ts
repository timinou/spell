export interface AgentTab {
  id: string;
  name: string;
  status: "idle" | "busy" | "error" | "completed";
  latestMessage?: string;
  tokenCount: number;
}

export class AgentTabManager {
  #tabs: Map<string, AgentTab> = new Map();
  #activeId: string | null = null;

  addTab(tab: AgentTab): void {
    this.#tabs.set(tab.id, tab);
    // Auto-activate the first tab added.
    if (this.#activeId === null) {
      this.#activeId = tab.id;
    }
  }

  updateStatus(
    id: string,
    status: AgentTab["status"],
    message?: string
  ): void {
    const tab = this.#tabs.get(id);
    if (!tab) throw new Error(`Tab not found: ${id}`);
    const updated: AgentTab = { ...tab, status };
    if (message !== undefined) updated.latestMessage = message;
    this.#tabs.set(id, updated);
  }

  getTabs(): AgentTab[] {
    return [...this.#tabs.values()];
  }

  getActiveTab(): AgentTab | null {
    if (this.#activeId === null) return null;
    return this.#tabs.get(this.#activeId) ?? null;
  }

  switchTab(id: string): void {
    if (!this.#tabs.has(id)) throw new Error(`Tab not found: ${id}`);
    this.#activeId = id;
  }
}
