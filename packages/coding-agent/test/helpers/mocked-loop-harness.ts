import type { LoopEvent } from "../../src/loop/contracts";
import type { LoopManagerSettings } from "../../src/loop/loop-manager";
import type { LoopSnapshot } from "../../src/loop/types";

export interface MockState {
	persistedEvents: Array<{ event: LoopEvent; snapshot: LoopSnapshot }>;
	syncedSnapshots: LoopSnapshot[];
	savedStates: LoopSnapshot[];
	gitCalls: string[];
	worktreeCalls: string[];
	gitCheckResult: { ok: boolean; message?: string };
	restoreSnapshots: LoopSnapshot[];
}

export function createMockState(): MockState {
	return {
		persistedEvents: [],
		syncedSnapshots: [],
		savedStates: [],
		gitCalls: [],
		worktreeCalls: [],
		gitCheckResult: { ok: true },
		restoreSnapshots: [],
	};
}

export function resetMockState(state: MockState): void {
	state.persistedEvents.length = 0;
	state.syncedSnapshots.length = 0;
	state.savedStates.length = 0;
	state.gitCalls.length = 0;
	state.worktreeCalls.length = 0;
	state.gitCheckResult = { ok: true };
	state.restoreSnapshots.length = 0;
}

export function createTestSettings(): LoopManagerSettings {
	return {
		getModelRole(role: string) {
			return role === "review" ? "anthropic/claude-sonnet-4-6" : undefined;
		},
	};
}
