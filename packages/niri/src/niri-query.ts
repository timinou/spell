import { $ } from "bun";

export interface NiriWorkspaceInfo {
	id: number;
	name: string | null;
	idx: number;
}

export interface NiriWindowInfo {
	id: number;
	title: string | null;
	workspace_id: number | null;
}

/**
 * Builds the title-token delimiter test for a session id. Mirrors the producer
 * side ({@link module:title-generator.setSessionTitleToken}), which appends
 * `⟨<sessionId>⟩` to the window title. niri echoes the title verbatim as
 * `windows[].title`, so a window belongs to this session iff its title contains
 * that exact token.
 */
function titleHasToken(title: string | null | undefined, sessionId: string): boolean {
	return typeof title === "string" && title.includes(`⟨${sessionId}⟩`);
}

/**
 * Pure core of {@link queryOwnWorkspaceName}: given this session's id, the niri
 * window list, and the workspace list, returns the name of the workspace whose
 * window carries this session's title token — or null when no such window is
 * present yet (title not propagated, niri mid-update) or its workspace has no
 * name.
 *
 * This is the ONLY window↔session resolution spell does, and it is a self-join
 * on an identity spell OWNS (the token it stamped into its own title), so it is
 * correct regardless of focus, launch order, or a shared terminal server — the
 * ambiguities that made focus/process-ancestry resolution unreliable.
 *
 * Exported for unit testing; production callers use {@link queryOwnWorkspaceName}.
 */
export function resolveWorkspaceByToken(
	sessionId: string,
	windows: readonly NiriWindowInfo[],
	workspaces: readonly NiriWorkspaceInfo[],
): string | null {
	if (!sessionId) return null;
	const own = windows.find(w => titleHasToken(w.title, sessionId));
	if (!own || typeof own.workspace_id !== "number") return null;
	const ws = workspaces.find(entry => entry.id === own.workspace_id);
	return ws?.name ?? null;
}

/**
 * Resolves the name of the workspace this session's own window currently sits
 * on, by matching this session's title token against live niri window titles.
 * Returns null when niri is unavailable, the token hasn't propagated to the
 * window title yet, or the workspace is unnamed.
 *
 * Used only to snapshot a last-known workspace for `spell recover` (a dead
 * session's window is gone, so the workspace can't be derived live at recovery
 * time). The live desktop bar does its OWN token join and never calls this.
 */
export async function queryOwnWorkspaceName(sessionId: string): Promise<string | null> {
	if (!sessionId) return null;
	try {
		const [windowsResult, workspacesResult] = await Promise.all([
			$`niri msg -j windows`.quiet().nothrow(),
			$`niri msg -j workspaces`.quiet().nothrow(),
		]);
		if (windowsResult.exitCode !== 0 || workspacesResult.exitCode !== 0) return null;
		const rawWindows = JSON.parse(windowsResult.text()) as Array<{
			id?: unknown;
			title?: unknown;
			workspace_id?: unknown;
		}>;
		const windows: NiriWindowInfo[] = [];
		for (const w of rawWindows) {
			if (typeof w.id === "number")
				windows.push({
					id: w.id,
					title: typeof w.title === "string" ? w.title : null,
					workspace_id: typeof w.workspace_id === "number" ? w.workspace_id : null,
				});
		}
		const workspaces = JSON.parse(workspacesResult.text()) as Array<NiriWorkspaceInfo>;
		return resolveWorkspaceByToken(sessionId, windows, workspaces);
	} catch {
		return null;
	}
}
