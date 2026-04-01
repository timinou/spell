import * as path from "node:path";
import type { SpellcastSessionContext } from "./index";

export interface SpellcastSyncMatch {
	manifestName: string;
	manifestPath: string;
	url: string;
	filePath: string;
}

export function checkFileAgainstManifests(filePath: string, context: SpellcastSessionContext): SpellcastSyncMatch | null {
	const resolvedFilePath = path.resolve(filePath);
	for (const discovered of context.discoveredManifests) {
		const publishState = context.publishState[discovered.manifestPath];
		if (!publishState) continue;
		for (const relativeFile of discovered.manifest.files) {
			const expectedPath = path.resolve(discovered.manifestDir, relativeFile);
			if (expectedPath === resolvedFilePath) {
				return {
					manifestName: discovered.manifest.name,
					manifestPath: discovered.manifestPath,
					url: publishState.appUrl,
					filePath: resolvedFilePath,
				};
			}
		}
	}
	return null;
}

export function extractModifiedPaths(toolName: string, args: unknown, cwd: string): string[] {
	if (!args || typeof args !== "object") return [];
	const pathValue = (args as { path?: unknown }).path;
	if (typeof pathValue !== "string") return [];
	if (toolName !== "write" && toolName !== "edit") return [];
	return [path.resolve(cwd, pathValue)];
}

export function formatSpellcastSyncNote(match: SpellcastSyncMatch): string {
	return `Note: You modified ${path.basename(match.filePath)} which is part of published spellcast "${match.manifestName}" (${match.url}). Consider running canvas_cast update to push changes.`;
}
