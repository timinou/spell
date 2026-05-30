import type {
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Effort,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	SystemPrompt,
	streamSimple,
	TextContent,
	Tool,
	ToolChoice,
	ToolResultMessage,
} from "@spell/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";

/** Stream function - can return sync or Promise for async config lookup */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * Configuration for the agent loop.
 */
export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model;

	/**
	 * When to interrupt tool execution for steering messages.
	 * - "immediate": check after each tool call (default)
	 * - "wait": defer steering until the current turn completes
	 */
	interruptMode?: "immediate" | "wait";

	/**
	 * Optional session identifier forwarded to LLM providers.
	 * Used by providers that support session-based caching (e.g., OpenAI Codex).
	 */
	sessionId?: string;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after each tool execution to check for user interruptions unless interruptMode is "wait".
	 * If messages are returned, remaining tool calls are skipped and
	 * these messages are added to the context before the next LLM call.
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Provides tool execution context, resolved per tool call.
	 * Use for late-bound UI or session state access.
	 */
	getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;

	/**
	 * Attempts to resolve a tool that was called but is not in the active set.
	 * Used for deferred/tiered tool loading: when the model calls a tool not yet
	 * activated, this callback can activate it and return the tool instance.
	 * Returns the tool if resolved, or null/undefined to fall through to the default error.
	 */
	resolveUnknownTool?: (toolName: string) => Promise<AgentTool | null | undefined> | AgentTool | null | undefined;

	/**
	 * Refreshes prompt/tool context from live session state before each model call.
	 * Use this when tool availability or the system prompt can change mid-turn.
	 */
	syncContextBeforeModelCall?: (context: AgentContext) => void | Promise<void>;

	/**
	 * Optional transform applied to tool call arguments before execution.
	 * Use for deobfuscating secrets or rewriting arguments.
	 */
	transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => Record<string, unknown>;
	/**
	 * Enable intent tracing for tool calls.
	 * When enabled, the harness injects an `_i: string` field into tool schemas sent to the model,
	 * then strips `_i` from arguments before executing tools.
	 */
	intentTracing?: boolean;

	/**
	 * Dynamic tool choice override, resolved per LLM call.
	 * When set and returns a value, overrides the static `toolChoice`.
	 */
	getToolChoice?: () => ToolChoice | undefined;

	/**
	 * Mid-stream early-dispatch policy for tools declaring `executionMode:
	 * "parallel"` (the default for everything except ask / await /
	 * cancel_job / exit_plan_mode / browser).
	 *
	 * Default `"enforce"`. When a parallel tool's `toolcall_end` event fires
	 * mid-stream, the harness invokes `tool.execute(...)` IMMEDIATELY — the
	 * resulting promise runs concurrently with the rest of the assistant
	 * stream. `executeToolCalls` later observes the dispatch via an internal
	 * `eagerDispatch` map and awaits each pending promise in source order
	 * instead of re-running the tool.
	 *
	 * Concretely: an async bash job emitted as the first of 30 tool calls
	 * begins executing while the model is still emitting tool blocks 2..30.
	 * Without this, real work waits for the whole stream to drain.
	 *
	 * Sequential tools are never early-dispatched — they are batch-barrier
	 * tools (their `executionMode: "sequential"` declaration carries that
	 * semantic) and the `sequentialToolStreamBarrier` policy cuts the stream
	 * at their `toolcall_end` instead.
	 *
	 * `"off"` restores the prior behaviour (all tools execute strictly after
	 * `streamAssistantResponse` returns). Used for diagnostics and A/B.
	 */
	earlyDispatchParallelTools?: "enforce" | "off";

	/**
	 * Mid-stream barrier policy for tools declaring `executionMode: "sequential"`.
	 *
	 * Default `"enforce"`. When the streamed assistant message emits a
	 * `toolcall_end` for a tool whose definition has `executionMode: "sequential"`,
	 * the harness CUTS the SSE at that point: it trims the assistant message to
	 * end at the barrier tool inclusive, marks it `stopReason: "toolUse"`, best-
	 * effort aborts the upstream stream, and lets the normal
	 * `executeToolCalls` → next-turn cycle continue with real `tool_result`
	 * context.
	 *
	 * This enforces a property the autoregressive model cannot enforce for
	 * itself: don't generate tokens about a state you don't yet have (a tool
	 * result, a user answer, a job completion). Without this, a model that emits
	 * `[bash(echo ok1), await, bash(echo ok2)]` in one turn produces `ok2`'s args
	 * before any await result exists, then waits through the whole sequential
	 * batch before getting a chance to revise.
	 *
	 * `"off"` exists for diagnostics and regression testing. Production code
	 * should leave it at the default.
	 */
	sequentialToolStreamBarrier?: "enforce" | "off";
}

export interface ToolCallContext {
	batchId: string;
	index: number;
	total: number;
	toolCalls: Array<{ id: string; name: string }>;
}

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@spell/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Agent state containing all configuration and conversation data.
 */
export interface AgentState {
	systemPrompt: SystemPrompt;
	model: Model;
	thinkingLevel?: Effort;
	tools: AgentTool<any>[];
	messages: AgentMessage[]; // Can include attachments + custom message types
	isStreaming: boolean;
	streamMessage: AgentMessage | null;
	pendingToolCalls: Set<string>;
	error?: string;
}

export interface AgentToolResult<T = any, _TInput = unknown> {
	// Content blocks supporting text and images
	content: (TextContent | ImageContent)[];
	// Details to be displayed in a UI or logged
	details?: T;
	// True when the tool surfaced an error to the model. Aggregators can read this
	// to short-circuit subsequent operations or roll back transactional batches.
	isError?: boolean;
}

// Callback for streaming tool execution updates
export type AgentToolUpdateCallback<T = any, TInput = unknown> = (partialResult: AgentToolResult<T, TInput>) => void;

/** Options passed to renderResult */
export interface RenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
	/** Current spinner frame index for animated elements (optional) */
	spinnerFrame?: number;
}

/**
 * Context passed to tool execution.
 * Apps can extend via declaration merging.
 */
export interface AgentToolContext {
	// Empty by default - apps extend via declaration merging
}

export type AgentToolExecFn<TParameters extends TSchema = TSchema, TDetails = any, TTheme = unknown> = (
	this: AgentTool<TParameters, TDetails, TTheme>,
	toolCallId: string,
	params: Static<TParameters>,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
	context?: AgentToolContext,
) => Promise<AgentToolResult<TDetails, TParameters>>;

// AgentTool extends Tool but adds the execute function
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any, TTheme = unknown>
	extends Tool<TParameters> {
	// A human-readable label for the tool to be displayed in UI
	label: string;
	/** If true, tool is excluded unless explicitly listed in --tools or agent's tools field */
	hidden?: boolean;
	/** If true, tool can stage a pending action that requires explicit resolution via the resolve tool. */
	deferrable?: boolean;
	/** If true, tool execution ignores abort signals (runs to completion) */
	nonAbortable?: boolean;
	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool requires that no sibling tool calls in the same
	 *   assistant batch run concurrently with it. The whole batch is executed
	 *   serially, in assistant source order, when any tool sets this mode.
	 * - "parallel" (default): this tool can run alongside its siblings.
	 *
	 * Use "sequential" only for tools whose semantics REQUIRE batch-wide
	 * exclusivity: blocking on user input (e.g. ask), mutating the agent's tool
	 * set or mode (e.g. exit_plan_mode), or being a sync point for siblings
	 * (e.g. await on an async job that another sibling might also touch).
	 * Tools that have an internal consistency invariant (file locks, per-session
	 * mutexes, ephemeral subprocesses) MUST own their serialization at the layer
	 * that holds the invariant — do not lift it to "sequential".
	 */
	executionMode?: "sequential" | "parallel";
	/** If true, argument validation errors are non-fatal: raw args are passed to execute() instead of returning an error to the LLM. */
	lenientArgValidation?: boolean;
	/**
	 * Optional cleanup when session is disposed, switched, or forked.
	 * Called by AgentSession at lifecycle boundaries. Must be idempotent —
	 * may be called multiple times (e.g. switchSession then dispose).
	 * After dispose, the tool must support lazy reinit on next execute().
	 */
	dispose?(): Promise<void> | void;
	execute: AgentToolExecFn<TParameters, TDetails, TTheme>;

	/** Optional custom rendering for tool call display (returns UI component) */
	renderCall?: (args: Static<TParameters>, options: RenderResultOptions, theme: TTheme) => unknown;

	/** Optional custom rendering for tool result display (returns UI component) */
	renderResult?: (
		result: AgentToolResult<TDetails, TParameters>,
		options: RenderResultOptions,
		theme: TTheme,
	) => unknown;
}

// AgentContext is like Context but uses AgentTool
export interface AgentContext {
	systemPrompt: SystemPrompt;
	messages: AgentMessage[];
	tools?: AgentTool<any>[];
}

/**
 * Events emitted by the Agent for UI updates.
 * These events provide fine-grained lifecycle information for messages, turns, and tool executions.
 */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage }
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any; intent?: string }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError?: boolean };
