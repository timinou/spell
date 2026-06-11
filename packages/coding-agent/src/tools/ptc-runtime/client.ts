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
import { type ResolveSpawnOptions, resolveSpawn, type SpawnPlan } from "./spawn";

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

/** Mirror of the BEAM peer's @code_not_initialized. */
const CODE_NOT_INITIALIZED = -32001;

type InboundFrame = (RequestFrame | ResponseFrame) & Record<string, unknown>;

/** A reentrant tool_call from the BEAM. */
export interface ToolCallRequest {
	tool: string;
	args: Record<string, unknown>;
	/**
	 * The originating execute's id (D3): binds this tool call to its program's
	 * transaction scope so write-effect calls enlist under the right program.
	 * Absent for callers that don't carry one (the wire stays clean).
	 */
	execId?: number;
}

/**
 * Services a BEAM-originated tool_call; resolves with the tool's value.
 *
 * `signal` aborts when EITHER the runtime tears down (client close / process
 * exit) OR the originating execute's signal fires — composed per-call so one
 * execute's cancellation never aborts another's in-flight tool_calls
 * (PLAN-324).
 */
export type ToolCallHandler = (req: ToolCallRequest, signal?: AbortSignal) => Promise<unknown>;

/** Parameters for an `execute` request. */
export interface ExecuteParams {
	program: string;
	context?: Record<string, unknown>;
	signature?: string;
	timeoutMs?: number;
	/**
	 * Sandbox heap ceiling in BEAM WORDS (1 word = 8 bytes — callers convert from
	 * MB at the boundary; FEAT-791). Omitted → the runtime's default (~50MB).
	 */
	maxHeapWords?: number;
	/** Session-store ceiling in BYTES (PATCH-5); omitted → runtime default. */
	sessionStoreBytes?: number;
	/** Aborts the tool_calls this execute issues (composed with the client signal). */
	signal?: AbortSignal;
	/**
	 * Called synchronously with the execute's wire id the instant it is allocated
	 * (D3). The id is the SAME value that tags this program's reentrant tool_calls
	 * (`exec_id`), so a caller can open a transaction scope keyed by it BEFORE the
	 * program issues its first write. Called once per attempt (a transparent
	 * re-init retry re-invokes it with the retry's id).
	 */
	onExecId?: (execId: number) => void;
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
	private _closed = false;
	private closeReason: Error | null = null;
	// Aborts when the runtime tears down (close / process exit); composed into
	// every tool_call signal so in-flight tool work stops promptly (PLAN-324).
	private readonly ownAbort = new AbortController();
	// execute request id → that execute's caller signal, so a reentrant tool_call
	// can be composed with the SIGNAL OF ITS OWN EXECUTE — never cross-aborting a
	// sibling concurrent execute (PLAN-324).
	private readonly execSignals = new Map<number, AbortSignal>();
	// Last catalog sent at init, retained so we can transparently replay `init`
	// if the BEAM-side Peer is supervisor-restarted (loses its initialized
	// state) without the OS process dying (Review Gate 1, P2).
	private lastCatalog: Catalog | null = null;

	constructor(opts: PtcRuntimeClientOptions) {
		this.transport = opts.transport;
		this.onToolCall = opts.onToolCall;
		this.onWarn = opts.onWarn ?? (() => {});

		this.transport.onLine(line => this.onData(line));
		this.transport.onClose(info => this.onClosed(info));
	}

	/** Hydrate the runtime with the tool + provider catalog. */
	async init(catalog: Catalog, sessionStoreBytes?: number): Promise<{ tools: string[] }> {
		this.lastCatalog = catalog;
		const params: Record<string, unknown> = { catalog };
		if (sessionStoreBytes !== undefined) params.sessionStoreBytes = sessionStoreBytes;
		const result = (await this.request("init", params)) as { tools?: string[] };
		return { tools: result.tools ?? [] };
	}

	/** True once the runtime has closed (process exit or `close()`). */
	get closed(): boolean {
		return this._closed;
	}

	/**
	 * Parse-only validation (W4 / FEAT-810): check a program parses and uses no
	 * unknown builtins/vars, running ZERO tool calls and ZERO effects. Used at
	 * STORE time for a stored program. Resolves `{ ok: true }` or
	 * `{ ok: false, errors }` (errors carry "Did you mean" hints). Available
	 * pre-init.
	 */
	async validate(program: string): Promise<{ ok: boolean; errors?: string[] }> {
		const result = (await this.request("validate", { program })) as {
			ok?: boolean;
			errors?: string[];
		};
		return { ok: result.ok ?? false, errors: result.errors };
	}

	/** Run a PTC-Lisp program; resolve with its (signature-validated) value. */
	async execute(params: ExecuteParams): Promise<unknown> {
		const send = (): Promise<unknown> => {
			const id = this.nextId;
			// Register the per-execute signal under the id we are about to allocate
			// so inbound tool_calls tagged with this exec_id compose against it.
			if (params.signal) this.execSignals.set(id, params.signal);
			// D3: hand the caller the id NOW (before the program runs) so it can open
			// a transaction scope keyed by the same exec_id this program's tool_calls
			// will carry.
			params.onExecId?.(id);
			const p = this.request("execute", {
				program: params.program,
				context: params.context,
				signature: params.signature,
				timeout_ms: params.timeoutMs,
				max_heap: params.maxHeapWords,
			});
			// Fire-and-forget cleanup: deregister the per-execute signal once this
			// execute settles. Done off the awaited chain so it adds no microtask
			// hop to callers (preserves the re-init retry frame ordering).
			void p.then(
				() => this.execSignals.delete(id),
				() => this.execSignals.delete(id),
			);
			return p;
		};

		try {
			return await send();
		} catch (e) {
			// The Peer may have been supervisor-restarted, losing its init state.
			// If we've initialized before and the runtime reports not-initialized,
			// replay init once and retry transparently (Review Gate 1, P2).
			if (e instanceof PtcRuntimeError && e.code === CODE_NOT_INITIALIZED && this.lastCatalog) {
				await this.request("init", { catalog: this.lastCatalog });
				return send();
			}
			throw e;
		}
	}

	/** Terminate the runtime and reject all in-flight requests. */
	close(): void {
		if (this._closed) return;
		this._closed = true;
		this.closeReason ??= new Error("PtcRuntime client closed");
		this.ownAbort.abort(this.closeReason);
		this.rejectAllPending(this.closeReason);
		this.transport.close();
	}

	// ----- outbound request/response correlation -----

	private request(method: string, params: unknown): Promise<unknown> {
		if (this._closed) {
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

		const params = (frame.params ?? {}) as Partial<ToolCallRequest> & { exec_id?: number };
		const tool = params.tool;
		if (typeof tool !== "string") {
			this.respondError(frame.id, -32602, "tool_call missing 'tool'");
			return;
		}

		try {
			const value = await this.onToolCall(
				{ tool, args: params.args ?? {}, execId: params.exec_id },
				this.toolCallSignal(params.exec_id),
			);
			this.respondResult(frame.id, value);
		} catch (e) {
			this.respondError(frame.id, -32000, e instanceof Error ? e.message : String(e));
		}
	}

	/**
	 * Compose the abort signal handed to a tool_call handler: the client-wide
	 * teardown signal, plus (when the frame names one) the originating execute's
	 * signal. Using the per-execute signal — not a single shared one — is what
	 * keeps one execute's cancellation from aborting another's tool work
	 * (PLAN-324).
	 */
	private toolCallSignal(execId: number | undefined): AbortSignal {
		const perExec = execId !== undefined ? this.execSignals.get(execId) : undefined;
		return perExec ? AbortSignal.any([this.ownAbort.signal, perExec]) : this.ownAbort.signal;
	}

	private respondResult(id: number, result: unknown): void {
		if (this._closed) return;
		this.transport.writeLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
	}

	private respondError(id: number, code: number, message: string): void {
		if (this._closed) return;
		this.transport.writeLine(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
	}

	// ----- lifecycle -----

	private onClosed(info: { code: number | null; signal: string | null }): void {
		if (this._closed) return;
		this._closed = true;
		this.closeReason = new Error(`PtcRuntime exited (code=${info.code ?? "null"}, signal=${info.signal ?? "null"})`);
		this.ownAbort.abort(this.closeReason);
		this.rejectAllPending(this.closeReason);
	}

	private rejectAllPending(err: Error): void {
		for (const { reject } of this.pending.values()) reject(err);
		this.pending.clear();
	}
}

// ============================================================================
// Backpressure-aware line writer
// ============================================================================

/** The minimal writable surface a backpressured writer needs (a subset of
 * Node's stream.Writable: `write` returns false when the buffer is full, and
 * a `drain` event fires when it empties). */
export interface WritableSink {
	/** Write a chunk; returns false when the internal buffer is full. */
	write(chunk: string): boolean;
	/** Register the drain observer (fired when the buffer empties). */
	onDrain(cb: () => void): void;
}

/**
 * Build a `writeLine(line)` that honors stream backpressure (PLAN-322).
 *
 * `child.stdin.write()` returns false when the OS pipe buffer is full; ignoring
 * it makes Node buffer in UNBOUNDED user-space memory. Under heavy reentrant
 * tool_call replies (pmap fan-out + large results) that can balloon RAM. Here we
 * stop writing once the sink signals backpressure, QUEUE subsequent lines in
 * order, and flush them on `drain`. Frames are never dropped or reordered —
 * strict FIFO. The queue is still in-memory (true bounded backpressure to the
 * producer is a future step, FUP), but writes now self-regulate to the pipe's
 * pace instead of being fired blindly.
 */
export function createBackpressuredWriter(sink: WritableSink): (line: string) => void {
	const queue: string[] = [];
	let blocked = false;

	const flush = (): void => {
		blocked = false;
		while (queue.length > 0) {
			const chunk = queue.shift() as string;
			if (!sink.write(chunk)) {
				// Filled again mid-flush: stop, wait for the next drain.
				blocked = true;
				return;
			}
		}
	};

	sink.onDrain(flush);

	return (line: string): void => {
		const chunk = `${line}\n`;
		// While blocked, everything queues to preserve order (an un-blocked write
		// must never jump ahead of queued frames).
		if (blocked || queue.length > 0) {
			queue.push(chunk);
			return;
		}
		if (!sink.write(chunk)) blocked = true;
	};
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
		// Drain complete lines; keep the partial tail buffered.
		for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (lineCb && line.length > 0) lineCb(line);
		}
	});

	// Honor stdin backpressure: queue + flush on drain instead of blindly
	// buffering when the pipe fills (PLAN-322).
	const writeLine = createBackpressuredWriter({
		write: chunk => child.stdin.write(chunk),
		onDrain: cb => child.stdin.on("drain", cb),
	});

	const transport: Transport = {
		writeLine,
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
