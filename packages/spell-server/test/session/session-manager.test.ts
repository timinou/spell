import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { RpcEvent, RpcSpawnOptions } from "@oh-my-pi/telegram-bridge";
import { type BaseSpawnOptions, type SessionLifecycle, SessionManager } from "../../src/session";

class MockRpcClient {
	alive = false;
	killCount = 0;
	startCount = 0;
	options: RpcSpawnOptions;
	#listeners: Array<(event: RpcEvent) => void> = [];
	#startDeferred = Promise.withResolvers<void>();

	constructor(options: RpcSpawnOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		this.startCount += 1;
		await this.#startDeferred.promise;
		this.alive = true;
	}

	resolveStart(): void {
		this.#startDeferred.resolve();
	}

	async kill(): Promise<void> {
		this.killCount += 1;
		this.alive = false;
	}

	onEvent(callback: (event: RpcEvent) => void): void {
		this.#listeners.push(callback);
	}

	offEvent(callback: (event: RpcEvent) => void): void {
		const index = this.#listeners.indexOf(callback);
		if (index === -1) return;
		this.#listeners.splice(index, 1);
	}

	emit(event: RpcEvent): void {
		for (const listener of this.#listeners) {
			listener(event);
		}
	}

	async prompt(): Promise<void> {}

	send(): void {}
}

function createLifecycle(
	idleTimeout: number | null,
	hooks: Partial<SessionLifecycle<string>> = {},
): SessionLifecycle<string> {
	return {
		buildSpawnOptions: (key, base) => ({ cwd: base.cwd, tools: [...base.tools], appendSystemPrompt: key }),
		getIdleTimeout: () => idleTimeout,
		...hooks,
	};
}

const BASE_OPTIONS: BaseSpawnOptions = {
	cwd: "/tmp/project",
	tools: ["read", "grep"],
	appendSystemPrompt: "system",
	sessionDir: "/tmp/sessions",
	sandboxPolicyPath: "/tmp/policy.json",
};

describe("SessionManager", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("creates a session and returns the live client", async () => {
		const clients: MockRpcClient[] = [];
		const manager = new SessionManager<string>({
			lifecycle: createLifecycle(1_000),
			keyToString: key => key,
			createClient: options => {
				const client = new MockRpcClient(options);
				clients.push(client);
				queueMicrotask(() => client.resolveStart());
				return client as unknown as never;
			},
		});

		const client = await manager.getOrCreate("chat-1", BASE_OPTIONS);

		expect(client).toBe(clients[0] as unknown as typeof client);
		expect(clients[0]?.alive).toBe(true);
		expect(clients[0]?.options).toEqual({
			cwd: "/tmp/project",
			tools: ["read", "grep"],
			appendSystemPrompt: "chat-1",
		});
		expect(manager.get("chat-1")).toBe(client);
		expect(manager.size).toBe(1);
	});

	it("returns existing live session for repeated lookups", async () => {
		const client = new MockRpcClient({ cwd: "/tmp/project", tools: ["read"] });
		client.resolveStart();
		const manager = new SessionManager<string>({
			lifecycle: createLifecycle(1_000),
			keyToString: key => key,
			createClient: () => client as unknown as never,
		});

		const first = await manager.getOrCreate("chat-1", BASE_OPTIONS);
		const second = await manager.getOrCreate("chat-1", BASE_OPTIONS);

		expect(second).toBe(first);
		expect(client.startCount).toBe(1);
	});

	it("returns undefined for missing sessions", () => {
		const manager = new SessionManager<string>({
			lifecycle: createLifecycle(1_000),
			keyToString: key => key,
		});

		expect(manager.get("missing")).toBeUndefined();
	});

	it("kills an active session", async () => {
		const client = new MockRpcClient({ cwd: "/tmp/project", tools: ["read"] });
		client.resolveStart();
		const manager = new SessionManager<string>({
			lifecycle: createLifecycle(1_000),
			keyToString: key => key,
			createClient: () => client as unknown as never,
		});

		await manager.getOrCreate("chat-1", BASE_OPTIONS);
		await manager.kill("chat-1");

		expect(client.killCount).toBe(1);
		expect(manager.get("chat-1")).toBeUndefined();
		expect(manager.size).toBe(0);
	});

	it("rejects when max sessions limit is reached", async () => {
		const first = new MockRpcClient({ cwd: "/tmp/project", tools: ["read"] });
		first.resolveStart();
		const second = new MockRpcClient({ cwd: "/tmp/project", tools: ["grep"] });
		second.resolveStart();
		const clients = [first, second];
		const manager = new SessionManager<string>({
			lifecycle: createLifecycle(1_000),
			keyToString: key => key,
			maxSessions: 1,
			createClient: () => clients.shift() as unknown as never,
		});

		await manager.getOrCreate("chat-1", BASE_OPTIONS);
		await expect(manager.getOrCreate("chat-2", BASE_OPTIONS)).rejects.toThrow(
			/Max sessions limit reached \(1\).*chat-2/,
		);
	});

	it("coalesces concurrent creation for the same key", async () => {
		const client = new MockRpcClient({ cwd: "/tmp/project", tools: ["read"] });
		const manager = new SessionManager<string>({
			lifecycle: createLifecycle(1_000),
			keyToString: key => key,
			createClient: () => client as unknown as never,
		});

		const firstPromise = manager.getOrCreate("chat-1", BASE_OPTIONS);
		const secondPromise = manager.getOrCreate("chat-1", BASE_OPTIONS);
		client.resolveStart();
		const [first, second] = await Promise.all([firstPromise, secondPromise]);

		expect(first).toBe(second);
		expect(client.startCount).toBe(1);
	});

	it("kills sessions after idle timeout", async () => {
		const client = new MockRpcClient({ cwd: "/tmp/project", tools: ["read"] });
		client.resolveStart();
		const manager = new SessionManager<string>({
			lifecycle: createLifecycle(50),
			keyToString: key => key,
			createClient: () => client as unknown as never,
		});

		await manager.getOrCreate("chat-1", BASE_OPTIONS);
		vi.advanceTimersByTime(49);
		expect(client.killCount).toBe(0);
		vi.advanceTimersByTime(1);
		await Promise.resolve();

		expect(client.killCount).toBe(1);
		expect(manager.get("chat-1")).toBeUndefined();
	});

	it("does not start an idle timer when lifecycle disables it", async () => {
		const client = new MockRpcClient({ cwd: "/tmp/project", tools: ["read"] });
		client.resolveStart();
		const manager = new SessionManager<string>({
			lifecycle: createLifecycle(null),
			keyToString: key => key,
			createClient: () => client as unknown as never,
		});

		await manager.getOrCreate("chat-1", BASE_OPTIONS);
		vi.advanceTimersByTime(10_000);
		await Promise.resolve();

		expect(client.killCount).toBe(0);
		expect(manager.get("chat-1")).toBe(client as unknown as never);
	});

	it("removes crashed sessions and reports lifecycle errors", async () => {
		const onSessionError = vi.fn(async () => {});
		const onSessionComplete = vi.fn(async () => {});
		const client = new MockRpcClient({ cwd: "/tmp/project", tools: ["read"] });
		client.resolveStart();
		const manager = new SessionManager<string>({
			lifecycle: createLifecycle(1_000, { onSessionError, onSessionComplete }),
			keyToString: key => key,
			createClient: () => client as unknown as never,
		});

		await manager.getOrCreate("chat-1", BASE_OPTIONS);
		client.emit({ type: "error", message: "RPC process exited" });
		await Promise.resolve();
		await Promise.resolve();

		expect(manager.get("chat-1")).toBeUndefined();
		expect(client.killCount).toBe(0);
		expect(onSessionComplete).not.toHaveBeenCalled();
		expect(onSessionError).toHaveBeenCalledWith(
			"chat-1",
			expect.objectContaining({ message: expect.stringContaining("RPC process exited") }),
		);
	});
});
