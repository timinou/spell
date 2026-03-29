import { DEFAULT_LOOP_DEPTH_LIMIT } from "../constants";

export interface DepthGuardResult {
	allowed: boolean;
	nextDepth: number;
	escalate: boolean;
	reason?: string;
}

export function enforceDepthLimit(parentDepth: number, limit = DEFAULT_LOOP_DEPTH_LIMIT): DepthGuardResult {
	const nextDepth = parentDepth + 1;
	if (limit <= 0 || nextDepth <= limit) {
		return { allowed: true, nextDepth, escalate: false };
	}
	return {
		allowed: false,
		nextDepth,
		escalate: true,
		reason: `Depth limit reached at ${nextDepth}; human approval required to go deeper`,
	};
}
