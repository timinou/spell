import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { renderPromptTemplate, type TemplateContext } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import Handlebars from "handlebars";
import { buildSystemPrompt } from "../src/system-prompt";

const systemPromptsDir = path.resolve(import.meta.dir, "../src/prompts/system");

const baseRenderContext: TemplateContext = {
	TASK_TOOL_NAME: "task",
	ARGUMENTS: "alpha beta",
	agent: "You are a delegated worker",
	agentsMdSearch: { files: [] },
	appendPrompt: "Appendix instructions",
	arguments: "alpha beta",
	base: "Base system prompt",
	content: "Rule content",
	context: "Background context",
	contextFile: "/tmp/context.md",
	contextFiles: [{ path: "/tmp/context/a.md", content: "Alpha context" }],
	customPrompt: "Custom prompt body",
	cwd: "/tmp/pi-issue-147",
	date: "2026-02-24",
	dateTime: "2026-02-24T12:00:00Z",
	editToolName: "edit",
	environment: [{ label: "OS", value: "Darwin" }],
	finalPlanFilePath: "local://PLAN_FINAL.md",
	git: {
		isRepo: true,
		currentBranch: "feature/tests",
		mainBranch: "main",
		status: "M packages/coding-agent/src/prompts/system/custom-system-prompt.md",
		commits: "abc123 Fix tests",
	},
	intentField: "_i",
	intentTracing: true,
	iterative: true,
	maxRetries: 3,
	modifiedFiles: ["packages/coding-agent/src/config/prompt-templates.ts"],
	name: "rs-no-unwrap",
	path: "packages/coding-agent/src/config/prompt-templates.ts",
	planContent: "1. Read code\n2. Add tests",
	planExists: true,
	planInitState: "ITEM",
	planFilePath: "local://PLAN.md",
	readFiles: ["packages/coding-agent/src/prompts/system/custom-system-prompt.md"],
	repeatToolDescriptions: true,
	reentry: false,
	request: "Create an agent to review prompt templates",
	retryCount: 1,
	rules: [{ name: "rs-no-unwrap", description: "Avoid unwrap", globs: ["**/*.rs"] }],
	skills: [{ name: "system-prompts", description: "Prompt design skill" }],
	systemPromptCustomization: "System customization",
	toolInfo: [{ name: "read", label: "Read", description: "Reads files" }],
	tools: ["read", "grep", "find", "edit", "task", "web_search", "todo_write"],
	worktree: "/tmp/pi-issue-147",
	writeToolName: "write",
};

async function loadSystemPromptTemplates(): Promise<Map<string, string>> {
	const templates = new Map<string, string>();
	const glob = new Bun.Glob("*.md");

	for await (const fileName of glob.scan({ cwd: systemPromptsDir, onlyFiles: true })) {
		const templatePath = path.join(systemPromptsDir, fileName);
		templates.set(fileName, await Bun.file(templatePath).text());
	}

	return templates;
}

async function renderBuiltSystemPrompt(settings: Settings): Promise<string> {
	const blocks = await buildSystemPrompt({
		contextFiles: [],
		cwd: import.meta.dir,
		rules: [],
		settings,
		skills: [],
		toolNames: [],
	});

	return blocks.map(block => block.text).join("\n");
}

describe("system Handlebars prompt templates", () => {
	test("parses and compiles every system template", async () => {
		const templates = await loadSystemPromptTemplates();
		expect(templates.size).toBeGreaterThan(0);

		for (const [fileName, template] of templates) {
			expect(() => Handlebars.parse(template), `Failed parsing ${fileName}`).not.toThrow();
			expect(() => Handlebars.compile(template), `Failed compiling ${fileName}`).not.toThrow();
		}
	});

	test("custom-system-prompt renders project section for context and git combinations", async () => {
		const templatePath = path.join(systemPromptsDir, "custom-system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const both = renderPromptTemplate(template, {
			...baseRenderContext,
			contextFiles: [{ path: "a.txt", content: "A" }],
			git: { ...((baseRenderContext.git as Record<string, unknown>) ?? {}), isRepo: true },
		});
		expect(both).toContain("<project>");
		expect(both).toContain("## Context");
		expect(both).toContain("## Version Control");

		const contextOnly = renderPromptTemplate(template, {
			...baseRenderContext,
			contextFiles: [{ path: "a.txt", content: "A" }],
			git: { isRepo: false },
		});
		expect(contextOnly).toContain("<project>");
		expect(contextOnly).toContain("## Context");
		expect(contextOnly).not.toContain("## Version Control");

		const gitOnly = renderPromptTemplate(template, {
			...baseRenderContext,
			contextFiles: [],
			git: {
				isRepo: true,
				currentBranch: "feature/tests",
				mainBranch: "main",
				status: "clean",
				commits: "abc123 test commit",
			},
		});
		expect(gitOnly).toContain("<project>");
		expect(gitOnly).not.toContain("## Context");
		expect(gitOnly).toContain("## Version Control");

		const neither = renderPromptTemplate(template, {
			...baseRenderContext,
			contextFiles: [],
			git: { isRepo: false },
		});
		expect(neither).not.toContain("<project>");
		expect(neither).not.toContain("## Context");
		expect(neither).not.toContain("## Version Control");
	});

	test("system-prompt renders discipline section instead of behavior and code-integrity", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const rendered = renderPromptTemplate(template, baseRenderContext);
		expect(rendered).toContain("<discipline>");
		expect(rendered).toContain("</discipline>");
		expect(rendered).toContain('Q not: "does this work?"');
		expect(rendered).not.toContain("<behavior>");
		expect(rendered).not.toContain("<code-integrity>");
		expect(rendered).toContain("# Principles");
		expect(rendered).not.toContain("# Design Integrity");
	});

	test("system-prompt renders MCP discovery hint when enabled", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const rendered = renderPromptTemplate(template, {
			...baseRenderContext,
			mcpDiscoveryMode: true,
			hasMCPDiscoveryServers: true,
			mcpDiscoveryServerSummaries: ["github (2 tools)", "slack (1 tool)"],
		});

		expect(rendered).toContain("### MCP tool discovery");
		expect(rendered).toContain("Discoverable MCP servers in this session: github (2 tools), slack (1 tool).");
		expect(rendered).not.toContain("Example discoverable MCP tools:");
		expect(rendered).toContain("call `search_tool_bm25` before concluding no such tool exists");
	});

	test("todo-write prompt includes dependency management content and omits 'On blockers:'", async () => {
		const templatePath = path.join(import.meta.dir, "../src/prompts/tools/todo-write.md");
		const template = await Bun.file(templatePath).text();
		const rendered = renderPromptTemplate(template, baseRenderContext);

		expect(rendered).toContain("dependency-management");
		expect(rendered).toContain("blockers");
		expect(rendered).not.toContain("On blockers:");
		expect(rendered).toContain("On runtime impediments:");
	});

	test("plan-mode-active standard mode includes sub-outline body standard and org wave guidance", async () => {
		const templatePath = path.join(systemPromptsDir, "plan-mode-active.md");
		const template = await Bun.file(templatePath).text();
		const rendered = renderPromptTemplate(template, {
			...baseRenderContext,
			orgEnabled: true,
			planCategory: "plans",
			childCategories: [{ name: "features", prefix: "FEAT", description: "Feature items" }],
			exitToolName: "exit_plan_mode",
			askToolName: "task",
			askPolicies: false,
			allowedFolders: undefined,
			customDecomposition: false,
			customDecompositionSections: undefined,
			ultraplan: false,
			modeContext: "",
			modeInstructions: "",
			taskPolicyLayers: {},
			taskPolicyList: [],
			reentry: false,
			iterative: false,
			designFlavor: false,
			askPolicyEnabled: false,
			tools: [...(baseRenderContext.tools as string[]), "code"],
		});

		expect(rendered).toContain(":CUSTOM_ID: FEAT-001::define-types");
		expect(rendered).toContain("FILE-LEVEL-ID::suboutline-id");
		expect(rendered).toContain("run `org wave`");
		expect(rendered).toContain(":wave:` headings");
	});

	test("system-prompt renders eager task guidance from default settings", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();
		const settings = Settings.isolated();
		const rendered = renderPromptTemplate(template, {
			...baseRenderContext,
			tools: [...(baseRenderContext.tools as string[]), "code"],
			eagerTasks: settings.get("task.eager"),
		});

		expect(settings.get("task.eager")).toBe(true);
		expect(rendered).toContain("### Task tool for parallel work");
		expect(rendered).toContain("Delegate work to subagents by default");
	});

	test("system-prompt renders notation guidance in stable section", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const rendered = renderPromptTemplate(template, {
			...baseRenderContext,
		});

		expect(rendered).toContain("Think and speak in notation");
		expect(rendered).toContain("Symbols carry logic");
		expect(rendered).not.toContain("<thinking-mode>");
	});

	test("caveman template does not contain thinking instructions", async () => {
		const templatePath = path.join(systemPromptsDir, "caveman.md");
		const template = await Bun.file(templatePath).text();

		const rendered = renderPromptTemplate(template, {
			...baseRenderContext,
			cavemanActive: true,
			terseThinking: true,
		});

		expect(rendered).not.toContain("thinking-mode");
		expect(rendered).toContain("Terse mode active");
	});
});

describe("caveman prompt composition", () => {
	test("buildSystemPrompt renders terse caveman guidance without thinking-mode wrapper", async () => {
		const rendered = await renderBuiltSystemPrompt(
			Settings.isolated({
				"caveman.defaultLevel": "full",
				"caveman.thinkingMode": "normal",
			}),
		);

		expect(rendered).toContain("Terse mode active");
		expect(rendered).not.toContain("<thinking-mode>");
		expect(rendered).not.toContain("Think in notation");
	});

	test("buildSystemPrompt keeps terse caveman guidance in caveman mode", async () => {
		const rendered = await renderBuiltSystemPrompt(
			Settings.isolated({
				"caveman.defaultLevel": "full",
				"caveman.thinkingMode": "caveman",
			}),
		);

		expect(rendered).toContain("Terse mode active");
		expect(rendered).not.toContain("<thinking-mode>");
		expect(rendered).not.toContain("Think in notation");
	});
});

describe("specialized tools in system prompt", () => {
	test("renders specialized tool names when present", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();
		const rendered = renderPromptTemplate(template, {
			...baseRenderContext,
			hasSpecializedTools: true,
			specializedToolNames: ["canvas", "python", "notebook"],
		});
		expect(rendered).toContain("Specialized tools");
		expect(rendered).toContain("`canvas`");
		expect(rendered).toContain("`python`");
		expect(rendered).toContain("`notebook`");
	});

	test("omits specialized section when no specialized tools", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();
		const rendered = renderPromptTemplate(template, {
			...baseRenderContext,
			hasSpecializedTools: false,
			specializedToolNames: [],
		});
		expect(rendered).not.toContain("Specialized tools");
	});
});

describe("tool ordering stability", () => {
	test("sorted tool names produce deterministic order", () => {
		const tools1 = ["read", "edit", "bash", "grep", "find"].sort();
		const tools2 = ["find", "grep", "bash", "edit", "read"].sort();
		expect(tools1).toEqual(tools2);
		const hash1 = Bun.hash(tools1.join("\0"));
		const hash2 = Bun.hash(tools2.join("\0"));
		expect(hash1).toBe(hash2);
	});

	test("different tool sets produce different hashes", () => {
		const tools1 = ["read", "edit", "bash"].sort();
		const tools2 = ["read", "edit", "bash", "canvas"].sort();
		const hash1 = Bun.hash(tools1.join("\0"));
		const hash2 = Bun.hash(tools2.join("\0"));
		expect(hash1).not.toBe(hash2);
	});
});
