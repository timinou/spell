import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { CodeTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as nativesModule from "@oh-my-pi/pi-natives";

function createAgent(): Agent {
	return new Agent({
		initialState: {
			systemPrompt: "system prompt",
			messages: [],
			tools: [],
		},
	});
}

function createToolSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function getText(message: Message | undefined): string {
	if (!message || typeof message.content === "string")
		return typeof message?.content === "string" ? message.content : "";
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("");
}

describe("AgentSession message pipeline", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("applies transformContext before convertToLlm", async () => {
		const inputMessages: AgentMessage[] = [{ role: "user", content: "hello", timestamp: Date.now() }];
		const transformedMessages: AgentMessage[] = [
			...inputMessages,
			{ role: "user", content: "injected context", timestamp: Date.now() },
		];
		const convertedMessages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "converted" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		];
		const transformContext = vi.fn(async (messages: AgentMessage[], signal?: AbortSignal) => {
			expect(signal).toBe(abortController.signal);
			return [...messages, ...transformedMessages.slice(messages.length)];
		});
		const convertToLlm = vi.fn(async (_messages: AgentMessage[]) => {
			return convertedMessages;
		});
		const abortController = new AbortController();
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			transformContext,
			convertToLlm,
		});
		sessions.push(session);

		const result = await session.convertMessagesToLlm(inputMessages, abortController.signal);

		expect(transformContext).toHaveBeenCalledWith(inputMessages, abortController.signal);
		expect(convertToLlm).toHaveBeenCalledWith(transformedMessages);
		expect(result).toEqual(convertedMessages);
	});

	it("composes session payload hooks into direct side-request options", async () => {
		const sessionOnPayload = vi.fn(async (payload: unknown) => ({
			...(payload as Record<string, unknown>),
			session: true,
		}));
		const requestOnPayload = vi.fn(async () => undefined);
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			onPayload: sessionOnPayload,
		});
		sessions.push(session);
		const options: SimpleStreamOptions = {
			apiKey: "key", // pragma: allowlist secret
			onPayload: requestOnPayload,
		};

		const prepared = session.prepareSimpleStreamOptions(options);
		const result = await prepared.onPayload?.({ original: true });

		expect(sessionOnPayload).toHaveBeenCalledWith({ original: true }, undefined);
		expect(requestOnPayload).toHaveBeenCalledWith({ original: true, session: true }, undefined);
		expect(result).toEqual({ original: true, session: true });
	});

	it("passes compact code tool context through the session pipeline without serializing details", async () => {
		spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { version: 2, diff: "@@ add @@\n-return a + b;\n+return a * b;", editCount: 1 },
			error: false,
		});
		const codeTool = new CodeTool(createToolSession());
		const toolResult = await codeTool.execute("call-1", {
			command: "edit",
			file: "/tmp/test/src/main.ts",
			symbol: "add",
			operation: "patch",
			patches: [{ find: "return a + b;", replace: "return a * b;" }],
		});

		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		const converted = await session.convertMessagesToLlm([
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "code",
				content: toolResult.content,
				details: toolResult.details,
				isError: false,
				timestamp: Date.now(),
			},
		]);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("toolResult");
		const text = getText(converted[0]);
		expect(text).toContain("Edited src/main.ts (1 operation, buffer version 2)");
		expect(text).toContain("@@ add @@");
		expect(text).not.toContain('"editCount"');
		expect(text).not.toContain('"version"');
	});
});
