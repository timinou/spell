import { $ } from "bun";

export interface NiriWorkspaceInfo {
	id: number;
	name: string | null;
	idx: number;
}

/**
 * Returns the niri window ID of the currently focused window, or null if
 * niri is not running or the query fails.
 */
export async function queryNiriFocusedWindowId(): Promise<number | null> {
	try {
		const result = await $`niri msg -j focused-window`.quiet().nothrow();
		if (result.exitCode !== 0) return null;
		const win = JSON.parse(result.text()) as { id?: unknown };
		return typeof win.id === "number" ? win.id : null;
	} catch {
		return null;
	}
}

/** Returns the focused workspace metadata, or null when niri is unavailable. */
export async function queryFocusedWorkspace(): Promise<NiriWorkspaceInfo | null> {
	try {
		const [focusedWindowResult, workspacesResult] = await Promise.all([
			$`niri msg -j focused-window`.quiet().nothrow(),
			$`niri msg -j workspaces`.quiet().nothrow(),
		]);
		if (focusedWindowResult.exitCode !== 0 || workspacesResult.exitCode !== 0) return null;
		const focusedWindow = JSON.parse(focusedWindowResult.text()) as { workspace_id?: unknown };
		const workspaces = JSON.parse(workspacesResult.text()) as Array<NiriWorkspaceInfo>;
		const workspaceId = focusedWindow.workspace_id;
		if (typeof workspaceId !== "number") return null;
		const workspace = workspaces.find(entry => entry.id === workspaceId);
		return workspace ?? null;
	} catch {
		return null;
	}
}
