export type BlockingEventKind = "plan_approval" | "ask" | "pending_action" | "hook_selector" | "hook_input";

interface SocketMessageBase {
	type: string;
	timestamp: number;
}

export interface RegisterSocketClientMessage extends SocketMessageBase {
	type: "register";
	sessionId: string;
	pid: number;
	cwd: string;
	mode: string;
	startedAt: number;
	projectName: string;
}

export interface DeregisterSocketClientMessage extends SocketMessageBase {
	type: "deregister";
}

export interface PlanApprovalBlockingEventPayload {
	kind: "plan_approval";
	eventId: string;
	title: string;
	itemId: string;
	planSummary: string;
	selectorOptions: string[];
}

export interface AskOption {
	label: string;
}

export interface AskQuestion {
	id: string;
	question: string;
	options: AskOption[];
	recommended?: number;
	multi?: boolean;
}

export interface AskBlockingEventPayload {
	kind: "ask";
	eventId: string;
	questions: AskQuestion[];
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

export interface BlockingEventSocketClientMessage extends SocketMessageBase {
	type: "blocking_event";
	payload: BlockingEventPayload;
}

export interface HeartbeatSocketClientMessage extends SocketMessageBase {
	type: "heartbeat";
	status: string;
}

export interface EventResolvedSocketClientMessage extends SocketMessageBase {
	type: "event_resolved";
	eventId: string;
}

/**
 * How a remotely-injected message should be delivered into the session.
 * - "steer": interrupt the current stream (steering message)
 * - "followUp": queue behind the current stream
 * - "auto": steer if streaming, otherwise submit as a normal new turn
 */
export type InjectDeliverAs = "steer" | "followUp" | "auto";

/**
 * Client → server acknowledgement that an `inject_input` frame was (or was not)
 * accepted as a real user turn. Mirrors the `event_resolved` ack style.
 */
export interface InjectAckSocketClientMessage extends SocketMessageBase {
	type: "inject_ack";
	injectId: string;
	accepted: boolean;
	reason?: string;
}

export type EventLogEntryKind =
	| "turn_start"
	| "turn_end"
	| "tool_call"
	| "tool_result"
	| "assistant_text"
	| "user_message"
	| "plan_decision"
	| "error";

export const EVENT_LOG_ENTRY_KINDS: ReadonlySet<EventLogEntryKind> = new Set([
	"turn_start",
	"turn_end",
	"tool_call",
	"tool_result",
	"assistant_text",
	"user_message",
	"plan_decision",
	"error",
]);

export interface EventLogEntry {
	kind: EventLogEntryKind;
	ts: number;
	text?: string;
	toolName?: string;
	meta?: Record<string, string | number | boolean>;
}

export interface EventLogSocketClientMessage extends SocketMessageBase {
	type: "event_log";
	entry: EventLogEntry;
}

export function isEventLogEntry(value: unknown): value is EventLogEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	if (typeof entry.kind !== "string" || !EVENT_LOG_ENTRY_KINDS.has(entry.kind as EventLogEntryKind)) {
		return false;
	}
	if (typeof entry.ts !== "number" || !Number.isFinite(entry.ts)) return false;
	if (entry.text !== undefined && typeof entry.text !== "string") return false;
	if (entry.toolName !== undefined && typeof entry.toolName !== "string") return false;
	return true;
}

export type SocketClientMessage =
	| RegisterSocketClientMessage
	| DeregisterSocketClientMessage
	| BlockingEventSocketClientMessage
	| HeartbeatSocketClientMessage
	| EventResolvedSocketClientMessage
	| EventLogSocketClientMessage
	| InjectAckSocketClientMessage;

export interface RegisteredSocketServerMessage extends SocketMessageBase {
	type: "registered";
	serverVersion: string;
	registeredAt: number;
}

export interface PlanApprovalEventResponsePayload {
	kind: "plan_approval";
	selectedOption: string;
}

export interface AskAnswer {
	questionId: string;
	selectedIndices: number[];
}

export interface AskEventResponsePayload {
	kind: "ask";
	answers: AskAnswer[];
}

export interface HookSelectorEventResponsePayload {
	kind: "hook_selector";
	selectedIndex: number;
}

export interface HookInputEventResponsePayload {
	kind: "hook_input";
	value: string;
}

export type EventResponsePayload =
	| PlanApprovalEventResponsePayload
	| AskEventResponsePayload
	| HookSelectorEventResponsePayload
	| HookInputEventResponsePayload;

export interface EventResponseSocketServerMessage extends SocketMessageBase {
	type: "event_response";
	eventId: string;
	payload: EventResponsePayload;
}

export interface EventCancelledSocketServerMessage extends SocketMessageBase {
	type: "event_cancelled";
	eventId: string;
	reason?: string;
}

/**
 * Server → client free-form input injection. Routed to a registered external
 * (terminal/TUI) session so a web/remote operator can steer it exactly as if
 * the message had been typed in the terminal. The client replies with
 * `inject_ack`.
 */
export interface InjectInputSocketServerMessage extends SocketMessageBase {
	type: "inject_input";
	injectId: string;
	text: string;
	deliverAs: InjectDeliverAs;
}

export type SocketServerMessage =
	| RegisteredSocketServerMessage
	| EventResponseSocketServerMessage
	| EventCancelledSocketServerMessage
	| InjectInputSocketServerMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const SOCKET_CLIENT_MESSAGE_TYPES = new Set([
	"register",
	"deregister",
	"blocking_event",
	"heartbeat",
	"event_resolved",
	"event_log",
	"inject_ack",
]);

export function isSocketClientMessage(value: unknown): value is SocketClientMessage {
	if (!isRecord(value)) {
		return false;
	}

	return (
		typeof value.type === "string" &&
		typeof value.timestamp === "number" &&
		SOCKET_CLIENT_MESSAGE_TYPES.has(value.type)
	);
}
