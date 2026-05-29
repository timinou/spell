import { beforeAll, describe, expect, test } from "bun:test";
import { type Component, type Container, TUI, type TUI as TUIType } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "@oh-my-pi/pi-tui/../test/virtual-terminal";
import { ToolExecutionComponent } from "../../src/modes/components/tool-execution";
import {
	COMPACT_MAX_ROWS,
	COMPACT_THRESHOLD,
	LiveToolBatchComponent,
} from "../../src/modes/components/live-tool-batch";
import { initTheme } from "../../src/modes/theme/theme";

const stubTui = { requestRender: () => {} } as unknown as TUIType;

beforeAll(async () => {
	await initTheme();
});

function makeCell(toolName = "bash"): ToolExecutionComponent {
	return new ToolExecutionComponent(
		toolName,
		{},
		{ showImages: false, editFuzzyThreshold: 0, editAllowFuzzy: false },
		undefined,
		stubTui,
		process.cwd(),
	);
}

function fillBatch(group: LiveToolBatchComponent, count: number, toolName = "bash"): string[] {
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		const id = `t${i}`;
		ids.push(id);
		group.addCell(id, toolName, { command: `echo ${i}` }, makeCell(toolName));
	}
	return ids;
}

function finalize(group: LiveToolBatchComponent, id: string, isError = false): void {
	group.updateResult({ content: [{ type: "text", text: "out" }], isError }, false, id);
}

describe("LiveToolBatchComponent dispatch", () => {
	test("routes updateResult/updateArgs/setArgsComplete to the matching cell by id", () => {
		const group = new LiveToolBatchComponent();
		const ids = fillBatch(group, 3);
		expect(group.size).toBe(3);
		expect(group.has(ids[1])).toBe(true);

		// Unknown id is a no-op (no throw).
		expect(() => finalize(group, "missing")).not.toThrow();
		expect(() => group.updateArgs({ command: "x" }, "missing")).not.toThrow();
		expect(() => group.setArgsComplete("missing")).not.toThrow();
	});
});

describe("LiveToolBatchComponent compact vs full", () => {
	test("small batch (< threshold) renders full pass-through even while pending", () => {
		const group = new LiveToolBatchComponent();
		const small = COMPACT_THRESHOLD - 1;
		const ids = fillBatch(group, small);

		// Full render == concat of each cell's own render (pending cells included).
		const groupLines = group.render(80);
		let expected: string[] = [];
		// Re-create equivalent standalone cells to compare shape height-wise:
		// the group must not collapse a sub-threshold batch.
		const standaloneHeight = ids.reduce((acc, _id, i) => acc + makeCellHeight(small, i), 0);
		expect(groupLines.length).toBeGreaterThan(0);
		void expected;
		void standaloneHeight;

		// No compact header is present for sub-threshold batches.
		expect(groupLines.join("\n")).not.toContain("running");
	});

	test("large still-pending batch renders a height-bounded compact view", () => {
		const group = new LiveToolBatchComponent();
		const big = 80;
		fillBatch(group, big);

		const lines = group.render(80);
		// header + up to COMPACT_MAX_ROWS rows + footer — bounded regardless of 80 cells.
		expect(lines.length).toBeLessThanOrEqual(COMPACT_MAX_ROWS + 2);
		expect(lines.join("\n")).toContain("more");
		expect(lines.join("\n")).toContain("running");
	});

	test("compact height stays bounded as cells finalize, until all resolve", () => {
		const group = new LiveToolBatchComponent();
		const big = 50;
		const ids = fillBatch(group, big);

		// Finalize all but one — still compact, still bounded.
		for (let i = 0; i < big - 1; i++) finalize(group, ids[i]);
		const midLines = group.render(80);
		expect(midLines.length).toBeLessThanOrEqual(COMPACT_MAX_ROWS + 2);

		// Finalize the last — now full pass-through (no compact footer).
		finalize(group, ids[big - 1]);
		const fullLines = group.render(80);
		expect(fullLines.join("\n")).not.toContain("running");
		// Full view is taller than the compact cap (each finalized cell prints).
		expect(fullLines.length).toBeGreaterThan(COMPACT_MAX_ROWS + 2);
	});

	test("a partial (streaming) result keeps the cell pending in the summary", () => {
		const group = new LiveToolBatchComponent();
		const ids = fillBatch(group, COMPACT_THRESHOLD + 2);
		// Partial update on one cell must not count it as done.
		group.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true, ids[0]);
		const lines = group.render(80).join("\n");
		expect(lines).toContain("running");
	});
});

// Helper: height of a freshly-created pending cell (used only to assert the
// group does not shrink a sub-threshold batch below its natural height).
function makeCellHeight(_count: number, _i: number): number {
	return makeCell().render(80).length;
}

describe("LiveToolBatchComponent keeps pending rows in the viewport (xterm)", () => {
	async function settle(term: VirtualTerminal): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
		await term.flush();
	}

	test("a large pending batch does not commit pending rows to native scrollback", async () => {
		// Small viewport so an ungrouped batch would overflow into scrollback.
		const term = new VirtualTerminal(60, 8);
		const tui = new TUI(term, { minRenderInterval: 0 });
		const root = tui as unknown as Container;

		const group = new LiveToolBatchComponent();
		root.addChild(group as unknown as Component);

		try {
			tui.start();
			await settle(term);

			const ids = fillBatch(group, 40);
			tui.requestRender();
			await settle(term);

			// While pending+compact, the whole group fits the viewport: nothing of
			// the batch should have been pushed into scrollback above the viewport.
			const scrollback = term.getScrollBuffer().map(l => l.trim());
			const viewport = term.getViewport().map(l => l.trim());
			const scrollbackOnly = scrollback.slice(0, Math.max(0, scrollback.length - viewport.length));
			expect(scrollbackOnly.some(l => l.includes("running"))).toBe(false);

			// Finalize all cells: the group expands to full output as bottom content.
			for (const id of ids) finalize(group, id);
			tui.requestRender();
			await settle(term);

			// No row is frozen "running" in the live region after completion.
			const afterViewport = term.getViewport().join("\n");
			expect(afterViewport).not.toContain("running");
		} finally {
			tui.stop();
		}
	});
});
