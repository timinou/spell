import { beforeEach, describe, expect, test, spyOn } from "bun:test";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Container } from "@oh-my-pi/pi-tui";
import { _resetSettingsForTest, Settings } from "../../../../src/config/settings";
import { AssistantMessageComponent } from "../../../../src/modes/components/assistant-message";
import { ReadToolGroupComponent } from "../../../../src/modes/components/read-tool-group";
import { SubagentViewerEventHandler } from "../../../../src/modes/components/subagent-viewer/event-handler";
import type { SubagentViewerContext } from "../../../../src/modes/components/subagent-viewer/types";
import { ToolExecutionComponent } from "../../../../src/modes/components/tool-execution";
import { CodeTool, type ToolSession } from "../../../../src/tools";
import * as nativesModule from "@oh-my-pi/pi-natives";

const ev = (event: unknown) => event as AgentEvent;

function createToolSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("SubagentViewerEventHandler", () => {
	let chatContainer: Container;
	let ctx: SubagentViewerContext;
	let handler: SubagentViewerEventHandler;
	let requestRender: () => void;

	beforeEach(async () => {
		initTheme();
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: "/test" });
		chatContainer = new Container();
		requestRender = () => {};
		ctx = {
			chatContainer,
			ui: {
				requestRender,
				terminal: { columns: 80, rows: 24 },
			} as unknown as SubagentViewerContext["ui"],
			toolOutputExpanded: false,
			cwd: "/test",
		};
		handler = new SubagentViewerEventHandler(ctx);
	});

	test("message_start with assistant creates AssistantMessageComponent", () => {
		handler.handleEvent(ev({ type: "message_start", message: { role: "assistant", content: [] } }));

		expect(chatContainer.children.some(child => child instanceof AssistantMessageComponent)).toBe(true);
	});

	test("message_update updates streaming component without adding children", () => {
		handler.handleEvent(ev({ type: "message_start", message: { role: "assistant", content: [] } }));
		const childCountAfterStart = chatContainer.children.length;

		handler.handleEvent(
			ev({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
				assistantMessageEvent: { type: "content", content: { type: "text", text: "hello" } },
			}),
		);

		expect(chatContainer.children).toHaveLength(childCountAfterStart);
	});

	test("message_end finalizes streaming", () => {
		handler.handleEvent(ev({ type: "message_start", message: { role: "assistant", content: [] } }));
		handler.handleEvent(
			ev({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
				},
			}),
		);
		handler.handleEvent(ev({ type: "message_start", message: { role: "assistant", content: [] } }));

		expect(chatContainer.children.filter(child => child instanceof AssistantMessageComponent)).toHaveLength(2);
	});

	test("tool_execution_start creates ToolExecutionComponent", () => {
		handler.handleEvent(
			ev({ type: "tool_execution_start", toolCallId: "tc1", toolName: "edit", args: { path: "test.ts" } }),
		);

		expect(chatContainer.children.some(child => child instanceof ToolExecutionComponent)).toBe(true);
	});

	test("tool_execution_start with read creates ReadToolGroupComponent", () => {
		handler.handleEvent(
			ev({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "a.ts" } }),
		);

		expect(chatContainer.children.some(child => child instanceof ReadToolGroupComponent)).toBe(true);
	});

	test("tool_execution_end for known then unknown id is a no-op after completion", () => {
		handler.handleEvent(
			ev({ type: "tool_execution_start", toolCallId: "tc1", toolName: "edit", args: { path: "test.ts" } }),
		);
		const childCountAfterStart = chatContainer.children.length;
		handler.handleEvent(
			ev({
				type: "tool_execution_end",
				toolCallId: "tc1",
				toolName: "edit",
				result: { content: [{ type: "text", text: "done" }] },
			}),
		);
		handler.handleEvent(
			ev({
				type: "tool_execution_end",
				toolCallId: "tc1",
				toolName: "edit",
				result: { content: [{ type: "text", text: "done again" }] },
			}),
		);

		expect(chatContainer.children).toHaveLength(childCountAfterStart);
	});

	test("clear resets internal state", () => {
		handler.handleEvent(ev({ type: "message_start", message: { role: "assistant", content: [] } }));
		handler.handleEvent(
			ev({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "a.ts" } }),
		);

		handler.clear();
		handler.handleEvent(ev({ type: "message_start", message: { role: "assistant", content: [] } }));
		handler.handleEvent(
			ev({ type: "tool_execution_start", toolCallId: "read-2", toolName: "read", args: { path: "b.ts" } }),
		);

		expect(chatContainer.children.filter(child => child instanceof AssistantMessageComponent)).toHaveLength(2);
		expect(chatContainer.children.filter(child => child instanceof ReadToolGroupComponent)).toHaveLength(2);
	});

	test("unknown event types are ignored", () => {
		handler.handleEvent(ev({ type: "agent_start" }));
		handler.handleEvent(ev({ type: "turn_start" }));

		expect(chatContainer.children).toHaveLength(0);
	});

	test("message_update without streaming component is ignored", () => {
		handler.handleEvent(
			ev({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
				assistantMessageEvent: { type: "content", content: { type: "text", text: "hello" } },
			}),
		);

		expect(chatContainer.children).toHaveLength(0);
	});

	test("message_start with non-assistant role is ignored", () => {
		handler.handleEvent(ev({ type: "message_start", message: { role: "user", content: [] } }));

		expect(chatContainer.children).toHaveLength(0);
	});

	test("multiple read tool calls batch into the same component and non-read resets the group", () => {
		handler.handleEvent(
			ev({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "a.ts" } }),
		);
		handler.handleEvent(
			ev({ type: "tool_execution_start", toolCallId: "read-2", toolName: "read", args: { path: "b.ts" } }),
		);

		expect(chatContainer.children.filter(child => child instanceof ReadToolGroupComponent)).toHaveLength(1);

		handler.handleEvent(
			ev({ type: "tool_execution_start", toolCallId: "tc1", toolName: "edit", args: { path: "test.ts" } }),
		);
		handler.handleEvent(
			ev({ type: "tool_execution_start", toolCallId: "read-3", toolName: "read", args: { path: "c.ts" } }),
		);

		expect(chatContainer.children.filter(child => child instanceof ReadToolGroupComponent)).toHaveLength(2);
	});

	test("setExpanded updates existing expandable children and context state", () => {
		handler.handleEvent(
			ev({ type: "tool_execution_start", toolCallId: "tc1", toolName: "edit", args: { path: "test.ts" } }),
		);
		handler.handleEvent(
			ev({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "a.ts" } }),
		);

		handler.setExpanded(true);

		expect(ctx.toolOutputExpanded).toBe(true);
	});

	test("renders compact code tool results in rebuilt viewer flow", async () => {
		spyOn(nativesModule, "executeCodeBuffer").mockReturnValue({
			output: { version: 2, diff: "@@ add @@\n-return a + b;\n+return a * b;", editCount: 1 },
			error: false,
		});
		const codeTool = new CodeTool(createToolSession());
		const result = await codeTool.execute("call-1", {
			command: "edit",
			file: "/test/src/main.ts",
			symbol: "add",
			operation: "patch",
			patches: [{ find: "return a + b;", replace: "return a * b;" }],
		});

		handler.handleEvent(
			ev({ type: "tool_execution_start", toolCallId: "call-1", toolName: "code", args: { command: "edit" } }),
		);
		handler.handleEvent(
			ev({ type: "tool_execution_end", toolCallId: "call-1", toolName: "code", result, isError: false }),
		);

		const rendered = chatContainer.render(100).join("\n");
		expect(rendered).toContain("Edited src/main.ts (1 operation, buffer version 2)");
		expect(rendered).toContain("@@ add @@");
		expect(rendered).not.toContain('"editCount"');
		expect(rendered).not.toContain('"version"');
	});
});
