/**
 * NiriOverviewController tests.
 *
 * Contracts:
 *  - Shows the overlay when an OverviewOpenedOrClosed{is_open:true} event arrives.
 *  - Hides the overlay (via handle.hide) on OverviewOpenedOrClosed{is_open:false}.
 *  - Does not show the overlay twice if already open.
 *  - Does not hide if already closed.
 *  - Derives AgentStatus: needs_input > error > running > idle (precedence order).
 *  - Snapshot reflects current context values at show time.
 *  - Session subscribe listener updates the overlay when the overlay is visible.
 *  - destroy() tears down the IPC stream and hides any open overlay.
 *
 * The NiriEventStream is mocked so tests run without a real socket.
 */

import { describe, expect, it, mock } from "bun:test";
import type { NiriOverviewContext } from "../src/controller";
import { NiriOverviewController } from "../src/controller";
import type { OverviewComponent } from "../src/overview-component";
import type { AgentStatus } from "../src/types";

// ─── Mock NiriEventStream ─────────────────────────────────────────────────────

// We intercept the module so NiriOverviewController never opens a real socket.
type EventCb = (event: object) => void;

let capturedCallback: EventCb | null = null;
let streamDestroyed = false;

mock.module("../src/ipc.ts", () => ({
	NiriEventStream: class {
		constructor(_path: string, cb: EventCb) {
			capturedCallback = cb;
			streamDestroyed = false;
		}
		destroy() {
			streamDestroyed = true;
		}
	},
}));

// ─── Factory helpers ──────────────────────────────────────────────────────────

interface FakeOverlayHandle {
	hide: ReturnType<typeof mock>;
	setHidden: ReturnType<typeof mock>;
	isHidden: ReturnType<typeof mock>;
}

function makeHandle(): FakeOverlayHandle {
	return {
		hide: mock(() => {}),
		setHidden: mock(() => {}),
		isHidden: mock(() => false),
	};
}

/** Build a minimal NiriOverviewContext that satisfies the interface. */
function makeCtx(
	overrides: Partial<{
		isStreaming: boolean;
		error: string | undefined;
		hasInputCallback: boolean;
		isAwaitingHookInput: boolean;
		todoPhases: NiriOverviewContext["todoPhases"];
		sessionName: string;
	}> = {},
): {
	ctx: NiriOverviewContext;
	showOverlayMock: ReturnType<typeof mock>;
	renderMock: ReturnType<typeof mock>;
	overlayHandle: FakeOverlayHandle;
	sessionListeners: Array<() => void>;
} {
	const handle = makeHandle();
	const showOverlayMock = mock((_comp: OverviewComponent) => handle);
	const renderMock = mock(() => {});
	const sessionListeners: Array<() => void> = [];

	const ctx: NiriOverviewContext = {
		ui: {
			showOverlay: showOverlayMock as unknown as NiriOverviewContext["ui"]["showOverlay"],
			requestRender: renderMock,
		},
		session: {
			get isStreaming() {
				return overrides.isStreaming ?? false;
			},
			messages: [],
			get state() {
				return { error: overrides.error };
			},
		},
		get onInputCallback() {
			return overrides.hasInputCallback ? () => {} : undefined;
		},
		get isAwaitingHookInput() {
			return overrides.isAwaitingHookInput ?? false;
		},
		get isPendingApproval() {
			return overrides.isPendingApproval ?? false;
		},
		sessionManager: {
			getCwd: () => "/projects/myapp",
			getSessionName: () => overrides.sessionName ?? "test-session",
		},
		get todoPhases() {
			return overrides.todoPhases ?? [];
		},
		subscribe(listener) {
			sessionListeners.push(listener);
			return () => {
				const i = sessionListeners.indexOf(listener);
				if (i !== -1) sessionListeners.splice(i, 1);
			};
		},
	};

	return { ctx, showOverlayMock, renderMock, overlayHandle: handle, sessionListeners };
}

function fireNiriEvent(event: object): void {
	if (!capturedCallback) throw new Error("No NiriEventStream callback captured");
	capturedCallback(event);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("NiriOverviewController", () => {
	it("shows the overlay when overview opens", () => {
		const { ctx, showOverlayMock } = makeCtx();
		const ctrl = new NiriOverviewController("/fake.sock", ctx);

		fireNiriEvent({ OverviewOpenedOrClosed: { is_open: true } });

		expect(showOverlayMock).toHaveBeenCalledTimes(1);
		ctrl.destroy();
	});

	it("hides the overlay when overview closes", () => {
		const { ctx, overlayHandle } = makeCtx();
		const ctrl = new NiriOverviewController("/fake.sock", ctx);

		fireNiriEvent({ OverviewOpenedOrClosed: { is_open: true } });
		fireNiriEvent({ OverviewOpenedOrClosed: { is_open: false } });

		expect(overlayHandle.hide).toHaveBeenCalledTimes(1);
		ctrl.destroy();
	});

	it("does not show the overlay twice when already open", () => {
		const { ctx, showOverlayMock } = makeCtx();
		const ctrl = new NiriOverviewController("/fake.sock", ctx);

		fireNiriEvent({ OverviewOpenedOrClosed: { is_open: true } });
		fireNiriEvent({ OverviewOpenedOrClosed: { is_open: true } });

		expect(showOverlayMock).toHaveBeenCalledTimes(1);
		ctrl.destroy();
	});

	it("does not hide when already closed", () => {
		const { ctx, overlayHandle } = makeCtx();
		const ctrl = new NiriOverviewController("/fake.sock", ctx);

		// Never opened — close event should be a no-op
		fireNiriEvent({ OverviewOpenedOrClosed: { is_open: false } });

		expect(overlayHandle.hide).not.toHaveBeenCalled();
		ctrl.destroy();
	});

	it("ignores unrelated niri events", () => {
		const { ctx, showOverlayMock } = makeCtx();
		const ctrl = new NiriOverviewController("/fake.sock", ctx);

		fireNiriEvent({ WorkspaceActivated: { id: 1, focused: true } });

		expect(showOverlayMock).not.toHaveBeenCalled();
		ctrl.destroy();
	});

	it("destroys the IPC stream on destroy()", () => {
		const { ctx } = makeCtx();
		const ctrl = new NiriOverviewController("/fake.sock", ctx);
		ctrl.destroy();
		expect(streamDestroyed).toBe(true);
	});

	it("hides an open overlay on destroy()", () => {
		const { ctx, overlayHandle } = makeCtx();
		const ctrl = new NiriOverviewController("/fake.sock", ctx);

		fireNiriEvent({ OverviewOpenedOrClosed: { is_open: true } });
		ctrl.destroy();

		expect(overlayHandle.hide).toHaveBeenCalledTimes(1);
	});

	it("unsubscribes from session events on destroy()", () => {
		const { ctx, sessionListeners } = makeCtx();
		const ctrl = new NiriOverviewController("/fake.sock", ctx);

		expect(sessionListeners).toHaveLength(1);
		ctrl.destroy();
		expect(sessionListeners).toHaveLength(0);
	});

	describe("AgentStatus derivation", () => {
		const cases: Array<[string, Parameters<typeof makeCtx>[0], AgentStatus]> = [
			["idle when nothing is happening", {}, "idle"],
			["running when session is streaming", { isStreaming: true }, "running"],
			["error when session has error", { error: "oops" }, "error"],
			["needs_input when onInputCallback is set", { hasInputCallback: true }, "needs_input"],
			// running takes precedence over needs_input: if the session is streaming, it wins
			// even if onInputCallback is set. This covers the exit_plan_mode race: abort()
			// causes prompt() to return, the main loop calls getUserInput() (sets the
			// callback), then the tool handler fires session.prompt(syntheticPrompt) —
			// isStreaming becomes true again while the callback is still set.
			["running over needs_input", { hasInputCallback: true, isStreaming: true }, "running"],
			// needs_input only applies when NOT streaming
			["needs_input when not streaming", { hasInputCallback: true, isStreaming: false }, "needs_input"],
			// error takes precedence over needs_input
			["error over needs_input", { hasInputCallback: true, error: "oops" }, "error"],
			// error takes precedence over running
			["error over running", { error: "oops", isStreaming: true }, "error"],
			// hook input: LLM is streaming but paused awaiting user answer (ask tool,
			// plan approval, etc.) — must show needs_input, not running.
			["needs_input when hook active mid-stream", { isStreaming: true, isAwaitingHookInput: true }, "needs_input"],
			// hook without streaming (tool already returned, main loop called getUserInput)
			[
				"needs_input when hook active not streaming",
				{ isStreaming: false, isAwaitingHookInput: true },
				"needs_input",
			],
			// error beats hook
			["error over hook input", { isStreaming: true, isAwaitingHookInput: true, error: "oops" }, "error"],
			// pending_approval: isPendingApproval=true (set while showing plan selector)
			["pending_approval when isPendingApproval is set", { isPendingApproval: true }, "pending_approval"],
			// pending_approval beats hook input
			["pending_approval over hook input", { isPendingApproval: true, isAwaitingHookInput: true }, "pending_approval"],
			// completed: all todos done + onInputCallback set (agent awaiting next message)
			[
				"completed when all todos done and awaiting next message",
				{
					hasInputCallback: true,
					todoPhases: [
						{
							name: "Phase 1",
							tasks: [
								{ content: "Task A", status: "completed" },
								{ content: "Task B", status: "completed" },
							],
						},
					],
				},
				"completed",
			],
			// needs_input when todos exist but not all done
			[
				"needs_input when some todos still pending",
				{
					hasInputCallback: true,
					todoPhases: [
						{
							name: "Phase 1",
							tasks: [
								{ content: "Task A", status: "completed" },
								{ content: "Task B", status: "pending" },
							],
						},
					],
				},
				"needs_input",
			],
			// needs_input when no todos — can't infer completion, stay cautious
			["needs_input when no todos and callback set", { hasInputCallback: true, todoPhases: [] }, "needs_input"],
		];

		for (const [label, ctxOverrides, expectedStatus] of cases) {
			it(`derives ${expectedStatus}: ${label}`, () => {
				const { ctx, showOverlayMock } = makeCtx(ctxOverrides);
				const ctrl = new NiriOverviewController("/fake.sock", ctx);

				fireNiriEvent({ OverviewOpenedOrClosed: { is_open: true } });

				// The snapshot passed to the overlay's update() carries the status.
				// We can't inspect the component directly, but the overlay was shown —
				// verify by checking the component rendered with correct status by
				// peeking at what was passed to showOverlay.
				const component = showOverlayMock.mock.calls[0]?.[0] as OverviewComponent | undefined;
				expect(component).toBeDefined();

				// Render and check that the status label appears in the output
				const lines = component!.render(80);
				const combined = lines.join("\n");
				// Strip ANSI sequences before checking text content
				const plain = combined.replace(/\x1b\[[^m]*m/g, "");

				const statusLabels: Record<AgentStatus, string> = {
					idle: "Idle",
					running: "Running",
					needs_input: "Needs Input",
					error: "Error",
					completed: "Completed",
					pending_approval: "Pending Approval",
				};
				expect(plain).toContain(statusLabels[expectedStatus]);

				ctrl.destroy();
			});
		}
	});

	it("builds snapshot with project name from cwd basename", () => {
		const { ctx, showOverlayMock } = makeCtx({ sessionName: "my-session" });
		const ctrl = new NiriOverviewController("/fake.sock", ctx);

		fireNiriEvent({ OverviewOpenedOrClosed: { is_open: true } });

		const component = showOverlayMock.mock.calls[0]?.[0] as OverviewComponent | undefined;
		expect(component).toBeDefined();

		const lines = component!.render(80);
		const plain = lines.join("\n").replace(/\x1b\[[^m]*m/g, "");
		// cwd is /projects/myapp → basename is "myapp"
		expect(plain).toContain("myapp");
		expect(plain).toContain("my-session");

		ctrl.destroy();
	});

	it("updates the overlay on session events when visible", () => {
		const { ctx, sessionListeners, renderMock } = makeCtx();
		const ctrl = new NiriOverviewController("/fake.sock", ctx);

		// Overlay not yet open — session event should be a no-op (no render)
		sessionListeners[0]?.();
		expect(renderMock).not.toHaveBeenCalled();

		// Open overlay, then fire session event
		fireNiriEvent({ OverviewOpenedOrClosed: { is_open: true } });
		const callsBefore = renderMock.mock.calls.length;
		sessionListeners[0]?.();
		expect(renderMock.mock.calls.length).toBeGreaterThan(callsBefore);

		ctrl.destroy();
	});
});
