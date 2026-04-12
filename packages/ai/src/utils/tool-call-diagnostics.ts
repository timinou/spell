import type {
	Api,
	AssistantMessage,
	PersistedDebugArtifactRef,
	Provider,
	ToolCall,
	ToolCallStreamDiagnostic,
	ToolCallStreamDiagnosticState,
} from "../types";

const UTF8_ENCODER = new TextEncoder();

interface ToolCallBlockWithStreamingState extends ToolCall {
	partialJson?: string;
	partialArgs?: string;
	index?: number;
}

export interface CreateToolCallStreamDiagnosticOptions {
	state: ToolCallStreamDiagnosticState;
	api: Api;
	provider: Provider;
	model: string;
	toolName?: string;
	toolCallId?: string;
	contentIndex?: number;
	arguments?: Record<string, unknown>;
	parsedArgumentKeys?: string[];
	rawPartialJson?: string;
	rawPartialJsonBytes?: number;
	rawPartialJsonArtifact?: PersistedDebugArtifactRef;
	firstTokenTimeMs?: number;
	idleTimeoutMs?: number;
	providerRetryAttempt?: number;
}

export interface ClassifyToolCallStreamInterruptionOptions {
	api?: Api;
	provider?: Provider;
	model?: string;
	firstTokenTimeMs?: number;
	idleTimeoutMs?: number;
	providerRetryAttempt?: number;
}

const TOOL_CALL_STREAM_MAX_RETRIES = 3;
const TOOL_CALL_STREAM_RETRY_BASE_DELAY_MS = 2_000;
function getRawPartialJsonByteLength(rawPartialJson: string | undefined): number {
	if (rawPartialJson === undefined || rawPartialJson.length === 0) return 0;
	return UTF8_ENCODER.encode(rawPartialJson).length;
}

function getParsedArgumentKeys(
	argumentsObject: Record<string, unknown> | undefined,
	explicitKeys: string[] | undefined,
): string[] {
	if (explicitKeys && explicitKeys.length > 0) {
		return [...explicitKeys].sort();
	}
	if (!argumentsObject) return [];
	return Object.keys(argumentsObject).sort();
}

function isToolCallBlockWithStreamingState(value: unknown): value is ToolCallBlockWithStreamingState {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ToolCallBlockWithStreamingState>;
	return (
		candidate.type === "toolCall" &&
		typeof candidate.id === "string" &&
		typeof candidate.name === "string" &&
		typeof candidate.arguments === "object" &&
		candidate.arguments !== null
	);
}

function getStreamingToolCallRawJson(block: ToolCallBlockWithStreamingState): string | undefined {
	if (typeof block.partialJson === "string") return block.partialJson;
	if (typeof block.partialArgs === "string") return block.partialArgs;
	return undefined;
}

function getStreamingToolCallContentIndex(
	message: AssistantMessage,
	block: ToolCallBlockWithStreamingState,
): number | undefined {
	if (typeof block.index === "number") return message.content.indexOf(block);
	return message.content.indexOf(block);
}

function getLastToolCall(message: AssistantMessage): ToolCall | undefined {
	for (let i = message.content.length - 1; i >= 0; i--) {
		const block = message.content[i];
		if (block?.type === "toolCall") return block;
	}
	return undefined;
}

export function createToolCallStreamDiagnostic(
	options: CreateToolCallStreamDiagnosticOptions,
): ToolCallStreamDiagnostic {
	return {
		kind: "tool_call_stream_diagnostic",
		state: options.state,
		api: options.api,
		provider: options.provider,
		model: options.model,
		toolName: options.toolName,
		toolCallId: options.toolCallId,
		contentIndex: options.contentIndex,
		parsedArgumentKeys: getParsedArgumentKeys(options.arguments, options.parsedArgumentKeys),
		rawPartialJson: options.rawPartialJson,
		rawPartialJsonBytes: options.rawPartialJsonBytes ?? getRawPartialJsonByteLength(options.rawPartialJson),
		rawPartialJsonArtifact: options.rawPartialJsonArtifact,
		firstTokenTimeMs: options.firstTokenTimeMs,
		idleTimeoutMs: options.idleTimeoutMs,
		providerRetryAttempt: options.providerRetryAttempt ?? 0,
	};
}

export function classifyToolCallStreamInterruption(
	message: AssistantMessage,
	options: ClassifyToolCallStreamInterruptionOptions = {},
): ToolCallStreamDiagnostic | undefined {
	const incompleteToolCall = message.content.find(
		(block): block is ToolCallBlockWithStreamingState =>
			isToolCallBlockWithStreamingState(block) && getStreamingToolCallRawJson(block) !== undefined,
	);
	if (incompleteToolCall) {
		const rawPartialJson = getStreamingToolCallRawJson(incompleteToolCall) ?? "";
		return createToolCallStreamDiagnostic({
			state: rawPartialJson.length > 0 ? "stalled_incomplete_tool_args" : "stalled_before_tool_args",
			api: options.api ?? message.api,
			provider: options.provider ?? message.provider,
			model: options.model ?? message.model,
			toolName: incompleteToolCall.name,
			toolCallId: incompleteToolCall.id,
			contentIndex: getStreamingToolCallContentIndex(message, incompleteToolCall),
			arguments: incompleteToolCall.arguments,
			rawPartialJson,
			firstTokenTimeMs: options.firstTokenTimeMs,
			idleTimeoutMs: options.idleTimeoutMs,
			providerRetryAttempt: options.providerRetryAttempt,
		});
	}

	const completedToolCall = getLastToolCall(message);
	if (!completedToolCall) return undefined;
	return createToolCallStreamDiagnostic({
		state: "completed_tool_call_missing_trailing_stop",
		api: options.api ?? message.api,
		provider: options.provider ?? message.provider,
		model: options.model ?? message.model,
		toolName: completedToolCall.name,
		toolCallId: completedToolCall.id,
		contentIndex: message.content.lastIndexOf(completedToolCall),
		arguments: completedToolCall.arguments,
		firstTokenTimeMs: options.firstTokenTimeMs,
		idleTimeoutMs: options.idleTimeoutMs,
		providerRetryAttempt: options.providerRetryAttempt,
	});
}

export function hasActiveToolArgumentStreaming(message: AssistantMessage): boolean {
	return message.content.some(
		block => isToolCallBlockWithStreamingState(block) && getStreamingToolCallRawJson(block) !== undefined,
	);
}

export function appendToolCallStreamDiagnostic(
	message: AssistantMessage,
	diagnostic: ToolCallStreamDiagnostic,
): ToolCallStreamDiagnostic {
	message.streamDiagnostics = [...(message.streamDiagnostics ?? []), diagnostic];
	return diagnostic;
}

export function isToolCallStreamDiagnostic(value: unknown): value is ToolCallStreamDiagnostic {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ToolCallStreamDiagnostic>;
	return (
		candidate.kind === "tool_call_stream_diagnostic" &&
		typeof candidate.state === "string" &&
		typeof candidate.api === "string" &&
		typeof candidate.provider === "string" &&
		typeof candidate.model === "string" &&
		Array.isArray(candidate.parsedArgumentKeys) &&
		typeof candidate.rawPartialJsonBytes === "number" &&
		typeof candidate.providerRetryAttempt === "number"
	);
}

function describeState(state: ToolCallStreamDiagnosticState): string {
	switch (state) {
		case "stalled_before_tool_args":
			return "stalled before any tool arguments arrived";
		case "stalled_incomplete_tool_args":
			return "stalled while streaming incomplete tool arguments";
		case "completed_tool_call_missing_trailing_stop":
			return "stalled after a completed tool call but before trailing stop events";
	}
}

export function summarizeToolCallStreamDiagnostic(diagnostic: ToolCallStreamDiagnostic): string {
	const toolLabel = diagnostic.toolName ? ` ${diagnostic.toolName}` : "";
	const parsedKeys =
		diagnostic.parsedArgumentKeys.length > 0 ? ` Parsed keys: ${diagnostic.parsedArgumentKeys.join(", ")}.` : "";
	return `Tool call${toolLabel} ${describeState(diagnostic.state)}.${parsedKeys}`;
}

export function formatToolCallStreamDiagnosticMessage(diagnostic: ToolCallStreamDiagnostic): string {
	const details: string[] = [];
	if (diagnostic.idleTimeoutMs !== undefined) {
		details.push(`Idle timeout: ${diagnostic.idleTimeoutMs}ms.`);
	}
	if (diagnostic.providerRetryAttempt > 0) {
		details.push(`Retry attempts: ${diagnostic.providerRetryAttempt}.`);
	}
	return [summarizeToolCallStreamDiagnostic(diagnostic), ...details].join(" ").trim();
}

export function isRetryableToolCallStreamDiagnostic(diagnostic: ToolCallStreamDiagnostic): boolean {
	return diagnostic.state !== "completed_tool_call_missing_trailing_stop";
}

export function getToolCallStreamMaxRetries(): number {
	return TOOL_CALL_STREAM_MAX_RETRIES;
}

export function getToolCallStreamRetryDelayMs(attempt: number): number {
	return TOOL_CALL_STREAM_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
}
export class ToolCallStreamDiagnosticError extends Error {
	readonly diagnostic: ToolCallStreamDiagnostic;

	constructor(diagnostic: ToolCallStreamDiagnostic) {
		super(formatToolCallStreamDiagnosticMessage(diagnostic));
		this.name = "ToolCallStreamDiagnosticError";
		this.diagnostic = diagnostic;
	}
}

export function isToolCallStreamDiagnosticError(error: unknown): error is ToolCallStreamDiagnosticError {
	return error instanceof ToolCallStreamDiagnosticError;
}
