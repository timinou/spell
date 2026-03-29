import type { LoopSnapshot } from "../types";
import { readLoopOrgState } from "./org-sync";

export async function reconcileLoopState(cwd: string, snapshot: LoopSnapshot): Promise<LoopSnapshot> {
	const orgState = await readLoopOrgState(cwd, snapshot.id);
	if (!orgState?.state || orgState.state === snapshot.state) {
		return snapshot;
	}
	return {
		...snapshot,
		state: orgState.state as LoopSnapshot["state"],
		taskContent: orgState.body ?? snapshot.taskContent,
		statusReason: `Reconciled from org state ${orgState.state}`,
	};
}
