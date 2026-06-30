import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@spell/pi-agent-core";
import { getBundledModel } from "@spell/pi-ai";
import { ModelRegistry } from "@spell/pi-coding-agent/config/model-registry";
import { Settings } from "@spell/pi-coding-agent/config/settings";
import { type AgentSessionEvent, AgentSession } from "@spell/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@spell/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@spell/pi-coding-agent/session/session-manager";
import { Snowflake } from "@spell/pi-utils";

/**
 * Regression: a turn ending while awaiting user input must re-derive the
 * agent status (running -> needs_input). The interactive main loop arms its
 * input callback WITHOUT emitting an agent event, so status-derived observers
 * (the niri status-file writer, the intention briefing) would never re-evaluate
 * and the status file would freeze at "running". `notifyStatusObservers()` is
 * the explicit nudge that drives that re-derivation; this test pins that it
 * reaches local session subscribers.
 */
describe("AgentSession.notifyStatusObservers", () => {
	let tempDir: string;
	let session: AgentSession;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-status-observers-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		sessionManager = SessionManager.create(tempDir);
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage, undefined, path.join(tempDir, "models.yml"));

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model not found in registry");

		const agent = new Agent({
			getApiKey: () => "test",
			initialState: { model, systemPrompt: "test", tools: [] },
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});
	});

	afterEach(async () => {
		await session.dispose();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	it("emits status_observable_changed to local subscribers", () => {
		const events: AgentSessionEvent[] = [];
		session.subscribe(e => events.push(e));

		session.notifyStatusObservers();

		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("status_observable_changed");
	});

	it("notifies every subscriber on each call", () => {
		let a = 0;
		let b = 0;
		session.subscribe(() => a++);
		session.subscribe(() => b++);

		session.notifyStatusObservers();
		session.notifyStatusObservers();

		expect(a).toBe(2);
		expect(b).toBe(2);
	});

	it("stops notifying after unsubscribe", () => {
		let count = 0;
		const unsubscribe = session.subscribe(() => count++);

		session.notifyStatusObservers();
		unsubscribe();
		session.notifyStatusObservers();

		expect(count).toBe(1);
	});
});
