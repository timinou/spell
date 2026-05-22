import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { TUI } from "@oh-my-pi/pi-tui";
import {
	ASYNC_JOB_PROGRESS_CHANNEL,
	type AsyncJob,
	type AsyncJobManager,
	type AsyncJobUpdate,
} from "../../../../src/async";
import { getThemeByName, setThemeInstance } from "../../../../src/modes/theme/theme";
import { SubagentViewerComponent } from "../../../../src/modes/components/subagent-viewer/viewer-component";
import { SubagentTracker } from "../../../../src/task/subagent-tracker";
import type { AgentProgress } from "../../../../src/task/types";
import { TASK_SUBAGENT_EVENT_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../../../../src/task/types";
import { EventBus } from "../../../../src/utils/event-bus";

function makeAsyncJob(id: string, overrides: Partial<AsyncJob> = {}): AsyncJob {
	return {
		id,
		type: "bash",
		status: "running",
		startTime: Date.now() - 1_000,
		label: `job ${id}`,
		abortController: new AbortController(),
		promise: Promise.resolve(),
		...overrides,
	};
}

/** Strip the body padding rows; just keep the header line. */
function headerOf(v: SubagentViewerComponent): string {
	return v.render(80)[0] ?? "";
}

function makeAsyncJobManagerMock(initial: AsyncJob[]): { manager: AsyncJobManager; cancelled: string[] } {
	const jobs = new Map(initial.map(job => [job.id, job]));
	const cancelled: string[] = [];
	const manager = {
		getAllJobs: () => Array.from(jobs.values()),
		getRunningJobs: () => Array.from(jobs.values()).filter(job => job.status === "running"),
		getRecentJobs: () => [],
		getJob: (id: string) => jobs.get(id),
		cancel: (id: string) => {
			const job = jobs.get(id);
			if (!job || job.status !== "running") return false;
			job.status = "cancelled";
			cancelled.push(id);
			return true;
		},
	} as unknown as AsyncJobManager;
	return { manager, cancelled };
}

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

function makeToolEvent(
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

	beforeAll(async () => {
		const defaultTheme = await getThemeByName("dark");
		if (defaultTheme) setThemeInstance(defaultTheme);
	});

	beforeEach(() => {
		eventBus = new EventBus();
		ui = createMockTui();
		closeCalled = false;
		renderRequested = false;
		viewer = new SubagentViewerComponent({
			eventBus,
			ui,
			cwd: "/test",
			onClose: () => {
				closeCalled = true;
			},
			onRequestRender: () => {
				renderRequested = true;
			},
		});
	});

	afterEach(() => {
		viewer.dispose();
	});

	test("renders empty state when no jobs or agents", () => {
		const lines = viewer.render(80);
		expect(lines.length).toBeGreaterThan(0);
		const joined = lines.join("\n");
		expect(joined).toContain("No jobs or agents");
	});

	test("header reads 'Jobs & Agents' and shows counts", () => {
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			progress: makeProgress(0, { id: "Worker" }),
		});
		const joined = viewer.render(80).join("\n");
		expect(joined).toContain("Jobs & Agents");
		expect(joined).toContain("1 agent");
		expect(joined).toContain("0 jobs");
	});

	test("renders header with agent info after progress update", () => {
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			progress: makeProgress(0, { id: "ReadSchema" }),
		});

		const lines = viewer.render(80);
		const joined = lines.join("\n");
		expect(joined).toContain("Jobs & Agents");
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

	test("hydrates from SubagentTracker on mount", () => {
		const tracker = new SubagentTracker(eventBus, () => {});
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 9,
			agent: "task",
			progress: makeProgress(9, { id: "PreLaunched" }),
		});

		const hydrated = new SubagentViewerComponent({
			eventBus: new EventBus(), // fresh bus → only hydration can populate
			ui,
			cwd: "/test",
			onClose: () => {},
			onRequestRender: () => {},
			subagentTracker: tracker,
		});

		const joined = hydrated.render(80).join("\n");
		expect(joined).toContain("PreLaunched");
		hydrated.dispose();
		tracker.dispose();
	});

	test("hydrates async jobs from AsyncJobManager on mount", () => {
		const { manager } = makeAsyncJobManagerMock([
			makeAsyncJob("bg_1", { label: "prebuilt async work" }),
		]);
		const hydrated = new SubagentViewerComponent({
			eventBus: new EventBus(),
			ui,
			cwd: "/test",
			onClose: () => {},
			onRequestRender: () => {},
			asyncJobManager: manager,
		});

		const joined = hydrated.render(80).join("\n");
		expect(joined).toContain("prebuilt async work");
		expect(joined).toContain("0 agents");
		expect(joined).toContain("1 job");
		hydrated.dispose();
	});

	test("async job updates from event bus appear in the list", () => {
		const update: AsyncJobUpdate = {
			reason: "registered",
			job: {
				id: "bg_42",
				type: "bash",
				status: "running",
				label: "running curl",
				startTime: Date.now(),
			},
		};
		eventBus.emit(ASYNC_JOB_PROGRESS_CHANNEL, update);
		const joined = viewer.render(80).join("\n");
		expect(joined).toContain("running curl");
		expect(joined).toContain("[bash]");
	});

	test("async progress is rendered in the body pane", () => {
		eventBus.emit(ASYNC_JOB_PROGRESS_CHANNEL, {
			reason: "progress",
			job: {
				id: "bg_7",
				type: "bash",
				status: "running",
				label: "long bash",
				startTime: Date.now() - 5_000,
				latestProgress: { text: "step 3 of 5", updatedAt: Date.now() },
			},
		} satisfies AsyncJobUpdate);

		const joined = viewer.render(80).join("\n");
		expect(joined).toContain("Latest progress");
		expect(joined).toContain("step 3 of 5");
	});

	test("`c` cancels the selected running async job", () => {
		const { manager, cancelled } = makeAsyncJobManagerMock([
			makeAsyncJob("bg_9", { label: "big task" }),
		]);
		const withCancel = new SubagentViewerComponent({
			eventBus: new EventBus(),
			ui,
			cwd: "/test",
			onClose: () => {},
			onRequestRender: () => {},
			asyncJobManager: manager,
		});

		withCancel.handleInput("c");
		expect(cancelled).toEqual(["bg_9"]);
		withCancel.dispose();
	});

	test("Tab cycles selection: subagent → async job → subagent", () => {
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			progress: makeProgress(0, { id: "AgentX" }),
		});
		eventBus.emit(ASYNC_JOB_PROGRESS_CHANNEL, {
			reason: "registered",
			job: {
				id: "bg_100",
				type: "bash",
				status: "running",
				label: "shell session",
				startTime: Date.now(),
			},
		} satisfies AsyncJobUpdate);

		// Initial: subagent is selected (it was added first via the subagent channel).
		let header = headerOf(viewer);
		expect(header).toContain("AgentX");
		expect(header).not.toContain("bg_100");

		// Tab once: async job should now be selected.
		viewer.handleInput("\t");
		header = headerOf(viewer);
		expect(header).toContain("bg_100");
		expect(header).not.toContain("AgentX");

		// Tab again: wraps back to subagent.
		viewer.handleInput("\t");
		header = headerOf(viewer);
		expect(header).toContain("AgentX");
	});

	test("Tab via real EventBus.enqueue path (mid-turn, no drain)", async () => {
		// Mirror production: events are enqueued (Priority.P2) and only fire on drain().
		const bus = new EventBus();
		const tracker = new SubagentTracker(bus, () => {});
		const { manager } = makeAsyncJobManagerMock([]);

		const v = new SubagentViewerComponent({
			eventBus: bus,
			ui,
			cwd: "/test",
			onClose: () => {},
			onRequestRender: () => {},
			subagentTracker: tracker,
			asyncJobManager: manager,
		});

		bus.enqueue(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			{ index: 0, agent: "task", progress: makeProgress(0, { id: "FirstAgent" }) },
			/* Priority.P2 */ 2,
			"task-progress-0",
		);
		bus.enqueue(
			ASYNC_JOB_PROGRESS_CHANNEL,
			{
				reason: "registered",
				job: {
					id: "bg_live",
					type: "bash",
					status: "running",
					label: "live job",
					startTime: Date.now(),
				},
			} satisfies AsyncJobUpdate,
			/* Priority.P2 */ 2,
			"async-job-bg_live",
		);

		// User hits alt+j RIGHT NOW. No drain has happened. Both events sit in the queue.
		// The viewer's own flush timer (250ms) MUST flush them so subscribers fire.
		await new Promise(resolve => setTimeout(resolve, 300));
		await bus.drain(); // belt-and-braces — ensure any racing async tasks complete.

		let header = headerOf(v);
		expect(header).toMatch(/FirstAgent|bg_live/);
		v.handleInput("\t");
		header = headerOf(v);
		// After Tab, the *other* identifier must appear in the header.
		const showsFirst = header.includes("FirstAgent");
		const showsSecond = header.includes("bg_live");
		expect(showsFirst || showsSecond).toBe(true);
		expect(showsFirst && showsSecond).toBe(false);

		v.dispose();
		tracker.dispose();
	});

	test("forwards tool events to event handler", () => {
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			progress: makeProgress(0),
		});

		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			index: 0,
			agent: "task",
			event: makeToolEvent("tool_execution_start", "tc1", "edit"),
		});
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			index: 0,
			agent: "task",
			event: makeToolEvent("tool_execution_end", "tc1", "edit"),
		});

		const lines = viewer.render(80);
		const joined = lines.join("\n");
		// ToolExecutionComponent capitalizes and renders the tool name
		expect(joined).toContain("Edit");
	});
});
