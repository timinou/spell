import { DEFAULT_HUMAN_GATE_TIMEOUT_MS } from "../../constants";
import { GATE_OUTCOMES } from "../../contracts";
import type { HumanGateConfig, LoopPendingHumanGate } from "../../types";
import type { Clock } from "../clock";
import { GateTimer } from "../timer";
import type { GateExecutionContext, GateExecutor } from "../types";

interface PendingHumanGate {
	pending: LoopPendingHumanGate;
	resolve: (approved: boolean, reason: string) => void;
	timer?: GateTimer;
}

function makePendingKey(loopId: string, gateId: string): string {
	return `${loopId}:${gateId}`;
}

export interface HumanGateSettings {
	getAutoApproveTimeoutMs(): number | undefined;
	getAutoApproveEnabled(): boolean | undefined;
}

export class HumanGateExecutor implements GateExecutor<HumanGateConfig> {
	readonly #clock: Clock;
	#pending = new Map<string, PendingHumanGate>();
	#settings?: HumanGateSettings;

	constructor(clock: Clock, settings?: HumanGateSettings) {
		this.#clock = clock;
		this.#settings = settings;
	}

	async execute(gate: HumanGateConfig, context: GateExecutionContext) {
		const key = makePendingKey(context.loop.id, gate.id);
		const { promise, resolve } = Promise.withResolvers<{ approved: boolean; reason: string }>();
		const globalTimeout = this.#settings?.getAutoApproveTimeoutMs();
		// Per-gate config overrides global setting
		const autoApproveAfterMs = gate.autoApproveAfterMs ?? globalTimeout ?? DEFAULT_HUMAN_GATE_TIMEOUT_MS;
		const entry: PendingHumanGate = {
			pending: {
				loopId: context.loop.id,
				gateId: gate.id,
				prompt: gate.prompt,
				autoApproveAt: autoApproveAfterMs > 0 ? this.#clock.now() + autoApproveAfterMs : undefined,
			},
			resolve: (approved, reason) => {
				entry.timer?.cancel();
				this.#pending.delete(key);
				resolve({ approved, reason });
			},
		};
		if (autoApproveAfterMs > 0) {
			entry.timer = new GateTimer(this.#clock, autoApproveAfterMs, () => {
				entry.resolve(true, "Auto-approved after timeout");
			});
			entry.timer.start();
		}
		this.#pending.set(key, entry);
		const result = await promise;
		return {
			gateId: gate.id,
			trigger: gate.trigger.kind,
			outcome: result.approved ? GATE_OUTCOMES.pass : GATE_OUTCOMES.fail,
			reason: result.reason,
			evidence: [gate.prompt],
			attemptNumber: context.attemptNumber,
			maxAttempts: gate.maxAttempts ?? 1,
		};
	}

	approve(loopId: string, gateId: string, reason = "Approved by operator"): void {
		this.#pending.get(makePendingKey(loopId, gateId))?.resolve(true, reason);
	}

	reject(loopId: string, gateId: string, reason = "Rejected by operator"): void {
		this.#pending.get(makePendingKey(loopId, gateId))?.resolve(false, reason);
	}

	setAutoApprove(loopId: string, gateId: string, enabled: boolean, timeoutMs = DEFAULT_HUMAN_GATE_TIMEOUT_MS): void {
		const entry = this.#pending.get(makePendingKey(loopId, gateId));
		if (!entry) return;
		entry.timer?.cancel();
		if (!enabled || timeoutMs <= 0) {
			entry.pending.autoApproveAt = undefined;
			return;
		}
		entry.pending.autoApproveAt = this.#clock.now() + timeoutMs;
		entry.timer = new GateTimer(this.#clock, timeoutMs, () => {
			entry.resolve(true, "Auto-approved after timeout");
		});
		entry.timer.start();
	}

	listPending(loopId?: string): LoopPendingHumanGate[] {
		return Array.from(this.#pending.values())
			.map(entry => structuredClone(entry.pending))
			.filter(entry => !loopId || entry.loopId === loopId);
	}
}
