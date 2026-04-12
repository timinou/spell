import { describe, expect, it } from "bun:test";
import { renderPromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import planModeActivePrompt from "@oh-my-pi/pi-coding-agent/prompts/system/plan-mode-active.md" with { type: "text" };
import planModeSubagentPrompt from "@oh-my-pi/pi-coding-agent/prompts/system/plan-mode-subagent.md" with {
	type: "text",
};

const allowedFolders = [
	{ path: "./docs/plans", description: "Architecture notes and plan artifacts" },
	{ path: "~/shared-plans", description: "Cross-project plan output directory" },
];

describe("plan-mode allowed folder prompts", () => {
	it("surfaces configured folders in the main plan-mode prompt", () => {
		const rendered = renderPromptTemplate(planModeActivePrompt, {
			planFilePath: "local://PLAN.md",
			planExists: true,
			askToolName: "ask",
			writeToolName: "write",
			editToolName: "edit",
			exitToolName: "exit_plan_mode",
			reentry: false,
			iterative: false,
			orgEnabled: false,
			planCategory: "plans",
			childCategories: [],
			allowedFolders,
			ultraplan: false,
			designFlavor: false,
			designHistory: "",
			planModeUiuxPrompt: "",
		});

		expect(rendered).toContain("You **MAY** create or edit files only in these configured folders:");
		expect(rendered).toContain("`./docs/plans`: Architecture notes and plan artifacts");
		expect(rendered).toContain("`~/shared-plans`: Cross-project plan output directory");
		expect(rendered).toContain("Deletes and moves remain forbidden.");
	});

	it("requires org-native plans to include verification guidance", () => {
		const rendered = renderPromptTemplate(planModeActivePrompt, {
			planFilePath: "org://PLAN-001-auth-initiative",
			planExists: true,
			askToolName: "ask",
			writeToolName: "write",
			editToolName: "edit",
			exitToolName: "exit_plan_mode",
			reentry: false,
			iterative: false,
			orgEnabled: true,
			planCategory: "plans",
			childCategories: [{ name: "features", prefix: "FEAT", description: "Feature work" }],
			allowedFolders: undefined,
			ultraplan: false,
			designFlavor: false,
			designHistory: "",
			planModeUiuxPrompt: "",
		});

		expect(rendered).toContain("verification criteria (exact tests, checks, or manual proof)");
		expect(rendered).toContain("* Verification");
		expect(rendered).toContain("screenshots/artifacts for UI behavior");
	});

	it("keeps the subagent prompt read-only when no folders are configured", () => {
		const rendered = renderPromptTemplate(planModeSubagentPrompt, {});

		expect(rendered).toContain("except for configured allowed folders listed below (none configured)");
		expect(rendered).not.toContain("You **MAY** create or edit files only in these configured folders:");
	});

	it("surfaces configured folders in the subagent prompt", () => {
		const rendered = renderPromptTemplate(planModeSubagentPrompt, { allowedFolders });

		expect(rendered).toContain("`./docs/plans`: Architecture notes and plan artifacts");
		expect(rendered).toContain("`~/shared-plans`: Cross-project plan output directory");
		expect(rendered).toContain("Deletes and moves remain forbidden.");
	});
});
