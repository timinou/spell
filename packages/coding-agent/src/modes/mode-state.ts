import type { ResolvedModeConfig } from "../capability/mode";
import type { AuditState } from "./audit-state";

export interface UserModeState {
	type: "user";
	name: string;
	config: ResolvedModeConfig;
	enabled: boolean;
	readOnly: boolean;
	toolSnapshot?: string[];
}

export type ActiveModeState = AuditState | UserModeState;

export function isAuditMode(state: ActiveModeState | undefined | null): state is AuditState {
	return state?.type === "audit";
}

export function isUserMode(state: ActiveModeState | undefined | null): state is UserModeState {
	return state?.type === "user";
}
