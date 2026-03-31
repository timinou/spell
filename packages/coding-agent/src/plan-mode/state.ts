import type { ResolvedModeConfig } from "../capability/mode";
import type { AuditState } from "./audit-state";

export interface PlanModeState {
	type: "plan";
	enabled: boolean;
	planFilePath: string;
	workflow?: "parallel" | "iterative";
	reentry?: boolean;
	/** When true, ultraplan mode is active (runs Metis gap analysis and optional Momus review). */
	ultraplan?: boolean;
	/** When set to "design", activates the UI/UX design planning workflow with Aphrodite/Athena gates. */
	flavor?: "design";
	/** Name of the user-defined mode config, if this plan was activated from a mode. */
	modeConfigName?: string;
}

export interface UserModeState {
	type: "user";
	name: string;
	config: ResolvedModeConfig;
	enabled: boolean;
	readOnly: boolean;
	toolSnapshot?: string[];
}

export type ActiveModeState = PlanModeState | AuditState | UserModeState;

export function isPlanMode(state: ActiveModeState | undefined | null): state is PlanModeState {
	return state?.type === "plan";
}

export function isAuditMode(state: ActiveModeState | undefined | null): state is AuditState {
	return state?.type === "audit";
}

export function isUserMode(state: ActiveModeState | undefined | null): state is UserModeState {
	return state?.type === "user";
}
