import { beforeAll, describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { getThemeByName, setThemeInstance, theme } from "../../src/modes/theme/theme";
import { renderCodePathCall } from "../../src/tools/get";

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("Failed to load dark theme for tests");
	setThemeInstance(loaded);
});

/**
 * Regression: a near-budget CodePath query (capped at CODEPATH_HEADER_MAX=96
 * chars by truncateQuery) plus the icon + verb + ": " prefix could exceed a
 * narrow terminal width, overflowing the parent Box and crashing the renderer
 * (#doRender: "Rendered line N exceeds terminal width"). renderCodePathCall
 * must truncate its composed status line to the width it is handed.
 */
describe("renderCodePathCall width-safety", () => {
	const longTarget =
		'packages/coding-agent/src/session/messages.ts::§line[text~="intentionSummary|parentId|customType|toolName|extra"]';

	test.each([20, 40, 60, 80, 103, 120])("fits within width %i", width => {
		const comp = renderCodePathCall("Find", longTarget, { isPartial: true, spinnerFrame: 0 }, theme);
		const lines = comp.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("does not crash on zero/undefined width sentinel", () => {
		const comp = renderCodePathCall("Find", longTarget, { isPartial: true }, theme);
		// width 0 → no truncation budget; should fall back to the raw line.
		const lines = comp.render(0);
		expect(lines.length).toBe(1);
	});

	test("short query is unchanged content-wise", () => {
		const comp = renderCodePathCall("Get", "foo.ts", { isPartial: false }, theme);
		const lines = comp.render(80);
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("foo.ts");
	});
});
