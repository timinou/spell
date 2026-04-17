import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { TemplateContext } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { renderPromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import planModeReminder from "@oh-my-pi/pi-coding-agent/prompts/system/plan-mode-tool-decision-reminder.md" with {
	type: "text",
};
import codePrompt from "@oh-my-pi/pi-coding-agent/prompts/tools/code.md" with { type: "text" };
import fallbackHint from "@oh-my-pi/pi-coding-agent/prompts/tools/code-hint-text-fallback.md" with { type: "text" };
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
	request: "Document the code-edit contract",
	retryCount: 0,
	rules: [],
	skills: [],
	systemPromptCustomization: "",
	toolInfo: [],
	tools: ["read", "grep", "find", "edit", "write", "code", "task"],
	worktree: "/tmp/project",
	writeToolName: "write",
	eagerTasks: true,
};

describe("code-edit contract prompts", () => {
	it("teaches line-target edits as node-boundary operations with explicit separators", () => {
		expect(codePrompt).toContain("Line-target insertions operate at AST/node boundaries");
		expect(codePrompt).toContain('"content": ["", "import { x } from \'./x\';"]');
		expect(codePrompt).toContain("retry narrowly instead of switching to text `edit` or `write`");
	});

	it("keeps patch mode off code-supported fallback paths", () => {
		expect(patchPrompt).toContain("only for unsupported plain-text files");
		expect(patchPrompt).toContain("tighten the structural target instead of falling back to patch mode");
	});

	it("repeats the same recovery ladder in plan-mode reminders and fallback hints", () => {
		expect(planModeReminder).toContain("Line-target `code edit` operations are node-boundary edits");
		expect(planModeReminder).toContain("tighten the target instead of switching to text `edit` or `write`");
		expect(fallbackHint).toContain("failed structural edit on a semantic file means re-read and tighten the target");
	});

	it("renders the system prompt with the structural code-edit recovery contract", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();
		const rendered = renderPromptTemplate(template, renderContext);

		expect(rendered).toContain("structural edits on code-supported files with usable tree-sitter support");
		expect(rendered).toContain("Line-target `code edit` operations resolve AST/node boundaries");
		expect(rendered).toContain("Do not switch to text `edit` or `write` for that file");
	});
});
