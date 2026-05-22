import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { TemplateContext } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { renderPromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import planModeReminder from "@oh-my-pi/pi-coding-agent/prompts/system/plan-mode-tool-decision-reminder.md" with {
	type: "text",
};
import semanticHint from "@oh-my-pi/pi-coding-agent/prompts/tools/code-hint-semantic.md" with { type: "text" };
import fallbackHint from "@oh-my-pi/pi-coding-agent/prompts/tools/code-hint-text-fallback.md" with { type: "text" };
import grepPrompt from "@oh-my-pi/pi-coding-agent/prompts/tools/grep.md" with { type: "text" };
import patchPrompt from "@oh-my-pi/pi-coding-agent/prompts/tools/patch.md" with { type: "text" };

const systemPromptsDir = path.resolve(import.meta.dir, "../../src/prompts/system");

const renderContext: TemplateContext = {
	TASK_TOOL_NAME: "task",
	ARGUMENTS: "",
	agent: "You are a delegated worker",
	agentsMdSearch: { files: [] },
	appendPrompt: "",
	arguments: "",
	base: "Base system prompt",
	content: "",
	context: "",
	contextFile: "/tmp/context.md",
	contextFiles: [],
	customPrompt: "",
	cwd: "/tmp/project",
	date: "2026-04-17",
	dateTime: "2026-04-17T00:00:00Z",
	editToolName: "edit",
	environment: [],
	finalPlanFilePath: "local://PLAN_FINAL.md",
	git: { isRepo: false },
	intentField: "_i",
	intentTracing: true,
	iterative: false,
	maxRetries: 3,
	modifiedFiles: [],
	name: "prompt-contract",
	path: "packages/coding-agent/src/prompts/system/system-prompt.md",
	planContent: "",
	planExists: false,
	planInitState: "ITEM",
	planFilePath: "local://PLAN.md",
	readFiles: [],
	repeatToolDescriptions: true,
	reentry: false,
	request: "Document the edit contract",
	retryCount: 0,
	rules: [],
	skills: [],
	systemPromptCustomization: "",
	toolInfo: [],
	tools: ["get", "edit", "create", "manage", "task", "bash"],
	worktree: "/tmp/project",
	writeToolName: "write",
	eagerTasks: true,
};

describe("code-edit contract prompts", () => {
	it("keeps patch mode off code-supported fallback paths", () => {
		expect(patchPrompt).toContain("only for unsupported plain-text files");
		expect(patchPrompt).toContain("tighten the structural target instead of falling back to patch mode");
	});

	it("describes grep semantic and raw-text repo search modes", () => {
		expect(grepPrompt).toContain(`mode: "auto"`);
		expect(grepPrompt).toContain(`mode: "rawText"`);
		expect(grepPrompt).toContain(`mode: "semantic"`);
		expect(grepPrompt).toContain("targetId");
		expect(grepPrompt).toContain("scopeTargetId");
	});

	it("describes code symbols file and workspace modes", () => {
		expect(semanticHint).toContain("`code symbols { file }`");
		expect(semanticHint).toContain("`code symbols { query }`");
		expect(semanticHint).toContain("`code symbols` with neither file nor query");
		expect(semanticHint).toContain("file mode wins");
	});

	it("states managed edits do not require reread after success", () => {
		expect(planModeReminder).toContain("Successful managed edits do not require a fresh `get` before the next edit");
		expect(planModeReminder).toContain("tighten the target/action");
		expect(fallbackHint).toContain("`code edit { operations: [{ targetId, actions }] }`");
		expect(fallbackHint).not.toContain('code read, code diff, code edit { operation: "replace" }');
	});

	it("renders the system prompt with the structural code-edit recovery contract", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();
		const rendered = renderPromptTemplate(template, renderContext);

		expect(rendered).toContain("tree-sitter read/outline/edit/change");
		expect(rendered).toContain("Your main tool: `edit`.");
		expect(rendered).toContain("line-target resolve AST/node boundaries");
		expect(rendered).toContain("fallback to patch mode is last resort");
	});
});
