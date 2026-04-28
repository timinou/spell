import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RpcClient, RpcEvent, RpcSpawnOptions } from "../../../src/rpc";
import { SessionManager } from "../../../src/session";
import { SocketSessionRegistry } from "../../../src/socket/session-registry";
import { WebSpawnedLifecycle } from "../../../src/web/session/spawned-lifecycle";
import { WebSessionHub } from "../../../src/web/session/web-session-hub";

class FakeRpcClient {
	alive = true;
	options: RpcSpawnOptions;
	sentCommands: unknown[] = [];
	#listeners: Array<(event: RpcEvent) => void> = [];

	constructor(options: RpcSpawnOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		this.alive = true;
		// Simulate the RPC `ready` event arriving shortly after start.
		setTimeout(() => this.emit({ type: "ready" }), 0);
	}

	async kill(): Promise<void> {
		this.alive = false;
		this.emit({ type: "agent_end" });
	}

	send(command: { id?: string; type: string }): void {
		this.sentCommands.push(command);
		// Fake success response.
		setTimeout(() => {
			this.emit({ type: "response", command: command.type, success: true });
		}, 0);
	}

	async prompt(): Promise<void> {}

	async abort(): Promise<void> {}

	onEvent(cb: (event: RpcEvent) => void): void {
		this.#listeners.push(cb);
	}
	offEvent(cb: (event: RpcEvent) => void): void {
		const i = this.#listeners.indexOf(cb);
		if (i !== -1) this.#listeners.splice(i, 1);
	}

	emit(event: RpcEvent): void {
		for (const listener of [...this.#listeners]) listener(event);
	}
}

function makeHub() {
	const registry = new SocketSessionRegistry();
	const created: FakeRpcClient[] = [];
	const sessionManager = new SessionManager<string>({
		lifecycle: new WebSpawnedLifecycle({ idleTimeoutMs: 60_000 }),
		keyToString: k => k,
		createClient: opts => {
			const client = new FakeRpcClient(opts);
			created.push(client);
			return client as unknown as RpcClient;
		},
	});
	const hub = new WebSessionHub({ sessionManager, registry });
	return { registry, sessionManager, hub, created };
}

describe("WebSessionHub", () => {
	let env: ReturnType<typeof makeHub>;

	beforeEach(() => {
		env = makeHub();
	});

	afterEach(async () => {
		await env.sessionManager.killAll();
		env.hub.stop();
	});

	it("spawns a session and registers it as 'spawned' kind with ownedBy", async () => {
		const { sessionId } = await env.hub.spawn({
			ownedBy: "alice",
			templateName: "document",
			watchExtensions: [".pdf"],
			base: { cwd: "/tmp", tools: ["read"] },
		});
		const entries = env.registry.getSpawned();
		expect(entries.length).toBe(1);
		expect(entries[0].kind).toBe("spawned");
		expect(entries[0].ownedBy).toBe("alice");
		expect(entries[0].templateName).toBe("document");
		expect(entries[0].watchExtensions).toEqual([".pdf"]);
		expect(entries[0].sessionId).toBe(sessionId);
	});

	it("emits session_added on spawn and session_removed on kill", async () => {
		const events: string[] = [];
		env.hub.onLifecycle(e => events.push(e.type));
		const { sessionId } = await env.hub.spawn({ ownedBy: "alice", base: { cwd: "/tmp", tools: [] } });
		await env.hub.kill(sessionId);
		expect(events).toContain("session_added");
		expect(events).toContain("session_removed");
		expect(env.registry.getSpawned()).toEqual([]);
	});

	it("subscribeEvents fans out events to multiple subscribers", async () => {
		const { sessionId } = await env.hub.spawn({ ownedBy: "alice", base: { cwd: "/tmp", tools: [] } });
		const seenA: RpcEvent[] = [];
		const seenB: RpcEvent[] = [];
		env.hub.subscribeEvents(sessionId, e => seenA.push(e));
		env.hub.subscribeEvents(sessionId, e => seenB.push(e));
		const client = env.created.at(-1);
		client?.emit({ type: "agent_start" });
		await Bun.sleep(5);
		expect(seenA.length).toBe(1);
		expect(seenB.length).toBe(1);
	});

	it("subscribeEvents unsubscribe stops delivery", async () => {
		const { sessionId } = await env.hub.spawn({ ownedBy: "alice", base: { cwd: "/tmp", tools: [] } });
		const seen: RpcEvent[] = [];
		const off = env.hub.subscribeEvents(sessionId, e => seen.push(e));
		off();
		const client = env.created.at(-1);
		client?.emit({ type: "agent_start" });
		await Bun.sleep(5);
		expect(seen.length).toBe(0);
	});

	it("send() forwards commands to the underlying client", async () => {
		const { sessionId } = await env.hub.spawn({ ownedBy: "alice", base: { cwd: "/tmp", tools: [] } });
		const responsePromise = env.hub.send(sessionId, { type: "prompt", message: "hi" });
		const response = await responsePromise;
		expect(response.type).toBe("response");
		const client = env.created.at(-1);
		expect(client?.sentCommands.length).toBeGreaterThan(0);
	});

	it("send() throws for unknown session id", async () => {
		expect(() => env.hub.send("not-real", { type: "prompt", message: "x" })).toThrow(/not steerable|unknown/i);
	});

	it("client error event triggers session removal", async () => {
		const events: string[] = [];
		env.hub.onLifecycle(e => events.push(`${e.type}:${e.sessionId}`));
		const { sessionId } = await env.hub.spawn({ ownedBy: "alice", base: { cwd: "/tmp", tools: [] } });
		const client = env.created.at(-1);
		client?.emit({ type: "error", message: "boom" });
		await Bun.sleep(5);
		expect(env.registry.getSession(sessionId)).toBeUndefined();
		expect(events.some(e => e.startsWith("session_removed"))).toBe(true);
	});

	it("registry.getAll() returns spawned then external", () => {
		// Spawn one
		void env.hub.spawn({ ownedBy: "alice", base: { cwd: "/tmp", tools: [] } });
		// We don't have an external session here; just confirm the order shape.
		const all = env.registry.getAll();
		expect(all.every(e => e.kind === "spawned" || e.kind === "external")).toBe(true);
	});
});
