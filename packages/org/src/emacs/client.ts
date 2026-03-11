import { logger } from "@oh-my-pi/pi-utils";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface OrgClient {
	/**
	 * Call a tool on the Emacs MCP server and return the parsed result.
	 *
	 * Opens a fresh socat connection per call — simpler than maintaining
	 * persistent state and sufficient for low-frequency org operations.
	 */
	callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
	/** No-op for this implementation; kept for API symmetry. */
	close(): Promise<void>;
}

/**
 * Create an OrgClient that speaks raw JSON-RPC over a socat stdio bridge.
 *
 * Returns null when socat is unavailable, logging a warning so callers can
 * degrade gracefully rather than crashing.
 *
 * @param socketPath - Path to the Emacs MCP Unix socket.
 * @param socatPath  - Optional explicit path to the socat binary (falls back to PATH).
 */
export async function createOrgClient(socketPath: string, socatPath?: string): Promise<OrgClient | null> {
	const socat = socatPath ?? Bun.which("socat");
	if (!socat) {
		logger.warn("[org-client] socat not found — JSON-RPC transport unavailable", { socketPath });
		return null;
	}

	return {
		async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
			return callToolOnce(socat, socketPath, name, args);
		},
		async close(): Promise<void> {
			// Per-call connections are already closed by callToolOnce; nothing to do.
		},
	};
}

// ---------------------------------------------------------------------------
// JSON-RPC types (minimal — only the fields we consume)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params: unknown;
}

interface JsonRpcSuccess {
	jsonrpc: "2.0";
	id: number;
	result: {
		content: Array<{ type: string; text: string }>;
	};
}

interface JsonRpcError {
	jsonrpc: "2.0";
	id: number;
	error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

function isJsonRpcError(r: JsonRpcResponse): r is JsonRpcError {
	return "error" in r;
}

// ---------------------------------------------------------------------------
// Core: open socat, send one request, read one response, close
// ---------------------------------------------------------------------------

const CALL_TIMEOUT_MS = 30_000;
let nextId = 1;

async function callToolOnce(
	socat: string,
	socketPath: string,
	name: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const id = nextId++;

	const request: JsonRpcRequest = {
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: { name, arguments: args },
	};

	const line = `${JSON.stringify(request)}\n`;

	logger.debug("[org-client] Sending tool call", { name, id });

	// Open a fresh socat connection — each call is independent.
	const proc = Bun.spawn([socat, "STDIO", `UNIX-CONNECT:${socketPath}`], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});

	// Write request, then signal EOF on stdin so socat knows we're done sending.
	proc.stdin.write(line);
	proc.stdin.end();

	// Read stdout with a hard deadline.
	const responseText = await Promise.race([
		readFirstLine(proc.stdout),
		Bun.sleep(CALL_TIMEOUT_MS).then(() => {
			proc.kill();
			throw new Error(`Tool call "${name}" timed out after ${CALL_TIMEOUT_MS}ms`);
		}),
	]);

	// Ensure the child has exited so we don't leak file descriptors.
	proc.kill();

	let parsed: JsonRpcResponse;
	try {
		parsed = JSON.parse(responseText) as JsonRpcResponse;
	} catch {
		throw new Error(`Invalid JSON-RPC response from Emacs MCP: ${responseText.slice(0, 200)}`);
	}

	if (isJsonRpcError(parsed)) {
		const { code, message, data } = parsed.error;
		logger.warn("[org-client] JSON-RPC error", { name, code, message, data });
		throw new Error(`Emacs MCP error ${code}: ${message}`);
	}

	// The MCP content block protocol: content is an array of typed blocks.
	// We return the text of the first text block (matching the source project's pattern).
	const textBlock = parsed.result.content.find(c => c.type === "text");
	if (!textBlock) {
		throw new Error(`Tool "${name}" returned no text content block`);
	}

	// Parse inner JSON if possible; return raw text otherwise.
	try {
		return JSON.parse(textBlock.text) as unknown;
	} catch {
		return textBlock.text;
	}
}

/**
 * Read the first non-empty line from a ReadableStream<Uint8Array>.
 * Accumulates chunks until a newline is found.
 */
async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			const nlIdx = buffer.indexOf("\n");
			if (nlIdx !== -1) {
				const line = buffer.slice(0, nlIdx).replace(/\r$/, "");
				if (line.trim().length > 0) return line;
				// Empty line — keep reading (e.g. protocol preamble).
				buffer = buffer.slice(nlIdx + 1);
			}
		}
	} finally {
		reader.releaseLock();
	}

	// Stream ended without a newline — return whatever we accumulated.
	const trimmed = buffer.trim();
	if (trimmed.length === 0) {
		throw new Error("Empty response from Emacs MCP server");
	}
	return trimmed;
}
