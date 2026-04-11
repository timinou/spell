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
		expect(rendered).toContain("artifact://14b64b/main/screenshot/3.png");
		expect(rendered).toContain("artifact://<session-id>/<subagent-name>/<tool>/<file>");
		expect(rendered).toContain("artifact://<session-id>/<agent>/<tool>/<file>.<ext>");
		expect(rendered).toContain("5. Commit the changes:");
		expect(rendered).toContain("Stage the org-mode files from `!tasks/`");
		expect(rendered.indexOf("4. Close org lifecycle state truthfully:")).toBeLessThan(
			rendered.indexOf("5. Commit the changes:"),
		);
		expect(rendered.indexOf("5. Commit the changes:")).toBeLessThan(
			rendered.indexOf("6. If verification fails or required evidence is missing"),
		);
	});

	it("includes TodoWrite blocker wiring guidance when todo_write is available", () => {
		const rendered = renderPromptTemplate(planModeApprovedPrompt, {
			planContent: "1. Do work",
			finalPlanFilePath: "org://PLAN-005-test",
			orgItemId: "PLAN-005-test",
			orgItemArtifactsDir: "!tasks/plans/plan-artifacts/PLAN-005-test",
			tools: ["read", "todo_write", "edit"],
		});

		expect(rendered).toContain("blockers");
		expect(rendered).toContain("dependency gate enforces correct execution order");
		expect(rendered).toContain(":DEPENDS:");
	});
});

it("describes auto-initialized todo execution without manual initialization steps", () => {
	const rendered = renderPromptTemplate(planModeApprovedPrompt, {
		planContent: "1. Do work",
		finalPlanFilePath: "org://PLAN-062-test",
		orgItemId: "PLAN-062-test",
		orgItemArtifactsDir: "!tasks/plans/plan-artifacts/PLAN-062-test",
		tools: ["read", "todo_write", "edit", "task"],
		autoInitialized: true,
	});

	expect(rendered).toContain("Your todo list has been pre-populated from the plan's execution structure.");
	expect(rendered).toContain("Child org item state transitions happen automatically");
	expect(rendered).toContain("`todo_write` does not finish the parent plan for you");
	expect(rendered).not.toContain("Wave-based Todo Initialization");
	expect(rendered).toContain("4. Close org lifecycle state truthfully:");
});

it("renders the coordinator execution branch when execution items are provided", () => {
	const rendered = renderPromptTemplate(planModeApprovedPrompt, {
		planId: "fluid-canvas",
		executionItems: [
			{ id: "root", task: "Gather data", dependsOn: [], effort: "S", priority: "A", body: "Inspect the code." },
			{
				id: "merge",
				task: "Merge findings",
				dependsOn: ["root"],
				effort: "M",
				priority: "B",
				body: "Summarize outputs.",
			},
		],
		itemCount: 2,
		isSimple: true,
	});

	expect(rendered).toContain("# Coordinator");
	expect(rendered).toContain("You are coordinating execution of 2 planned tasks for `fluid-canvas`.");
	expect(rendered).toContain("### root");
	expect(rendered).toContain("### merge");
	expect(rendered).toContain("Keep at most one direct task `in_progress` at a time.");
	expect(rendered).not.toContain("Plan approved. You **MUST** execute it now.");
});
