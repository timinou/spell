import { describe, expect, it } from "bun:test";
import { renderPromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import planModeApprovedPrompt from "@oh-my-pi/pi-coding-agent/prompts/system/plan-mode-approved.md" with {
	type: "text",
};

describe("plan-mode-approved prompt", () => {
	it("includes final plan artifact path in injected execution prompt", () => {
		const rendered = renderPromptTemplate(planModeApprovedPrompt, {
			planContent: "1. Do work",
			finalPlanFilePath: "local://WP_MIGRATION_PLAN.md",
		});

		expect(rendered).toContain("local://WP_MIGRATION_PLAN.md");
	});

	it("describes the org-backed completion protocol and artifact directory", () => {
		const rendered = renderPromptTemplate(planModeApprovedPrompt, {
			planContent: "1. Do work",
			finalPlanFilePath: "org://PLAN-003-plan-completion-artifacts-and-lifecycle",
			orgItemId: "PLAN-003-plan-completion-artifacts-and-lifecycle",
			orgItemArtifactsDir: "!tasks/plans/plan-artifacts/PLAN-003-plan-completion-artifacts-and-lifecycle",
		});

		expect(rendered).toContain("## Completion Protocol");
		expect(rendered).toContain("!tasks/plans/plan-artifacts/PLAN-003-plan-completion-artifacts-and-lifecycle/");
		expect(rendered).toContain("Append a `** Completion [YYYY-MM-DD]` section");
		expect(rendered).toContain(
			"PLAN item `PLAN-003-plan-completion-artifacts-and-lifecycle` **MUST** move from `DOING` to `DONE`",
		);
		expect(rendered).toContain(
			"[[file:!tasks/plans/plan-artifacts/PLAN-003-plan-completion-artifacts-and-lifecycle/name.png]]",
		);
		expect(rendered).toContain("5. Commit the changes:");
		expect(rendered).toContain("Stage the org-mode files from `!tasks/`");
		expect(rendered.indexOf("4. Close org lifecycle state truthfully:")).toBeLessThan(
			rendered.indexOf("5. Commit the changes:"),
		);
		expect(rendered.indexOf("5. Commit the changes:")).toBeLessThan(
			rendered.indexOf("6. If verification fails or required evidence is missing"),
		);
	});
});
