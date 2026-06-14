import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { SessionBridgeClient } from "../../src/session-bridge/client";

// FEAT-815: the client's duplex rpc_request → rpc_response wiring. Mirrors the
// inject-input client test; a mini bridge server pushes rpc_request frames and
// captures the rpc_response the client emits.

interface MiniBridgeServer {
	socketPath: string;
	receivedLines: string[];
	push: (obj: unknown) => void;
	stop: () => Promise<void>;
}

async function startMiniBridge(): Promise<MiniBridgeServer> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spell-rpc-client-"));
	const socketPath = path.join(tmpDir, "bridge.sock");
	const receivedLines: string[] = [];
	const sockets: net.Socket[] = [];
	let latest: net.Socket | undefined;
	const server = net.createServer(socket => {
		sockets.push(socket);
		latest = socket;
		let buffer = "";
		socket.on("data", chunk => {
			buffer += chunk.toString();
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				receivedLines.push(line);
				try {
					const msg = JSON.parse(line) as { type?: string };
					if (msg.type === "register") {
						socket.write(
							`${JSON.stringify({ type: "registered", timestamp: Date.now(), serverVersion: "0.0.0-test", registeredAt: Date.now() })}\n`,
						);
					}
				} catch {
					// ignore
				}
				nl = buffer.indexOf("\n");
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});
	return {
		socketPath,
		receivedLines,
		push(obj: unknown) {
			latest?.write(`${JSON.stringify(obj)}\n`);
		},
		async stop() {
			for (const s of sockets) s.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
			try {
				await fs.unlink(socketPath);
			} catch {
				// best-effort
			}
		},
	};
}

interface RpcResponseLine {
	type: string;
	requestId: string;
	response: { type: string; command: string; success: boolean; data?: unknown; error?: string };
}

describe("SessionBridgeClient onRpcRequest", () => {
	let bridge: MiniBridgeServer;

	beforeEach(async () => {
		bridge = await startMiniBridge();
	});
	afterEach(async () => {
		await bridge.stop();
	});

	function makeClient(): SessionBridgeClient {
		return new SessionBridgeClient({
			socketPath: bridge.socketPath,
			sessionId: "client-rpc",
			pid: process.pid,
			cwd: "/tmp",
			mode: "interactive",
			startedAt: Date.now(),
			projectName: "x",
		});
	}

	async function waitForResponse(timeoutMs = 1000): Promise<RpcResponseLine> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const line = bridge.receivedLines.find(l => l.includes('"rpc_response"'));
			if (line) return JSON.parse(line) as RpcResponseLine;
			await Bun.sleep(10);
		}
		throw new Error("timed out waiting for rpc_response");
	}

	it("runs the handler and replies with its result, correlated by requestId", async () => {
		const client = makeClient();
		expect(await client.connect()).toBe(true);
		const seen: string[] = [];
		client.onRpcRequest(async command => {
			seen.push(command.type);
			return { type: "response", command: command.type, success: true, data: { ok: 1 } };
		});

		bridge.push({ type: "rpc_request", timestamp: Date.now(), requestId: "r1", command: { type: "edit_history" } });

		const res = await waitForResponse();
		expect(res.requestId).toBe("r1");
		expect(res.response.success).toBe(true);
		expect(res.response.data).toEqual({ ok: 1 });
		expect(seen).toEqual(["edit_history"]);
		client.dispose();
	});

	it("replies no_rpc_handler when none registered", async () => {
		const client = makeClient();
		await client.connect();
		bridge.push({ type: "rpc_request", timestamp: Date.now(), requestId: "r2", command: { type: "undo" } });
		const res = await waitForResponse();
		expect(res.requestId).toBe("r2");
		expect(res.response.success).toBe(false);
		expect(res.response.error).toBe("no_rpc_handler");
		client.dispose();
	});

	it("captures a thrown handler error into the response", async () => {
		const client = makeClient();
		await client.connect();
		client.onRpcRequest(async () => {
			throw new Error("kernel_unavailable");
		});
		bridge.push({ type: "rpc_request", timestamp: Date.now(), requestId: "r3", command: { type: "code_query", target: "x" } });
		const res = await waitForResponse();
		expect(res.requestId).toBe("r3");
		expect(res.response.success).toBe(false);
		expect(res.response.error).toBe("kernel_unavailable");
		client.dispose();
	});
});
