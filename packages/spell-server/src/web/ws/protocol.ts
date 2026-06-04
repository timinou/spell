import type { BridgeRpcCommand, RpcEvent, RpcResponseEvent } from "../../rpc";
import type { BlockingEventPayload, EventLogEntry, EventResponsePayload, InjectDeliverAs } from "../../socket/types";
import type { ArtifactCreatedEvent } from "../artifacts/types";

/** Subscribable channel set per session. */
export type Channel = "events" | "artifacts" | "state" | "debug";

/** Periodic sample of a spawned RPC subprocess's resource usage. */
export interface ProcessInfoEvent {
	type: "process_info";
	sessionId: string;
	pid: number;
	rssBytes: number;
	cpuPercent: number;
	uptimeMs: number;
	ts: number;
}

/** One line of stderr from a spawned RPC subprocess. */
export interface RpcStderrEvent {
	type: "rpc_stderr";
	sessionId: string;
	line: string;
	ts: number;
}

export interface SessionSummary {
	sessionId: string;
	kind: "external" | "spawned";
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

// ---- Client \u2192 Server -----------------------------------------------------

export type WsClientMessage =
	| { type: "list_sessions"; correlationId?: string }
	| {
			type: "subscribe";
			sessionId: string;
			channels: Channel[];
			artifactExt?: string[];
			correlationId?: string;
	  }
	| { type: "unsubscribe"; sessionId: string; channels?: Channel[]; correlationId?: string }
	| {
			type: "rpc";
			sessionId: string;
			command: BridgeRpcCommand;
			/**
			 * For external (terminal) sessions a `prompt` command is injected as a
			 * real user turn; `deliverAs` controls steer vs follow-up vs auto.
			 * Ignored for spawned sessions.
			 */
			deliverAs?: InjectDeliverAs;
			correlationId?: string;
	  }
	| {
			type: "answer_blocking_event";
			sessionId: string;
			eventId: string;
			payload: EventResponsePayload;
			correlationId?: string;
	  }
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

// ---- Server \u2192 Client -----------------------------------------------------

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
	| { type: "blocking_event_cleared"; sessionId: string }
	| { type: "artifact_created"; sessionId: string; artifact: ArtifactCreatedEvent }
	| { type: "artifact_url"; sessionId: string; url: string; expiresAt: number; correlationId?: string }
	| { type: "spawn_result"; sessionId: string; correlationId?: string }
	| { type: "error"; code: string; message: string; correlationId?: string }
	| { type: "pong"; correlationId?: string }
	| ProcessInfoEvent
	| RpcStderrEvent;

export function isWsClientMessage(value: unknown): value is WsClientMessage {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as { type?: unknown };
	return typeof obj.type === "string";
}
