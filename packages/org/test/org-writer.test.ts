import { describe, expect, test } from "bun:test";
import { serializeFileItem, serializeHeading } from "../src/org-writer";

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

describe("serializeFileItem", () => {
	test("writes title, state, and per-item properties", () => {
		const result = serializeFileItem("My Task", "ITEM", { CUSTOM_ID: "PROJ-001" });
		expect(result).toContain("#+TITLE: My Task");
		expect(result).toContain("#+STATE: ITEM");
		expect(result).toContain("#+CUSTOM_ID: PROJ-001");
	});

	test("includes user body when provided", () => {
		const result = serializeFileItem("Task", "ITEM", {}, "body text");
		expect(result).toContain("body text");
	});

	test("writes SESSION_ID and TRANSCRIPT_PATH when session provided", () => {
		const result = serializeFileItem("Task", "ITEM", {}, undefined, {
			sessionId: "abc123",
			transcriptPath: "/home/user/.spell/sessions/abc.jsonl",
		});
		expect(result).toContain("#+SESSION_ID: abc123");
		expect(result).toContain("#+TRANSCRIPT_PATH: [[file:/home/user/.spell/sessions/abc.jsonl]]");
	});

	test("writes Initial Message section when initial message provided", () => {
		const result = serializeFileItem("Task", "ITEM", {}, undefined, {
			initialMessage: "You are a helpful agent.",
		});
		expect(result).toContain("* Initial Message");
		expect(result).toContain("You are a helpful agent.");
	});

	test("Initial Message section appears before user body", () => {
		const result = serializeFileItem("Task", "ITEM", {}, "user body", {
			initialMessage: "sys prompt",
		});
		const bodyIdx = result.indexOf("user body");
		const promptIdx = result.indexOf("* Initial Message");
		expect(promptIdx).toBeGreaterThan(0);
		expect(bodyIdx).toBeGreaterThan(promptIdx);
	});

	test("omits session fields when no session context provided", () => {
		const result = serializeFileItem("Task", "ITEM", {});
		expect(result).not.toContain("#+SESSION_ID");
		expect(result).not.toContain("#+TRANSCRIPT_PATH");
		expect(result).not.toContain("* Initial Message");
	});

	test("partial session context writes only present fields", () => {
		const result = serializeFileItem("Task", "ITEM", {}, undefined, { sessionId: "s1" });
		expect(result).toContain("#+SESSION_ID: s1");
		expect(result).not.toContain("#+TRANSCRIPT_PATH");
		expect(result).not.toContain("* Initial Prompt");
	});

	test("session properties appear before per-item properties in frontmatter", () => {
		const result = serializeFileItem("Task", "ITEM", { CUSTOM_ID: "X-001" }, undefined, {
			sessionId: "s1",
		});
		const sessionIdx = result.indexOf("#+SESSION_ID");
		const customIdx = result.indexOf("#+CUSTOM_ID");
		expect(sessionIdx).toBeGreaterThan(0);
		expect(customIdx).toBeGreaterThan(sessionIdx);
	});
});
