import type { EventBus } from "../utils/event-bus";
import type { LoopManager } from "./loop-manager";

export interface LoopDashboardPayload {
	type: "loop_snapshot";
	loop: {
		id: string;
		name: string;
		state: string;
		iteration: number;
		maxIterations: number;
		elapsedMs: number;
		budgetLimitMs: number;
	};
	tree: Array<{ id: string; name: string; state: string }>;
	gates: Array<{ gateId: string; outcome: string; reason: string }>;
	pendingGateId?: string;
	autoApproveEnabled: boolean;
	autoApproveAt: number;
	nowMs: number;
}

export class LoopDashboardBridge {
	readonly #manager: LoopManager;
	readonly #eventBus?: EventBus;
	#subscriptions: Array<() => void> = [];

	constructor(manager: LoopManager, eventBus?: EventBus) {
		this.#manager = manager;
		this.#eventBus = eventBus;
	}

	buildSnapshot(loopId: string): LoopDashboardPayload {
		const loop = this.#manager.getLoop(loopId);
		const pending = this.#manager.listPendingHumanGates(loopId)[0];
		return {
			type: "loop_snapshot",
			loop: {
				id: loop.id,
				name: loop.name,
				state: loop.state,
				iteration: loop.iteration,
				maxIterations: loop.maxIterations,
				elapsedMs: loop.budgetStatus.elapsedMs,
				budgetLimitMs: loop.budgetLimits.wallClockMs,
			},
			tree: [
				{ id: loop.id, name: loop.name, state: loop.state },
				...loop.childLoopIds.map(id => {
					const child = this.#manager.getLoop(id);
					return { id: child.id, name: child.name, state: child.state };
				}),
			],
			gates: loop.gateResults.map(decision => ({
				gateId: decision.gateId,
				outcome: decision.outcome,
				reason: decision.reason,
			})),
			pendingGateId: pending?.gateId,
			autoApproveEnabled: loop.autoApproveEnabled,
			autoApproveAt: pending?.autoApproveAt ?? 0,
			nowMs: Date.now(),
		};
	}

	subscribe(loopId: string, callback: (payload: LoopDashboardPayload) => void): void {
		callback(this.buildSnapshot(loopId));
		if (!this.#eventBus) return;
		for (const channel of [`loop:${loopId}:state`, `loop:${loopId}:iteration`, `loop:${loopId}:gate`]) {
			this.#subscriptions.push(
				this.#eventBus.subscribe(channel, () => {
					callback(this.buildSnapshot(loopId));
				}),
			);
		}
	}

	dispose(): void {
		for (const unsubscribe of this.#subscriptions) {
			unsubscribe();
		}
		this.#subscriptions = [];
	}

	async handleControl(payload: { loopId: string; action: string; gateId?: string }): Promise<void> {
		switch (payload.action) {
			case "pause":
				await this.#manager.pause(payload.loopId);
				return;
			case "resume":
				await this.#manager.resume(payload.loopId);
				return;
			case "approve":
				if (payload.gateId) await this.#manager.approveGate(payload.loopId, payload.gateId);
				return;
			case "reject":
				if (payload.gateId) await this.#manager.rejectGate(payload.loopId, payload.gateId);
				return;
			case "toggle-auto-approve":
				if (payload.gateId) this.#manager.setAutoApprove(payload.loopId, payload.gateId, true);
				return;
			case "kill":
				await this.#manager.kill(payload.loopId);
				return;
		}
	}
}
