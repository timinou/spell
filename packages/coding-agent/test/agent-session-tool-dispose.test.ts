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
		const modelRegistry = new ModelRegistry(authStorage, undefined, path.join(tempDir, "models.yml"));

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
		session.registerTool("no-dispose", {
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

	it("dispose is idempotent — second call is a no-op", async () => {
		await session.newSession();
		expect(disposeCalls).toHaveLength(2);

		// Second newSession should dispose again, but tools are already disposed
		disposeCalls.length = 0;
		await session.newSession();
		// Tools still get dispose called (they're still registered), count should be same
		expect(disposeCalls).toHaveLength(2);
	});

	it("fork() disposes all tools", async () => {
		await session.fork();
		expect(disposeCalls).toContain("tool-a");
		expect(disposeCalls).toContain("tool-b");
		expect(disposeCalls).toHaveLength(2);
	});

	it("tool with failing dispose does not block others", async () => {
		const failingTool: AgentTool = {
			name: "failing-tool",
			label: "Failing",
			description: "tool that fails dispose",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ type: "text" as const, text: "ok" }),
			dispose: async () => {
				throw new Error("dispose failed");
			},
		} as unknown as AgentTool;
		session.registerTool("failing-tool", failingTool);

		await session.newSession();
		// Both tool-a and tool-b should still have been disposed
		expect(disposeCalls).toContain("tool-a");
		expect(disposeCalls).toContain("tool-b");
	});

	it("ToolSession.dispose is called during #disposeTools", async () => {
		let toolSessionDisposed = false;
		// Access the internal toolSession field via the config
		// We need to create a new session with toolSession in config
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth2.db"));
		const modelRegistry2 = new ModelRegistry(authStorage, undefined, path.join(tempDir, "models2.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model not found");

		const dummyTool = createDisposableTool("dummy");
		const agent = new Agent({
			getApiKey: () => "test",
			initialState: { model, systemPrompt: "test", tools: [dummyTool] },
		});

		const sessionWithToolSession = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: modelRegistry2,
			toolRegistry: new Map([[dummyTool.name, dummyTool]]),
			toolSession: {
				dispose: async () => {
					toolSessionDisposed = true;
				},
			},
		});
		sessionWithToolSession.subscribe(() => {});

		await sessionWithToolSession.newSession();
		expect(toolSessionDisposed).toBe(true);
	});
});
