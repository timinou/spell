import { describe, expect, it } from "bun:test";
import { renderPromptTemplate } from "@spell/pi-coding-agent/config/prompt-templates";
import planAuditPrompt from "@spell/pi-coding-agent/prompts/system/plan-audit.md" with { type: "text" };

describe("plan-audit prompt", () => {
	it("keeps read-only audit contract and clean exit marker", () => {
		const rendered = renderPromptTemplate(planAuditPrompt, {
			sourceRef: "packages/coding-agent/src/modes/interactive-mode.ts",
		});

		expect(rendered).toContain("READ-ONLY");
		expect(rendered).toContain("You **MUST NOT**:");
		expect(rendered).toContain("review + report");
		expect(rendered).toContain("Any tool call aborts review and discards findings.");
		expect(rendered).toContain("[AUDIT_CLEAN]");
		expect(rendered).toContain("exactly:");
		expect(rendered.indexOf("## Clean Exit")).toBeLessThan(rendered.indexOf("[AUDIT_CLEAN]"));
		expect(rendered).not.toContain("Attempt to fix any issues you discover");
	});

	it("renders custom focus areas and audit cycle guidance", () => {
		const rendered = renderPromptTemplate(planAuditPrompt, {
			customFocusAreas: ["Edge cases", "Regression gaps"],
			auditDepth: 2,
			maxDepth: 4,
		});

		expect(rendered).toContain("- **Edge cases**");
		expect(rendered).toContain("- **Regression gaps**");
		expect(rendered).toContain("Audit cycle 2/4.");
		expect(rendered).toContain("introduced or missed in earlier cycles");
	});
});
