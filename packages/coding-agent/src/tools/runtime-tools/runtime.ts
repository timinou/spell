/**
 * PTC dispatch runtime for `deftool` runtime tools (PLAN-337).
 *
 * Owns a dedicated, long-lived `PtcRuntimeClient` used solely to evaluate a
 * tool's interface file. The interface's `:exec`/`:parse` closures never leave
 * the BEAM (closures are unencodable); this runtime crosses only DATA:
 *
 *   describe(source)            → ToolDescriptor              (load time)
 *   argv(source, verb, args)    → string[]                    (beat 1)
 *   parse(source, verb, stdout) → unknown (structured value)  (beat 3)
 *
 * Verb args and raw stdout are passed via the safe `context` channel (`data/*`),
 * never interpolated into program text. The catalog is empty: argv/parse are
 * pure data-shaping and call no tools.
 */
import { PtcRuntimeClient, spawnTransport } from "../ptc-runtime/client";
import { RUNTIME_TOOL_POSTLUDE, RUNTIME_TOOL_PRELUDE } from "./prelude.ptc";
import type { ToolDescriptor } from "./types";

/**
 * Compose a runnable program: prelude (`deftool`) → the tool's interface
 * (binds `tool`) → postlude (the rt-* dispatch helpers). PTC has no forward
 * references, so the helpers MUST come after the `(def tool ...)` they close over.
 */
export function composeToolSource(interfaceSource: string): string {
	return `${RUNTIME_TOOL_PRELUDE}\n${interfaceSource}\n${RUNTIME_TOOL_POSTLUDE}\n`;
}

export class RuntimeToolDispatcher {
	#client: PtcRuntimeClient | null = null;
	#initPromise: Promise<void> | null = null;

	async #ensureClient(): Promise<PtcRuntimeClient> {
		if (this.#client?.closed) {
			this.#client = null;
			this.#initPromise = null;
		}
		if (this.#client) return this.#client;
		if (!this.#initPromise) this.#initPromise = this.#spawn();
		try {
			await this.#initPromise;
		} catch (e) {
			this.#initPromise = null;
			throw e;
		}
		if (!this.#client) throw new Error("runtime-tool dispatcher failed to initialize");
		return this.#client;
	}

	async #spawn(): Promise<void> {
		const { transport } = spawnTransport({});
		const client = new PtcRuntimeClient({
			transport,
			// argv/parse are pure data-shaping — no reentrant tool calls.
			onToolCall: async ({ tool }) => {
				throw new Error(`runtime-tool dispatch must not call tools (got '${tool}')`);
			},
		});
		await client.init({ tools: [] });
		this.#client = client;
	}

	/** Run `(rt-describe)` against the composed source → load-time descriptor. */
	async describe(source: string): Promise<ToolDescriptor> {
		const client = await this.#ensureClient();
		const value = await client.execute({ program: `${source}\n(rt-describe)` });
		return value as ToolDescriptor;
	}

	/** Beat 1: build the process argv for `verb` from `args`. */
	async argv(source: string, verb: string, args: Record<string, unknown>): Promise<string[]> {
		const client = await this.#ensureClient();
		const value = await client.execute({
			program: `${source}\n(rt-argv data/verb data/args)`,
			context: { verb, args },
		});
		if (value && typeof value === "object" && "err" in (value as object)) {
			throw new Error(String((value as { err: unknown }).err));
		}
		if (!Array.isArray(value) || !value.every(v => typeof v === "string")) {
			throw new Error(`runtime-tool '${verb}' produced a non-string-array argv`);
		}
		return value as string[];
	}

	/** Beat 3: shape raw stdout into a structured value for `verb`. */
	async parse(source: string, verb: string, stdout: string): Promise<unknown> {
		const client = await this.#ensureClient();
		return client.execute({
			program: `${source}\n(rt-parse data/verb data/stdout)`,
			context: { verb, stdout },
		});
	}

	close(): void {
		this.#client?.close();
		this.#client = null;
		this.#initPromise = null;
	}
}
