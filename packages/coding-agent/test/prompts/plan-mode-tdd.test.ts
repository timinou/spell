import { describe, expect, it } from "bun:test";
import { renderPromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import planModeActivePrompt from "@oh-my-pi/pi-coding-agent/prompts/system/plan-mode-active.md" with { type: "text" };

function renderUltraplanPrompt(): string {
	return renderPromptTemplate(planModeActivePrompt, {
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
		ultraplan: true,
		customDecomposition: false,
		gateMetisDisabled: false,
		designFlavor: false,
		designHistory: "",
		planModeUiuxPrompt: "",
		tools: [],
	});
}

describe("plan-mode TDD prompt guidance", () => {
	it("renders TDD-first child item guidance and examples in ultraplan mode", () => {
		const rendered = renderUltraplanPrompt();

		expect(rendered).toContain("test-first sub-outline ordering **REQUIRED** for pure functions/new types");
		expect(rendered).toContain("Test sub-items **MUST** precede implementation sub-items in dependency graph");
		expect(rendered).toContain("** Write parser tests (TDD: before implementation)");
		expect(rendered).toContain(":DEPENDS: FEAT-001::define-types");
		expect(rendered).toContain(":DEPENDS: FEAT-001::parser-tests");
		expect(rendered).toContain("Scenarios from Tests section as initially-failing tests");
		expect(rendered).toContain("** test-contracts                                  :wave:");
		expect(rendered).toContain("depends FEAT-001::parser-tests");
		expect(rendered).not.toContain("** verify                                          :wave:");
		expect(rendered).toContain("**Anti-pattern: tests-last ordering.**");

		const defineTypesIndex = rendered.indexOf("** Define TypeScript interfaces");
		const parserTestsIndex = rendered.indexOf("** Write parser tests (TDD: before implementation)");
		const implementParserIndex = rendered.indexOf("** Implement core parser (satisfies parser-tests)");
		expect(defineTypesIndex).toBeGreaterThan(-1);
		expect(parserTestsIndex).toBeGreaterThan(defineTypesIndex);
		expect(implementParserIndex).toBeGreaterThan(parserTestsIndex);

		const testContractsWaveIndex = rendered.indexOf("** test-contracts                                  :wave:");
		const coreWaveIndex = rendered.indexOf("** core                                            :wave:");
		expect(testContractsWaveIndex).toBeGreaterThan(-1);
		expect(coreWaveIndex).toBeGreaterThan(testContractsWaveIndex);
	});
});
