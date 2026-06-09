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
import type { TodoNode } from "../../src/tools/todo-write";
import { EventBus } from "../../src/utils/event-bus";

function makeNodes(
	...items: Array<{
		id: string;
		content: string;
		status?: string;
		group?: string;
		verifyCommit?: boolean;
		verifyArtifact?: string;
		verifyCmd?: string;
		verificationArtifact?: string;
		blockers?: string[];
		ref?: string | null;
		closesRef?: boolean;
	}>
): TodoNode[] {
	return items.map(item => ({
		id: item.id,
		content: item.content,
		status: (item.status ?? "pending") as any,
		group: item.group ?? "Test Group",
		verify: item.verifyCommit || item.verifyArtifact || item.verifyCmd
			? {
					commit: item.verifyCommit,
					artifact: item.verifyArtifact,
					cmd: item.verifyCmd,
			  }
			: undefined,
		verificationArtifact: item.verificationArtifact,
		blockers: item.blockers,
		ref: item.ref,
		closesRef: item.closesRef,
	}));
}

function makeSession(initialNodes: TodoNode[] = []) {
	let nodes = initialNodes;
	return {
		getTodoNodes: () => nodes,
		setTodoNodes: (p: TodoNode[]) => {
			nodes = p;
		},
		get currentNodes() {
			return nodes;
		},
	};
}

describe("TodoDashboardBridge", () => {
	test("buildSnapshot returns groups with blocked status", () => {
		const session = makeSession(
			makeNodes(
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
		const gated = makeSession(makeNodes({ id: "t1", content: "A", verifyCommit: true }));
		const plain = makeSession(makeNodes({ id: "t1", content: "A" }));

		expect(new TodoDashboardBridge(gated).buildSnapshot().hasGatedTasks).toBe(true);
		expect(new TodoDashboardBridge(plain).buildSnapshot().hasGatedTasks).toBe(false);
	});

	test("subscribe triggers callback on todo:change", () => {
		const eventBus = new EventBus();
		const session = makeSession(makeNodes({ id: "t1", content: "A", verifyCommit: true }));
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

		const session = makeSession(makeNodes({ id: "t1", content: "A", verifyCommit: true }));
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

		const session = makeSession(makeNodes({ id: "t1", content: "A", verifyCommit: true }));
		const bridge = new TodoDashboardBridge(session, eventBus);
		bridge.subscribe(() => {});

		expect(bridge.panelRegistered).toBe(true);

		// Remove gated tasks and emit change
		session.setTodoNodes(makeNodes({ id: "t1", content: "A" }));
		eventBus.emit("todo:change", {});

		expect(bridge.panelRegistered).toBe(false);
		expect(removeEvents).toHaveLength(1);
	});

	test("handleControl toggles gate field on task", () => {
		const session = makeSession(makeNodes({ id: "task-1", content: "A" }));
		const bridge = new TodoDashboardBridge(session);

		bridge.handleControl({
			action: "todo_control",
			taskId: "task-1",
			gate: "commit",
			enabled: true,
		});

		const nodes = session.getTodoNodes();
		expect(nodes[0].verify?.commit).toBe(true);
	});

	test("handleControl ignores invalid gate field", () => {
		const session = makeSession(makeNodes({ id: "task-1", content: "A" }));
		const bridge = new TodoDashboardBridge(session);

		bridge.handleControl({
			action: "todo_control",
			taskId: "task-1",
			gate: "invalidField",
			enabled: true,
		});

		// No error thrown, task unchanged
		const nodes = session.getTodoNodes();
		expect(nodes[0].verify?.commit).toBeUndefined();
	});

	test("dispose cleans up subscriptions and unregisters panel", () => {
		const eventBus = new EventBus();
		const session = makeSession(makeNodes({ id: "t1", content: "A", verifyCommit: true }));
		const bridge = new TodoDashboardBridge(session, eventBus);

		bridge.subscribe(() => {});
		expect(bridge.panelRegistered).toBe(true);

		bridge.dispose();
		expect(bridge.panelRegistered).toBe(false);
	});

	test("buildSnapshot includes verificationArtifact", () => {
		const session = makeSession(
			makeNodes({ id: "task-1", content: "Auth task", verificationArtifact: "artifacts/verify.json" }),
		);
		const snap = new TodoDashboardBridge(session).buildSnapshot();

		expect(snap.groups[0].tasks[0]?.verificationArtifact).toBe("artifacts/verify.json");
	});

	test("buildSnapshot includes ref and closesRef", () => {
		const session = makeSession(
			makeNodes({
				id: "task-1",
				content: "Auth task",
				ref: "org://FEAT-001-auth",
				closesRef: true,
			}),
		);
		const bridge = new TodoDashboardBridge(session);
		const snap = bridge.buildSnapshot();

		expect(snap.groups[0].tasks[0].ref).toBe("org://FEAT-001-auth");
		expect(snap.groups[0].tasks[0].closesRef).toBe(true);
	});
});
