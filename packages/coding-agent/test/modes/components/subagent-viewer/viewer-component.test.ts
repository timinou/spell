import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { TUI } from "@oh-my-pi/pi-tui";
import { SubagentViewerComponent } from "../../../../src/modes/components/subagent-viewer/viewer-component";
import type { AgentProgress } from "../../../../src/task/types";
import { TASK_SUBAGENT_EVENT_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../../../../src/task/types";
import { EventBus } from "../../../../src/utils/event-bus";

function createMockTui(): TUI {
	return {
		requestRender: () => {},
		terminal: { columns: 80, rows: 24 },
		setFocus: () => {},
	} as unknown as TUI;
}

function makeProgress(index: number, overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index,
		id: `task-${index}`,
		agent: `agent-${index}`,
		agentSource: "bundled",
		status: "running",
		task: `task-${index}`,
		toolCount: 5,
		tokens: 1000,
		durationMs: 30000,
		recentTools: [],
		recentOutput: [],
		...overrides,
	};
}

function makeAssistantEvent(type: "message_start" | "message_update" | "message_end", text = "hello"): AgentEvent {
	const message: any = {
		role: "assistant",
		content: [{ type: "text", text }],
	};
	if (type === "message_end") {
		message.usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };
		message.stopReason = "stop";
	}
	if (type === "message_update") {
		return {
			type,
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: message },
		} as unknown as AgentEvent;
	}
	return { type, message } as AgentEvent;
}

function _makeToolEvent(
	type: "tool_execution_start" | "tool_execution_end",
	toolCallId: string,
	toolName: string,
): AgentEvent {
	if (type === "tool_execution_start") {
		return { type, toolCallId, toolName, args: { path: "test.ts" } } as AgentEvent;
	}
	return { type, toolCallId, toolName, result: { content: [{ type: "text", text: "done" }] } } as AgentEvent;
}

describe("SubagentViewerComponent", () => {
	let eventBus: EventBus;
	let ui: TUI;
	let closeCalled: boolean;
	let renderRequested: boolean;
	let viewer: SubagentViewerComponent;

	beforeEach(() => {
		eventBus = new EventBus();
		ui = createMockTui();
		closeCalled = false;
		renderRequested = false;
		viewer = new SubagentViewerComponent({
			eventBus,
			ui,
			cwd: "/test",
			terminalRows: 24,
			onClose: () => {
				closeCalled = true;
			},
			onRequestRender: () => {
				renderRequested = true;
			},
		});
	});

	test("renders empty state when no agents", () => {
		const lines = viewer.render(80);
		expect(lines.length).toBeGreaterThan(0);
		const joined = lines.join("\n");
		expect(joined).toContain("No active agents");
	});

	test("renders header with agent info after progress update", () => {
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			progress: makeProgress(0, { id: "ReadSchema" }),
		});

		const lines = viewer.render(80);
		const joined = lines.join("\n");
		expect(joined).toContain("Subagent Viewer");
		expect(joined).toContain("ReadSchema");
	});

	test("renders footer with stats from progress", () => {
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			progress: makeProgress(0, { toolCount: 42, tokens: 12345 }),
		});

		const lines = viewer.render(80);
		const joined = lines.join("\n");
		expect(joined).toContain("42 tools");
	});

	test("forwards matching agent events to event handler", () => {
		// Register an agent
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			progress: makeProgress(0),
		});

		// Emit an event for agent index 0
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			index: 0,
			agent: "task",
			event: makeAssistantEvent("message_start"),
		});

		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			index: 0,
			agent: "task",
			event: makeAssistantEvent("message_end", "test response"),
		});

		const lines = viewer.render(80);
		const joined = lines.join("\n");
		// Should have rendered some content from the assistant message
		expect(joined).toContain("test response");
	});

	test("filters events for non-selected agent", () => {
		// Register two agents
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			progress: makeProgress(0),
		});
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 1,
			agent: "task",
			progress: makeProgress(1),
		});

		// Emit event for agent index 1 (not selected, agent 0 is selected by default)
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			index: 1,
			agent: "task",
			event: makeAssistantEvent("message_start"),
		});
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			index: 1,
			agent: "task",
			event: makeAssistantEvent("message_end", "should not appear"),
		});

		const lines = viewer.render(80);
		const joined = lines.join("\n");
		expect(joined).not.toContain("should not appear");
	});

	test("escape calls onClose", () => {
		viewer.handleInput("\x1b");
		expect(closeCalled).toBe(true);
	});

	test("tab cycles to next agent", () => {
		// Register two agents
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			progress: makeProgress(0, { id: "Agent0" }),
		});
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 1,
			agent: "task",
			progress: makeProgress(1, { id: "Agent1" }),
		});

		// Initially showing Agent0
		let lines = viewer.render(80);
		expect(lines.join("\n")).toContain("Agent0");

		// Tab to next
		viewer.handleInput("\t");
		lines = viewer.render(80);
		expect(lines.join("\n")).toContain("Agent1");
	});

	test("scroll up disables auto-follow, End resumes", () => {
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			progress: makeProgress(0),
		});

		// Generate enough content to need scrolling
		for (let i = 0; i < 50; i++) {
			eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
				index: 0,
				agent: "task",
				event: makeAssistantEvent("message_start"),
			});
			eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
				index: 0,
				agent: "task",
				event: makeAssistantEvent("message_end", `message ${i}`),
			});
		}

		viewer.render(80);

		// Scroll up
		viewer.handleInput("\x1b[A"); // up arrow
		let lines = viewer.render(80);
		// Should show "line N" in footer, not "follow"
		expect(lines.join("\n")).not.toContain("follow");

		// Press End to resume auto-follow
		viewer.handleInput("\x1b[F"); // End key
		lines = viewer.render(80);
		expect(lines.join("\n")).toContain("follow");
	});

	test("ctrl+o toggles expanded state", () => {
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			progress: makeProgress(0),
		});

		viewer.render(80);
		let joined = viewer.render(80).join("\n");
		expect(joined).not.toContain("expanded");

		// Toggle expansion
		viewer.handleInput("\x0f"); // ctrl+o
		joined = viewer.render(80).join("\n");
		expect(joined).toContain("expanded");
	});

	test("dispose unsubscribes from event bus", () => {
		viewer.dispose();

		// After dispose, progress updates should not trigger render requests
		renderRequested = false;
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			progress: makeProgress(0),
		});
		expect(renderRequested).toBe(false);
	});

	test("agent switching clears chat and resubscribes", () => {
		// Register two agents
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			progress: makeProgress(0, { id: "AgentA" }),
		});
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 1,
			agent: "task",
			progress: makeProgress(1, { id: "AgentB" }),
		});

		// Add content for agent 0
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			index: 0,
			agent: "task",
			event: makeAssistantEvent("message_start"),
		});
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			index: 0,
			agent: "task",
			event: makeAssistantEvent("message_end", "agent 0 content"),
		});

		let joined = viewer.render(80).join("\n");
		expect(joined).toContain("agent 0 content");

		// Switch to agent 1
		viewer.handleInput("\t");
		joined = viewer.render(80).join("\n");
		// Agent 0 content should be cleared
		expect(joined).not.toContain("agent 0 content");
		// Should now show AgentB in header
		expect(joined).toContain("AgentB");
	});
});
