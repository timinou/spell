import type { ManifestTemplate } from "../api/client";

// Reuse RpcEvent / AssistantEvent shapes from the spell-server source so the
// frontend stays in sync with the backend wire protocol.
export interface AssistantTextDelta { type: "text_delta"; delta: string }
export interface AssistantTextEnd { type: "text_end"; content: string }
export interface AssistantThinkingDelta { type: "thinking_delta"; delta: string }
export interface AssistantThinkingEnd { type: "thinking_end"; content: string }
export interface AssistantToolStart { type: "toolcall_start" }
export interface AssistantToolEnd { type: "toolcall_end" }
export interface AssistantStart { type: "start" }
export interface AssistantDone { type: "done" }
export interface AssistantError { type: "error"; reason?: string; error?: { errorMessage?: string } }

export type AssistantEvent =
	| AssistantTextDelta
	| AssistantTextEnd
	| AssistantThinkingDelta
	| AssistantThinkingEnd
	| AssistantToolStart
	| AssistantToolEnd
	| AssistantStart
	| AssistantDone
	| AssistantError;

export interface RpcMessageUpdate { type: "message_update"; assistantMessageEvent: AssistantEvent }
export interface RpcAgentStart { type: "agent_start" }
export interface RpcAgentEnd { type: "agent_end" }
export interface RpcTurnStart { type: "turn_start" }
export interface RpcTurnEnd { type: "turn_end" }
export interface RpcToolStart { type: "tool_execution_start"; toolName: string; toolCallId: string; intent?: string }
export interface RpcToolEnd { type: "tool_execution_end"; toolName: string; toolCallId: string; isError?: boolean }
export interface RpcReady { type: "ready" }
export interface RpcError { type: "error"; message: string }

export type RpcEvent =
	| RpcMessageUpdate
	| RpcAgentStart
	| RpcAgentEnd
	| RpcTurnStart
	| RpcTurnEnd
	| RpcToolStart
	| RpcToolEnd
	| RpcReady
	| RpcError
	| { type: string; [key: string]: unknown };

const RESET = "\u001b[0m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const CYAN = "\u001b[36m";
const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const GRAY = "\u001b[90m";
const MAGENTA = "\u001b[35m";

/**
 * Pure helper: translate a single RpcEvent into ANSI bytes for xterm.js.
 * Kept as a pure function so it can be unit-tested without a real terminal.
 */
export function renderRpcEvent(event: RpcEvent): string {
	switch (event.type) {
		case "agent_start":
			return `${GRAY}— agent start —${RESET}\r\n`;
		case "agent_end":
			return `${GRAY}— agent end —${RESET}\r\n`;
		case "turn_start":
			return `${GRAY}· turn ${RESET}\r\n`;
		case "tool_execution_start":
			return `${CYAN}› tool: ${BOLD}${(event as RpcToolStart).toolName}${RESET}${(event as RpcToolStart).intent ? ` ${GRAY}${(event as RpcToolStart).intent}${RESET}` : ""}\r\n`;
		case "tool_execution_end": {
			const end = event as RpcToolEnd;
			const color = end.isError ? RED : GREEN;
			const marker = end.isError ? "✖" : "✓";
			return `${color}${marker} ${end.toolName}${RESET}\r\n`;
		}
		case "error": {
			const e = event as RpcError;
			return `${RED}error: ${e.message}${RESET}\r\n`;
		}
		case "message_update": {
			const inner = (event as RpcMessageUpdate).assistantMessageEvent;
			return renderAssistantEvent(inner);
		}
		default:
			return "";
	}
}

function renderAssistantEvent(event: AssistantEvent): string {
	switch (event.type) {
		case "text_delta":
			return (event as AssistantTextDelta).delta;
		case "text_end":
			return "";
		case "thinking_delta":
			return `${DIM}${MAGENTA}${(event as AssistantThinkingDelta).delta}${RESET}`;
		case "thinking_end":
			return "";
		case "toolcall_start":
			return "";
		case "toolcall_end":
			return "";
		case "start":
			return "";
		case "done":
			return "\r\n";
		case "error": {
			const err = event as AssistantError;
			return `${RED}assistant error: ${err.reason ?? ""} ${err.error?.errorMessage ?? ""}${RESET}\r\n`;
		}
		default:
			return "";
	}
}

export function renderEventLogEntry(entry: { kind: string; ts: number; text?: string; toolName?: string }): string {
	const time = new Date(entry.ts).toISOString().slice(11, 19);
	switch (entry.kind) {
		case "turn_start":
			return `${GRAY}[${time}] · turn${RESET}\r\n`;
		case "turn_end":
			return `${GRAY}[${time}] · end${RESET}\r\n`;
		case "user_message":
			return `${BOLD}${CYAN}[${time}] you ›${RESET} ${entry.text ?? ""}\r\n`;
		case "tool_call":
			return `${CYAN}[${time}] › ${entry.toolName ?? "?"}${RESET}\r\n`;
		case "tool_result":
			return `${GREEN}[${time}] ✓ ${entry.toolName ?? "?"}${RESET}\r\n`;
		case "assistant_text":
			return `${GRAY}[${time}]${RESET} ${entry.text ?? ""}\r\n`;
		case "plan_decision":
			return `${GREEN}[${time}] plan decided${RESET}\r\n`;
		case "error":
			return `${RED}[${time}] error: ${entry.text ?? ""}${RESET}\r\n`;
		default:
			return `${GRAY}[${time}] ${entry.kind}${RESET}\r\n`;
	}
}

export function renderTemplateInfo(template: ManifestTemplate): string {
	return `${BOLD}${template.name}${RESET}${template.description ? ` — ${template.description}` : ""}\r\n`;
}
