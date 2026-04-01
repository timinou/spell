import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceManager } from "../../src/workspace-manager.ts";
import type { WorkspaceLayout } from "../../src/workspaces/types.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WS_ALPHA: WorkspaceLayout = {
  id: "alpha",
  name: "Alpha",
  icon: "grid",
  panels: [{ panelId: "main-panel", position: "main", flex: 1 }],
};

const WS_BETA: WorkspaceLayout = {
  id: "beta",
  name: "Beta",
  icon: "columns",
  panels: [
    { panelId: "left", position: "main", flex: 2 },
    { panelId: "right", position: "secondary", flex: 1 },
  ],
  defaultMode: "split",
};

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-test-"));
});

afterAll(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WorkspaceManager", () => {
  describe("loadWorkspaces()", () => {
    test("reads valid JSON files and exposes them via getWorkspaces()", async () => {
      await Bun.write(path.join(tmpDir, "alpha.json"), JSON.stringify(WS_ALPHA));
      await Bun.write(path.join(tmpDir, "beta.json"), JSON.stringify(WS_BETA));

      const mgr = new WorkspaceManager({ workspacesDir: tmpDir });
      await mgr.loadWorkspaces(tmpDir);

      const workspaces = mgr.getWorkspaces();
      expect(workspaces).toHaveLength(2);

      const ids = workspaces.map((w) => w.id).sort();
      expect(ids).toEqual(["alpha", "beta"]);

      const alpha = workspaces.find((w) => w.id === "alpha")!;
      expect(alpha.name).toBe("Alpha");
      expect(alpha.panels).toHaveLength(1);
      expect(alpha.panels[0].panelId).toBe("main-panel");
    });

    test("returns empty and does not throw when the directory does not exist", async () => {
      const missing = path.join(tmpDir, "no-such-dir");
      const mgr = new WorkspaceManager({ workspacesDir: missing });

      await expect(mgr.loadWorkspaces(missing)).resolves.toBeUndefined();
      expect(mgr.getWorkspaces()).toHaveLength(0);
    });

    test("skips malformed JSON files and loads the valid ones", async () => {
      await Bun.write(path.join(tmpDir, "good.json"), JSON.stringify(WS_ALPHA));
      // Syntactically invalid JSON
      await Bun.write(path.join(tmpDir, "broken.json"), "{ not valid json }}");
      // Valid JSON but no 'id' field — should also be skipped
      await Bun.write(
        path.join(tmpDir, "no-id.json"),
        JSON.stringify({ name: "NoId", icon: "x", panels: [] }),
      );

      const mgr = new WorkspaceManager({ workspacesDir: tmpDir });
      await mgr.loadWorkspaces(tmpDir);

      const workspaces = mgr.getWorkspaces();
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].id).toBe("alpha");
    });

    test("uses the constructor workspacesDir when called with no argument", async () => {
      await Bun.write(path.join(tmpDir, "alpha.json"), JSON.stringify(WS_ALPHA));

      // Pass tmpDir only to the constructor — loadWorkspaces() gets no override.
      const mgr = new WorkspaceManager({ workspacesDir: tmpDir });
      await mgr.loadWorkspaces();

      const workspaces = mgr.getWorkspaces();
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].id).toBe("alpha");
    });
  });

  describe("getWorkspaces()", () => {
    test("returns all loaded workspaces with their full data intact", async () => {
      await Bun.write(path.join(tmpDir, "alpha.json"), JSON.stringify(WS_ALPHA));
      await Bun.write(path.join(tmpDir, "beta.json"), JSON.stringify(WS_BETA));

      const mgr = new WorkspaceManager({ workspacesDir: tmpDir });
      await mgr.loadWorkspaces(tmpDir);

      const workspaces = mgr.getWorkspaces();
      const beta = workspaces.find((w) => w.id === "beta")!;

      expect(beta.name).toBe("Beta");
      expect(beta.defaultMode).toBe("split");
      expect(beta.panels).toHaveLength(2);
      expect(beta.panels[1].position).toBe("secondary");
    });
  });

  describe("switchWorkspace()", () => {
    test("sets current workspace and invokes the onSwitch callback", async () => {
      await Bun.write(path.join(tmpDir, "alpha.json"), JSON.stringify(WS_ALPHA));
      await Bun.write(path.join(tmpDir, "beta.json"), JSON.stringify(WS_BETA));

      const received: WorkspaceLayout[] = [];
      const mgr = new WorkspaceManager({
        workspacesDir: tmpDir,
        onSwitch: (layout) => received.push(layout),
      });
      await mgr.loadWorkspaces(tmpDir);

      await mgr.switchWorkspace("beta");

      expect(mgr.getCurrentWorkspace()?.id).toBe("beta");
      expect(received).toHaveLength(1);
      expect(received[0].id).toBe("beta");
    });

    test("throws when the requested ID is not found", async () => {
      const mgr = new WorkspaceManager({ workspacesDir: tmpDir });
      // No workspaces loaded — any id is unknown.
      await expect(mgr.switchWorkspace("nonexistent")).rejects.toThrow("nonexistent");
    });
  });

  describe("getCurrentWorkspace()", () => {
    test("returns null before any switchWorkspace() call", async () => {
      await Bun.write(path.join(tmpDir, "alpha.json"), JSON.stringify(WS_ALPHA));

      const mgr = new WorkspaceManager({ workspacesDir: tmpDir });
      await mgr.loadWorkspaces(tmpDir);

      // Workspaces are loaded but none is active yet.
      expect(mgr.getCurrentWorkspace()).toBeNull();
    });
  });
});
