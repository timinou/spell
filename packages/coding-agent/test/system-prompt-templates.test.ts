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

	test("system-prompt conditionally renders inspect_image guidance", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const baseTools = baseRenderContext.tools as string[];
		const withInspectImage = renderPromptTemplate(template, {
			...baseRenderContext,
			tools: [...baseTools, "inspect_image"],
		});
		expect(withInspectImage).toContain("### Image inspection");
		expect(withInspectImage).toContain("**MUST** use `inspect_image` over `read`");
		expect(withInspectImage).toContain("Write a specific `question` for `inspect_image`");

		const withoutInspectImage = renderPromptTemplate(template, {
			...baseRenderContext,
			tools: baseTools.filter((tool: string) => tool !== "inspect_image"),
		});
		expect(withoutInspectImage).not.toContain("### Image inspection");
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

	test("todo-write prompt includes Dependency Management section and omits 'On blockers:'", async () => {
		const templatePath = path.join(import.meta.dir, "../src/prompts/tools/todo-write.md");
		const template = await Bun.file(templatePath).text();
		const rendered = renderPromptTemplate(template, baseRenderContext);

		// FEAT-099: Dependency Management section present
		expect(rendered).toContain("## Dependency Management");
		expect(rendered).toContain("### Smart gate enforcement");
		expect(rendered).toContain("### When to use `blockers`");
		expect(rendered).toContain("### Cross-phase dependency example");

		// FEAT-099: "On blockers:" removed, replaced with "On runtime impediments:"
		expect(rendered).not.toContain("On blockers:");
		expect(rendered).toContain("On runtime impediments:");
	});

	test("plan-mode-active includes DEPENDS property guidance for child items", async () => {
		const templatePath = path.join(systemPromptsDir, "plan-mode-active.md");
		const template = await Bun.file(templatePath).text();
		const rendered = renderPromptTemplate(template, {
			...baseRenderContext,
			orgEnabled: true,
			planCategory: "plans",
			childCategories: [{ name: "features", prefix: "FEAT", description: "Feature items" }],
			exitToolName: "exit_plan_mode",
			askToolName: "ask",
		});

		// FEAT-098: DEPENDS property guidance in child item requirements
		expect(rendered).toContain(":DEPENDS:");
		expect(rendered).toContain('properties: { DEPENDS: "ITEM-ID-1 ITEM-ID-2" }');
		// Example flow shows DEPENDS usage
		expect(rendered).toContain('DEPENDS: "FEAT-001-add-auth-api"');
	});

	test("system-prompt renders caveman thinking instructions in stable section when active", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const rendered = renderPromptTemplate(template, {
			...baseRenderContext,
			cavemanActive: true,
			cavemanThinking: true,
		});

		expect(rendered).toContain("PhD-caveman");
		expect(rendered).toContain("EVERY thinking block MUST");
		expect(rendered.indexOf("<thinking-mode>")).toBeGreaterThan(-1);
		expect(rendered.indexOf("<thinking-mode>")).toBeLessThan(rendered.indexOf("CACHE_BOUNDARY"));
	});

	test("system-prompt omits thinking instructions when caveman inactive", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const rendered = renderPromptTemplate(template, {
			...baseRenderContext,
			cavemanActive: false,
			cavemanThinking: false,
		});

		expect(rendered).not.toContain("<thinking-mode>");
	});

	test("system-prompt omits thinking instructions when caveman thinking is disabled", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();

		const rendered = renderPromptTemplate(template, {
			...baseRenderContext,
			cavemanActive: true,
			cavemanThinking: false,
		});

		expect(rendered).not.toContain("<thinking-mode>");
		expect(rendered).not.toContain("EVERY thinking block MUST");
	});

	test("caveman template does not contain thinking instructions", async () => {
		const templatePath = path.join(systemPromptsDir, "caveman.md");
		const template = await Bun.file(templatePath).text();

		const rendered = renderPromptTemplate(template, {
			...baseRenderContext,
			cavemanActive: true,
			cavemanThinking: true,
		});

		expect(rendered).not.toContain("thinking-mode");
		expect(rendered).toContain("CAVEMAN MODE");
	});
});

describe("caveman prompt composition", () => {
	test("buildSystemPrompt omits thinking instructions when caveman thinking mode is normal", async () => {
		const rendered = await renderBuiltSystemPrompt(
			Settings.isolated({
				"caveman.defaultLevel": "full",
				"caveman.thinkingMode": "normal",
			}),
		);

		expect(rendered).toContain("IMPORTANT: You are in CAVEMAN MODE.");
		expect(rendered).not.toContain("<thinking-mode>");
		expect(rendered).not.toContain("EVERY thinking block MUST");
	});

	test("buildSystemPrompt keeps caveman prompt free of thinking instructions", async () => {
		const rendered = await renderBuiltSystemPrompt(
			Settings.isolated({
				"caveman.defaultLevel": "full",
				"caveman.thinkingMode": "caveman",
			}),
		);

		expect(rendered).toContain("IMPORTANT: You are in CAVEMAN MODE.");
		expect(rendered).toContain("<thinking-mode>");
		expect(rendered.indexOf("<thinking-mode>")).toBeLessThan(rendered.indexOf("IMPORTANT: You are in CAVEMAN MODE."));
		expect(rendered.indexOf("EVERY thinking block MUST")).toBeLessThan(
			rendered.indexOf("IMPORTANT: You are in CAVEMAN MODE."),
		);
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
