import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DeliverableManager } from "../../src/pipeline/manager.ts";
import type { Deliverable } from "../../src/pipeline/types.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

let tmpDir: string;
const originalCwd = process.cwd();

// Create a temp directory, chdir into it so that manager's relative
// `deliverables/` writes land inside the temp dir, not the repo root.
async function setupTmpDir(): Promise<void> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-pipeline-test-"));
  process.chdir(tmpDir);
}

// Each manager uses an in-memory DB. The chdir is shared across the suite.
function makeManager(): DeliverableManager {
  return new DeliverableManager({ dbPath: ":memory:" });
}

// ─── Suite setup / teardown ──────────────────────────────────────────────────

// Run once before the first test.
// bun:test executes beforeEach before every test; we use a flag so the
// directory is created exactly once even though this file uses beforeEach only
// for the manager.
let dirReady = false;
beforeEach(async () => {
  if (!dirReady) {
    await setupTmpDir();
    dirReady = true;
  }
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("DeliverableManager", () => {
  describe("create()", () => {
    test("returns a BRIEF-state deliverable with UUID id, filePath, type, and title", () => {
      const mgr = makeManager();
      const d = mgr.create({ title: "Q1 Digest", type: "weekly-digest" });

      expect(d.state).toBe("BRIEF");
      expect(d.title).toBe("Q1 Digest");
      expect(d.type).toBe("weekly-digest");
      // UUID prefix check — avoids brittle full-format regex but confirms it is not empty/sequential.
      expect(d.id).toMatch(/^[0-9a-f]{8}-/);
      // filePath must contain the deliverables/ prefix and the UUID
      expect(d.filePath).toMatch(/^deliverables\//);
      expect(d.filePath).toContain(d.id);
      expect(d.filePath).toMatch(/\.typ$/);
      // orgItemId is empty string at creation
      expect(d.orgItemId).toBe("");
      mgr.dispose();
    });

    test("writes a .typ file stub to disk at the reported filePath", async () => {
      const mgr = makeManager();
      const d = mgr.create({ title: "Market Brief", type: "campaign-brief" });

      // filePath is relative to cwd; cwd is tmpDir for this suite.
      const absPath = path.join(tmpDir, d.filePath);
      const exists = await Bun.file(absPath).exists();
      expect(exists).toBe(true);

      // Content must contain something (not an empty stub).
      const content = await Bun.file(absPath).text();
      expect(content.length).toBeGreaterThan(0);

      mgr.dispose();
    });

    test("associates clientId when supplied", () => {
      const mgr = makeManager();
      const d = mgr.create({ title: "Proposal", type: "client-proposal", clientId: "client-42" });

      expect(d.clientId).toBe("client-42");
      mgr.dispose();
    });
  });

  describe("advance()", () => {
    test("transitions BRIEF→DRAFT→REVIEW→FINAL→SENT in correct order", () => {
      const mgr = makeManager();
      let d: Deliverable = mgr.create({ title: "Full Chain", type: "custom" });

      expect(d.state).toBe("BRIEF");

      d = mgr.advance(d.id, "DRAFT");
      expect(d.state).toBe("DRAFT");

      d = mgr.advance(d.id, "REVIEW");
      expect(d.state).toBe("REVIEW");

      d = mgr.advance(d.id, "FINAL");
      expect(d.state).toBe("FINAL");

      d = mgr.advance(d.id, "SENT");
      expect(d.state).toBe("SENT");

      mgr.dispose();
    });

    test("rejects skip transition BRIEF→FINAL (throws)", () => {
      const mgr = makeManager();
      const d = mgr.create({ title: "Skip Test", type: "custom" });

      expect(() => mgr.advance(d.id, "FINAL")).toThrow();
      mgr.dispose();
    });

    test("rejects same-state transition (throws)", () => {
      const mgr = makeManager();
      const d = mgr.create({ title: "Same State", type: "custom" });

      // BRIEF→BRIEF is not a forward step.
      expect(() => mgr.advance(d.id, "BRIEF")).toThrow();
      mgr.dispose();
    });

    test("throws on nonexistent ID", () => {
      const mgr = makeManager();

      expect(() => mgr.advance("00000000-0000-0000-0000-000000000000", "DRAFT")).toThrow(
        /not found/,
      );
      mgr.dispose();
    });

    test("throws when advancing past SENT (terminal state has no next state)", () => {
      const mgr = makeManager();
      let d: Deliverable = mgr.create({ title: "Terminal", type: "custom" });

      for (const state of ["DRAFT", "REVIEW", "FINAL", "SENT"] as const) {
        d = mgr.advance(d.id, state);
      }

      // SENT is terminal — any further advance must throw.
      expect(() => mgr.advance(d.id, "SENT")).toThrow();
      mgr.dispose();
    });
  });

  describe("getById()", () => {
    test("returns the deliverable when it exists", () => {
      const mgr = makeManager();
      const d = mgr.create({ title: "Lookup Test", type: "weekly-digest" });

      const found = mgr.getById(d.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(d.id);
      expect(found!.title).toBe("Lookup Test");
      mgr.dispose();
    });

    test("returns null for a missing ID", () => {
      const mgr = makeManager();

      expect(mgr.getById("nonexistent-id")).toBeNull();
      mgr.dispose();
    });
  });

  describe("listByState()", () => {
    test("filters deliverables by state across a mixed set", () => {
      const mgr = makeManager();

      // Create 3 in BRIEF, advance 2 to DRAFT, advance 1 of those to REVIEW.
      const [a, b, c] = [
        mgr.create({ title: "A", type: "custom" }),
        mgr.create({ title: "B", type: "custom" }),
        mgr.create({ title: "C", type: "custom" }),
      ];

      mgr.advance(a.id, "DRAFT");
      mgr.advance(b.id, "DRAFT");
      mgr.advance(a.id, "REVIEW");

      // State counts: BRIEF=1(c), DRAFT=1(b), REVIEW=1(a)
      expect(mgr.listByState("BRIEF")).toHaveLength(1);
      expect(mgr.listByState("BRIEF")[0].id).toBe(c.id);

      expect(mgr.listByState("DRAFT")).toHaveLength(1);
      expect(mgr.listByState("DRAFT")[0].id).toBe(b.id);

      expect(mgr.listByState("REVIEW")).toHaveLength(1);
      expect(mgr.listByState("REVIEW")[0].id).toBe(a.id);

      expect(mgr.listByState("FINAL")).toHaveLength(0);
      expect(mgr.listByState("SENT")).toHaveLength(0);

      mgr.dispose();
    });
  });

  describe("listByClient()", () => {
    test("filters deliverables by clientId, ignoring others", () => {
      const mgr = makeManager();

      mgr.create({ title: "Client A #1", type: "client-proposal", clientId: "client-a" });
      mgr.create({ title: "Client A #2", type: "client-proposal", clientId: "client-a" });
      mgr.create({ title: "Client B #1", type: "client-proposal", clientId: "client-b" });
      mgr.create({ title: "No Client", type: "custom" });

      const forA = mgr.listByClient("client-a");
      expect(forA).toHaveLength(2);
      expect(forA.every((d) => d.clientId === "client-a")).toBe(true);

      const forB = mgr.listByClient("client-b");
      expect(forB).toHaveLength(1);
      expect(forB[0].clientId).toBe("client-b");

      expect(mgr.listByClient("client-unknown")).toHaveLength(0);

      mgr.dispose();
    });
  });

  describe("dispose()", () => {
    test("closes the DB without throwing", () => {
      const mgr = makeManager();
      // Perform a write so the DB is definitely open and used before dispose.
      mgr.create({ title: "Dispose Test", type: "custom" });

      expect(() => mgr.dispose()).not.toThrow();
    });
  });
});
