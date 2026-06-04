import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { SocketServer } from "../../src/socket/server";
import { SocketSessionRegistry } from "../../src/socket/session-registry";
import type {
	BlockingEventPayload,
	EventResponsePayload,
	RegisteredSocketServerMessage,
	SocketClientMessage,
	SocketServerMessage,
} from "../../src/socket/types";

/** Minimal client for testing - connects to a Unix domain socket and speaks JSON lines. */
class TestSocketClient {
	#socket: net.Socket | null = null;
	#buffer = "";
	#messages: SocketServerMessage[] = [];
	#waiters: Array<{ resolve: (msg: SocketServerMessage) => void }> = [];

	async connect(socketPath: string): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const socket = net.connect({ path: socketPath });
		socket.once("connect", () => {
			socket.off("error", reject);
			resolve();
		});
		socket.once("error", reject);
		socket.on("data", (chunk: Buffer) => {
			this.#buffer += chunk.toString();
			const lines = this.#buffer.split("\n");
			this.#buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const parsed = JSON.parse(trimmed) as SocketServerMessage;
					const waiter = this.#waiters.shift();
					if (waiter) {
						waiter.resolve(parsed);
					} else {
						this.#messages.push(parsed);
					}
				} catch {
					// ignore invalid JSON in tests
				}
			}
		});
		this.#socket = socket;
		await promise;
	}

	send(msg: SocketClientMessage): void {
		if (!this.#socket) throw new Error("Not connected");
		this.#socket.write(`${JSON.stringify(msg)}\n`);
	}

	async nextMessage(timeoutMs = 2000): Promise<SocketServerMessage> {
		const buffered = this.#messages.shift();
		if (buffered) return buffered;

		const { promise, resolve } = Promise.withResolvers<SocketServerMessage>();
		this.#waiters.push({ resolve });
		const timeout = setTimeout(() => {
			const idx = this.#waiters.findIndex(w => w.resolve === resolve);
			if (idx !== -1) this.#waiters.splice(idx, 1);
			resolve({ type: "event_cancelled", eventId: "__timeout__", timestamp: 0 } as SocketServerMessage);
		}, timeoutMs);

		const msg = await promise;
		clearTimeout(timeout);
		return msg;
	}

	destroy(): void {
		this.#socket?.destroy();
		this.#socket = null;
	}

	rawWrite(data: string): void {
		if (!this.#socket) throw new Error("Not connected");
		this.#socket.write(data);
	}
}

function tmpSocketPath(): string {
	return path.join(os.tmpdir(), `spell-test-${process.pid}-${Date.now()}.sock`);
}

describe("socket server integration", () => {
	let socketPath: string;
	let registry: SocketSessionRegistry;
	let server: SocketServer;
	let clients: TestSocketClient[];

	beforeEach(async () => {
		socketPath = tmpSocketPath();
		registry = new SocketSessionRegistry();
		server = new SocketServer(socketPath, registry);
		clients = [];
		await server.start();
	});

	afterEach(async () => {
		for (const client of clients) {
			client.destroy();
		}
		await server.stop();
		try {
			await fs.unlink(socketPath);
		} catch {
			// already cleaned up
		}
	});

	function createClient(): TestSocketClient {
		const client = new TestSocketClient();
		clients.push(client);
		return client;
	}

	it("registers a session and receives acknowledgement", async () => {
		const client = createClient();
		await client.connect(socketPath);

		client.send({
			type: "register",
			timestamp: Date.now(),
			sessionId: "test-session-1",
			pid: process.pid,
			cwd: "/tmp/project",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "test-project",
		});

		const response = await client.nextMessage();
		expect(response.type).toBe("registered");
		expect((response as RegisteredSocketServerMessage).serverVersion).toBeDefined();

		const sessions = registry.getActive();
		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe("test-session-1");
		expect(sessions[0].cwd).toBe("/tmp/project");
		expect(sessions[0].mode).toBe("interactive");
	});

	it("deregisters a session on deregister message", async () => {
		const client = createClient();
		await client.connect(socketPath);

		client.send({
			type: "register",
			timestamp: Date.now(),
			sessionId: "test-session-2",
			pid: process.pid,
			cwd: "/tmp/project",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "test-project",
		});

		await client.nextMessage(); // registered ack

		expect(registry.getActive()).toHaveLength(1);

		client.send({ type: "deregister", timestamp: Date.now() });

		// Wait a tick for the message to process
		await Bun.sleep(50);

		expect(registry.getActive()).toHaveLength(0);
	});

	it("tracks blocking events and allows remote resolution", async () => {
		const client = createClient();
		await client.connect(socketPath);

		const sessionId = "test-session-3";
		client.send({
			type: "register",
			timestamp: Date.now(),
			sessionId,
			pid: process.pid,
			cwd: "/tmp/project",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "test-project",
		});
		await client.nextMessage(); // registered ack

		// Emit a plan_approval blocking event
		const eventPayload: BlockingEventPayload = {
			kind: "plan_approval",
			eventId: "evt-1",
			title: "AUTH_REFACTOR",
			itemId: "PLAN-001",
			planSummary: "Refactor auth module",
			selectorOptions: ["Approve and execute", "Refine plan", "Stay in plan mode"],
		};

		// Set up blocking event listener
		const receivedEvents: Array<{ sessionId: string; event: BlockingEventPayload }> = [];
		registry.onBlockingEvent((sid, evt) => receivedEvents.push({ sessionId: sid, event: evt }));

		client.send({
			type: "blocking_event",
			timestamp: Date.now(),
			payload: eventPayload,
		});

		// Wait for server to process
		await Bun.sleep(50);

		// Verify registry tracks the blocked session
		const blocked = registry.getBlocked();
		expect(blocked).toHaveLength(1);
		expect(blocked[0].sessionId).toBe(sessionId);
		expect(blocked[0].currentBlockingEvent?.kind).toBe("plan_approval");

		// Verify blocking event handler was called
		expect(receivedEvents).toHaveLength(1);
		expect(receivedEvents[0].event.kind).toBe("plan_approval");

		// Simulate Telegram response: resolve the event
		const responsePayload: EventResponsePayload = {
			kind: "plan_approval",
			selectedOption: "Approve and execute",
		};
		registry.resolveEvent(sessionId, "evt-1", responsePayload);

		// Client should receive the response
		const clientMsg = await client.nextMessage();
		expect(clientMsg.type).toBe("event_response");
		if (clientMsg.type === "event_response") {
			expect(clientMsg.eventId).toBe("evt-1");
			expect(clientMsg.payload.kind).toBe("plan_approval");
			if (clientMsg.payload.kind === "plan_approval") {
				expect(clientMsg.payload.selectedOption).toBe("Approve and execute");
			}
		}

		// Verify session is no longer blocked
		expect(registry.getBlocked()).toHaveLength(0);
	});

	it("handles ask event with remote answer", async () => {
		const client = createClient();
		await client.connect(socketPath);

		const sessionId = "test-session-4";
		client.send({
			type: "register",
			timestamp: Date.now(),
			sessionId,
			pid: process.pid,
			cwd: "/tmp/project",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "test-project",
		});
		await client.nextMessage();

		const askPayload: BlockingEventPayload = {
			kind: "ask",
			eventId: "evt-ask-1",
			questions: [
				{
					id: "auth",
					question: "Which authentication method?",
					options: [{ label: "JWT" }, { label: "OAuth2" }, { label: "Session cookies" }],
					recommended: 0,
				},
			],
		};

		client.send({
			type: "blocking_event",
			timestamp: Date.now(),
			payload: askPayload,
		});

		await Bun.sleep(50);

		// Resolve with answer
		registry.resolveEvent(sessionId, "evt-ask-1", {
			kind: "ask",
			answers: [{ questionId: "auth", selectedIndices: [1] }],
		});

		const response = await client.nextMessage();
		expect(response.type).toBe("event_response");
		if (response.type === "event_response") {
			expect(response.payload.kind).toBe("ask");
			if (response.payload.kind === "ask") {
				expect(response.payload.answers[0].questionId).toBe("auth");
				expect(response.payload.answers[0].selectedIndices).toEqual([1]);
			}
		}
	});

	it("cleans up session on client disconnect", async () => {
		const client = createClient();
		await client.connect(socketPath);

		client.send({
			type: "register",
			timestamp: Date.now(),
			sessionId: "test-session-5",
			pid: process.pid,
			cwd: "/tmp/project",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "test-project",
		});
		await client.nextMessage();
		expect(registry.getActive()).toHaveLength(1);

		// Disconnect the client
		client.destroy();

		// Wait for close event propagation
		await Bun.sleep(100);

		expect(registry.getActive()).toHaveLength(0);
	});

	it("cancels pending events when session disconnects", async () => {
		const client = createClient();
		await client.connect(socketPath);

		const sessionId = "test-session-6";
		client.send({
			type: "register",
			timestamp: Date.now(),
			sessionId,
			pid: process.pid,
			cwd: "/tmp/project",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "test-project",
		});
		await client.nextMessage();

		// Emit blocking event
		client.send({
			type: "blocking_event",
			timestamp: Date.now(),
			payload: {
				kind: "plan_approval",
				eventId: "evt-disconnect",
				title: "TEST",
				itemId: "PLAN-001",
				planSummary: "Test",
				selectorOptions: ["Approve"],
			},
		});

		await Bun.sleep(50);
		expect(registry.getBlocked()).toHaveLength(1);

		// Disconnect client
		client.destroy();
		await Bun.sleep(100);

		// Session and blocking event should be cleared
		expect(registry.getActive()).toHaveLength(0);
		expect(registry.getBlocked()).toHaveLength(0);
	});

	it("tracks multiple sessions independently", async () => {
		const client1 = createClient();
		const client2 = createClient();
		await client1.connect(socketPath);
		await client2.connect(socketPath);

		client1.send({
			type: "register",
			timestamp: Date.now(),
			sessionId: "session-A",
			pid: process.pid,
			cwd: "/tmp/project-a",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "project-a",
		});

		client2.send({
			type: "register",
			timestamp: Date.now(),
			sessionId: "session-B",
			pid: process.pid,
			cwd: "/tmp/project-b",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "project-b",
		});

		await client1.nextMessage();
		await client2.nextMessage();

		expect(registry.getActive()).toHaveLength(2);

		// Disconnect one
		client1.destroy();
		await Bun.sleep(100);

		const remaining = registry.getActive();
		expect(remaining).toHaveLength(1);
		expect(remaining[0].sessionId).toBe("session-B");
	});

	it("updates heartbeat timestamp", async () => {
		const client = createClient();
		await client.connect(socketPath);

		client.send({
			type: "register",
			timestamp: Date.now(),
			sessionId: "test-session-hb",
			pid: process.pid,
			cwd: "/tmp/project",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "test-project",
		});
		await client.nextMessage();

		const beforeHeartbeat = registry.getSession("test-session-hb")?.lastHeartbeat ?? 0;

		await Bun.sleep(10);

		client.send({
			type: "heartbeat",
			timestamp: Date.now(),
			status: "active",
		});

		await Bun.sleep(50);

		const afterHeartbeat = registry.getSession("test-session-hb")?.lastHeartbeat ?? 0;
		expect(afterHeartbeat).toBeGreaterThan(beforeHeartbeat);
	});

	it("cancels event via registry.cancelEvent", async () => {
		const client = createClient();
		await client.connect(socketPath);

		const sessionId = "test-session-cancel";
		client.send({
			type: "register",
			timestamp: Date.now(),
			sessionId,
			pid: process.pid,
			cwd: "/tmp/project",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "test-project",
		});
		await client.nextMessage();

		client.send({
			type: "blocking_event",
			timestamp: Date.now(),
			payload: {
				kind: "plan_approval",
				eventId: "evt-cancel-1",
				title: "TEST",
				itemId: "PLAN-001",
				planSummary: "Test",
				selectorOptions: ["Approve"],
			},
		});

		await Bun.sleep(50);

		registry.cancelEvent(sessionId, "evt-cancel-1", "Dismissed via Telegram");

		const response = await client.nextMessage();
		expect(response.type).toBe("event_cancelled");
		if (response.type === "event_cancelled") {
			expect(response.eventId).toBe("evt-cancel-1");
			expect(response.reason).toBe("Dismissed via Telegram");
		}
	});

	it("injects a remote message and resolves on inject_ack", async () => {
		const client = createClient();
		await client.connect(socketPath);

		const sessionId = "test-session-inject";
		client.send({
			type: "register",
			timestamp: Date.now(),
			sessionId,
			pid: process.pid,
			cwd: "/tmp/project",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "test-project",
		});
		await client.nextMessage(); // registered ack

		// Server injects a free-form steering message.
		const injectPromise = registry.injectMessage(sessionId, { text: "run the tests", deliverAs: "steer" });

		// Client receives the inject_input frame and acks it.
		const injected = await client.nextMessage();
		expect(injected.type).toBe("inject_input");
		if (injected.type !== "inject_input") throw new Error("expected inject_input");
		expect(injected.text).toBe("run the tests");
		expect(injected.deliverAs).toBe("steer");

		client.send({ type: "inject_ack", timestamp: Date.now(), injectId: injected.injectId, accepted: true });

		const result = await injectPromise;
		expect(result.accepted).toBe(true);
	});

	it("inject to unknown session is rejected", async () => {
		const result = await registry.injectMessage("nope", { text: "hi", deliverAs: "auto" });
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("unknown_session");
	});

	it("resolves pending inject as rejected on disconnect", async () => {
		const client = createClient();
		await client.connect(socketPath);
		const sessionId = "test-session-inject-drop";
		client.send({
			type: "register",
			timestamp: Date.now(),
			sessionId,
			pid: process.pid,
			cwd: "/tmp/project",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "test-project",
		});
		await client.nextMessage();

		const injectPromise = registry.injectMessage(sessionId, { text: "hello", deliverAs: "auto" });
		await client.nextMessage(); // inject_input frame
		client.destroy();
		await Bun.sleep(100);
		const result = await injectPromise;
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("deregistered");
	});

	it("handles malformed JSON gracefully", async () => {
		const client = createClient();
		await client.connect(socketPath);

		// Send garbage via rawWrite — this actually writes to the underlying socket
		client.rawWrite("not json\n");

		// The client should still be functional - register after the bad line
		client.send({
			type: "register",
			timestamp: Date.now(),
			sessionId: "test-session-robust",
			pid: process.pid,
			cwd: "/tmp/project",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "test-project",
		});

		const response = await client.nextMessage();
		expect(response.type).toBe("registered");
	});
});

describe("session registry standalone", () => {
	it("cleanupStale removes entries with dead PIDs", () => {
		const registry = new SocketSessionRegistry();
		const fakeSocket = new net.Socket();

		// Register with a PID that definitely doesn't exist
		registry.register(
			"stale-session",
			{
				pid: 999999999,
				cwd: "/tmp/stale",
				mode: "interactive",
				startedAt: Date.now(),
				projectName: "stale",
			},
			fakeSocket,
		);

		expect(registry.getActive()).toHaveLength(1);

		registry.cleanupStale();

		expect(registry.getActive()).toHaveLength(0);
		fakeSocket.destroy();
	});

	it("getBlocked returns only sessions with blocking events", () => {
		const registry = new SocketSessionRegistry();
		const socket1 = new net.Socket();
		const socket2 = new net.Socket();

		registry.register(
			"active-session",
			{ pid: process.pid, cwd: "/a", mode: "interactive", startedAt: Date.now(), projectName: "a" },
			socket1,
		);
		registry.register(
			"blocked-session",
			{ pid: process.pid, cwd: "/b", mode: "interactive", startedAt: Date.now(), projectName: "b" },
			socket2,
		);

		registry.setBlockingEvent("blocked-session", {
			kind: "ask",
			eventId: "evt-1",
			questions: [{ id: "q1", question: "Test?", options: [{ label: "Yes" }] }],
		});

		const blocked = registry.getBlocked();
		expect(blocked).toHaveLength(1);
		expect(blocked[0].sessionId).toBe("blocked-session");

		socket1.destroy();
		socket2.destroy();
	});
});
