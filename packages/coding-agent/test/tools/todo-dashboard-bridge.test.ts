/**
 * Tests for TodoDashboardBridge.
 *
 * Contracts:
 *   - buildSnapshot returns groups with computed blocked status
 *   - subscribe triggers callback on todo:change EventBus events
 *   - registerPanel/unregisterPanel emit shell:add_panel/shell:remove_panel
 *   - Auto-register when gated tasks exist, auto-unregister when not
 *   - handleControl toggles gate fields on tasks
 */

import { describe, expect, test } from "bun:test";
import { TodoDashboardBridge } from "../../src/tools/todo-dashboard-bridge";
import type { TodoGroup } from "../../src/tools/todo-write";
import { EventBus } from "../../src/utils/event-bus";

function makeGroups(
	...items: Array<{
		id: string;
		content: string;
		status?: string;
		gateCommit?: boolean;
		verificationArtifact?: string;
		blockers?: string[];
		orgItemId?: string;
		orgItemClosingId?: string;
	}>
): TodoGroup[] {
	return [
		{
			id: "group-1",
			name: "Test Group",
			tasks: items.map(item => ({
				id: item.id,
				content: item.content,
				status: (item.status ?? "pending") as any,
				gateCommit: item.gateCommit,
				verificationArtifact: item.verificationArtifact,
				blockers: item.blockers,
				orgItemId: item.orgItemId,
				orgItemClosingId: item.orgItemClosingId,
			})),
		},
	];
}

function makeSession(initialGroups: TodoGroup[] = []) {
	let groups = initialGroups;
	return {
		getTodoGroups: () => groups,
		setTodoGroups: (p: TodoGroup[]) => {
			groups = p;
		},
		get currentGroups() {
			return groups;
		},
	};
}

describe("TodoDashboardBridge", () => {
	test("buildSnapshot returns groups with blocked status", () => {
		const session = makeSession(
			makeGroups(
				{ id: "task-1", content: "First", status: "pending" },
				{ id: "task-2", content: "Second", status: "pending", blockers: ["task-1"] },
			),
		);
		const bridge = new TodoDashboardBridge(session);
		const snap = bridge.buildSnapshot();

		expect(snap.type).toBe("todo_snapshot");
		expect(snap.groups).toHaveLength(1);
		expect(snap.groups[0].tasks).toHaveLength(2);
		expect(snap.groups[0].tasks[0].blocked).toBe(false);
		expect(snap.groups[0].tasks[1].blocked).toBe(true);
	});

	test("buildSnapshot reports hasGatedTasks correctly", () => {
		const gated = makeSession(makeGroups({ id: "t1", content: "A", gateCommit: true }));
		const plain = makeSession(makeGroups({ id: "t1", content: "A" }));

		expect(new TodoDashboardBridge(gated).buildSnapshot().hasGatedTasks).toBe(true);
		expect(new TodoDashboardBridge(plain).buildSnapshot().hasGatedTasks).toBe(false);
	});

	test("subscribe triggers callback on todo:change", () => {
		const eventBus = new EventBus();
		const session = makeSession(makeGroups({ id: "t1", content: "A", gateCommit: true }));
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
		eventBus.subscribe("shell:add_panel", data => {
			events.push(data);
		});

		const bridge = new TodoDashboardBridge(makeSession(), eventBus);
		bridge.registerPanel();

		expect(events).toHaveLength(1);
		expect(events[0].id).toBe("todo-dashboard");
		expect(events[0].type).toBe("todo-dashboard");
	});

	test("registerPanel is idempotent", () => {
		const eventBus = new EventBus();
		const events: any[] = [];
		eventBus.subscribe("shell:add_panel", data => {
			events.push(data);
		});

		const bridge = new TodoDashboardBridge(makeSession(), eventBus);
		bridge.registerPanel();
		bridge.registerPanel();

		expect(events).toHaveLength(1);
	});

	test("auto-registers when gated tasks exist", () => {
		const eventBus = new EventBus();
		const events: any[] = [];
		eventBus.subscribe("shell:add_panel", data => {
			events.push(data);
		});

		const session = makeSession(makeGroups({ id: "t1", content: "A", gateCommit: true }));
		const bridge = new TodoDashboardBridge(session, eventBus);
		bridge.subscribe(() => {}); // subscribe triggers auto-register check

		expect(events).toHaveLength(1);
		expect(bridge.panelRegistered).toBe(true);
	});

	test("auto-unregisters when no gated tasks", () => {
		const eventBus = new EventBus();
		const addEvents: any[] = [];
		const removeEvents: any[] = [];
		eventBus.subscribe("shell:add_panel", data => {
			addEvents.push(data);
		});
		eventBus.subscribe("shell:remove_panel", data => {
			removeEvents.push(data);
		});

		const session = makeSession(makeGroups({ id: "t1", content: "A", gateCommit: true }));
		const bridge = new TodoDashboardBridge(session, eventBus);
		bridge.subscribe(() => {});

		expect(bridge.panelRegistered).toBe(true);

		// Remove gated tasks and emit change
		session.setTodoGroups(makeGroups({ id: "t1", content: "A" }));
		eventBus.emit("todo:change", {});

		expect(bridge.panelRegistered).toBe(false);
		expect(removeEvents).toHaveLength(1);
	});

	test("handleControl toggles gate field on task", () => {
		const session = makeSession(makeGroups({ id: "task-1", content: "A" }));
		const bridge = new TodoDashboardBridge(session);

		bridge.handleControl({
			action: "todo_control",
			taskId: "task-1",
			gate: "gateCommit",
			enabled: true,
		});

		const groups = session.getTodoGroups();
		expect(groups[0].tasks[0].gateCommit).toBe(true);
	});

	test("handleControl ignores invalid gate field", () => {
		const session = makeSession(makeGroups({ id: "task-1", content: "A" }));
		const bridge = new TodoDashboardBridge(session);

		bridge.handleControl({
			action: "todo_control",
			taskId: "task-1",
			gate: "invalidField",
			enabled: true,
		});

		// No error thrown, task unchanged
		const groups = session.getTodoGroups();
		expect(groups[0].tasks[0].gateCommit).toBeUndefined();
	});

	test("dispose cleans up subscriptions and unregisters panel", () => {
		const eventBus = new EventBus();
		const session = makeSession(makeGroups({ id: "t1", content: "A", gateCommit: true }));
		const bridge = new TodoDashboardBridge(session, eventBus);

		bridge.subscribe(() => {});
		expect(bridge.panelRegistered).toBe(true);

		bridge.dispose();
		expect(bridge.panelRegistered).toBe(false);
	});

	test("buildSnapshot includes verificationArtifact", () => {
		const session = makeSession(
			makeGroups({ id: "task-1", content: "Auth task", verificationArtifact: "artifacts/verify.json" }),
		);
		const snap = new TodoDashboardBridge(session).buildSnapshot();

		expect(snap.groups[0].tasks[0]?.verificationArtifact).toBe("artifacts/verify.json");
	});

	test("buildSnapshot includes orgItemId and orgItemClosingId", () => {
		const session = makeSession(
			makeGroups({
				id: "task-1",
				content: "Auth task",
				orgItemId: "FEAT-001-auth",
				orgItemClosingId: "FEAT-001-auth-close",
			}),
		);
		const bridge = new TodoDashboardBridge(session);
		const snap = bridge.buildSnapshot();

		expect(snap.groups[0].tasks[0].orgItemId).toBe("FEAT-001-auth");
		expect(snap.groups[0].tasks[0].orgItemClosingId).toBe("FEAT-001-auth-close");
	});
});
