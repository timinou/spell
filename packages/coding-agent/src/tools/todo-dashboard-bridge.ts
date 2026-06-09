/**
 * Bridge between session todo state and the QML dashboard panel.
 *
 * Follows the LoopDashboardBridge pattern: builds snapshots, subscribes to
 * EventBus changes, emits shell:add_panel/shell:remove_panel, and handles
 * gate toggle control messages from QML.
 */

import { logger } from "@spell/pi-utils";
import type { EventBus } from "../utils/event-bus";
import type { TodoNode } from "./todo-write";
import { hasGate, isNodeBlocked } from "./todo-write";

// =============================================================================
// Payload types
// =============================================================================

export interface TodoDashboardTask {
	id: string;
	content: string;
	status: string;
	blocked: boolean;
	group?: string;
	verifyCommit?: boolean;
	verifyArtifact?: string;
	verifyCmd?: string;
	verifyReview?: string;
	verificationArtifact?: string;
	blockers?: string[];
	ref?: string | null;
	closesRef?: boolean;
}

export interface TodoDashboardGroup {
	id: string;
	name: string;
	tasks: TodoDashboardTask[];
}

export interface TodoDashboardPayload {
	type: "todo_snapshot";
	groups: TodoDashboardGroup[];
	hasGatedTasks: boolean;
}

export interface TodoControlMessage {
	action: "todo_control";
	taskId: string;
	gate: string;
	enabled: boolean;
}

// =============================================================================
// Session accessor interface (subset of ToolSession)
// =============================================================================

interface TodoSessionAccessor {
	getTodoNodes?: () => TodoNode[];
	setTodoNodes?: (nodes: TodoNode[], options?: { reset?: boolean }) => void;
}

// =============================================================================
// Bridge
// =============================================================================

const PANEL_ID = "todo-dashboard";
const PANEL_TITLE = "Todo Tasks";

const VALID_GATE_FIELDS = new Set(["commit", "artifact", "cmd", "review"]);

export class TodoDashboardBridge {
	readonly #session: TodoSessionAccessor;
	readonly #eventBus?: EventBus;
	#subscriptions: Array<() => void> = [];
	#panelRegistered = false;

	constructor(session: TodoSessionAccessor, eventBus?: EventBus) {
		this.#session = session;
		this.#eventBus = eventBus;
	}

		buildSnapshot(): TodoDashboardPayload {
		const nodes = this.#session.getTodoNodes?.() ?? [];

		// Cluster flat nodes by cosmetic group label for the dashboard.
		const order: string[] = [];
		const buckets = new Map<string, TodoNode[]>();
		for (const node of nodes) {
			const label = node.group?.trim() || "Tasks";
			if (!buckets.has(label)) {
				buckets.set(label, []);
				order.push(label);
			}
			buckets.get(label)!.push(node);
		}

		const dashboardGroups: TodoDashboardGroup[] = order.map((label, idx) => ({
			id: `group-${idx + 1}`,
			name: label,
			tasks: buckets.get(label)!.map(task => ({
				id: task.id,
				content: task.content,
				status: task.status,
				blocked: isNodeBlocked(task, nodes),
				group: task.group,
				verifyCommit: task.verify?.commit,
				verifyArtifact: task.verify?.artifact,
				verifyCmd: task.verify?.cmd,
				verifyReview: task.verify?.review,
				verificationArtifact: task.verificationArtifact,
				blockers: task.blockers,
				ref: task.ref,
				closesRef: task.closesRef,
			})),
		}));

		return {
			type: "todo_snapshot",
			groups: dashboardGroups,
			hasGatedTasks: nodes.some(hasGate),
		};
	}

	/** Emit an add_panel event so the shell sidebar registers the todo dashboard. */
	registerPanel(): void {
		if (this.#panelRegistered) return;
		this.#eventBus?.emit("shell:add_panel", {
			id: PANEL_ID,
			title: PANEL_TITLE,
			type: "todo-dashboard",
		});
		this.#panelRegistered = true;
	}

	/** Emit a remove_panel event to clean up the shell sidebar entry. */
	unregisterPanel(): void {
		if (!this.#panelRegistered) return;
		this.#eventBus?.emit("shell:remove_panel", { id: PANEL_ID });
		this.#panelRegistered = false;
	}

	/** Subscribe to todo changes and auto-register/unregister the panel. */
	subscribe(callback: (payload: TodoDashboardPayload) => void): void {
		// Initial snapshot
		const snapshot = this.buildSnapshot();
		callback(snapshot);
		this.#autoRegister(snapshot);

		if (!this.#eventBus) return;

		const unsub = this.#eventBus.subscribe("todo:change", () => {
			const snap = this.buildSnapshot();
			callback(snap);
			this.#autoRegister(snap);
		});
		this.#subscriptions.push(unsub);
	}

	/** Process gate toggle messages from QML panel. */
		/** Process gate toggle messages from QML panel. */
	handleControl(payload: TodoControlMessage): void {
		if (payload.action !== "todo_control") return;

		const { taskId, gate, enabled } = payload;
		if (!VALID_GATE_FIELDS.has(gate)) {
			logger.warn("todo-dashboard: invalid gate field", { gate, taskId });
			return;
		}

		const nodes = this.#session.getTodoNodes?.();
		if (!nodes) return;

		const task = nodes.find(node => node.id === taskId);
		if (!task) {
			logger.warn("todo-dashboard: task not found for control", { taskId });
			return;
		}
		const verify = task.verify ?? (task.verify = {});
		if (gate === "commit") {
			verify.commit = enabled;
		} else if (gate === "artifact") {
			verify.artifact = enabled ? verify.artifact || "" : undefined;
		} else if (gate === "cmd") {
			verify.cmd = enabled ? verify.cmd || "" : undefined;
		} else if (gate === "review") {
			verify.review = enabled ? verify.review || "" : undefined;
		}

		this.#session.setTodoNodes?.(nodes);
		// Re-emit so subscribers (including ourselves) refresh
		this.#eventBus?.emit("todo:change", { nodes });
	}

	dispose(): void {
		for (const unsub of this.#subscriptions) {
			unsub();
		}
		this.#subscriptions = [];
		if (this.#panelRegistered) this.unregisterPanel();
	}

	get panelRegistered(): boolean {
		return this.#panelRegistered;
	}

	#autoRegister(snapshot: TodoDashboardPayload): void {
		if (snapshot.hasGatedTasks && !this.#panelRegistered) {
			this.registerPanel();
		} else if (!snapshot.hasGatedTasks && this.#panelRegistered) {
			this.unregisterPanel();
		}
	}
}
