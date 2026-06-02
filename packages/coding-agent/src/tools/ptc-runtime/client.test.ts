/**
 * Unit tests for PtcRuntimeClient over a fake transport.
 *
 * These drive the JSON-RPC protocol deterministically without a BEAM, so they
 * pin the Node-side framing, request/response correlation, and — critically —
 * the reentrant inbound tool_call path. A real-BEAM integration test lives in
 * `client.integration.test.ts` (gated on a built runtime).
 */

import { describe, expect, it } from "bun:test";
import { type Catalog, PtcRuntimeClient, PtcRuntimeError, type ToolCallHandler, type Transport } from "./client";

/** A controllable in-memory transport that plays the BEAM peer. */
class FakeTransport implements Transport {
	sent: string[] = [];
	private lineCb: ((line: string) => void) | null = null;
	private closeCb: ((info: { code: number | null; signal: string | null }) => void) | null = null;

	writeLine(line: string): void {
		this.sent.push(line);
	}
	onLine(cb: (line: string) => void): void {
		this.lineCb = cb;
	}
	onClose(cb: (info: { code: number | null; signal: string | null }) => void): void {
		this.closeCb = cb;
	}
	close(): void {
		this.closeCb?.({ code: 0, signal: null });
	}

	/** Simulate the BEAM emitting a frame to Node. */
	emit(frame: unknown): void {
		this.lineCb?.(JSON.stringify(frame));
	}
	/** Simulate process exit. */
	exit(code: number | null, signal: string | null): void {
		this.closeCb?.({ code, signal });
	}
	/** Parse the Nth frame Node sent. */
	parseSent(i: number): Record<string, unknown> {
		return JSON.parse(this.sent[i]) as Record<string, unknown>;
	}
	last(): Record<string, unknown> {
		return this.parseSent(this.sent.length - 1);
	}
}

const noToolCalls: ToolCallHandler = async () => {
	throw new Error("unexpected tool_call");
};

function mk(onToolCall: ToolCallHandler = noToolCalls): { client: PtcRuntimeClient; t: FakeTransport } {
	const t = new FakeTransport();
	const client = new PtcRuntimeClient({ transport: t, onToolCall });
	return { client, t };
}

describe("init", () => {
	it("sends an init request and resolves with tool names", async () => {
		const { client, t } = mk();
		const catalog: Catalog = { tools: [{ name: "find" }, { name: "org" }] };
		const p = client.init(catalog);

		const sent = t.last();
		expect(sent.method).toBe("init");
		expect((sent.params as { catalog: Catalog }).catalog.tools).toHaveLength(2);

		t.emit({ jsonrpc: "2.0", id: sent.id, result: { ok: true, tools: ["find", "org"] } });
		await expect(p).resolves.toEqual({ tools: ["find", "org"] });
	});
});

describe("execute", () => {
	it("round-trips a value", async () => {
		const { client, t } = mk();
		const p = client.execute({ program: "(+ 1 2)" });
		const sent = t.last();
		expect(sent.method).toBe("execute");
		expect((sent.params as { program: string }).program).toBe("(+ 1 2)");

		t.emit({ jsonrpc: "2.0", id: sent.id, result: 3 });
		await expect(p).resolves.toBe(3);
	});

	it("maps a JSON-RPC error to PtcRuntimeError", async () => {
		const { client, t } = mk();
		const p = client.execute({ program: "(boom)" });
		const id = t.last().id;
		t.emit({ jsonrpc: "2.0", id, error: { code: -32002, message: "execution failed", data: { reason: "x" } } });

		await expect(p).rejects.toBeInstanceOf(PtcRuntimeError);
		await p.catch((e: PtcRuntimeError) => {
			expect(e.code).toBe(-32002);
			expect(e.data).toEqual({ reason: "x" });
		});
	});

	it("passes context, signature, timeout through", async () => {
		const { client, t } = mk();
		void client.execute({ program: "x", context: { a: 1 }, signature: "{a :int}", timeoutMs: 500 });
		const params = t.last().params as Record<string, unknown>;
		expect(params.context).toEqual({ a: 1 });
		expect(params.signature).toBe("{a :int}");
		expect(params.timeout_ms).toBe(500);
	});
});

describe("re-init handshake (Review Gate 1, P2)", () => {
	it("replays init and retries when a previously-initialized runtime reports not-initialized", async () => {
		const { client, t } = mk();

		// Initial init.
		const initP = client.init({ tools: [{ name: "x" }] });
		t.emit({ jsonrpc: "2.0", id: t.last().id, result: { ok: true, tools: ["x"] } });
		await initP;

		// First execute hits a supervisor-restarted Peer → not_initialized.
		const execP = client.execute({ program: "(+ 1 1)" });
		const firstExecId = t.last().id;
		t.emit({ jsonrpc: "2.0", id: firstExecId, error: { code: -32001, message: "not initialized" } });
		await Promise.resolve();

		// Client should transparently replay init...
		const replayInit = t.last();
		expect(replayInit.method).toBe("init");
		t.emit({ jsonrpc: "2.0", id: replayInit.id, result: { ok: true, tools: ["x"] } });
		await Promise.resolve();

		// ...then retry the execute.
		const retryExec = t.last();
		expect(retryExec.method).toBe("execute");
		t.emit({ jsonrpc: "2.0", id: retryExec.id, result: 2 });
		await expect(execP).resolves.toBe(2);
	});

	it("does not retry when never initialized", async () => {
		const { client, t } = mk();
		const p = client.execute({ program: "(+ 1 1)" });
		t.emit({ jsonrpc: "2.0", id: t.last().id, error: { code: -32001, message: "not initialized" } });
		await expect(p).rejects.toBeInstanceOf(PtcRuntimeError);
	});
});

describe("reentrant tool_call", () => {
	it("services a BEAM-originated tool_call and replies with the result", async () => {
		const calls: Array<{ tool: string; args: unknown }> = [];
		const { client, t } = mk(async ({ tool, args }) => {
			calls.push({ tool, args });
			return { echoed: (args as { msg: string }).msg };
		});

		const p = client.execute({ program: "(tool/echo {:msg 'hi'})" });
		const execId = t.last().id;

		// BEAM asks Node to run the tool mid-execute.
		t.emit({ jsonrpc: "2.0", id: 99, method: "tool_call", params: { tool: "echo", args: { msg: "hi" } } });

		// Let the async handler resolve and write its response.
		await Promise.resolve();
		await Promise.resolve();

		const reply = t.parseSent(t.sent.length - 1);
		expect(reply.id).toBe(99);
		expect(reply.result).toEqual({ echoed: "hi" });
		expect(calls).toEqual([{ tool: "echo", args: { msg: "hi" } }]);

		// BEAM then completes the execute.
		t.emit({ jsonrpc: "2.0", id: execId, result: { echoed: "hi" } });
		await expect(p).resolves.toEqual({ echoed: "hi" });
	});

	it("replies with an error frame when the handler throws", async () => {
		const { client, t } = mk(async () => {
			throw new Error("tool blew up");
		});
		void client.execute({ program: "(tool/x {})" });
		t.emit({ jsonrpc: "2.0", id: 5, method: "tool_call", params: { tool: "x", args: {} } });
		await Promise.resolve();
		await Promise.resolve();

		const reply = t.parseSent(t.sent.length - 1);
		expect(reply.id).toBe(5);
		expect((reply.error as { message: string }).message).toContain("tool blew up");
	});

	it("services concurrent tool_calls (pmap fan-out) by id", async () => {
		const { client, t } = mk(async ({ args }) => {
			const n = (args as { n: number }).n;
			return n * n;
		});
		void client.execute({ program: "(pmap (fn [x] (tool/sq {:n x})) [1 2 3 4])" });

		for (let i = 1; i <= 4; i++) {
			t.emit({ jsonrpc: "2.0", id: 100 + i, method: "tool_call", params: { tool: "sq", args: { n: i } } });
		}
		// Flush microtasks.
		await new Promise(r => setTimeout(r, 0));

		const replies = t.sent
			.map(s => JSON.parse(s) as Record<string, unknown>)
			.filter(f => typeof f.id === "number" && (f.id as number) >= 101 && (f.id as number) <= 104);
		const byId = new Map(replies.map(r => [r.id, r.result]));
		expect(byId.get(101)).toBe(1);
		expect(byId.get(102)).toBe(4);
		expect(byId.get(103)).toBe(9);
		expect(byId.get(104)).toBe(16);
	});

	it("rejects unknown inbound methods", async () => {
		const { t } = mk();
		t.emit({ jsonrpc: "2.0", id: 7, method: "nonsense", params: {} });
		await Promise.resolve();
		const reply = t.last();
		expect((reply.error as { code: number }).code).toBe(-32601);
	});
});

describe("lifecycle", () => {
	it("rejects in-flight requests when the process exits", async () => {
		const { client, t } = mk();
		const p = client.execute({ program: "(+ 1 1)" });
		t.exit(1, null);
		await expect(p).rejects.toThrow(/exited/);
		void client;
	});

	it("rejects new requests after close()", async () => {
		const { client } = mk();
		client.close();
		await expect(client.execute({ program: "x" })).rejects.toThrow(/closed/);
	});

	it("rejects in-flight requests when the transport reports a spawn error via close", async () => {
		// Models the spawnTransport fix: a spawn 'error' is routed into onClose, so
		// pending requests reject instead of hanging forever (Review Gate 0, P1).
		const { client, t } = mk();
		const p = client.execute({ program: "(+ 1 1)" });
		t.exit(null, null); // spawn-error shape: code=null, signal=null
		await expect(p).rejects.toThrow(/exited/);
		void client;
	});

	it("drops unparseable frames without throwing", async () => {
		const warnings: string[] = [];
		const t = new FakeTransport();
		const client = new PtcRuntimeClient({ transport: t, onToolCall: noToolCalls, onWarn: m => warnings.push(m) });
		// emit() JSON.stringifies its argument, so feed the malformed line
		// straight through the line callback the client registered.
		(t as unknown as { lineCb: (l: string) => void }).lineCb("}{ not json");
		expect(warnings.some(w => w.includes("unparseable"))).toBe(true);
		void client;
	});
});
