/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */
import type { AgentMessage, ThinkingLevel } from "@spell/pi-agent-core";
import type { Effort, ImageContent, Model } from "@spell/pi-ai";
import type { BashResult } from "../../exec/bash-executor";
import type { SessionStats } from "../../session/agent-session";
import type { CompactionResult } from "../../session/compaction";
import type { DisciplineRuntimeStat } from "../../config/discipline";

// ============================================================================
// Edit history (PLAN-338 B)
// ============================================================================

/** One edit in the session's unified edit-history log (newest-first in lists). */
export interface EditHistoryEntry {
	/** Stable entry id — use for id-precise undo/redo. */
	id: string;
	/** Absolute path of the edited file. */
	file: string;
	/** Workspace root the file belongs to (monorepo subtree). */
	workspace: string;
	/** Group id shared by edits from one logical `edit` invocation (e.g. a rename). */
	groupId: string | null;
	/** True once undone (redoable); false while applied (undoable). */
	reverted: boolean;
	/** Live git state: the file is committed at HEAD (undo declines unless forced). */
	committed: boolean;
	/** HEAD sha the edit was recorded against (provenance), if in a repo. */
	commit: string | null;
	/** Agent/actor label that made the edit (multi-actor legibility). */
	agentLabel: string;
	/** Unix seconds. */
	timestamp: number;
}

/** Payload of an `edit_history` response: the session's edits + roll-up counts. */
export interface EditHistoryData {
	entries: EditHistoryEntry[];
	total: number;
	undoable: number;
	redoable: number;
}

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Stored programs (W4) — run a stored PTC-Lisp program through ExecuteTool's
	// intent-gated runner WITHOUT an LLM turn (a direct execution command, like
	// `bash`). A host (a Team Chat tile) sends this to preview (visible-refresh),
	// apply (interactive), or auto-run (background-tick) a stored program.
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

	// Tile persistence (FUP-123) — server-side CRUD for Team Chat tiles, riding the
	// same spawned-session lane as run_stored (external CLI sessions are rejected
	// upstream by #dispatchExternalRpc). Mirrors tile-store.ts's TileRecord contract.
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

	// Edit history (PLAN-338 B) — read this session's unified edit log (newest
	// first) for the Team Chat Edit History panel. `file` narrows to one path.
	// Read-only; rides the same spawned-session lane as run_stored.
	| { id?: string; type: "edit_history"; file?: string }
	// Undo/redo a recorded edit (PLAN-338 C). `id` targets a specific entry
	// (else newest); `force` overrides the commit-guard decline-by-default.
	// Routes through kernel `manage undo|redo` (revert_guarded + commit_guard).
	| { id?: string; type: "undo"; entryId?: string; force?: boolean }
	| { id?: string; type: "redo"; entryId?: string }
	// Semantic code query (FEAT-815 Phase C). Resolves an arbitrary CodePath
	// `target` (e.g. "src/x.ts::Foo def→", "::Bar#hover", "**/*.ts#diagnostics")
	// through pi-code-path/pi-code-graph via executeCodePath — read-only.
	| { id?: string; type: "code_query"; target: string; format?: string }
	| {
			id?: string;
			type: "tile_record_run";
			tileId: string;
			run: { intent: string; outcome: string; files: number; paths?: string[]; error?: string };
	  }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages" };

// ============================================================================
// Subagent dialogue events (stdout, observation-only — PLAN-331 W3')
// ============================================================================

/**
 * Projection of the in-process `task:ask:*` EventBus dialogue onto the RPC
 * stdout rail so spell-server (web / Telegram) can OBSERVE worker↔orchestrator
 * Q&A. Observation-only: the human watches; answers are composed in-process by
 * the orchestrator (PLAN-327 AskBroker), never over this channel.
 *
 * One frame kind, three lifecycle phases — keeps the ask taxonomy distinct on
 * the wire from blocking events (which ride a separate answerable path).
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
	| {
			type: "task_ask";
			phase: "answered";
			runId: string;
			questionId: string;
			answer: string;
			recipients: string[];
	  }
	| { type: "task_ask"; phase: "cancelled"; runId: string; questionId: string; reason: string };

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model;
	thinkingLevel: ThinkingLevel | undefined;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	queuedMessageCount: number;
	disciplineStats?: DisciplineRuntimeStat[];
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "abort_and_prompt"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model; thinkingLevel: ThinkingLevel | undefined; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: Effort } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "set_interrupt_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| {
			id?: string;
			type: "response";
			command: "edit_history";
			success: true;
			data: EditHistoryData;
	  }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "branch"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_branch_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
