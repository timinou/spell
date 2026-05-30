/**
 * Wire types mirroring `@spell/spell-server/web/ws/protocol`.
 * Kept hand-rolled here to avoid pulling the full server package into the
 * browser bundle. When the server types drift, update both sides together.
 */

export type SessionKind = "external" | "spawned";
export type Channel = "events" | "artifacts" | "state" | "debug";

export interface SessionSummary {
	sessionId: string;
	kind: SessionKind;
	pid: number;
	cwd: string;
	mode: string;
	startedAt: number;
	projectName: string;
	lastHeartbeat: number;
	currentBlockingEvent?: BlockingEventPayload;
	ownedBy?: string;
	templateName?: string;
	watchExtensions?: string[];
}

/* -- Blocking events --------------------------------------------------- */
export interface PlanApprovalBlockingEventPayload {
	kind: "plan_approval";
	eventId: string;
	title: string;
	itemId: string;
	planSummary: string;
	selectorOptions: string[];
}
export interface AskBlockingEventPayload {
	kind: "ask";
	eventId: string;
	questions: Array<{ id: string; question: string; options: Array<{ label: string }>; recommended?: number; multi?: boolean }>;
}
export interface PendingActionBlockingEventPayload {
	kind: "pending_action";
	eventId: string;
	actionType: string;
	description: string;
}
export interface HookSelectorBlockingEventPayload {
	kind: "hook_selector";
	eventId: string;
	title: string;
	options: string[];
}
export interface HookInputBlockingEventPayload {
	kind: "hook_input";
	eventId: string;
	title: string;
	placeholder?: string;
}
export type BlockingEventPayload =
	| PlanApprovalBlockingEventPayload
	| AskBlockingEventPayload
	| PendingActionBlockingEventPayload
	| HookSelectorBlockingEventPayload
	| HookInputBlockingEventPayload;

/* -- RPC envelope ------------------------------------------------------ */
export interface ImageContentRef {
	type: "image";
	mimeType: string;
	data: string;
}
export type BridgeRpcCommand =
	| { id?: string; type: "prompt"; message: string; images?: ImageContentRef[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session" }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_session_stats" };

export type RpcStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface RpcAssistantContentBlock { type?: string; text?: string; thinking?: string }
export interface RpcAssistantMessage {
	role?: string;
	content?: RpcAssistantContentBlock[];
	stopReason?: RpcStopReason;
	errorMessage?: string;
}
export interface AssistantEvent {
	type?: string;
	delta?: { text?: string; thinking?: string };
}
export interface RpcToolResult { content?: Array<{ type?: string; text?: string }>; isError?: boolean }

export type RpcResponseEvent = { type: "response"; correlationId?: string; ok?: boolean; data?: unknown };

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
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args?: unknown; partialResult: RpcToolResult }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; isError?: boolean; result?: RpcToolResult }
	| RpcResponseEvent
	| { type: "error"; message: string };

/* -- Event log (external sessions) ------------------------------------ */
export interface EventLogEntry {
	kind: string;
	ts: number;
	text?: string;
	toolName?: string;
}
export interface EventResponsePayload {
	eventId: string;
	choice?: string | number;
	values?: Record<string, unknown>;
}

/* -- Artifact event ---------------------------------------------------- */
export interface ArtifactCreatedEvent {
	sessionId: string;
	uri: string;
	agent: string;
	tool: string;
	filename: string;
	ext: string;
	mime: string;
	sizeBytes: number;
	ts: number;
}

export interface ProcessInfoEvent {
	pid: number;
	rssBytes: number;
	cpuPercent: number;
	uptimeMs: number;
	ts: number;
}

export interface RpcStderrEvent {
	line: string;
	ts: number;
}

/* -- WebSocket frames -------------------------------------------------- */
export type WsClientMessage =
	| { type: "list_sessions"; correlationId?: string }
	| { type: "subscribe"; sessionId: string; channels: Channel[]; artifactExt?: string[]; correlationId?: string }
	| { type: "unsubscribe"; sessionId: string; channels?: Channel[]; correlationId?: string }
	| { type: "rpc"; sessionId: string; command: BridgeRpcCommand; correlationId?: string }
	| { type: "answer_blocking_event"; sessionId: string; eventId: string; payload: EventResponsePayload; correlationId?: string }
	| {
			type: "spawn";
			templateName?: string;
			params?: Record<string, unknown>;
			mode?: string;
			setupRef?: string;
			cwd?: string;
			initialPrompt?: string;
			ownedBy?: string;
			correlationId?: string;
	  }
	| { type: "kill"; sessionId: string; correlationId?: string }
	| { type: "mint_artifact_url"; sessionId: string; artifactPath: string; ttlSec?: number; correlationId?: string }
	| { type: "ping"; correlationId?: string };

export type WsServerMessage =
	| { type: "auth_ok"; identity: { name: string } }
	| { type: "session_list"; sessions: SessionSummary[]; correlationId?: string }
	| { type: "session_added"; session: SessionSummary }
	| { type: "session_removed"; session: SessionSummary }
	| { type: "session_updated"; session: SessionSummary }
	| { type: "rpc_event"; sessionId: string; event: Exclude<RpcEvent, RpcResponseEvent> }
	| { type: "rpc_response"; sessionId: string; response: RpcResponseEvent; correlationId?: string }
	| { type: "external_event_log"; sessionId: string; entry: EventLogEntry }
	| { type: "blocking_event"; sessionId: string; payload: BlockingEventPayload }
	| { type: "artifact_created"; sessionId: string; artifact: ArtifactCreatedEvent }
	| { type: "artifact_url"; sessionId: string; url: string; expiresAt: number; correlationId?: string }
	| { type: "spawn_result"; sessionId: string; correlationId?: string }
	| { type: "process_info"; sessionId: string; pid: number; rssBytes: number; cpuPercent: number; uptimeMs: number; ts: number }
	| { type: "rpc_stderr"; sessionId: string; line: string; ts: number }
	| { type: "error"; code: string; message: string; correlationId?: string }
	| { type: "pong"; correlationId?: string };
