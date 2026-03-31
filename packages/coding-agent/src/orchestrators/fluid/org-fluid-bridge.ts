import { DEFAULT_ORG_CONFIG, findItemById, resolveCategories, updateItemStateInFile } from "@oh-my-pi/pi-org";
import { logger } from "@oh-my-pi/pi-utils";
import { completePlanItem } from "../../plan-mode/org-plan";
import type { EventBus } from "../../utils/event-bus";
import { type AgentRuntime, FLUID_EVENT_CHANNEL, type FluidEvent, type FluidPlan } from "./types";

export interface OrgFluidBridgeOptions {
	eventBus: EventBus;
	planId: string;
	planFile: string;
	settings: { get(key: string): unknown };
	projectRoot: string;
	/** 'auto' for ultraplan, 'suggest' for regular plan */
	auditMode: "auto" | "suggest";
	/** Whether this is a design-flavored plan */
	isDesign?: boolean;
}

export interface PostExecutionResult {
	totalAgents: number;
	completedCount: number;
	failedCount: number;
	failedAgentIds: string[];
	planCompleted: boolean;
	auditState: "auto" | "suggest";
}

export class OrgFluidBridge {
	#options: OrgFluidBridgeOptions;
	/** agentId -> current org state we last transitioned to */
	#stateTransitions: Map<string, string>;
	/** agentId -> orgItemId, populated from the plan_complete event */
	#nodeRegistry: Map<string, string>;
	#unsubscribe?: () => void;
	#finalized = false;

	constructor(options: OrgFluidBridgeOptions) {
		this.#options = options;
		this.#stateTransitions = new Map();
		this.#nodeRegistry = new Map();
	}

	/** Start listening to events. Accepts the FluidPlan so the node registry is
	 * populated before the first agent_state_change fires. Call before execute(). */
	start(plan: FluidPlan): void {
		if (this.#unsubscribe) return; // already started

		// Populate registry upfront — plan_complete fires after all agents complete,
		// too late to catch running/completed transitions.
		for (const node of plan.agents) {
			if (node.orgItemId) {
				this.#nodeRegistry.set(node.id, node.orgItemId);
			}
		}

		this.#unsubscribe = this.#options.eventBus.subscribe(FLUID_EVENT_CHANNEL, (event: unknown) =>
			this.#handleEvent(event as FluidEvent),
		);
	}

	/** Stop listening and run post-execution hooks. Call after execute() completes. */
	async finalize(results: Map<string, AgentRuntime>): Promise<PostExecutionResult> {
		// Idempotent: skip side-effects on repeated calls, but always return accurate counts.
		const didSideEffects = !this.#finalized;
		this.#finalized = true;

		this.#unsubscribe?.();
		this.#unsubscribe = undefined;

		const failedAgentIds: string[] = [];
		let completedCount = 0;

		for (const [agentId, runtime] of results) {
			if (runtime.state === "completed") {
				completedCount++;
			} else if (runtime.state === "failed") {
				failedAgentIds.push(agentId);
			}
		}

		const totalAgents = results.size;
		const failedCount = failedAgentIds.length;
		const allCompleted = failedCount === 0 && completedCount === totalAgents;

		let planCompleted = false;

		if (didSideEffects && allCompleted) {
			try {
				const result = await completePlanItem(
					this.#options.settings as Parameters<typeof completePlanItem>[0],
					this.#options.projectRoot,
					{ id: this.#options.planId, file: this.#options.planFile },
				);
				planCompleted = result !== null;
			} catch (err) {
				logger.error("org-fluid-bridge: failed to complete plan item", {
					planId: this.#options.planId,
					err,
				});
			}
		}

		return {
			totalAgents,
			completedCount,
			failedCount,
			failedAgentIds,
			planCompleted,
			auditState: this.#options.auditMode,
		};
	}

	#handleEvent(event: FluidEvent): void {
		if (event.type !== "agent_state_change") return;

		const { agentId, state } = event;

		if (state === "running") {
			void this.#maybeTransitionOrgItem(agentId, "DOING");
		} else if (state === "completed") {
			void this.#maybeTransitionOrgItem(agentId, "DONE");
		} else if (state === "failed") {
			logger.warn("org-fluid-bridge: agent failed, leaving org item in DOING", {
				agentId,
				error: event.error,
			});
		}
	}

	async #maybeTransitionOrgItem(agentId: string, targetState: string): Promise<void> {
		const orgItemId = this.#nodeRegistry.get(agentId);
		if (!orgItemId) return; // agent has no org representation; silently skip

		await this.#transitionOrgItem(orgItemId, targetState);
		this.#stateTransitions.set(agentId, targetState);
	}

	async #transitionOrgItem(orgItemId: string, targetState: string): Promise<void> {
		try {
			const rawKeywords = this.#options.settings.get("org.todoKeywords") as readonly string[] | string[] | undefined;
			const todoKeywords =
				rawKeywords && rawKeywords.length > 0 ? [...rawKeywords] : [...DEFAULT_ORG_CONFIG.todoKeywords];
			const config = { ...DEFAULT_ORG_CONFIG, todoKeywords };
			const categories = resolveCategories(config, this.#options.projectRoot);
			const catDirs = categories.map(c => ({ absPath: c.absPath, name: c.name, dir: c.dirName }));

			const item = await findItemById(catDirs, orgItemId, config.todoKeywords);
			if (!item) {
				logger.warn("org-fluid-bridge: org item not found, skipping transition", {
					orgItemId,
					targetState,
				});
				return;
			}

			const updated = await updateItemStateInFile(item.file, orgItemId, targetState, config.todoKeywords);
			if (!updated) {
				logger.warn("org-fluid-bridge: state transition returned false", {
					orgItemId,
					targetState,
					file: item.file,
				});
			} else {
				logger.debug("org-fluid-bridge: transitioned org item", { orgItemId, targetState });
			}
		} catch (err) {
			logger.error("org-fluid-bridge: error transitioning org item state", {
				orgItemId,
				targetState,
				err,
			});
		}
	}
}
