import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";
import { sanitizeText } from "@oh-my-pi/pi-natives";

type WriteRenderResult = Parameters<typeof writeToolRenderer.renderResult>[0];

describe("writeToolRenderer", () => {
	it("renders failed writes as errors instead of successful zero-line writes", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const component = writeToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Tool execution was aborted: Request was aborted" }],
				isError: true,
			} satisfies WriteRenderResult,
			{ expanded: false, isPartial: false },
			uiTheme,
			{ path: "specs/markdown-code-engine-integration.md" },
		);
		const rendered = sanitizeText(component.render(120).join("\n"));

		expect(rendered).toContain("Error: Tool execution was aborted: Request was aborted");
		expect(rendered).not.toContain("0 lines");
	});

	it("still shows line counts for successful writes with content", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const component = writeToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Successfully wrote 14 bytes to draft.md" }],
			} satisfies WriteRenderResult,
			{ expanded: false, isPartial: false },
			uiTheme,
			{ path: "draft.md", content: "line 1\nline 2" },
		);
		const rendered = sanitizeText(component.render(120).join("\n"));

		expect(rendered).toContain("2 lines");
		expect(rendered).toContain("line 1");
	});
});
