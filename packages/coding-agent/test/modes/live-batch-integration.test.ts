/**
 * Live end-to-end: drive the REAL EventController through a production-shaped
 * event stream (big mixed sync+async batch, background jobs completing out of
 * order) mounted on a real TUI + xterm VirtualTerminal, then assert no tool
 * cell is left frozen "pending/running" in the terminal's native scrollback,
 * and that once everything resolves the live region reflects completion.
 *
 * This is the actual bug reproduction. Before LiveToolBatchComponent a large
 * parallel batch streamed every cell pending at message_update time; the batch
 * overflowed the viewport and the top pending cells scrolled into immutable
 * native scrollback BEFORE their tool_execution_end results arrived, freezing
 * them visually pending forever.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { type Component, type Container, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "@oh-my-pi/pi-tui/../test/virtual-terminal";
import { Settings } from "../../src/config/settings";
import { EventController } from "../../src/modes/controllers/event-controller";
import type { ToolExecutionHandle } from "../../src/modes/components/tool-execution";
import type { InteractiveModeContext } from "../../src/modes/types";
import type { AgentSessionEvent } from "../../src/session/agent-session";
import { initTheme } from "../../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
	// The real EventController reads settings.get(...) while building tool cells;
	// initialize the global singleton in-memory so dispatch does not throw.
	await Settings.init({ inMemory: true });
});

async function settle(term: VirtualTerminal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
	await term.flush();
}

/** Build a real TUI-backed ctx wiring only what #dispatchEvent touches. */
function makeHarness(viewportRows = 10) {
	const term = new VirtualTerminal(80, viewportRows);
	const tui = new TUI(term, { minRenderInterval: 0 });
	const chatContainer = tui as unknown as Container;
	const pendingTools = new Map<string, ToolExecutionHandle>();

	const noop = () => {};
	const ctx = {
		isInitialized: true,
		init: async () => {},
		ui: tui,
		chatContainer,
		statusContainer: { clear: noop, addChild: noop } as unknown,
		pendingTools,
		toolOutputExpanded: false,
		streamingComponent: undefined,
		streamingMessage: undefined,
		statusLine: { setCanvasTaskCount: noop, invalidate: noop },
		updateEditorTopBorder: noop,
		taskManager: undefined,
		hideThinkingBlock: false,
		editor: { setText: noop, onEscape: undefined },
		clearUserPaused: noop,
		ensureLoadingAnimation: noop,
		updatePendingMessagesDisplay: noop,
		addMessageToChat: noop,
		getUserMessageText: () => "",
		setTodos: noop,
		setWorkingMessage: noop,
		recordSubagentResults: noop,
		flushPendingModelSwitch: async () => {},
		loadingAnimation: undefined,
		isBackgrounded: false,
		optimisticUserMessageSignature: undefined,
		sessionManager: { getCwd: () => process.cwd(), getSessionName: () => "test" },
		session: { getToolByName: () => undefined, getTodoGroups: () => [] },
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return { term, tui, controller, pendingTools };
}

type Call = { id: string; name: string; async?: boolean };

function assistantMsg(calls: Call[], partialUpTo = calls.length) {
	return {
		role: "assistant" as const,
		content: calls.slice(0, partialUpTo).map(c => ({
			type: "toolCall" as const,
			id: c.id,
			name: c.name,
			arguments: { command: `do ${c.id}`, _i: `doing ${c.id}` },
		})),
	};
}

/** Lines of the terminal's NATIVE scrollback that sit ABOVE the viewport. */
function scrollbackAboveViewport(term: VirtualTerminal, viewportRows: number): string[] {
	const sb = term.getScrollBuffer().map(l => l.trim());
	return sb.slice(0, Math.max(0, sb.length - viewportRows));
}

describe("live big async/sync batch → no frozen pending in scrollback", () => {
	test("40-call mixed batch, async jobs finishing out of order, all finalize", async () => {
		const rows = 10;
		const { term, tui, controller, pendingTools } = makeHarness(rows);
		tui.start();
		await settle(term);

		// 40 calls: every 5th is async (background). Mirrors session 14f48ced.
		const calls: Call[] = Array.from({ length: 40 }, (_v, i) => ({
			id: `c${i}`,
			name: i % 4 === 0 ? "bash" : i % 4 === 1 ? "find" : i % 4 === 2 ? "get" : "edit",
			async: i % 5 === 0,
		}));

		await controller.handleEvent({ type: "agent_start" } as AgentSessionEvent);
		await controller.handleEvent({
			type: "message_start",
			message: assistantMsg(calls, 0),
		} as unknown as AgentSessionEvent);

		// Stream the toolCalls in (message_update), as the model emits them.
		for (let n = 1; n <= calls.length; n++) {
			await controller.handleEvent({
				type: "message_update",
				message: assistantMsg(calls, n),
				assistantMessageEvent: { type: "tool_call_delta" },
			} as unknown as AgentSessionEvent);
		}
		await controller.handleEvent({
			type: "message_end",
			message: assistantMsg(calls),
		} as unknown as AgentSessionEvent);
		tui.requestRender();
		await settle(term);

		// CORE INVARIANT: while pending, NOTHING of the batch is frozen above the
		// viewport in native scrollback (the compact group keeps it on-screen).
		expect(scrollbackAboveViewport(term, rows).filter(l => l.includes("running") || /do c\d+/.test(l))).toEqual([]);

		// Each pending entry routes to the SAME group handle (per-id multiplexing).
		expect(pendingTools.size).toBe(calls.length);
		expect(new Set(pendingTools.values()).size).toBe(1);

		const asyncCalls = calls.filter(c => c.async);
		const syncCalls = calls.filter(c => !c.async);

		// Sync calls complete immediately.
		for (const c of syncCalls) {
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: c.id,
				toolName: c.name,
				result: { content: [{ type: "text", text: `out ${c.id}` }] },
				isError: false,
			} as unknown as AgentSessionEvent);
		}
		// Async calls first report running (background) — must NOT be finalized.
		for (const c of asyncCalls) {
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: c.id,
				toolName: c.name,
				result: {
					content: [{ type: "text", text: `bg ${c.id}` }],
					details: { async: { state: "running", jobId: c.id, type: "bash" } },
				},
				isError: false,
			} as unknown as AgentSessionEvent);
		}
		tui.requestRender();
		await settle(term);

		// Sync calls resolved & removed; background calls legitimately remain.
		expect(pendingTools.size).toBe(asyncCalls.length);

		// agent_end sweep must PRESERVE genuinely-running background calls.
		await controller.handleEvent({ type: "agent_end", messages: [] } as unknown as AgentSessionEvent);
		tui.requestRender();
		await settle(term);
		expect(pendingTools.size).toBe(asyncCalls.length);

		// Async completions arrive OUT OF ORDER (reverse) via tool_execution_update.
		for (const c of [...asyncCalls].reverse()) {
			await controller.handleEvent({
				type: "tool_execution_update",
				toolCallId: c.id,
				toolName: c.name,
				args: {},
				partialResult: {
					content: [{ type: "text", text: `done ${c.id}` }],
					details: { async: { state: "completed", jobId: c.id, type: "bash" } },
				},
			} as unknown as AgentSessionEvent);
		}
		tui.requestRender();
		await settle(term);

		// All entries resolved & drained.
		expect(pendingTools.size).toBe(0);

		// FINAL: nothing is frozen "running" anywhere in scrollback, and the live
		// region has repainted past the compact summary (no stale spinner header).
		const allLines = term.getScrollBuffer().map(l => l.trim());
		expect(allLines.filter(l => l.includes("running"))).toEqual([]);
		// The compact footer ("… N more · …") must be gone once expanded to full.
		expect(allLines.some(l => l.includes("more ·"))).toBe(false);

		tui.stop();
	});

	test("regression: pure sync batch larger than viewport finalizes clean", async () => {
		const rows = 8;
		const { term, tui, controller, pendingTools } = makeHarness(rows);
		tui.start();
		await settle(term);

		const calls: Call[] = Array.from({ length: 30 }, (_v, i) => ({ id: `s${i}`, name: "bash" }));
		await controller.handleEvent({ type: "agent_start" } as AgentSessionEvent);
		await controller.handleEvent({
			type: "message_start",
			message: assistantMsg(calls, 0),
		} as unknown as AgentSessionEvent);
		await controller.handleEvent({
			type: "message_update",
			message: assistantMsg(calls),
			assistantMessageEvent: { type: "tool_call_delta" },
		} as unknown as AgentSessionEvent);
		await controller.handleEvent({
			type: "message_end",
			message: assistantMsg(calls),
		} as unknown as AgentSessionEvent);
		tui.requestRender();
		await settle(term);

		// Pending batch: nothing frozen above the viewport.
		expect(scrollbackAboveViewport(term, rows).filter(l => l.includes("running"))).toEqual([]);

		for (const c of calls) {
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: c.id,
				toolName: c.name,
				result: { content: [{ type: "text", text: `ok ${c.id}` }] },
				isError: false,
			} as unknown as AgentSessionEvent);
		}
		await controller.handleEvent({ type: "agent_end", messages: [] } as unknown as AgentSessionEvent);
		tui.requestRender();
		await settle(term);

		expect(pendingTools.size).toBe(0);
		const allLines = term.getScrollBuffer().map(l => l.trim());
		expect(allLines.filter(l => l.includes("running"))).toEqual([]);
		expect(allLines.some(l => l.includes("more ·"))).toBe(false);

		tui.stop();
	});

	test("small batch (< threshold) is never collapsed", async () => {
		const rows = 20;
		const { term, tui, controller, pendingTools } = makeHarness(rows);
		tui.start();
		await settle(term);

		const calls: Call[] = [
			{ id: "a", name: "bash" },
			{ id: "b", name: "find" },
		];
		await controller.handleEvent({ type: "agent_start" } as AgentSessionEvent);
		await controller.handleEvent({
			type: "message_start",
			message: assistantMsg(calls, 0),
		} as unknown as AgentSessionEvent);
		await controller.handleEvent({
			type: "message_update",
			message: assistantMsg(calls),
			assistantMessageEvent: { type: "tool_call_delta" },
		} as unknown as AgentSessionEvent);
		await controller.handleEvent({
			type: "message_end",
			message: assistantMsg(calls),
		} as unknown as AgentSessionEvent);
		tui.requestRender();
		await settle(term);

		// No compact header/footer for a tiny batch.
		const lines = term.getScrollBuffer().map(l => l.trim());
		expect(lines.some(l => l.includes("more ·"))).toBe(false);
		expect(lines.some(l => l.includes("done,"))).toBe(false);

		for (const c of calls) {
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: c.id,
				toolName: c.name,
				result: { content: [{ type: "text", text: `ok ${c.id}` }] },
				isError: false,
			} as unknown as AgentSessionEvent);
		}
		await controller.handleEvent({ type: "agent_end", messages: [] } as unknown as AgentSessionEvent);
		tui.requestRender();
		await settle(term);
		expect(pendingTools.size).toBe(0);

		tui.stop();
	});
});
