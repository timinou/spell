/**
 * RPC protocol types for the bridge's interaction with spell --mode rpc.
 *
 * These are a compatible subset of the full RPC types from coding-agent.
 * We define them locally to avoid a hard dependency on the coding-agent package.
 */

/** Commands the bridge sends to spell's stdin */
export type BridgeRpcCommand =
	| { id?: string; type: "prompt"; message: string; images?: ImageContentRef[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session" }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_session_stats" }
	// Stored programs (W4) — run a stored PTC-Lisp program through the agent's
	// ExecuteTool intent-gated runner, WITHOUT an LLM turn. Carries the tile's
	// stored program + run intent; the response data is { data, isError,
	// transaction, text } the tile renders. Mirrors coding-agent RpcCommand.
	| {
			id?: string;
			type: "run_stored";
			program: string;
			mode?: "read" | "write";
			intent?: "interactive" | "visible-refresh" | "background-tick";
			autoWrite?: boolean;
			signature?: string;
			context?: Record<string, unknown>;
	  }
	// Tile persistence (FUP-123) — forwarded generically to the agent's
	// tile-store CRUD lane. Mirrors coding-agent RpcCommand tile variants.
	| { id?: string; type: "tile_list"; project?: string }
	| {
			id?: string;
			type: "tile_create";
			tile: {
				owner?: string;
				project?: string;
				title: string;
				kind?: "codemod" | "format";
				programRef?: string;
				programInline?: string;
				mode: "read" | "write";
				autoWrite: boolean;
				schedule?: string;
			};
	  }
	| { id?: string; type: "tile_update"; tileId: string; patch: Record<string, unknown> }
	| { id?: string; type: "tile_delete"; tileId: string }
	| {
			id?: string;
			type: "tile_record_run";
			tileId: string;
			run: { intent: string; outcome: string; files: number; paths?: string[]; error?: string };
	  }
	// Edit history (PLAN-338 B) — read-only listing of the session's unified edit
	// log; powers the Team Chat Edit History panel. Forwarded to the bridge as-is.
	| { id?: string; type: "edit_history"; file?: string };

/** Image content reference matching coding-agent's ImageContent */
export interface ImageContentRef {
	type: "image";
	mimeType: string;
	data: string;
}

/** Assistant stop reasons mirrored from the AI package */
export type RpcStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface RpcAssistantContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
}

export interface RpcAssistantMessage {
	role?: string;
	content?: RpcAssistantContentBlock[];
	stopReason?: RpcStopReason;
	errorMessage?: string;
}

export interface RpcToolResultContentBlock {
	type?: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface RpcToolResult {
	content?: RpcToolResultContentBlock[];
	details?: unknown;
}

export type RpcResponseEvent =
	| { type: "response"; command: string; success: true; data?: unknown }
	| { type: "response"; command: string; success: false; error: string };

/** Events the bridge reads from spell's stdout (JSON lines) */
export type RpcEvent =
	| { type: "ready" }
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start" }
	| { type: "message_update"; assistantMessageEvent: AssistantEvent }
	| { type: "message_end"; message?: RpcAssistantMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; intent?: string; args?: unknown }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args?: unknown;
			partialResult: RpcToolResult;
	  }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; isError?: boolean; result?: RpcToolResult }
	| RpcTaskAskEvent
	| RpcResponseEvent
	| { type: "error"; message: string };

/**
 * Observation-only projection of a spawned session's worker↔orchestrator
 * dialogue (PLAN-331 W3'). Mirrors coding-agent's RpcTaskAskEvent. Rides the
 * existing `rpc_event` WS frame to the browser; the human watches but does not
 * answer (answers are composed in-process by the orchestrator, PLAN-327).
 */
export type RpcTaskAskEvent =
	| {
			type: "task_ask";
			phase: "raised";
			runId: string;
			questionId: string;
			fromTaskId: string;
			fromSessionId?: string;
			question: string;
			scopeHint?: string;
			blocking: boolean;
	  }
	| { type: "task_ask"; phase: "answered"; runId: string; questionId: string; answer: string; recipients: string[] }
	| { type: "task_ask"; phase: "cancelled"; runId: string; questionId: string; reason: string };

/** Subset of AssistantMessageEvent we care about for streaming */
export type AssistantEvent =
	| { type: "text_delta"; delta: string }
	| { type: "text_end"; content: string }
	| { type: "thinking_delta"; delta: string }
	| { type: "thinking_end"; content: string }
	| { type: "toolcall_start" }
	| { type: "toolcall_end" }
	| { type: "start" }
	| { type: "done" }
	| { type: "error"; reason?: Extract<RpcStopReason, "aborted" | "error">; error?: RpcAssistantMessage };

/** Options for spawning an RPC process */
export interface RpcSpawnOptions {
	/** Working directory for the spell process */
	cwd: string;
	/** Tool names to allow (passed via --tools) */
	tools: string[];
	/** Explicit model slug passed via --model */
	model?: string;
	/** Path to resume a previous session */
	sessionPath?: string;
	/** Session directory for new sessions */
	sessionDir?: string;
	/** Additional system prompt text */
	appendSystemPrompt?: string;
	/** Sandbox policy path passed to spell */
	sandboxPolicyPath?: string;
	/** Whether to skip session persistence */
	noSession?: boolean;
	/** Additional environment variables for the spawned process */
	env?: Record<string, string>;
}

/** Delivery metadata from send_file tool result */
// SYNC: Mirrored in packages/coding-agent/src/tools/send-file.ts — keep in sync
export interface FileDelivery {
	type: "document" | "photo";
	absolutePath: string;
	fileName: string;
	mimeType: string;
	caption?: string;
	fileSize: number;
}
