import { describe, expect, it } from "bun:test";
import { EventController } from "../../../src/modes/controllers/event-controller";
import type { AgentSessionEvent } from "../../../src/session/agent-session";
import type { InteractiveModeContext } from "../../../src/modes/types";

/**
 * Subscriber-boundary guard regression.
 *
 * `EventController.handleEvent` is registered as an async listener on the agent
 * event bus (EventController.subscribeToAgent → AgentSession.subscribe).
 * AgentSession#emit invokes listeners WITHOUT awaiting them, so any rejection
 * escaping handleEvent reaches the global `unhandledRejection` handler, which
 * writes a crash report and calls process.exit(1) (pi-utils/postmortem).
 *
 * That is exactly how a missing `finalizeOrphanPendingTools` import (filed:
 * ReferenceError at the `agent_end` branch) killed live sessions: the throw at
 * turn end crashed the process before the final frame painted, so the last
 * batch of tool cells never showed even though their results were already
 * persisted to the session file.
 *
 * The guard makes handleEvent catch everything #dispatchEvent throws and degrade
 * to a logged warning + dropped frame. These tests pin that contract without
 * depending on any single buggy call site, so the whole class of "a UI
 * event-handler fault hard-kills the session" cannot regress.
 */
describe("EventController.handleEvent subscriber-boundary guard", () => {
	const makeCtx = (overrides: Partial<InteractiveModeContext> = {}) =>
		({
			isInitialized: true,
			statusLine: { setCanvasTaskCount() {}, invalidate() {} },
			updateEditorTopBorder() {},
			taskManager: undefined,
			...overrides,
		}) as unknown as InteractiveModeContext;

	/** Replace the private #dispatchEvent with a throwing stub. */
	function stubDispatch(controller: EventController, err: unknown): void {
		(controller as unknown as { dispatchEvent?: unknown });
		// #dispatchEvent is private; reach it through the instance by name mangling
		// is not possible, so we override via the prototype-bound property the
		// public wrapper calls. handleEvent calls `this.#dispatchEvent(event)`,
		// which resolves to the class-private slot — override it on the instance
		// using Reflect on the brand-checked field name used by the bundler is
		// brittle; instead we drive the real dispatch with an event whose handling
		// is guaranteed to throw (no ctx wiring), proving the wrapper catches it.
		void controller;
		void err;
	}

	it("does not throw when dispatch fails on a real event with an unwired context", async () => {
		// A bare ctx makes the real #dispatchEvent throw deep in a branch (e.g.
		// touching undefined sub-objects). The guard must absorb it.
		const controller = new EventController(
			makeCtx({
				// Force the very first statement of #dispatchEvent to throw.
				statusLine: undefined as unknown as InteractiveModeContext["statusLine"],
			}),
		);
		const event = { type: "agent_start" } as AgentSessionEvent;
		// Must resolve, never reject — otherwise an unhandledRejection would
		// crash the host process in production.
		await expect(controller.handleEvent(event)).resolves.toBeUndefined();
	});

	it("absorbs an async init() rejection without propagating", async () => {
		const controller = new EventController(
			makeCtx({
				isInitialized: false,
				init: async () => {
					throw new Error("init boom");
				},
			}),
		);
		const event = { type: "message_end", message: { role: "assistant", content: [] } } as unknown as AgentSessionEvent;
		await expect(controller.handleEvent(event)).resolves.toBeUndefined();
	});

	it("processes a benign event branch without error", async () => {
		let canvasCount = -1;
		const controller = new EventController(
			makeCtx({
				statusLine: {
					setCanvasTaskCount(n: number) {
						canvasCount = n;
					},
					invalidate() {},
				} as unknown as InteractiveModeContext["statusLine"],
			}),
		);
		// audit_suggest is a tiny branch; with showAuditOverlay stubbed it runs clean.
		const controllerCtx = controller as unknown as { ctx: Record<string, unknown> };
		controllerCtx.ctx.showAuditOverlay = () => {};
		const event = { type: "audit_suggest" } as AgentSessionEvent;
		await expect(controller.handleEvent(event)).resolves.toBeUndefined();
		expect(canvasCount).toBe(0);
	});

	void stubDispatch;
});
