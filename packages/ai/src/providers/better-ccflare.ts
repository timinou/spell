import { Anthropic } from "@anthropic-ai/sdk";
import { abortableSleep } from "@spell/pi-utils";
import { calculateCost } from "../models";
import { getEnvApiKey } from "../stream";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	RedactedThinkingContent,
	StreamFunction,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types";
import {
	appendToolCallStreamDiagnostic,
	classifyAssistantStreamInterruption,
	getToolCallStreamMaxRetries,
	getToolCallStreamRetryDelayMs,
	hasActiveToolArgumentStreaming,
	ToolCallStreamDiagnosticError,
} from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { finalizeErrorMessage, type RawHttpRequestDump } from "../utils/http-inspector";
import {
	getAnthropicStreamIdleTimeoutMs,
	getToolArgumentStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { parseStreamingJson } from "../utils/json-parse";
import { pushFallbackError } from "../utils/provider-error-boundary";
import type { AnthropicOptions } from "./anthropic";
import {
	buildBetaHeader,
	buildParams,
	claudeCodeBetaDefaults,
	claudeCodeHeaders,
	claudeCodeVersion,
	getHeaderCaseInsensitive,
	isAnthropicOAuthToken,
	isClaudeCodeClientUserAgent,
	isProviderRetryableError,
	isTransientStreamParseError,
	mapStopReason,
	normalizeExtraBetas,
	resolveAnthropicBaseUrl,
	stripClaudeToolPrefix,
} from "./anthropic";

export interface BetterCcflareHeaderOptions {
	apiKey: string;
	baseUrl?: string;
	isOAuth?: boolean;
	extraBetas?: string[];
	stream?: boolean;
	modelHeaders?: Record<string, string>;
}

export function buildBetterCcflareHeaders(options: BetterCcflareHeaderOptions): Record<string, string> {
	const oauthToken = options.isOAuth ?? isAnthropicOAuthToken(options.apiKey);
	const extraBetas = options.extraBetas ?? [];
	const stream = options.stream ?? false;
	const betaHeader = buildBetaHeader(claudeCodeBetaDefaults, extraBetas);
	const acceptHeader = stream ? "text/event-stream" : "application/json";
	const incomingUserAgent = getHeaderCaseInsensitive(options.modelHeaders, "User-Agent");
	const userAgent = isClaudeCodeClientUserAgent(incomingUserAgent)
		? incomingUserAgent
		: `claude-cli/${claudeCodeVersion} (external, cli)`;

	const headers: Record<string, string> = {
		...claudeCodeHeaders,
		Accept: acceptHeader,
		"Accept-Encoding": "gzip, deflate, br",
		Connection: "keep-alive",
		"Content-Type": "application/json",
		"Anthropic-Version": "2023-06-01",
		"Anthropic-Dangerous-Direct-Browser-Access": "true",
		"Anthropic-Beta": betaHeader,
		"User-Agent": userAgent,
		"X-App": "cli",
	};

	// Auth: OAuth passthrough when apiKey is empty/falsy
	if (options.apiKey) {
		if (oauthToken) {
			headers.Authorization = `Bearer ${options.apiKey}`;
		} else {
			headers["x-api-key"] = options.apiKey;
		}
	}
	// else: NO auth header → OAuth passthrough mode

	// Apply model-specific headers, respecting enforced keys
	const enforcedHeaderKeys = new Set(Object.keys(headers).map(key => key.toLowerCase()));
	if (options.modelHeaders) {
		for (const [key, value] of Object.entries(options.modelHeaders)) {
			if (!enforcedHeaderKeys.has(key.toLowerCase())) {
				headers[key] = value;
			}
		}
	}

	return headers;
}

export const streamBetterCcflare: StreamFunction<"anthropic-messages"> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let rawRequestDump: RawHttpRequestDump | undefined;

		try {
			const apiKey = options?.apiKey ?? getEnvApiKey("better-ccflare") ?? "";
			const baseUrl = resolveAnthropicBaseUrl(model, apiKey) ?? "http://localhost:8080";
			const isOAuthToken = isAnthropicOAuthToken(apiKey);

			// Build headers using better-ccflare specific function
			const extraBetas = normalizeExtraBetas(options?.betas);
			const defaultHeaders = buildBetterCcflareHeaders({
				apiKey,
				baseUrl,
				extraBetas,
				stream: true,
				modelHeaders: options?.headers,
			});

			const client = new Anthropic({
				apiKey: apiKey || "dummy", // SDK requires non-empty string
				baseURL: baseUrl,
				maxRetries: 4,
				dangerouslyAllowBrowser: true,
				defaultHeaders,
			});

			let params = buildParams(model, context, isOAuthToken, options);
			const replacementPayload = await options?.onPayload?.(params, model);
			if (replacementPayload !== undefined) {
				params = replacementPayload as typeof params;
			}

			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url: `${baseUrl}/messages`,
				body: params,
			};

			type Block = (
				| ThinkingContent
				| RedactedThinkingContent
				| TextContent
				| (ToolCall & { partialJson: string })
			) & { index: number };
			const blocks = output.content as Block[];
			stream.push({ type: "start", partial: output });

			const streamIdleTimeoutMs = getAnthropicStreamIdleTimeoutMs();
			const toolArgumentIdleTimeoutMs = getToolArgumentStreamIdleTimeoutMs(streamIdleTimeoutMs);
			let providerRetryAttempt = 0;
			let started = false;
			do {
				const requestAbortController = new AbortController();
				const requestSignal = options?.signal
					? AbortSignal.any([options.signal, requestAbortController.signal])
					: requestAbortController.signal;
				const anthropicStream = client.messages.stream({ ...params, stream: true }, { signal: requestSignal });

				try {
					for await (const event of iterateWithIdleTimeout(anthropicStream, {
						idleTimeoutMs: streamIdleTimeoutMs,
						getIdleTimeoutMs: () =>
							hasActiveToolArgumentStreaming(output) ? toolArgumentIdleTimeoutMs : streamIdleTimeoutMs,
						errorMessage: "Anthropic messages stream stalled while waiting for the next event",
						onIdle: () => requestAbortController.abort(),
					})) {
						started = true;
						if (event.type === "message_start") {
							// Capture initial token usage from message_start event
							// This ensures we have input token counts even if the stream is aborted early
							output.usage.input = event.message.usage.input_tokens || 0;
							output.usage.output = event.message.usage.output_tokens || 0;
							output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
							output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
							// Anthropic doesn't provide total_tokens, compute from components
							output.usage.totalTokens =
								output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model, output.usage);
						} else if (event.type === "content_block_start") {
							if (!firstTokenTime) firstTokenTime = Date.now();
							if (event.content_block.type === "text") {
								const block: Block = {
									type: "text",
									text: "",
									index: event.index,
								};
								output.content.push(block);
								stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
							} else if (event.content_block.type === "thinking") {
								const block: Block = {
									type: "thinking",
									thinking: "",
									thinkingSignature: "",
									index: event.index,
								};
								output.content.push(block);
								stream.push({
									type: "thinking_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							} else if (event.content_block.type === "redacted_thinking") {
								const block: Block = {
									type: "redactedThinking",
									data: event.content_block.data,
									index: event.index,
								};
								output.content.push(block);
							} else if (event.content_block.type === "tool_use") {
								const block: Block = {
									type: "toolCall",
									id: event.content_block.id,
									name: isOAuthToken
										? stripClaudeToolPrefix(event.content_block.name)
										: event.content_block.name,
									arguments: (event.content_block.input as Record<string, unknown>) ?? {},
									partialJson: "",
									index: event.index,
								};
								output.content.push(block);
								stream.push({
									type: "toolcall_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							}
						} else if (event.type === "content_block_delta") {
							if (event.delta.type === "text_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "text") {
									block.text += event.delta.text;
									stream.push({
										type: "text_delta",
										contentIndex: index,
										delta: event.delta.text,
										partial: output,
									});
								}
							} else if (event.delta.type === "thinking_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "thinking") {
									block.thinking += event.delta.thinking;
									stream.push({
										type: "thinking_delta",
										contentIndex: index,
										delta: event.delta.thinking,
										partial: output,
									});
								}
							} else if (event.delta.type === "input_json_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "toolCall") {
									block.partialJson += event.delta.partial_json;
									block.arguments = parseStreamingJson(block.partialJson);
									stream.push({
										type: "toolcall_delta",
										contentIndex: index,
										delta: event.delta.partial_json,
										partial: output,
									});
								}
							} else if (event.delta.type === "signature_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "thinking") {
									block.thinkingSignature = block.thinkingSignature || "";
									block.thinkingSignature += event.delta.signature;
								}
							}
						} else if (event.type === "content_block_stop") {
							const index = blocks.findIndex(b => b.index === event.index);
							const block = blocks[index];
							if (block) {
								delete (block as { index?: number }).index;
								if (block.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex: index,
										content: block.text,
										partial: output,
									});
								} else if (block.type === "thinking") {
									// Orphan guard: a signature with no body means the relay
									// forwarded signature_delta but not thinking_delta. That
									// signature can never validate against empty text, so discard
									// it rather than persist a block the API later rejects.
									if (block.thinking.length === 0) block.thinkingSignature = "";
									stream.push({
										type: "thinking_end",
										contentIndex: index,
										content: block.thinking,
										partial: output,
									});
								} else if (block.type === "toolCall") {
									block.arguments = parseStreamingJson(block.partialJson);
									delete (block as { partialJson?: string }).partialJson;
									stream.push({
										type: "toolcall_end",
										contentIndex: index,
										toolCall: block,
										partial: output,
									});
								}
							}
						} else if (event.type === "message_delta") {
							if (event.delta.stop_reason) {
								output.stopReason = mapStopReason(event.delta.stop_reason);
							}
							// Only update usage fields if present (not null).
							// Preserves input_tokens from message_start when proxies omit it in message_delta.
							if (event.usage.input_tokens != null) {
								output.usage.input = event.usage.input_tokens;
							}
							if (event.usage.output_tokens != null) {
								output.usage.output = event.usage.output_tokens;
							}
							if (event.usage.cache_read_input_tokens != null) {
								output.usage.cacheRead = event.usage.cache_read_input_tokens;
							}
							if (event.usage.cache_creation_input_tokens != null) {
								output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
							}
							// Anthropic doesn't provide total_tokens, compute from components
							output.usage.totalTokens =
								output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model, output.usage);
						}
					}

					if (options?.signal?.aborted) {
						throw new Error("Request was aborted");
					}

					if (output.stopReason === "stop" && output.content.some(block => block.type === "toolCall")) {
						output.stopReason = "toolUse";
					}
					if (output.stopReason === "aborted" || output.stopReason === "error") {
						throw new Error("An unknown error occurred");
					}
					break; // Stream completed successfully
				} catch (streamError) {
					const idleTimeoutMs = hasActiveToolArgumentStreaming(output)
						? toolArgumentIdleTimeoutMs
						: streamIdleTimeoutMs;
					const stallDiagnostic =
						streamError instanceof Error &&
						streamError.message.includes("Anthropic messages stream stalled while waiting for the next event")
							? classifyAssistantStreamInterruption(output, {
									firstTokenTimeMs: firstTokenTime ? firstTokenTime - startTime : undefined,
									idleTimeoutMs,
									providerRetryAttempt,
								})
							: undefined;
					if (stallDiagnostic) {
						appendToolCallStreamDiagnostic(output, stallDiagnostic);
					}
					if (stallDiagnostic?.state === "completed_tool_call_missing_trailing_stop") {
						output.stopReason = "toolUse";
						break;
					}
					const finalStreamError = stallDiagnostic
						? new ToolCallStreamDiagnosticError(stallDiagnostic)
						: streamError;
					const isTransient =
						isTransientStreamParseError(streamError) || stallDiagnostic?.state === "stalled_incomplete_tool_args";
					if (
						options?.signal?.aborted ||
						providerRetryAttempt >= getToolCallStreamMaxRetries() ||
						(stallDiagnostic !== undefined && !isTransient) ||
						(stallDiagnostic === undefined && !isTransient && firstTokenTime !== undefined) ||
						(stallDiagnostic === undefined && !isTransient && !isProviderRetryableError(streamError))
					) {
						throw finalStreamError;
					}
					providerRetryAttempt++;
					await abortableSleep(getToolCallStreamRetryDelayMs(providerRetryAttempt), options?.signal);
					// Reset output state for clean retry
					output.content.length = 0;
					output.stopReason = "stop";
					firstTokenTime = undefined;
					started = false;
				}
			} while (!started);

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			try {
				for (const block of output.content) {
					if ("index" in block) delete block.index;
					if ("partialJson" in block) delete block.partialJson;
				}
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				if (error instanceof ToolCallStreamDiagnosticError) {
					const lastDiagnostic = output.streamDiagnostics?.at(-1);
					if (lastDiagnostic !== error.diagnostic) {
						output.streamDiagnostics = [...(output.streamDiagnostics ?? []), error.diagnostic];
					}
				}
				output.errorMessage = await finalizeErrorMessage(error, rawRequestDump);
				output.duration = Date.now() - startTime;
				if (firstTokenTime) output.ttft = firstTokenTime - startTime;
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end();
			} catch (innerError) {
				pushFallbackError(stream, model, innerError);
			}
		}
	})().catch(err => pushFallbackError(stream, model, err));

	return stream;
};
