import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { GoalExecutionController } from "../../src/executor";
import type { GoalResult } from "../../src/executor/types";
import type { AutonomyManifest, ManifestGoal, ManifestSetup } from "../../src/manifest";
import type { RpcEvent, RpcSpawnOptions } from "../../src/rpc";
import { type SessionLifecycle, SessionManager } from "../../src/session";

class MockRpcClient {
	alive = false;
	killCount = 0;
	options: RpcSpawnOptions;
	promptMessages: string[] = [];
	#listeners: Array<(event: RpcEvent) => void> = [];
	#promptImpl: (message: string) => Promise<void>;
	#pendingPromptReject: ((error: Error) => void) | null = null;

	constructor(options: RpcSpawnOptions, promptImpl?: (message: string) => Promise<void>) {
		this.options = options;
		this.#promptImpl = promptImpl ?? (async () => {});
	}

	async start(): Promise<void> {
		this.alive = true;
	}

	onEvent(callback: (event: RpcEvent) => void): void {
		this.#listeners.push(callback);
	}

	offEvent(callback: (event: RpcEvent) => void): void {
		const index = this.#listeners.indexOf(callback);
		if (index === -1) {
			return;
		}
		this.#listeners.splice(index, 1);
	}

	emit(event: RpcEvent): void {
		for (const listener of this.#listeners) {
			listener(event);
		}
	}

	setPromptImpl(promptImpl: (message: string) => Promise<void>): void {
		this.#promptImpl = promptImpl;
	}

	async prompt(message: string): Promise<void> {
		this.promptMessages.push(message);
		return await this.#promptImpl(message);
	}

	async kill(): Promise<void> {
		this.killCount += 1;
		this.alive = false;
		const reject = this.#pendingPromptReject;
		this.#pendingPromptReject = null;
		reject?.(new Error("RPC process exited with code 143"));
	}

	createPendingPrompt(): Promise<void> {
		const deferred = Promise.withResolvers<void>();
		this.#pendingPromptReject = deferred.reject;
		return deferred.promise;
	}
}

function createLifecycle(): SessionLifecycle<string> {
	return {
		buildSpawnOptions: (_key, base) => ({
			cwd: base.cwd,
			tools: [...base.tools],
			appendSystemPrompt: base.appendSystemPrompt,
			sessionDir: base.sessionDir,
			sandboxPolicyPath: base.sandboxPolicyPath,
		}),
		getIdleTimeout: () => null,
	};
}

function createManifest(
	goalOverrides: Partial<ManifestGoal> = {},
	setupOverrides: Partial<ManifestSetup> = {},
): AutonomyManifest {
	const goal: ManifestGoal = {
		setup: "default",
		schedule: { type: "cron", expression: "0 * * * *" },
		prompt: "Line one\nLine two",
		retry: { maxRetries: 0 },
		...goalOverrides,
	};

	const setup: ManifestSetup = {
		domain: "coding",
		tools: { allow: ["read", "grep", "bash"], deny: ["bash"] },
		sandbox: { pathsWrite: ["src/"], bashAllow: ["git status"] },
		...setupOverrides,
	};

	return {
		name: "spell-server",
		version: "1.0.0",
		setups: new Map([["default", setup]]),
		goals: new Map([["ship-it", goal]]),
		exportTargets: [],
		notificationRoutes: [],
		reviewPolicies: [],
		checkpoints: [],
		panels: [],
		layouts: [],
		syncCollections: [],
		stateSchemas: [],
		toolModules: [],
		operatorActions: [],
	};
}

function createManager(clients: MockRpcClient[]): SessionManager<string> {
	return new SessionManager<string>({
		lifecycle: createLifecycle(),
		keyToString: key => key,
		createClient: options => {
			const client = clients.shift();
			if (!client) {
				throw new Error("No mock client available");
			}
			client.options = options;
			return client as unknown as never;
		},
	});
}

function parseActionPrompt(message: string): Record<string, unknown> {
	const match = /BEGIN_ACTION_SPEC_JSON\n([\s\S]*?)\nEND_ACTION_SPEC_JSON/.exec(message);
	if (!match) {
		throw new Error(`Missing action payload markers in prompt: ${message}`);
	}
	return JSON.parse(match[1]) as Record<string, unknown>;
}

describe("GoalExecutionController", () => {
	it("spawns a session with resolved setup params and passes the full prompt", async () => {
		const client = new MockRpcClient({ cwd: "", tools: [] }, async () => {});
		const controller = new GoalExecutionController({
			sessionManager: createManager([client]),
			manifest: createManifest(),
			now: () => 1_000,
		});

		const result = await controller.executeGoal("ship-it", "/repo/project");

		const sandboxPolicyPath = client.options.sandboxPolicyPath;
		expect(client.options.cwd).toBe("/repo/project");
		expect(client.options.tools).toEqual(["read", "grep"]);
		expect(sandboxPolicyPath).toMatch(/^\/tmp\/spell-sandbox-/);
		await expect(fs.access(sandboxPolicyPath!)).rejects.toThrow();
		expect(client.promptMessages).toEqual(["Line one\nLine two"]);
		expect(result.status).toBe("success");
		expect(controller.getState("ship-it")).toBe("completed");
	});

	it("transitions to completed and fires the hook on successful completion", async () => {
		const client = new MockRpcClient({ cwd: "", tools: [] }, async () => {
			client.emit({
				type: "message_update",
				assistantMessageEvent: { type: "text_end", content: "Finished successfully" },
			});
		});
		const onHook = vi.fn(async (_goalName: string, _result: GoalResult) => {});
		const controller = new GoalExecutionController({
			sessionManager: createManager([client]),
			manifest: createManifest(),
			onHook,
			now: () => 2_000,
		});

		const result = await controller.executeGoal("ship-it", "/repo/project");

		expect(result.summary).toBe("Finished successfully");
		expect(result.runs[0]).toEqual(expect.objectContaining({ status: "completed", attempt: 1 }));
		expect(controller.getState("ship-it")).toBe("completed");
		expect(onHook).toHaveBeenCalledWith(
			"ship-it",
			expect.objectContaining({ status: "success", summary: "Finished successfully" }),
		);
	});

	it("records a failed run before retrying with exponential backoff", async () => {
		const firstClient = new MockRpcClient({ cwd: "", tools: [] }, async () => {
			firstClient.alive = false;
			firstClient.emit({ type: "error", message: "RPC process exited with code 1" });
			throw new Error("RPC process exited with code 1");
		});
		const secondClient = new MockRpcClient({ cwd: "", tools: [] }, async () => {
			secondClient.emit({
				type: "message_update",
				assistantMessageEvent: { type: "text_end", content: "Recovered" },
			});
		});
		const sleep = vi.fn(async (_ms: number) => {});
		const controller = new GoalExecutionController({
			sessionManager: createManager([firstClient, secondClient]),
			manifest: createManifest({ retry: { maxRetries: 1, initialDelayMs: 25, multiplier: 4 } }),
			sleep,
			now: () => 3_000,
		});

		const result = await controller.executeGoal("ship-it", "/repo/project");

		expect(sleep).toHaveBeenCalledWith(25);
		expect(result.status).toBe("success");
		expect(result.runs).toHaveLength(2);
		expect(result.runs[0]).toEqual(
			expect.objectContaining({ status: "failed", error: "RPC process exited with code 1", attempt: 1 }),
		);
		expect(result.runs[1]).toEqual(expect.objectContaining({ status: "completed", attempt: 2 }));
		expect(controller.getState("ship-it")).toBe("completed");
	});

	it("exhausts retries, escalates, and pauses the goal", async () => {
		const firstClient = new MockRpcClient({ cwd: "", tools: [] }, async () => {
			firstClient.alive = false;
			firstClient.emit({ type: "error", message: "RPC process exited with code 1" });
			throw new Error("RPC process exited with code 1");
		});
		const secondClient = new MockRpcClient({ cwd: "", tools: [] }, async () => {
			secondClient.alive = false;
			secondClient.emit({ type: "error", message: "RPC process exited with code 1" });
			throw new Error("RPC process exited with code 1");
		});
		const onEscalation = vi.fn(async () => {});
		const controller = new GoalExecutionController({
			sessionManager: createManager([firstClient, secondClient]),
			manifest: createManifest({ retry: { maxRetries: 1, initialDelayMs: 10, multiplier: 2 } }),
			onEscalation,
			sleep: vi.fn(async () => {}),
			now: () => 4_000,
		});

		const result = await controller.executeGoal("ship-it", "/repo/project");

		expect(result.status).toBe("failure");
		expect(result.error).toBe("RPC process exited with code 1");
		expect(controller.getState("ship-it")).toBe("paused");
		expect(onEscalation).toHaveBeenCalledWith("ship-it", "RPC process exited with code 1");
	});

	it("executes action-only goals through the prompt flow with a deterministic structured payload", async () => {
		const client = new MockRpcClient({ cwd: "", tools: [] }, async () => {});
		const controller = new GoalExecutionController({
			sessionManager: createManager([client]),
			manifest: createManifest({
				prompt: undefined,
				action: {
					id: "spell.noop",
					params: { zeta: 1, alpha: { beta: true }, items: ["keep", 2] },
					promptSlots: {
						review: { name: "review", kind: "inline", content: "Review the staged digest." },
						attachment: {
							name: "attachment",
							kind: "file",
							path: "/repo/project/prompts/attachment.md",
							content: "File-backed guidance.",
						},
					},
				},
			}),
			now: () => 5_250,
		});

		const result = await controller.executeGoal("ship-it", "/repo/project");
		const payload = parseActionPrompt(client.promptMessages[0]!);

		expect(result.status).toBe("success");
		expect(payload).toEqual({
			actionId: "spell.noop",
			params: { alpha: { beta: true }, items: ["keep", 2], zeta: 1 },
			promptSlots: {
				attachment: {
					content: "File-backed guidance.",
					kind: "file",
					name: "attachment",
					path: "/repo/project/prompts/attachment.md",
				},
				review: { content: "Review the staged digest.", kind: "inline", name: "review" },
			},
		});
		expect(client.promptMessages[0]).not.toContain("does not execute yet");
	});

	it("keeps empty action params and prompt slots truthful in the generated payload", async () => {
		const client = new MockRpcClient({ cwd: "", tools: [] }, async () => {});
		const controller = new GoalExecutionController({
			sessionManager: createManager([client]),
			manifest: createManifest({
				prompt: undefined,
				action: { id: "spell.noop", params: {}, promptSlots: {} },
			}),
			now: () => 5_400,
		});

		await controller.executeGoal("ship-it", "/repo/project");

		expect(parseActionPrompt(client.promptMessages[0]!)).toEqual({
			actionId: "spell.noop",
			params: {},
			promptSlots: {},
		});
	});

	it("rejects execution while a goal is already running", async () => {
		const client = new MockRpcClient({ cwd: "", tools: [] });
		const deferred = Promise.withResolvers<void>();
		client.setPromptImpl(() => deferred.promise);
		const controller = new GoalExecutionController({
			sessionManager: createManager([client]),
			manifest: createManifest(),
			now: () => 5_000,
		});

		const firstRun = controller.executeGoal("ship-it", "/repo/project");
		await expect(controller.executeGoal("ship-it", "/repo/project")).rejects.toThrow(
			"Goal 'ship-it' is already running",
		);
		deferred.resolve();
		const result = await firstRun;
		expect(result.status).toBe("success");
		expect(controller.getState("ship-it")).toBe("completed");
	});

	it("reports inflight goals while drain waits are pending", async () => {
		const client = new MockRpcClient({ cwd: "", tools: [] });
		const deferred = Promise.withResolvers<void>();
		client.setPromptImpl(() => deferred.promise);
		const controller = new GoalExecutionController({
			sessionManager: createManager([client]),
			manifest: createManifest(),
			now: () => 5_500,
		});

		const firstRun = controller.executeGoal("ship-it", "/repo/project");
		expect(controller.getInflightGoalNames()).toEqual(["ship-it"]);
		await expect(controller.waitForInflightGoals(10)).resolves.toEqual({
			drained: false,
			activeGoals: ["ship-it"],
		});
		deferred.resolve();
		await firstRun;
		expect(controller.getInflightGoalNames()).toEqual([]);
	});

	it("rejects execution after escalation pauses the goal", async () => {
		const client = new MockRpcClient({ cwd: "", tools: [] }, async () => {
			client.alive = false;
			client.emit({ type: "error", message: "RPC process exited with code 1" });
			throw new Error("RPC process exited with code 1");
		});
		const controller = new GoalExecutionController({
			sessionManager: createManager([client]),
			manifest: createManifest(),
			now: () => 6_000,
		});

		await controller.executeGoal("ship-it", "/repo/project");
		await expect(controller.executeGoal("ship-it", "/repo/project")).rejects.toThrow(
			"Goal 'ship-it' is paused after escalation",
		);
	});

	it("kills timed out sessions and records timeout runs", async () => {
		const client = new MockRpcClient({ cwd: "", tools: [] });
		client.setPromptImpl(() => client.createPendingPrompt());
		const controller = new GoalExecutionController({
			sessionManager: createManager([client]),
			manifest: createManifest({}, { timeout: "10ms" }),
			now: () => 7_000,
		});

		const result = await controller.executeGoal("ship-it", "/repo/project");

		expect(client.killCount).toBe(1);
		expect(result.status).toBe("failure");
		expect(result.runs[0]).toEqual(expect.objectContaining({ status: "timeout", attempt: 1 }));
		expect(controller.getState("ship-it")).toBe("paused");
	});

	it("treats process exit code 0 without completion as success", async () => {
		const client = new MockRpcClient({ cwd: "", tools: [] }, async () => {
			client.alive = false;
			client.emit({ type: "error", message: "RPC process exited with code 0" });
			throw new Error("RPC process exited with code 0");
		});
		const controller = new GoalExecutionController({
			sessionManager: createManager([client]),
			manifest: createManifest(),
			now: () => 8_000,
		});

		const result = await controller.executeGoal("ship-it", "/repo/project");

		expect(result.status).toBe("success");
		expect(result.runs[0]).toEqual(expect.objectContaining({ status: "completed", attempt: 1 }));
		expect(controller.getState("ship-it")).toBe("completed");
	});
});
