import { describe, expect, it } from "bun:test";
import { renderPromptTemplate } from "../../src/config/prompt-templates";
import planModeActivePrompt from "../../src/prompts/system/plan-mode-active.md" with { type: "text" };
import planModeApprovedPrompt from "../../src/prompts/system/plan-mode-approved.md" with { type: "text" };

const taskPolicies = {
	version: 1,
	layers: {
		app: { description: "Application logic and workflows" },
		infra: { description: "Infrastructure and deployment plumbing" },
	},
	policies: [
		{
			name: "App verification",
			description: "Require focused app verification",
			match: { layer: "app" },
			gates: {
				gateCmd: "bun test packages/coding-agent/test/prompts/plan-mode-policies.test.ts",
				gateLlm: "Review policy-sensitive prompt changes",
				gateCommit: true,
				gateArtifact: "artifacts/prompt-proof.txt",
				verifyCmd: "bun test packages/coding-agent/test/prompts/plan-mode-policies.test.ts",
			},
			inject: "Preserve prompt truthfulness.",
		},
	],
} as const;

describe("plan-mode task policy prompts", () => {
	it("renders plan-mode-active task policies when configured", () => {
		const rendered = renderPromptTemplate(planModeActivePrompt, {
			planFilePath: "org://PLAN-001-task-policies",
			planExists: true,
			taskPolicies,
			taskPolicyLayers: taskPolicies.layers,
			taskPolicyList: taskPolicies.policies,
			askToolName: "ask",
			writeToolName: "write",
			editToolName: "edit",
			exitToolName: "exit_plan_mode",
			reentry: false,
			iterative: false,
			orgEnabled: true,
			planInitState: "ITEM",
			planCategory: "plans",
			childCategories: [],
			ultraplan: false,
			designFlavor: false,
			designHistory: "",
			planModeUiuxPrompt: "",
		});

		expect(rendered).toContain("## Project Task Policies");
		expect(rendered).toContain("|`app`|Application logic and workflows|");
		expect(rendered).toContain("|`infra`|Infrastructure and deployment plumbing|");
		expect(rendered).toContain("**App verification** (layer: `app`)");
		expect(rendered).toContain(
			"- Gate command: `bun test packages/coding-agent/test/prompts/plan-mode-policies.test.ts`",
		);
		expect(rendered).toContain("- LLM review: Review policy-sensitive prompt changes");
		expect(rendered).toContain("- Requires commit");
		expect(rendered).toContain("- Required artifact: `artifacts/prompt-proof.txt`");
		expect(rendered).toContain(
			"- Verify command: `bun test packages/coding-agent/test/prompts/plan-mode-policies.test.ts`",
		);
		expect(rendered).toContain("- Guidance: Preserve prompt truthfulness.");
	});

	it("omits the plan-mode-active task policy section when unset", () => {
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
			planInitState: "ITEM",
			planCategory: "plans",
			childCategories: [],
			ultraplan: false,
			designFlavor: false,
			designHistory: "",
			planModeUiuxPrompt: "",
		});

		expect(rendered).not.toContain("## Project Task Policies");
	});

	it("renders plan-mode-active layers even when no policies match", () => {
		const rendered = renderPromptTemplate(planModeActivePrompt, {
			planFilePath: "org://PLAN-002-layer-only",
			planExists: true,
			taskPolicies: { version: 1, layers: taskPolicies.layers, policies: [] },
			taskPolicyLayers: taskPolicies.layers,
			taskPolicyList: [],
			askToolName: "ask",
			writeToolName: "write",
			editToolName: "edit",
			exitToolName: "exit_plan_mode",
			reentry: false,
			iterative: false,
			orgEnabled: true,
			planInitState: "ITEM",
			planCategory: "plans",
			childCategories: [],
			ultraplan: false,
			designFlavor: false,
			designHistory: "",
			planModeUiuxPrompt: "",
		});

		expect(rendered).toContain("## Project Task Policies");
		expect(rendered).toContain("### Declared Layers");
		expect(rendered).toContain("|`app`|Application logic and workflows|");
		expect(rendered).not.toContain("### Active Policies");
	});

	it("renders plan-mode-approved task policies when configured", () => {
		const rendered = renderPromptTemplate(planModeApprovedPrompt, {
			planContent: "1. Do work",
			finalPlanFilePath: "org://PLAN-003-task-policies",
			taskPolicies,
			taskPolicyList: taskPolicies.policies,
		});

		expect(rendered).toContain("## Active Task Policies");
		expect(rendered).toContain(
			"- **App verification** (layer: `app`): `bun test packages/coding-agent/test/prompts/plan-mode-policies.test.ts` + LLM review + commit",
		);
		expect(rendered).toContain(
			"For org-linked tasks, layer resolves automatically from the org item's `:LAYER:` property",
		);
	});

	it("omits the plan-mode-approved task policy section when unset", () => {
		const rendered = renderPromptTemplate(planModeApprovedPrompt, {
			planContent: "1. Do work",
			finalPlanFilePath: "local://PLAN_TASK_POLICIES.md",
		});

		expect(rendered).not.toContain("## Active Task Policies");
	});
});
