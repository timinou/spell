import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SpellDomain } from "../src/domain/loader";

const DOMAIN_SYSTEM_PROMPT = "DOMAIN PROMPT";
const DOMAIN_CONTEXT_TEXT = "DOMAIN CONTEXT";

function createDomainManifest(): SpellDomain {
	return {
		name: "growth",
		description: "Growth domain",
		systemPromptPath: "domain/growth/prompts/system.md",
		contextFiles: ["domain/growth/prompts/context.md"],
		tools: {
			exclude: ["lsp", "ast_grep", "ast_edit", "emacs_code"],
		},
		panels: [],
		workspaces: [],
	};
}

describe("createAgentSession domain policy", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-sdk-domain-"));
		await Bun.write(path.join(tempDir, "domain", "growth", "prompts", "system.md"), DOMAIN_SYSTEM_PROMPT);
		await Bun.write(path.join(tempDir, "domain", "growth", "prompts", "context.md"), DOMAIN_CONTEXT_TEXT);
	});

	afterEach(async () => {
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("filters excluded tools by default for the active domain", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			domainManifest: createDomainManifest(),
		});

		try {
			const activeTools = session.getActiveToolNames();
			expect(activeTools).toContain("read");
			expect(activeTools).not.toContain("lsp");
			expect(activeTools).not.toContain("ast_grep");
			expect(activeTools).not.toContain("ast_edit");
			expect(activeTools).not.toContain("emacs_code");
		} finally {
			await session.dispose();
		}
	});

	it("preserves explicitly requested tools even when the domain excludes them by default", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			toolNames: ["read", "lsp"],
			domainManifest: createDomainManifest(),
		});

		try {
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "lsp"]));
		} finally {
			await session.dispose();
		}
	});

	it("prepends the domain prompt before string system prompt overrides and includes domain context files", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			toolNames: ["read"],
			systemPrompt: "CLI PROMPT",
			domainManifest: createDomainManifest(),
		});

		try {
			expect(session.systemPrompt.indexOf(DOMAIN_SYSTEM_PROMPT)).toBeLessThan(
				session.systemPrompt.indexOf("CLI PROMPT"),
			);
			expect(session.systemPrompt).toContain('path="domain/growth/prompts/context.md"');
			expect(session.systemPrompt).toContain(DOMAIN_CONTEXT_TEXT);
		} finally {
			await session.dispose();
		}
	});

	it("keeps the domain prompt ahead of function-based prompt additions", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			toolNames: ["read"],
			systemPrompt: defaultPrompt => `${defaultPrompt}\n\nFUNCTION APPEND`,
			domainManifest: createDomainManifest(),
		});

		try {
			expect(session.systemPrompt.indexOf(DOMAIN_SYSTEM_PROMPT)).toBeLessThan(
				session.systemPrompt.indexOf("FUNCTION APPEND"),
			);
		} finally {
			await session.dispose();
		}
	});
});
