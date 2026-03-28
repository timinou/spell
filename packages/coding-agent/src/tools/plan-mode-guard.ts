import * as path from "node:path";
import { resolveLocalUrlToPath } from "../internal-urls";
import type { ToolSession } from ".";
import { expandTilde, resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";

const LOCAL_URL_PREFIX = "local://";

export function resolvePlanPath(session: ToolSession, targetPath: string): string {
	if (targetPath.startsWith(LOCAL_URL_PREFIX)) {
		return resolveLocalUrlToPath(targetPath, {
			getArtifactsDir: session.getArtifactsDir,
			getSessionId: session.getSessionId,
		});
	}

	return resolveToCwd(targetPath, session.cwd);
}

function isUnderAllowedFolder(targetPath: string, cwd: string, allowedFolders: Record<string, string>): boolean {
	return Object.keys(allowedFolders).some(folder => {
		const resolvedFolder = path.resolve(cwd, expandTilde(folder));
		return targetPath === resolvedFolder || targetPath.startsWith(resolvedFolder + path.sep);
	});
}

export function enforcePlanModeWrite(
	session: ToolSession,
	targetPath: string,
	options?: { move?: string; op?: "create" | "update" | "delete" },
): void {
	const state = session.getPlanModeState?.();
	if (!state?.enabled) return;

	const resolvedTarget = resolvePlanPath(session, targetPath);
	const resolvedPlan = resolvePlanPath(session, state.planFilePath);

	if (options?.move) {
		throw new ToolError("Plan mode: renaming files is not allowed.");
	}

	if (options?.op === "delete") {
		throw new ToolError("Plan mode: deleting files is not allowed.");
	}

	if (resolvedTarget === resolvedPlan) return;

	const allowedFolders = session.settings.get("planMode.allowedFolders");
	if (Object.keys(allowedFolders).length > 0 && isUnderAllowedFolder(resolvedTarget, session.cwd, allowedFolders)) {
		return;
	}

	if (Object.keys(allowedFolders).length > 0) {
		throw new ToolError(
			`Plan mode: only the plan file (${state.planFilePath}) and configured allowed folders may be modified.`,
		);
	}

	throw new ToolError(`Plan mode: only the plan file may be modified (${state.planFilePath}).`);
}
