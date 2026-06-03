import { localUrlToPath } from "./local-path";
import type { ActiveModeState } from "../modes/mode-state";
import { isAuditMode, isUserMode } from "../modes/mode-state";
import type { ToolSession } from ".";
import { resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";

const LOCAL_URL_PREFIX = "local://";

export function resolvePlanPath(session: ToolSession, targetPath: string): string {
	if (targetPath.startsWith(LOCAL_URL_PREFIX)) {
		return localUrlToPath(targetPath, {
			getArtifactsDir: session.getArtifactsDir,
			getSessionId: session.getSessionId,
		});
	}

	return resolveToCwd(targetPath, session.cwd);
}


export function enforceModeWrite(
	session: ToolSession,
	_targetPath: string,
	options?: { move?: string; op?: "create" | "update" | "delete" },
): void {
	const state: ActiveModeState | undefined = session.getActiveModeState?.();
	if (!state) return;

	if (isUserMode(state) && !state.enabled) return;

	// User modes: check readOnly flag
	if (isUserMode(state)) {
		if (!state.readOnly) return;
		if (options?.move) throw new ToolError("Mode: renaming files is not allowed in read-only mode.");
		if (options?.op === "delete") throw new ToolError("Mode: deleting files is not allowed in read-only mode.");
		throw new ToolError(`Read-only mode "${state.name}": file modifications are not allowed.`);
	}

	// Audit modes: always read-only
	if (isAuditMode(state)) {
		if (options?.move) throw new ToolError("Audit mode: renaming files is not allowed.");
		if (options?.op === "delete") throw new ToolError("Audit mode: deleting files is not allowed.");
		throw new ToolError("Audit mode: file modifications are not allowed.");
	}
}
