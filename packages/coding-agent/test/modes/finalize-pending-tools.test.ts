import { beforeAll, describe, expect, test } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "../../src/modes/components/tool-execution";
import { initTheme } from "../../src/modes/theme/theme";

// Headless stub: the component only calls ui.requestRender(); no live TUI in tests.
const stubTui = { requestRender: () => {} } as unknown as TUI;

beforeAll(async () => {
	// ToolExecutionComponent#updateDisplay reads the global theme instance.
	await initTheme();
});

import { finalizeOrphanPendingTools, INTERRUPTED_TOOL_RESULT_TEXT } from "../../src/modes/utils/finalize-pending-tools";

function makePending(toolName = "edit"): ToolExecutionComponent {
	return new ToolExecutionComponent(
		toolName,
		{},
		{ showImages: false, editFuzzyThreshold: 0, editAllowFuzzy: false },
		undefined,
		stubTui,
		process.cwd(),
	);
}

describe("ToolExecutionComponent.isPending", () => {
	test("is true before any result, false after a terminal result", () => {
		const c = makePending();
		expect(c.isPending).toBe(true);
		c.updateResult({ content: [{ type: "text", text: "out" }], isError: false }, false, "t1");
		expect(c.isPending).toBe(false);
	});

	test("stays pending for a partial (still-running) result", () => {
		const c = makePending();
		c.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true, "t1");
		expect(c.isPending).toBe(true);
	});
});

describe("finalizeOrphanPendingTools", () => {
	test("finalizes a pending cell that never received a result", () => {
		const c = makePending();
		expect(c.isPending).toBe(true);
		const map = new Map<string, ToolExecutionComponent>([["t1", c]]);

		const finalized = finalizeOrphanPendingTools(map, new Set());

		expect(finalized).toEqual(["t1"]);
		expect(c.isPending).toBe(false);
		expect(map.size).toBe(0);
	});

	test("uses the interrupted sentinel as the error result text", () => {
		const c = makePending("bash");
		const map = new Map<string, ToolExecutionComponent>([["t1", c]]);

		finalizeOrphanPendingTools(map, new Set());

		// The finalized cell carries an error result with the sentinel text.
		expect(c.isPending).toBe(false);
		expect(INTERRUPTED_TOOL_RESULT_TEXT.length).toBeGreaterThan(0);
	});

	test("leaves genuinely-running background cells untouched", () => {
		const c = makePending("bash");
		const map = new Map<string, ToolExecutionComponent>([["bg", c]]);

		const finalized = finalizeOrphanPendingTools(map, new Set(["bg"]));

		expect(finalized).toEqual([]);
		expect(c.isPending).toBe(true);
		expect(map.size).toBe(1);
	});

	test("finalizes non-background and preserves background in a mixed map", () => {
		const orphan = makePending("edit");
		const bg = makePending("bash");
		const map = new Map<string, ToolExecutionComponent>([
			["orphan", orphan],
			["bg", bg],
		]);

		const finalized = finalizeOrphanPendingTools(map, new Set(["bg"]));

		expect(finalized).toEqual(["orphan"]);
		expect(orphan.isPending).toBe(false);
		expect(bg.isPending).toBe(true);
		expect(map.has("bg")).toBe(true);
		expect(map.has("orphan")).toBe(false);
	});
});
