/**
 * Bridge between session todo state and the QML dashboard panel.
 *
 * Follows the LoopDashboardBridge pattern: builds snapshots, subscribes to
 * EventBus changes, emits shell:add_panel/shell:remove_panel, and handles
 * gate toggle control messages from QML.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { EventBus } from "../utils/event-bus";
import type { TodoPhase } from "./todo-write";
import { hasGate, isTaskBlocked } from "./todo-write";

// =============================================================================
// Payload types
// =============================================================================

export interface TodoDashboardTask {
	id: string;
	content: string;
	status: string;
	blocked: boolean;
	gateCommit?: boolean;
	gateArtifact?: string;
	gateCmd?: string;
	gateLlm?: string;
	verifyCmd?: string;
	blockers?: string[];
}

export interface TodoDashboardPhase {
	id: string;
	name: string;
	tasks: TodoDashboardTask[];
}

export interface TodoDashboardPayload {
	type: "todo_snapshot";
	phases: TodoDashboardPhase[];
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
	getTodoPhases?: () => TodoPhase[];
	setTodoPhases?: (phases: TodoPhase[]) => void;
}

// =============================================================================
// Bridge
// =============================================================================

const PANEL_ID = "todo-dashboard";
const PANEL_TITLE = "Todo Tasks";

const VALID_GATE_FIELDS = new Set(["gateCommit", "gateArtifact", "gateCmd", "gateLlm", "verifyCmd"]);

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
		const phases = this.#session.getTodoPhases?.() ?? [];
		const allTasks = phases.flatMap(p => p.tasks);

		const dashPhases: TodoDashboardPhase[] = phases.map(phase => ({
			id: phase.id,
			name: phase.name,
			tasks: phase.tasks.map(task => ({
				id: task.id,
				content: task.content,
				status: task.status,
				blocked: isTaskBlocked(task, allTasks),
				gateCommit: task.gateCommit,
				gateArtifact: task.gateArtifact,
				gateCmd: task.gateCmd,
				gateLlm: task.gateLlm,
				verifyCmd: task.verifyCmd,
				blockers: task.blockers,
			})),
		}));

		return {
			type: "todo_snapshot",
			phases: dashPhases,
			hasGatedTasks: allTasks.some(hasGate),
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
	handleControl(payload: TodoControlMessage): void {
		if (payload.action !== "todo_control") return;

		const { taskId, gate, enabled } = payload;
		if (!VALID_GATE_FIELDS.has(gate)) {
			logger.warn("todo-dashboard: invalid gate field", { gate, taskId });
			return;
		}

		const phases = this.#session.getTodoPhases?.();
		if (!phases) return;

		let found = false;
		for (const phase of phases) {
			for (const task of phase.tasks) {
				if (task.id === taskId) {
					if (gate === "gateCommit") {
						task.gateCommit = enabled;
					} else if (gate === "gateArtifact") {
						task.gateArtifact = enabled ? task.gateArtifact || "" : undefined;
					} else if (gate === "gateCmd") {
						task.gateCmd = enabled ? task.gateCmd || "" : undefined;
					} else if (gate === "gateLlm") {
						task.gateLlm = enabled ? task.gateLlm || "" : undefined;
					} else if (gate === "verifyCmd") {
						task.verifyCmd = enabled ? task.verifyCmd || "" : undefined;
					}
					found = true;
					break;
				}
			}
			if (found) break;
		}

		if (!found) {
			logger.warn("todo-dashboard: task not found for control", { taskId });
			return;
		}

		this.#session.setTodoPhases?.(phases);
		// Re-emit so subscribers (including ourselves) refresh
		this.#eventBus?.emit("todo:change", { phases });
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
