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
	| { id?: string; type: "get_session_stats" };

/** Image content reference matching coding-agent's ImageContent */
export interface ImageContentRef {
	type: "base64";
	media_type: string;
	data: string;
}

/** Events the bridge reads from spell's stdout (JSON lines) */
export type RpcEvent =
	| { type: "ready" }
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start" }
	| { type: "message_update"; assistantMessageEvent: AssistantEvent }
	| { type: "message_end" }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; intent?: string }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; isError?: boolean }
	| { type: "response"; command: string; success: boolean; data?: unknown; error?: string }
	| { type: "error"; message: string };

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
	| { type: "error" };

/** Options for spawning an RPC process */
export interface RpcSpawnOptions {
	/** Working directory for the spell process */
	cwd: string;
	/** Tool names to allow (passed via --tools) */
	tools: string[];
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
}
