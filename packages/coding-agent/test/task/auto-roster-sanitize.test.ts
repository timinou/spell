import { describe, expect, it } from "bun:test";
import { deriveAutoRosterPhaseNameFromContext, sanitizeTaskContent } from "../../src/task/sanitize";

describe("deriveAutoRosterPhaseNameFromContext", () => {
	it("extracts a heading from context containing literal \\n sequences", () => {
		const context = "## Investigation\\n## Goal\\nShip roster fixes";
		expect(deriveAutoRosterPhaseNameFromContext(context, undefined)).toBe("Investigation");
	});

	it("truncates extracted headings longer than 80 characters", () => {
		const heading = "A".repeat(81);
		const context = `## ${heading}`;
		expect(deriveAutoRosterPhaseNameFromContext(context, undefined)).toBe("A".repeat(80));
	});

	it("keeps extracted headings at exactly 80 characters", () => {
		const heading = "B".repeat(80);
		const context = `## ${heading}`;
		expect(deriveAutoRosterPhaseNameFromContext(context, undefined)).toBe(heading);
	});

	it("falls back to Tasks when context has no markdown headings", () => {
		const context = "Goal\\nConstraints\\nAcceptance";
		expect(deriveAutoRosterPhaseNameFromContext(context, undefined)).toBe("Tasks");
	});

	it("supports normal context with real newlines", () => {
		const context = "# Investigation\n## Goal\nFix task dispatch";
		expect(deriveAutoRosterPhaseNameFromContext(context, undefined)).toBe("Investigation");
	});

	it("uses explicit phase when provided", () => {
		const context = "# Investigation\n## Goal\nFix task dispatch";
		expect(deriveAutoRosterPhaseNameFromContext(context, "Manual Phase")).toBe("Manual Phase");
	});

	it("returns Tasks for undefined context", () => {
		expect(deriveAutoRosterPhaseNameFromContext(undefined, undefined)).toBe("Tasks");
	});

	it("handles mixed real and literal newlines", () => {
		const context = "## Goal\\n## Deep Dive\n## Constraints";
		expect(deriveAutoRosterPhaseNameFromContext(context, undefined)).toBe("Deep Dive");
	});
});

describe("sanitizeTaskContent", () => {
	it("strips literal \\n sequences from descriptions", () => {
		expect(sanitizeTaskContent("Inspect\\nlogs", "task-1")).toBe("Inspect logs");
	});

	it("strips real newlines from descriptions", () => {
		expect(sanitizeTaskContent("Inspect\nlogs", "task-1")).toBe("Inspect logs");
	});

	it("falls back to task id when description is empty after sanitization", () => {
		expect(sanitizeTaskContent("  \n  ", "task-42")).toBe("task-42");
	});
});
