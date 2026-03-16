import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Verify that AgentSession calls dispose() on registered tools during
 * session lifecycle transitions (newSession, switchSession, dispose).
 */
describe("AgentSession tool dispose lifecycle", () => {
	let tempDir: string;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let disposeCalls: string[];

	function createDisposableTool(name: string): AgentTool {
		return {
			name,
			label: name,
			description: `test tool ${name}`,
			parameters: { type: "object", properties: {} },
			execute: async () => ({ type: "text" as const, text: "ok" }),
			dispose: async () => {
				disposeCalls.push(name);
			},
		} as unknown as AgentTool;
	}

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-tool-dispose-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		disposeCalls = [];

		sessionManager = SessionManager.create(tempDir);
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model not found in registry");

		const tools = [createDisposableTool("tool-a"), createDisposableTool("tool-b")];
		const toolRegistry = new Map(tools.map(t => [t.name, t]));

		const agent = new Agent({
			getApiKey: () => "test",
			initialState: {
				model,
				systemPrompt: "test",
				tools,
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry,
		});

		session.subscribe(() => {});
	});

	afterEach(async () => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	it("newSession disposes all tools with dispose methods", async () => {
		await session.newSession();
		expect(disposeCalls).toContain("tool-a");
		expect(disposeCalls).toContain("tool-b");
		expect(disposeCalls).toHaveLength(2);
	});

	it("dispose() disposes all tools", async () => {
		await session.dispose();
		expect(disposeCalls).toContain("tool-a");
		expect(disposeCalls).toContain("tool-b");
		expect(disposeCalls).toHaveLength(2);
	});

	it("tools without dispose are skipped without error", async () => {
		// Register a tool without dispose
		session.registerTool({
			name: "no-dispose",
			label: "No Dispose",
			description: "tool without dispose",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ type: "text" as const, text: "ok" }),
		} as unknown as AgentTool);

		await session.newSession();
		// Only the two disposable tools should have been called
		expect(disposeCalls).toHaveLength(2);
	});
});
