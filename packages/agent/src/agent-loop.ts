/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */
import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	StreamFn,
} from "./types";

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [...prompts];
		const currentContext: AgentContext = {
			...context,
			messages: [...context.messages, ...prompts],
		};

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });
		for (const prompt of prompts) {
			stream.push({ type: "message_start", message: prompt });
			stream.push({ type: "message_end", message: prompt });
		}

		try {
			await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error("Agent loop failed", { error: msg, stack: error instanceof Error ? error.stack : undefined });
			try {
				stream.push({ type: "agent_end", messages: newMessages });
				stream.end(newMessages);
			} catch {
				// stream may already be ended
			}
		}
	})();

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [];
		const currentContext: AgentContext = { ...context };

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });

		try {
			await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error("Agent loop failed", { error: msg, stack: error instanceof Error ? error.stack : undefined });
			try {
				stream.push({ type: "agent_end", messages: newMessages });
				stream.end(newMessages);
			} catch {
				// stream may already be ended
			}
		}
	})();

	return stream;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

function normalizeMessagesForProvider(
	messages: Context["messages"],
	model: AgentLoopConfig["model"],
): Context["messages"] {
	if (model.provider !== "cerebras") {
		return messages;
	}

	let changed = false;
	const normalized = messages.map(message => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			return message;
		}

		const filtered = message.content.filter(block => block.type !== "thinking");
		if (filtered.length === message.content.length) {
			return message;
		}

		changed = true;
		return { ...message, content: filtered };
	});

	return changed ? normalized : messages;
}

export const INTENT_FIELD = "_i";

function injectIntentIntoSchema(schema: unknown): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
	const schemaRecord = schema as Record<string, unknown>;
	const propertiesValue = schemaRecord.properties;
	const properties =
		propertiesValue && typeof propertiesValue === "object" && !Array.isArray(propertiesValue)
			? (propertiesValue as Record<string, unknown>)
			: {};
	const requiredValue = schemaRecord.required;
	const required = Array.isArray(requiredValue)
		? requiredValue.filter((item): item is string => typeof item === "string")
		: [];
	if (INTENT_FIELD in properties) {
		const { [INTENT_FIELD]: intentProp, ...rest } = properties;
		const needsReorder = Object.keys(properties)[0] !== INTENT_FIELD;
		const needsRequired = !required.includes(INTENT_FIELD);
		if (!needsReorder && !needsRequired) return schema;
		return {
			...schemaRecord,
			...(needsReorder ? { properties: { [INTENT_FIELD]: intentProp, ...rest } } : {}),
			...(needsRequired ? { required: [...required, INTENT_FIELD] } : {}),
		};
	}
	return {
		...schemaRecord,
		properties: {
			[INTENT_FIELD]: {
				type: "string",
			},
			...properties,
		},
		required: [...required, INTENT_FIELD],
	};
}

function normalizeTools(tools: Context["tools"], injectIntent: boolean): Context["tools"] {
	return tools?.map(tool => ({
		...tool,
		description: tool.description || "",
		...(injectIntent && { parameters: injectIntentIntoSchema(tool.parameters) as typeof tool.parameters }),
	}));
}

function extractIntent(args: Record<string, unknown>): { intent?: string; strippedArgs: Record<string, unknown> } {
	const intent = args[INTENT_FIELD];
	if (typeof intent !== "string") {
		return { strippedArgs: args };
	}
	const { [INTENT_FIELD]: _ignored, ...strippedArgs } = args;
	const trimmed = intent.trim();
	return { intent: trimmed.length > 0 ? trimmed : undefined, strippedArgs };
}

/**
 * Mid-stream eager dispatch entry — BUG-423.
 *
 * When a parallel-mode tool's `toolcall_end` event fires inside
 * `streamAssistantResponse`, we kick off `tool.execute(...)` right then. The
 * in-flight promise (plus the bookkeeping `executeToolCalls` needs to skip
 * re-execution) lands in a per-turn map keyed by `toolCallId`. The post-stream
 * batch dispatch later picks the entry up, awaits its result, and emits the
 * `tool_execution_end` + `tool_result` events in source order.
 *
 * `started: true` suppresses the duplicate `tool_execution_start` that
 * `runTool` would otherwise emit. `intent` and `args` are pre-extracted here
 * because we already had to call `extractIntent` to invoke `tool.execute`
 * cleanly; mirroring that in `runTool` would either duplicate work or skew
 * the recorded args.
 */
interface EagerDispatchEntry {
	promise: Promise<{ result: AgentToolResult<any>; isError: boolean }>;
	args: Record<string, unknown>;
	intent?: string;
}
type EagerDispatchMap = Map<string, EagerDispatchEntry>;

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;
		let steeringAfterTools: AgentMessage[] | null = null;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				stream.push({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					stream.push({ type: "message_start", message });
					stream.push({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Refresh prompt/tool context from live state before each model call
			if (config.syncContextBeforeModelCall) {
				await config.syncContextBeforeModelCall(currentContext);
			}

			// Eager-dispatch map for this turn. Parallel tools whose `toolcall_end`
			// fires inside `streamAssistantResponse` land here as in-flight promises;
			// `executeToolCalls` picks them up via the same map. BUG-423.
			const eagerDispatch: EagerDispatchMap = new Map();

			// Stream assistant response
			const message = await streamAssistantResponse(
				currentContext,
				config,
				signal,
				stream,
				streamFn,
				eagerDispatch,
			);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				// Create placeholder tool results for any tool calls in the aborted message
				// This maintains the tool_use/tool_result pairing that the API requires
				type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
				const toolCalls = message.content.filter((c): c is ToolCallContent => c.type === "toolCall");
				const toolResults: ToolResultMessage[] = [];
				for (const toolCall of toolCalls) {
					const result = createAbortedToolResult(toolCall, stream, message.stopReason, message.errorMessage);
					currentContext.messages.push(result);
					newMessages.push(result);
					toolResults.push(result);
				}
				stream.push({ type: "turn_end", message, toolResults });
				stream.push({ type: "agent_end", messages: newMessages });
				stream.end(newMessages);
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter(c => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				const toolExecution = await executeToolCalls(
					currentContext.tools,
					message,
					signal,
					stream,
					config.getSteeringMessages,
					config.getToolContext,
					config.interruptMode,
					config.transformToolCallArguments,
					config.intentTracing,
					config.resolveUnknownTool,
					eagerDispatch,
				);
				toolResults.push(...toolExecution.toolResults);
				steeringAfterTools = toolExecution.steeringMessages ?? null;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			stream.push({ type: "turn_end", message, toolResults });

			// Get steering messages after turn completes
			if (steeringAfterTools && steeringAfterTools.length > 0) {
				pendingMessages = steeringAfterTools;
				steeringAfterTools = null;
			} else {
				pendingMessages = (await config.getSteeringMessages?.()) || [];
			}
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	stream.push({ type: "agent_end", messages: newMessages });
	stream.end(newMessages);
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
	eagerDispatch?: EagerDispatchMap,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);
	const normalizedMessages = normalizeMessagesForProvider(llmMessages, config.model);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: normalizedMessages,
		tools: normalizeTools(context.tools, !!config.intentTracing),
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const dynamicToolChoice = config.getToolChoice?.();

	// Stream-barrier abort controller — separate from the user/turn signal so we
	// can cut the SSE on a sequential toolcall_end without conflating with user
	// cancellation. Compose with the caller's signal so either source aborts the
	// upstream stream.
	const barrierAbort = new AbortController();
	const providerSignal = signal
		? AbortSignal.any([signal, barrierAbort.signal])
		: barrierAbort.signal;
	const barrierEnabled = (config.sequentialToolStreamBarrier ?? "enforce") === "enforce";

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		toolChoice: dynamicToolChoice ?? config.toolChoice,
		signal: providerSignal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		// Check for abort signal before processing each event
		if (signal?.aborted) {
			const errorMessage = "Request was aborted";
			const abortedMessage: AssistantMessage = partialMessage
				? { ...partialMessage, stopReason: "aborted", errorMessage }
				: {
						role: "assistant",
						content: [],
						api: config.model.api,
						provider: config.model.provider,
						model: config.model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "aborted",
						errorMessage,
						timestamp: Date.now(),
					};
			if (addedPartial) {
				context.messages[context.messages.length - 1] = abortedMessage;
			} else {
				context.messages.push(abortedMessage);
				stream.push({ type: "message_start", message: { ...abortedMessage } });
			}
			stream.push({ type: "message_end", message: abortedMessage });
			return abortedMessage;
		}

		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				stream.push({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					stream.push({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					stream.push({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});

					// Eager dispatch for parallel tools (BUG-423). The tool starts
					// executing the moment its args are complete, alongside the rest
					// of the streaming assistant message. Sequential tools fall through
					// to the barrier branch below and never reach this path. Unknown
					// tools (not in context.tools) fail open here — their error result
					// is produced post-stream by `executeToolCalls`.
					const earlyDispatchEnabled =
						(config.earlyDispatchParallelTools ?? "enforce") === "enforce";
					if (earlyDispatchEnabled && eagerDispatch) {
						const tool = context.tools?.find(t => t.name === event.toolCall.name);
						if (tool && tool.executionMode !== "sequential" && !eagerDispatch.has(event.toolCall.id)) {
							const rawArgs = event.toolCall.arguments as Record<string, unknown>;
							let args = rawArgs;
							let intent: string | undefined;
							if (config.intentTracing) {
								const extracted = extractIntent(rawArgs);
								args = extracted.strippedArgs;
								intent = extracted.intent;
							}
							// Emit tool_execution_start now so downstream UI can mount the
							// cell, mirroring `executeToolCalls.runTool`'s contract. The
							// matching tool_execution_end is emitted by executeToolCalls
							// once it awaits this entry's promise — keeping the source-
							// ordered tool_use/tool_result pairing the API requires.
							stream.push({
								type: "tool_execution_start",
								toolCallId: event.toolCall.id,
								toolName: event.toolCall.name,
								args,
								intent,
							});
							// Build the execute() invocation. Validation, transform, and
							// intent handling mirror `runTool`. Errors get captured as
							// `{ result, isError: true }` so executeToolCalls can emit
							// them through its normal channels without re-running the tool.
							const toolCallForExec = { ...event.toolCall, arguments: args };
							const promise = (async (): Promise<{ result: AgentToolResult<any>; isError: boolean }> => {
								try {
									let effectiveArgs: Record<string, unknown>;
									try {
										effectiveArgs = validateToolArguments(tool, toolCallForExec);
									} catch (validationError) {
										if (tool.lenientArgValidation) {
											effectiveArgs = args;
										} else {
											throw validationError;
										}
									}
									const toolContext = config.getToolContext
										? config.getToolContext({
												batchId: `eager_${event.toolCall.id}`,
												index: 0,
												total: 1,
												toolCalls: [{ id: event.toolCall.id, name: event.toolCall.name }],
										})
										: undefined;
									const result = await tool.execute(
										event.toolCall.id,
										config.transformToolCallArguments
											? config.transformToolCallArguments(effectiveArgs, event.toolCall.name)
											: effectiveArgs,
										tool.nonAbortable ? undefined : signal,
										partialResult => {
											stream.push({
												type: "tool_execution_update",
												toolCallId: event.toolCall.id,
												toolName: event.toolCall.name,
												args,
												partialResult,
											});
										},
										toolContext,
									);
									return { result, isError: false };
								} catch (err) {
									return {
										result: {
											content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
											details: {},
										},
										isError: true,
									};
								}
							})();
							eagerDispatch.set(event.toolCall.id, { promise, args, intent });
						}
					}

					// Stream barrier: if this tool declares executionMode "sequential"
					// (ask / await / cancel_job / exit_plan_mode / browser), cut the SSE
					// at this block. The model can't see the tool's result mid-stream so
					// anything it generates past this point reasons against fictitious
					// state. We close the turn here, executeToolCalls runs the trimmed
					// batch, and the next assistant turn starts with real context.
					if (barrierEnabled) {
						const barrierTool = context.tools?.find(t => t.name === event.toolCall.name);
						const trimmedMessage = partialMessage;
						if (barrierTool?.executionMode === "sequential") {
							const barrierIndex = trimmedMessage.content.findIndex(
								c => c.type === "toolCall" && c.id === event.toolCall.id,
							);
							if (barrierIndex >= 0) {
								type ContentBlock = (typeof trimmedMessage.content)[number];
								const keptContent: ContentBlock[] = trimmedMessage.content
									.slice(0, barrierIndex + 1)
									.map(block => {
										// Strip provider streaming residue from kept blocks so
										// the trimmed message round-trips cleanly through
										// history / convertToLlm. Mirrors the cleanup the
										// Anthropic provider already runs on its error path.
										const clean: Record<string, unknown> = { ...(block as object) };
										delete clean.partialJson;
										delete clean.index;
										return clean as unknown as ContentBlock;
									});
								const finalMessage: AssistantMessage = {
									...trimmedMessage,
									content: keptContent,
									stopReason: "toolUse",
								};
								if (addedPartial) {
									context.messages[context.messages.length - 1] = finalMessage;
								} else {
									context.messages.push(finalMessage);
									stream.push({ type: "message_start", message: { ...finalMessage } });
								}
								stream.push({ type: "message_end", message: finalMessage });
								// Best-effort cancel the upstream provider stream. The
								// provider's for-await consumer should observe `signal.aborted`
								// at its next iteration and exit cleanly.
								barrierAbort.abort();
								return finalMessage;
							}
						}
					}
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					stream.push({ type: "message_start", message: { ...finalMessage } });
				}
				stream.push({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	return await response.result();
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	tools: AgentTool<any>[] | undefined,
	assistantMessage: AssistantMessage,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	getSteeringMessages?: AgentLoopConfig["getSteeringMessages"],
	getToolContext?: AgentLoopConfig["getToolContext"],
	interruptMode: AgentLoopConfig["interruptMode"] = "immediate",
	transformToolCallArguments?: AgentLoopConfig["transformToolCallArguments"],
	intentTracing?: AgentLoopConfig["intentTracing"],
	resolveUnknownTool?: AgentLoopConfig["resolveUnknownTool"],
	eagerDispatch?: EagerDispatchMap,
): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> {
	type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
	const toolCalls = assistantMessage.content.filter((c): c is ToolCallContent => c.type === "toolCall");
	const emittedToolResults: ToolResultMessage[] = [];
	let steeringMessages: AgentMessage[] | undefined;
	const shouldInterruptImmediately = interruptMode !== "wait";
	const toolCallInfos = toolCalls.map(call => ({ id: call.id, name: call.name }));
	const batchId = `${assistantMessage.timestamp ?? Date.now()}_${toolCalls[0]?.id ?? "batch"}`;
	const steeringAbortController = new AbortController();
	const toolSignal = signal
		? AbortSignal.any([signal, steeringAbortController.signal])
		: steeringAbortController.signal;
	const interruptState = { triggered: false };
	let steeringCheck: Promise<void> | null = null;

	const checkSteering = async (): Promise<void> => {
		if (!shouldInterruptImmediately || !getSteeringMessages || interruptState.triggered) {
			return;
		}
		if (steeringCheck) {
			await steeringCheck;
			return;
		}
		steeringCheck = (async () => {
			const steering = await getSteeringMessages();
			if (steering.length > 0) {
				steeringMessages = steering;
				interruptState.triggered = true;
				steeringAbortController.abort();
			}
		})().finally(() => {
			steeringCheck = null;
		});
		await steeringCheck;
	};

	const records = toolCalls.map(toolCall => ({
		toolCall,
		tool: tools?.find(t => t.name === toolCall.name),
		args: toolCall.arguments as Record<string, unknown>,
		started: false,
		result: undefined as AgentToolResult<any> | undefined,
		isError: false,
		skipped: false,
		toolResultMessage: undefined as ToolResultMessage | undefined,
		resultEmitted: false,
	}));

	// Resolve deferred/tiered tools that aren't in the active set
	if (resolveUnknownTool) {
		for (const record of records) {
			if (!record.tool) {
				const resolved = await resolveUnknownTool(record.toolCall.name);
				if (resolved) {
					record.tool = resolved;
				}
			}
		}
	}

	const emitToolResult = (record: (typeof records)[number], result: AgentToolResult<any>, isError: boolean): void => {
		if (record.resultEmitted) return;
		const { toolCall } = record;
		if (!record.started) {
			stream.push({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: record.args,
				intent: toolCall.intent,
			});
		}
		stream.push({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError,
		});

		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			details: result.details,
			isError,
			timestamp: Date.now(),
		};
		record.result = result;
		record.isError = isError;
		record.toolResultMessage = toolResultMessage;
		record.resultEmitted = true;
		emittedToolResults.push(toolResultMessage);

		stream.push({ type: "message_start", message: toolResultMessage });
		stream.push({ type: "message_end", message: toolResultMessage });
	};

	const runTool = async (record: (typeof records)[number], index: number): Promise<void> => {
		if (interruptState.triggered) {
			record.skipped = true;
			return;
		}

		const { toolCall, tool } = record;

		// Eager-dispatch consumer (BUG-423). When `streamAssistantResponse`
		// kicked off this tool mid-stream, the entry holds the in-flight
		// promise plus the pre-extracted intent / args. We await its result
		// and emit through the normal channels, suppressing the duplicate
		// tool_execution_start (which already fired at dispatch time) by
		// flipping `record.started` before `emitToolResult` checks it.
		const eagerEntry = eagerDispatch?.get(toolCall.id);
		if (eagerEntry) {
			record.args = eagerEntry.args;
			if (eagerEntry.intent) {
				toolCall.intent = eagerEntry.intent;
			}
			record.started = true; // suppress duplicate tool_execution_start in emitToolResult
			const { result, isError } = await eagerEntry.promise;
			emitToolResult(record, result, isError);
			await checkSteering();
			return;
		}

		let argsForExecution = toolCall.arguments as Record<string, unknown>;
		if (intentTracing) {
			const { intent, strippedArgs } = extractIntent(toolCall.arguments);
			argsForExecution = strippedArgs;
			if (intent) {
				toolCall.intent = intent;
			}
		}
		record.args = argsForExecution;
		record.started = true;
		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: argsForExecution,
			intent: toolCall.intent,
		});

		let result: AgentToolResult<any>;
		let isError = false;

		try {
			if (!tool) throw new Error(`Tool ${toolCall.name} not found`);

			let effectiveArgs: Record<string, unknown>;
			try {
				effectiveArgs = validateToolArguments(tool, { ...toolCall, arguments: argsForExecution });
			} catch (validationError) {
				if (tool.lenientArgValidation) {
					effectiveArgs = argsForExecution;
				} else {
					throw validationError;
				}
			}
			const toolContext = getToolContext
				? getToolContext({
						batchId,
						index,
						total: toolCalls.length,
						toolCalls: toolCallInfos,
					})
				: undefined;
			result = await tool.execute(
				toolCall.id,
				transformToolCallArguments ? transformToolCallArguments(effectiveArgs, toolCall.name) : effectiveArgs,
				tool.nonAbortable ? undefined : toolSignal,
				partialResult => {
					if (interruptState.triggered) return;
					stream.push({
						type: "tool_execution_update",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						args: argsForExecution,
						partialResult,
					});
				},
				toolContext,
			);
		} catch (e) {
			result = {
				content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
				details: {},
			};
			isError = true;
		}

		if (interruptState.triggered) {
			record.skipped = true;
			emitToolResult(record, createSkippedToolResult(), true);
		} else {
			emitToolResult(record, result, isError);
		}

		await checkSteering();
	};

	// Tool concurrency model:
	//
	// Tools that have an INTERNAL consistency invariant (file locks, per-session
	// mutexes, ephemeral subprocesses) own their serialization at the layer that
	// holds the invariant. Examples that DO NOT lift the invariant here:
	//   - edit       → kernel per-file fd_lock + in-memory buffer Mutex
	//   - todo_write → per-session queueTodoMutation chain
	//   - bash       → ephemeral per-call shell (no shared cwd/env to corrupt)
	//   - ssh        → stateless per-call remote exec over concurrency-safe mux
	//
	// Tools whose semantics REQUIRE batch-wide exclusivity — blocking on user
	// input, mutating the agent's tool set/mode, or acting as a sync point for
	// siblings in the SAME batch — declare `executionMode: "sequential"` on the
	// tool definition. When any tool in the current batch declares it, the
	// whole batch executes serially in assistant source order. This is the only
	// concurrency knob: one boolean per tool, one decision per batch. We do not
	// re-introduce wave scheduling — that previously turned every gated tool
	// into a whole-batch barrier and tangled invariants across layers.
	const wantsSequential = records.some(record => record.tool?.executionMode === "sequential");

	if (wantsSequential) {
		for (let index = 0; index < records.length; index++) {
			if (interruptState.triggered) break;
			await runTool(records[index], index);
		}
	} else {
		const tasks = records.map((_, index) => runTool(records[index], index));
		await Promise.allSettled(tasks);
	}

	for (const record of records) {
		if (!record.toolResultMessage) {
			record.skipped = true;
			emitToolResult(record, createSkippedToolResult(), true);
		}
	}

	return { toolResults: emittedToolResults, steeringMessages };
}

function createSkippedToolResult(): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: "Skipped due to queued user message." }],
		details: {},
	};
}

/**
 * Create a tool result for a tool call that was aborted or errored before execution.
 * Maintains the tool_use/tool_result pairing required by the API.
 */
function createAbortedToolResult(
	toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	reason: "aborted" | "error",
	errorMessage?: string,
): ToolResultMessage {
	const message = reason === "aborted" ? "Tool execution was aborted" : "Tool execution failed due to an error";
	const result: AgentToolResult<any> = {
		content: [{ type: "text", text: errorMessage ? `${message}: ${errorMessage}` : `${message}.` }],
		details: {},
	};

	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
		intent: toolCall.intent,
	});
	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError: true,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: {},
		isError: true,
		timestamp: Date.now(),
	};

	stream.push({ type: "message_start", message: toolResultMessage });
	stream.push({ type: "message_end", message: toolResultMessage });

	return toolResultMessage;
}
