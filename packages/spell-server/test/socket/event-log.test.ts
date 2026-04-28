import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { SocketServer } from "../../src/socket/server";
import { SocketSessionRegistry } from "../../src/socket/session-registry";
import type { EventLogEntry } from "../../src/socket/types";

async function waitFor<T>(check: () => T | undefined, timeoutMs = 1000, stepMs = 10): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = check();
		if (value !== undefined) return value;
		await Bun.sleep(stepMs);
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("socket event_log", () => {
	let socketPath: string;
	let server: SocketServer;
	let registry: SocketSessionRegistry;

	beforeEach(async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-evlog-"));
		socketPath = path.join(tmpDir, "server.sock");
		registry = new SocketSessionRegistry({ recentLogCap: 5 });
		server = new SocketServer(socketPath, registry);
		await server.start();
	});

	afterEach(async () => {
		await server.stop();
		try {
			await fs.unlink(socketPath);
		} catch {
			// already cleaned up
		}
	});

	async function connectAndRegister(sessionId: string): Promise<net.Socket> {
		const client = net.connect({ path: socketPath });
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		client.once("connect", () => resolve());
		client.once("error", reject);
		await promise;
		client.write(
			`${JSON.stringify({
				type: "register",
				timestamp: Date.now(),
				sessionId,
				pid: process.pid,
				cwd: "/tmp",
				mode: "interactive",
				startedAt: Date.now(),
				projectName: "x",
			})}\n`,
		);
		await waitFor(() => (registry.getSession(sessionId) ? true : undefined));
		return client;
	}

	it("appends event_log entries to the registry ring buffer", async () => {
		const client = await connectAndRegister("evlog-1");
		const entry: EventLogEntry = { kind: "tool_call", ts: Date.now(), toolName: "bash" };
		const seen: Array<[string, EventLogEntry]> = [];
		registry.onEventLog((sid, e) => seen.push([sid, e]));
		client.write(`${JSON.stringify({ type: "event_log", timestamp: Date.now(), entry })}\n`);
		await waitFor(() => (registry.getRecentLog("evlog-1").length > 0 ? true : undefined));
		expect(registry.getRecentLog("evlog-1")).toEqual([entry]);
		expect(seen).toEqual([["evlog-1", entry]]);
		client.destroy();
	});

	it("evicts oldest entries beyond the configured cap", async () => {
		const client = await connectAndRegister("evlog-2");
		for (let i = 0; i < 8; i += 1) {
			client.write(
				`${JSON.stringify({
					type: "event_log",
					timestamp: Date.now(),
					entry: { kind: "tool_call", ts: i, toolName: `t${i}` },
				})}\n`,
			);
		}
		await waitFor(() => (registry.getRecentLog("evlog-2").length === 5 ? true : undefined));
		const log = registry.getRecentLog("evlog-2");
		expect(log.length).toBe(5);
		// FIFO eviction keeps the 5 most recent (ts=3..7)
		expect(log.map(e => e.ts)).toEqual([3, 4, 5, 6, 7]);
		client.destroy();
	});

	it("getRecentLog returns a defensive copy", async () => {
		const client = await connectAndRegister("evlog-3");
		client.write(
			`${JSON.stringify({
				type: "event_log",
				timestamp: Date.now(),
				entry: { kind: "turn_start", ts: 1 },
			})}\n`,
		);
		await waitFor(() => (registry.getRecentLog("evlog-3").length > 0 ? true : undefined));
		const copy = registry.getRecentLog("evlog-3");
		copy.push({ kind: "error", ts: 99 });
		expect(registry.getRecentLog("evlog-3").length).toBe(1);
		client.destroy();
	});

	it("deregister clears the recent log", async () => {
		const client = await connectAndRegister("evlog-4");
		client.write(
			`${JSON.stringify({
				type: "event_log",
				timestamp: Date.now(),
				entry: { kind: "turn_start", ts: 1 },
			})}\n`,
		);
		await waitFor(() => (registry.getRecentLog("evlog-4").length > 0 ? true : undefined));
		client.write(`${JSON.stringify({ type: "deregister", timestamp: Date.now() })}\n`);
		await waitFor(() => (registry.getSession("evlog-4") === undefined ? true : undefined));
		expect(registry.getRecentLog("evlog-4")).toEqual([]);
		client.destroy();
	});
});
