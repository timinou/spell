import { describe, expect, test } from "bun:test";
import { serializeHeading } from "../src/org-writer";

describe("serializeHeading", () => {
	test("generates valid org heading with PROPERTIES drawer", () => {
		const result = serializeHeading(1, "ITEM", "Implement feature", {
			CUSTOM_ID: "PROJ-001-implement-feature",
			EFFORT: "2h",
			PRIORITY: "#B",
		});

		expect(result).toContain("* ITEM Implement feature");
		expect(result).toContain(":PROPERTIES:");
		expect(result).toContain(":CUSTOM_ID: PROJ-001-implement-feature");
		expect(result).toContain(":EFFORT: 2h");
		expect(result).toContain(":PRIORITY: #B");
		expect(result).toContain(":END:");
	});

	test("includes body text when provided", () => {
		const result = serializeHeading(
			1,
			"DOING",
			"Fix bug",
			{ CUSTOM_ID: "BUG-001" },
			"This is the body.\nSecond line.",
		);
		expect(result).toContain("This is the body.");
		expect(result).toContain("Second line.");
	});

	test("no body produces no extra blank lines in content", () => {
		const result = serializeHeading(1, "ITEM", "No body", { CUSTOM_ID: "X-001" });
		// Should end with a single trailing newline after :END:
		expect(result.trim()).toMatch(/:END:$/);
	});

	test("respects heading level", () => {
		const h2 = serializeHeading(2, "ITEM", "Sub task", { CUSTOM_ID: "X-001" });
		expect(h2).toContain("** ITEM Sub task");

		const h3 = serializeHeading(3, "DOING", "Deep task", { CUSTOM_ID: "X-002" });
		expect(h3).toContain("*** DOING Deep task");
	});

	test("level 0 is normalized to 1", () => {
		const result = serializeHeading(0, "ITEM", "Test", { CUSTOM_ID: "X-001" });
		expect(result).toContain("* ITEM Test");
	});
});
