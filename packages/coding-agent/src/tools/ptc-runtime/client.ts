/**
 * PtcRuntimeClient — Node half of the Spell ↔ BEAM bridge.
 *
 * Owns a long-lived BEAM runtime (one per session) and speaks bidirectional
 * JSON-RPC 2.0 over NDJSON. See `beam/ptc_runtime/lib/ptc_runtime/peer.ex` for
 * the BEAM counterpart and the full protocol description.
 *
 * ## Two frame directions
 *
 *   * **Outbound requests** (Node → BEAM): `init`, `execute`. We allocate the
 *     `id`, send, and resolve a promise when the matching response returns.
 *   * **Inbound requests** (BEAM → Node): `tool_call`. The runtime issues these
 *     *while we await an `execute`* — when a PTC-Lisp program reaches a
 *     `(tool/...)` form. We service each via the injected `onToolCall` handler
 *     and reply with a response frame carrying the same `id`. Many may be in
 *     flight at once (pmap fan-out), so handlers run concurrently and replies
 *     are correlated purely by id.
 *
 * The two directions never share an id-space: a frame with `method` is a
 * request, a frame with `result`/`error` is a response. We track only the ids
 * *we* originate; ids the BEAM originates are echoed straight back.
 *
 * ## Transport abstraction
 *
 * The client is decoupled from `child_process` via the `Transport` interface
 * (write a line; receive lines; observe exit). `spawnTransport()` provides the
 * real process-backed transport; tests inject a fake to drive the protocol
 * deterministically without a BEAM.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { type SpawnPlan, resolveSpawn, type ResolveSpawnOptions } from "./spawn";

// ============================================================================
// Protocol frame types
// ============================================================================

interface RequestFrame {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: unknown;
}

interface ResponseFrame {
	jsonrpc: "2.0";
	id: number;
	result?: unknown;
	error?: JsonRpcError;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

type InboundFrame = (RequestFrame | ResponseFrame) & Record<string, unknown>;

/** A reentrant tool_call from the BEAM. */
export interface ToolCallRequest {
	tool: string;
	args: Record<string, unknown>;
}

/** Services a BEAM-originated tool_call; resolves with the tool's value. */
export type ToolCallHandler = (req: ToolCallRequest) => Promise<unknown>;

/** Parameters for an `execute` request. */
export interface ExecuteParams {
	program: string;
	context?: Record<string, unknown>;
	signature?: string;
	timeoutMs?: number;
}

/** Catalog handed to the runtime at `init`. */
export interface Catalog {
	tools: Array<{ name: string; signature?: string; effect?: string; description?: string }>;
	providers?: Array<{ alias: string; model: string }>;
}

// ============================================================================
// Transport
// ============================================================================

/** Line-oriented bidirectional transport (NDJSON framing handled by client). */
export interface Transport {
	/** Write one complete line (the client appends no newline; do it here). */
	writeLine(line: string): void;
	/** Register the line consumer. Called once. */
	onLine(cb: (line: string) => void): void;
	/** Register the exit/close observer. Called once. */
	onClose(cb: (info: { code: number | null; signal: string | null }) => void): void;
	/** Terminate the transport (kill the process / close streams). */
	close(): void;
}

// ============================================================================
// Client
// ============================================================================

/** Raised when the runtime returns a JSON-RPC error for one of our requests. */
export class PtcRuntimeError extends Error {
	readonly code: number;
	readonly data: unknown;
	constructor(err: JsonRpcError) {
		super(err.message);
		this.name = "PtcRuntimeError";
		this.code = err.code;
		this.data = err.data;
	}
}

export interface PtcRuntimeClientOptions {
	transport: Transport;
	/** Services reentrant tool_call requests from the runtime. */
	onToolCall: ToolCallHandler;
	/** Optional diagnostic sink for protocol-level warnings. */
	onWarn?: (msg: string) => void;
}

export class PtcRuntimeClient {
	private readonly transport: Transport;
	private readonly onToolCall: ToolCallHandler;
	private readonly onWarn: (msg: string) => void;

	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private buffer = "";
	private closed = false;
	private closeReason: Error | null = null;

	constructor(opts: PtcRuntimeClientOptions) {
		this.transport = opts.transport;
		this.onToolCall = opts.onToolCall;
		this.onWarn = opts.onWarn ?? (() => {});

		this.transport.onLine(line => this.onData(line));
		this.transport.onClose(info => this.onClosed(info));
	}

	/** Hydrate the runtime with the tool + provider catalog. */
	async init(catalog: Catalog): Promise<{ tools: string[] }> {
		const result = (await this.request("init", { catalog })) as { tools?: string[] };
		return { tools: result.tools ?? [] };
	}

	/** Run a PTC-Lisp program; resolve with its (signature-validated) value. */
	async execute(params: ExecuteParams): Promise<unknown> {
		return this.request("execute", {
			program: params.program,
			context: params.context,
			signature: params.signature,
			timeout_ms: params.timeoutMs,
		});
	}

	/** Terminate the runtime and reject all in-flight requests. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.closeReason ??= new Error("PtcRuntime client closed");
		this.rejectAllPending(this.closeReason);
		this.transport.close();
	}

	// ----- outbound request/response correlation -----

	private request(method: string, params: unknown): Promise<unknown> {
		if (this.closed) {
			return Promise.reject(this.closeReason ?? new Error("PtcRuntime client closed"));
		}
		const id = this.nextId++;
		const frame: RequestFrame = { jsonrpc: "2.0", id, method, params };
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.transport.writeLine(JSON.stringify(frame));
		});
	}

	// ----- inbound dispatch -----

	private onData(line: string): void {
		const trimmed = line.trim();
		if (trimmed === "") return;

		let frame: InboundFrame;
		try {
			frame = JSON.parse(trimmed) as InboundFrame;
		} catch {
			this.onWarn(`PtcRuntime: dropped unparseable frame: ${trimmed.slice(0, 200)}`);
			return;
		}

		// Request from BEAM (has method) → service it.
		if (typeof (frame as RequestFrame).method === "string") {
			void this.handleInboundRequest(frame as RequestFrame);
			return;
		}

		// Response to one of our requests.
		this.handleResponse(frame as ResponseFrame);
	}

	private handleResponse(frame: ResponseFrame): void {
		const entry = this.pending.get(frame.id);
		if (!entry) {
			this.onWarn(`PtcRuntime: response for unknown id ${frame.id}`);
			return;
		}
		this.pending.delete(frame.id);
		if (frame.error) {
			entry.reject(new PtcRuntimeError(frame.error));
		} else {
			entry.resolve(frame.result);
		}
	}

	private async handleInboundRequest(frame: RequestFrame): Promise<void> {
		if (frame.method !== "tool_call") {
			this.respondError(frame.id, -32601, `unknown method: ${frame.method}`);
			return;
		}

		const params = (frame.params ?? {}) as Partial<ToolCallRequest>;
		const tool = params.tool;
		if (typeof tool !== "string") {
			this.respondError(frame.id, -32602, "tool_call missing 'tool'");
			return;
		}

		try {
			const value = await this.onToolCall({ tool, args: params.args ?? {} });
			this.respondResult(frame.id, value);
		} catch (e) {
			this.respondError(frame.id, -32000, e instanceof Error ? e.message : String(e));
		}
	}

	private respondResult(id: number, result: unknown): void {
		if (this.closed) return;
		this.transport.writeLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
	}

	private respondError(id: number, code: number, message: string): void {
		if (this.closed) return;
		this.transport.writeLine(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
	}

	// ----- lifecycle -----

	private onClosed(info: { code: number | null; signal: string | null }): void {
		if (this.closed) return;
		this.closed = true;
		this.closeReason = new Error(
			`PtcRuntime exited (code=${info.code ?? "null"}, signal=${info.signal ?? "null"})`,
		);
		this.rejectAllPending(this.closeReason);
	}

	private rejectAllPending(err: Error): void {
		for (const { reject } of this.pending.values()) reject(err);
		this.pending.clear();
	}
}

// ============================================================================
// Process-backed transport
// ============================================================================

/** Spawn the BEAM runtime and adapt its stdio to the Transport interface. */
export function spawnTransport(opts: ResolveSpawnOptions = {}): { transport: Transport; plan: SpawnPlan } {
	const plan = resolveSpawn(opts);
	const child: ChildProcessWithoutNullStreams = spawn(plan.command, plan.args, {
		cwd: plan.cwd,
		env: { ...process.env, ...plan.env },
		stdio: ["pipe", "pipe", "pipe"],
	}) as ChildProcessWithoutNullStreams;

	// stderr is for diagnostics only — never protocol. Surface it to nowhere by
	// default (the BEAM logs to a file); callers may attach a listener.
	child.stderr.resume();

	let buffer = "";
	let lineCb: ((line: string) => void) | null = null;
	let closeCb: ((info: { code: number | null; signal: string | null }) => void) | null = null;
	let closed = false;

	const fireClose = (info: { code: number | null; signal: string | null }): void => {
		if (closed) return;
		closed = true;
		closeCb?.(info);
	};

	// A spawn failure (ENOENT when `mix`/binary is absent, EACCES, etc.) emits
	// 'error', NOT 'close'. Without this handler Node would (1) re-throw the
	// EventEmitter error and crash, and (2) never run onClose → the init()/
	// execute() promise would hang forever (Review Gate 0, P1). Route spawn
	// errors into the close path so pending requests reject cleanly.
	child.on("error", () => fireClose({ code: null, signal: null }));

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let nl: number;
		// Drain complete lines; keep the partial tail buffered.
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (lineCb && line.length > 0) lineCb(line);
		}
	});

	const transport: Transport = {
		writeLine(line: string): void {
			child.stdin.write(`${line}\n`);
		},
		onLine(cb): void {
			lineCb = cb;
		},
		onClose(cb): void {
			closeCb = cb;
			child.on("close", (code, signal) => fireClose({ code, signal }));
		},
		close(): void {
			child.kill("SIGTERM");
		},
	};

	return { transport, plan };
}
