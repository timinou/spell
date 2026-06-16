import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { renderPromptTemplate, type TemplateContext } from "@spell/pi-coding-agent/config/prompt-templates";
import { Settings } from "@spell/pi-coding-agent/config/settings";
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
		expect(rendered).toContain('Q ✗ "does it work?"');
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

	test("todo-write prompt documents blocker DAG + abandonment (PLAN-328 roster)", async () => {
		const templatePath = path.join(import.meta.dir, "../src/prompts/tools/todo-write.md");
		const template = await Bun.file(templatePath).text();
		const rendered = renderPromptTemplate(template, baseRenderContext);

		expect(rendered).toContain("blockers");
		expect(rendered).toContain("deferralFupId");
		// Pre-PLAN-328 phrasing must not resurface.
		expect(rendered).not.toContain("On blockers:");
		expect(rendered).not.toContain("On runtime impediments:");
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
		// The base prompt is intentionally neutral on delegation (scope decides);
		// swarm-by-default voice belongs to mode overlays, not the stable base.
		expect(rendered).toContain("Keep direct execution for straightforward work");
		expect(rendered).not.toContain("Delegate work to subagents by default");
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

	test("system-prompt's per-turn imperative counts proof as advancement (kill-list D4)", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();
		const rendered = renderPromptTemplate(template, { ...baseRenderContext });

		expect(rendered).toContain("or its proof");
		// Narrow phrasing biased the model to skip the review lane to show progress.
		expect(rendered).not.toContain("MUST** materially advance the deliverable.");
		// Anti-stop spine restored alongside the D4 proof carve-out (session-log
		// analysis: recurring "why did you stop" after the imperative was softened).
		expect(rendered).toContain("Never yield mid-wave");
	});

	test("system-prompt bans destructive git state-discard ops", async () => {
		const rendered = await renderBuiltSystemPrompt(Settings.isolated());
		// Highest-recurrence user instruction across repos: never stash/reset/revert/checkout.
		expect(rendered).toContain("git stash");
		expect(rendered).toMatch(/NEVER.*reset.*revert.*checkout/);
	});

	test("system-prompt scopes terseness to conversation, exempts artifacts", async () => {
		const rendered = await renderBuiltSystemPrompt(Settings.isolated());
		expect(rendered).toContain("comprehensive, not terse");
	});

	test("system-prompt surfaces execute above bash in the precedence ladder", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();
		const rendered = renderPromptTemplate(template, {
			...baseRenderContext,
			tools: ["find", "edit", "create", "task", "bash", "execute", "org"],
		});
		// execute is a core tool; the ladder must name it as the compute/inspect lane
		// and demote bash to process-only (session logs: 52.7% bash, 0.2% execute).
		const execIdx = rendered.indexOf("**Compute/inspect**");
		const bashIdx = rendered.indexOf("**Process**");
		expect(execIdx).toBeGreaterThan(-1);
		expect(bashIdx).toBeGreaterThan(execIdx);
		expect(rendered).toContain("Replace the bash + pipe habit with `execute`");
		// org default bakes in repo-independently when the tool is present.
		expect(rendered).toContain("Track multi-step work in `org`");
	});

	test("precedence ladder falls back to plain bash when execute absent", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();
		const rendered = renderPromptTemplate(template, {
			...baseRenderContext,
			tools: ["find", "edit", "bash"],
		});
		expect(rendered).toContain("simple one-liners only");
		expect(rendered).not.toContain("**Compute/inspect**");
	});
});

describe("terse communication baked into base prompt", () => {
	// Caveman mode was removed as a toggle; its style is now unconditional in
	// <communication>. These pins guard against the style regressing to prose.
	test("buildSystemPrompt always carries terse communication guidance", async () => {
		const rendered = await renderBuiltSystemPrompt(Settings.isolated());

		expect(rendered).toContain("Terse by default");
		expect(rendered).toContain("Auto-clarity");
		expect(rendered).not.toContain("Terse mode active");
		expect(rendered).not.toContain("<thinking-mode>");
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

describe("GPT-family model conditioning (FEAT-821)", () => {
	const PERSISTENCE = "<persistence>";
	const VERIFICATION = "<verification>";
	const PRECEDENCE = "completeness wins, always";

	async function renderForModel(model?: { provider?: string; api?: string; id?: string }): Promise<string> {
		const blocks = await buildSystemPrompt({
			contextFiles: [],
			cwd: import.meta.dir,
			rules: [],
			skills: [],
			toolNames: ["read", "edit", "bash"],
			model,
		});
		return blocks.map(block => block.text).join("\n");
	}

	test("renders persistence + verification + precedence blocks for openai-codex api", async () => {
		const rendered = await renderForModel({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4" });
		expect(rendered).toContain(PERSISTENCE);
		expect(rendered).toContain(VERIFICATION);
		expect(rendered).toContain(PRECEDENCE);
		expect(rendered).toContain("Verify before you claim");
	});

	test("renders GPT blocks for a gpt-5 id even under a generic provider", async () => {
		const rendered = await renderForModel({ provider: "openrouter", api: "openai-completions", id: "gpt-5.5" });
		expect(rendered).toContain(PERSISTENCE);
		expect(rendered).toContain(VERIFICATION);
	});

	test("renders GPT blocks for a codex id", async () => {
		const rendered = await renderForModel({ provider: "openai", api: "openai-completions", id: "gpt-5.3-codex" });
		expect(rendered).toContain(PERSISTENCE);
	});

	test("omits GPT blocks for an Anthropic Opus model (Claude dialect preserved)", async () => {
		const rendered = await renderForModel({ provider: "anthropic", api: "anthropic", id: "claude-opus-4-8" });
		expect(rendered).not.toContain(PERSISTENCE);
		expect(rendered).not.toContain(VERIFICATION);
		expect(rendered).not.toContain(PRECEDENCE);
		// Base discipline content must remain.
		expect(rendered).toContain("<discipline>");
	});

	test("omits GPT blocks when no model is supplied (default path unchanged)", async () => {
		const rendered = await renderForModel(undefined);
		expect(rendered).not.toContain(PERSISTENCE);
		expect(rendered).not.toContain(VERIFICATION);
	});

	test("template gates both blocks on isGptFamily", async () => {
		const templatePath = path.join(systemPromptsDir, "system-prompt.md");
		const template = await Bun.file(templatePath).text();
		const on = renderPromptTemplate(template, { ...baseRenderContext, isGptFamily: true });
		const off = renderPromptTemplate(template, { ...baseRenderContext, isGptFamily: false });
		expect(on).toContain(PERSISTENCE);
		expect(on).toContain(VERIFICATION);
		expect(off).not.toContain(PERSISTENCE);
		expect(off).not.toContain(VERIFICATION);
	});
});

