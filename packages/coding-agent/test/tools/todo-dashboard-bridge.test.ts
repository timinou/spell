/**
 * Tests for TodoDashboardBridge.
 *
 * Contracts:
 *   - buildSnapshot returns phases with computed blocked status
 *   - subscribe triggers callback on todo:change EventBus events
 *   - registerPanel/unregisterPanel emit shell:add_panel/shell:remove_panel
 *   - Auto-register when gated tasks exist, auto-unregister when not
 *   - handleControl toggles gate fields on tasks
 */

import { describe, expect, test } from "bun:test";
import { EventBus } from "../../src/utils/event-bus";
import type { TodoPhase } from "../../src/tools/todo-write";
import { TodoDashboardBridge } from "../../src/tools/todo-dashboard-bridge";

function makePhases(
	...items: Array<{ id: string; content: string; status?: string; gateCommit?: boolean; blockers?: string[] }>
): TodoPhase[] {
	return [
		{
			id: "phase-1",
			name: "Test Phase",
			tasks: items.map(item => ({
				id: item.id,
				content: item.content,
				status: (item.status ?? "pending") as any,
				gateCommit: item.gateCommit,
				blockers: item.blockers,
			})),
		},
	];
}

function makeSession(initialPhases: TodoPhase[] = []) {
	let phases = initialPhases;
	return {
		getTodoPhases: () => phases,
		setTodoPhases: (p: TodoPhase[]) => {
			phases = p;
		},
		get currentPhases() {
			return phases;
		},
	};
}

describe("TodoDashboardBridge", () => {
	test("buildSnapshot returns phases with blocked status", () => {
		const session = makeSession(
			makePhases(
				{ id: "task-1", content: "First", status: "pending" },
				{ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] },
			),
		);
		const bridge = new TodoDashboardBridge(session);
		const snap = bridge.buildSnapshot();

		expect(snap.type).toBe("todo_snapshot");
		expect(snap.phases).toHaveLength(1);
		expect(snap.phases[0].tasks).toHaveLength(2);
		expect(snap.phases[0].tasks[0].blocked).toBe(false);
		expect(snap.phases[0].tasks[1].blocked).toBe(true);
	});

	test("buildSnapshot reports hasGatedTasks correctly", () => {
		const gated = makeSession(makePhases({ id: "t1", content: "A", gateCommit: true }));
		const plain = makeSession(makePhases({ id: "t1", content: "A" }));

		expect(new TodoDashboardBridge(gated).buildSnapshot().hasGatedTasks).toBe(true);
		expect(new TodoDashboardBridge(plain).buildSnapshot().hasGatedTasks).toBe(false);
	});

	test("subscribe triggers callback on todo:change", () => {
		const eventBus = new EventBus();
		const session = makeSession(makePhases({ id: "t1", content: "A", gateCommit: true }));
		const bridge = new TodoDashboardBridge(session, eventBus);

		const snapshots: any[] = [];
		bridge.subscribe(snap => snapshots.push(snap));

		// Initial callback
		expect(snapshots).toHaveLength(1);

		// Emit change
		eventBus.emit("todo:change", {});
		expect(snapshots).toHaveLength(2);
	});

	test("registerPanel emits shell:add_panel", () => {
		const eventBus = new EventBus();
		const events: any[] = [];
		eventBus.subscribe("shell:add_panel", data => { events.push(data); });

		const bridge = new TodoDashboardBridge(makeSession(), eventBus);
		bridge.registerPanel();

		expect(events).toHaveLength(1);
		expect(events[0].id).toBe("todo-dashboard");
		expect(events[0].type).toBe("todo-dashboard");
	});

	test("registerPanel is idempotent", () => {
		const eventBus = new EventBus();
		const events: any[] = [];
		eventBus.subscribe("shell:add_panel", data => { events.push(data); });

		const bridge = new TodoDashboardBridge(makeSession(), eventBus);
		bridge.registerPanel();
		bridge.registerPanel();

		expect(events).toHaveLength(1);
	});

	test("auto-registers when gated tasks exist", () => {
		const eventBus = new EventBus();
		const events: any[] = [];
		eventBus.subscribe("shell:add_panel", data => { events.push(data); });

		const session = makeSession(makePhases({ id: "t1", content: "A", gateCommit: true }));
		const bridge = new TodoDashboardBridge(session, eventBus);
		bridge.subscribe(() => {}); // subscribe triggers auto-register check

		expect(events).toHaveLength(1);
		expect(bridge.panelRegistered).toBe(true);
	});

	test("auto-unregisters when no gated tasks", () => {
		const eventBus = new EventBus();
		const addEvents: any[] = [];
		const removeEvents: any[] = [];
		eventBus.subscribe("shell:add_panel", data => { addEvents.push(data); });
		eventBus.subscribe("shell:remove_panel", data => { removeEvents.push(data); });

		const session = makeSession(makePhases({ id: "t1", content: "A", gateCommit: true }));
		const bridge = new TodoDashboardBridge(session, eventBus);
		bridge.subscribe(() => {});

		expect(bridge.panelRegistered).toBe(true);

		// Remove gated tasks and emit change
		session.setTodoPhases(makePhases({ id: "t1", content: "A" }));
		eventBus.emit("todo:change", {});

		expect(bridge.panelRegistered).toBe(false);
		expect(removeEvents).toHaveLength(1);
	});

	test("handleControl toggles gate field on task", () => {
		const session = makeSession(makePhases({ id: "task-1", content: "A" }));
		const bridge = new TodoDashboardBridge(session);

		bridge.handleControl({
			action: "todo_control",
			taskId: "task-1",
			gate: "gateCommit",
			enabled: true,
		});

		const phases = session.getTodoPhases();
		expect(phases[0].tasks[0].gateCommit).toBe(true);
	});

	test("handleControl ignores invalid gate field", () => {
		const session = makeSession(makePhases({ id: "task-1", content: "A" }));
		const bridge = new TodoDashboardBridge(session);

		bridge.handleControl({
			action: "todo_control",
			taskId: "task-1",
			gate: "invalidField",
			enabled: true,
		});

		// No error thrown, task unchanged
		const phases = session.getTodoPhases();
		expect(phases[0].tasks[0].gateCommit).toBeUndefined();
	});

	test("dispose cleans up subscriptions and unregisters panel", () => {
		const eventBus = new EventBus();
		const session = makeSession(makePhases({ id: "t1", content: "A", gateCommit: true }));
		const bridge = new TodoDashboardBridge(session, eventBus);

		bridge.subscribe(() => {});
		expect(bridge.panelRegistered).toBe(true);

		bridge.dispose();
		expect(bridge.panelRegistered).toBe(false);
	});
});
