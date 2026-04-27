import { describe, expect, it } from "bun:test";
import { renderPromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import planModeActivePrompt from "@oh-my-pi/pi-coding-agent/prompts/system/plan-mode-active.md" with { type: "text" };

function renderPrompt(orgEnabled: boolean): string {
	return renderPromptTemplate(planModeActivePrompt, {
		planFilePath: "org://PLAN-001-suboutline-manifest",
		planExists: true,
		askToolName: "ask",
		writeToolName: "write",
		editToolName: "edit",
		exitToolName: "exit_plan_mode",
		reentry: false,
		iterative: false,
		orgEnabled,
		planInitState: "ITEM",
		planCategory: "plans",
		childCategories: [{ name: "features", prefix: "FEAT", description: "Single feature additions" }],
		allowedFolders: undefined,
		ultraplan: orgEnabled,
		customDecomposition: false,
		gateMetisDisabled: false,
		designFlavor: false,
		designHistory: "",
		planModeUiuxPrompt: "",
		tools: [],
	});
}

describe("plan-mode active sub-outline guidance", () => {
	it("renders ITEM injection and normalized sub-outline guidance in org mode", () => {
		const rendered = renderPrompt(true);
		expect(rendered).toContain("Implementation sub-steps **MUST** be sub-headings");
		expect(rendered).toContain("may be fully-qualified, bare, or empty-left");
		expect(rendered).toContain("FILE-LEVEL-ID::suboutline-id");
		expect(rendered).toContain("org wave --manifest=true --planItemId=<PLAN-ID>");
		expect(rendered).toContain("** File-level DAG");
		expect(rendered).toContain("** Subfeature-level DAG");
		expect(rendered).toContain("edge `from` depends on `to`");
		expect(rendered).toContain("DAG headings are context only and MUST NOT use the `:wave:` tag");
		expect(rendered).toContain("[[id:FEAT-001]]");
		expect(rendered).toContain("[[id:FEAT-001::define-types]]");
		expect(rendered).toContain("missing-top-level-link");
		expect(rendered).toContain("missing-suboutline-declaration");
		expect(rendered).toContain("manifest-missing-suboutlines");
		expect(rendered).toContain("** ITEM Define TypeScript interfaces");
	});

	it("renders ultraplan example with dual links", () => {
		const rendered = renderPrompt(true);
		expect(rendered).toContain("- [[id:FEAT-001]]");
		expect(rendered).toContain("** foundation");
		expect(rendered).toContain("[[id:FEAT-001::define-types]]");
		expect(rendered).toContain("file nodes are child CUSTOM_IDs");
		expect(rendered).toContain("subfeature nodes are sub-outline CUSTOM_IDs");
	});

	it("omits org-specific guidance when org mode is disabled", () => {
		const rendered = renderPrompt(false);
		expect(rendered).not.toContain("Implementation sub-steps **MUST** be sub-headings");
		expect(rendered).not.toContain("org wave --manifest=true --planItemId=<PLAN-ID>");
	});
});
