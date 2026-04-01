import { describe, test, expect } from "bun:test";
import { computeDiff } from "../../src/signals/diff-engine.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAd(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { adId: id, ...fields };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("computeDiff", () => {
  describe("new ads", () => {
    test("records in current but not previous are classified as 'new'", () => {
      const current = [makeAd("1", { body: "hello" }), makeAd("2", { body: "world" })];
      const result = computeDiff(current, [], "adId");

      expect(result.diffs).toHaveLength(2);
      const ids = result.diffs.map((d) => d.adId).sort();
      expect(ids).toEqual(["1", "2"]);
      for (const diff of result.diffs) {
        expect(diff.type).toBe("new");
      }
    });

    test("only the new record is emitted when previous already has some", () => {
      const shared = makeAd("existing", { body: "same" });
      const current = [shared, makeAd("fresh", { body: "new" })];
      const previous = [shared];

      const result = computeDiff(current, previous, "adId");
      const newDiffs = result.diffs.filter((d) => d.type === "new");
      expect(newDiffs).toHaveLength(1);
      expect(newDiffs[0].adId).toBe("fresh");
    });
  });

  describe("removed ads", () => {
    test("records in previous but not current are classified as 'removed'", () => {
      const previous = [makeAd("gone1"), makeAd("gone2")];
      const result = computeDiff([], previous, "adId");

      expect(result.diffs).toHaveLength(2);
      const ids = result.diffs.map((d) => d.adId).sort();
      expect(ids).toEqual(["gone1", "gone2"]);
      for (const diff of result.diffs) {
        expect(diff.type).toBe("removed");
      }
    });
  });

  describe("changed ads", () => {
    test("same id with a different field value produces a 'changed' diff with before/after", () => {
      const current = [makeAd("1", { body: "updated text" })];
      const previous = [makeAd("1", { body: "original text" })];

      const result = computeDiff(current, previous, "adId");

      expect(result.diffs).toHaveLength(1);
      const diff = result.diffs[0];
      expect(diff.type).toBe("changed");
      expect(diff.adId).toBe("1");
      expect(diff.fields).toBeDefined();
      const bodyField = diff.fields!.find((f) => f.field === "body");
      expect(bodyField).toBeDefined();
      expect(bodyField!.before).toBe("original text");
      expect(bodyField!.after).toBe("updated text");
    });

    test("multiple changed fields are all reported", () => {
      const current = [makeAd("1", { title: "new title", cta: "Buy Now" })];
      const previous = [makeAd("1", { title: "old title", cta: "Learn More" })];

      const result = computeDiff(current, previous, "adId");
      const diff = result.diffs[0];
      expect(diff.type).toBe("changed");
      const fieldNames = diff.fields!.map((f) => f.field).sort();
      expect(fieldNames).toContain("title");
      expect(fieldNames).toContain("cta");
    });
  });

  describe("unchanged ads", () => {
    test("identical records produce no diff entry and all-zero summary", () => {
      const ad = makeAd("1", { body: "same", cta: "Click" });
      // Deep-copy to ensure object identity doesn't matter — only values do.
      const current = [{ ...ad }];
      const previous = [{ ...ad }];

      const result = computeDiff(current, previous, "adId");

      expect(result.diffs).toHaveLength(0);
      expect(result.summary.new).toBe(0);
      expect(result.summary.removed).toBe(0);
      expect(result.summary.changed).toBe(0);
    });
  });

  describe("both empty", () => {
    test("empty current and previous produces empty diffs and all-zero summary", () => {
      const result = computeDiff([], [], "adId");

      expect(result.diffs).toHaveLength(0);
      expect(result.summary.new).toBe(0);
      expect(result.summary.removed).toBe(0);
      expect(result.summary.changed).toBe(0);
    });
  });

  describe("summary counts", () => {
    test("summary counts exactly match the diffs array contents", () => {
      // 1 new, 1 removed, 1 changed
      const current = [
        makeAd("new-one", { body: "fresh" }),
        makeAd("shared", { body: "changed value" }),
      ];
      const previous = [
        makeAd("gone", { body: "bye" }),
        makeAd("shared", { body: "original value" }),
      ];

      const result = computeDiff(current, previous, "adId");

      expect(result.summary.new).toBe(result.diffs.filter((d) => d.type === "new").length);
      expect(result.summary.removed).toBe(result.diffs.filter((d) => d.type === "removed").length);
      expect(result.summary.changed).toBe(result.diffs.filter((d) => d.type === "changed").length);

      // Verify the expected counts explicitly.
      expect(result.summary.new).toBe(1);
      expect(result.summary.removed).toBe(1);
      expect(result.summary.changed).toBe(1);
    });
  });

  describe("missing idField", () => {
    test("records without the idField are silently skipped and not included in diffs", () => {
      // One record has 'adId', one does not.
      const current = [
        { body: "no id here" }, // missing adId — must be skipped
        makeAd("valid", { body: "present" }),
      ];
      const result = computeDiff(current, [], "adId");

      // Only the record with an adId should appear.
      expect(result.diffs).toHaveLength(1);
      expect(result.diffs[0].adId).toBe("valid");
    });

    test("records missing idField in previous are also skipped", () => {
      const previous = [
        { body: "ghost" }, // missing adId
        makeAd("real", { body: "was here" }),
      ];
      const result = computeDiff([], previous, "adId");

      expect(result.diffs).toHaveLength(1);
      expect(result.diffs[0].adId).toBe("real");
      expect(result.diffs[0].type).toBe("removed");
    });
  });

  describe("field missing on one side", () => {
    test("field present in previous but absent in current is treated as empty string in 'after'", () => {
      const current = [makeAd("1", { title: "title only" })]; // no 'cta'
      const previous = [makeAd("1", { title: "title only", cta: "Learn More" })];

      const result = computeDiff(current, previous, "adId");

      expect(result.diffs).toHaveLength(1);
      const diff = result.diffs[0];
      expect(diff.type).toBe("changed");
      const ctaField = diff.fields!.find((f) => f.field === "cta");
      expect(ctaField).toBeDefined();
      expect(ctaField!.before).toBe("Learn More");
      expect(ctaField!.after).toBe(""); // absent → empty string
    });

    test("field present in current but absent in previous is treated as empty string in 'before'", () => {
      const current = [makeAd("1", { title: "title only", cta: "Buy Now" })];
      const previous = [makeAd("1", { title: "title only" })]; // no 'cta'

      const result = computeDiff(current, previous, "adId");

      expect(result.diffs).toHaveLength(1);
      const diff = result.diffs[0];
      expect(diff.type).toBe("changed");
      const ctaField = diff.fields!.find((f) => f.field === "cta");
      expect(ctaField).toBeDefined();
      expect(ctaField!.before).toBe(""); // absent → empty string
      expect(ctaField!.after).toBe("Buy Now");
    });
  });

  describe("sourceId", () => {
    test("sourceId is always empty string regardless of input", () => {
      const r1 = computeDiff([makeAd("1")], [], "adId");
      expect(r1.sourceId).toBe("");

      const r2 = computeDiff([], [makeAd("1")], "adId");
      expect(r2.sourceId).toBe("");

      const r3 = computeDiff([], [], "adId");
      expect(r3.sourceId).toBe("");
    });
  });
});
