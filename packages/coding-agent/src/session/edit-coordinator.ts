import {
	type CodeCoordPeerActivity,
	type CodeCoordStatus,
	executeCodeBuffer,
} from "@spell/pi-natives";

export interface SessionIdSource {
	getSessionId?: () => string | null | undefined;
}

export function recentPeerActivity(
	file: string,
	sinceMs: number = Date.now() - 60_000,
	limit: number = 5,
): CodeCoordPeerActivity {
	const result = executeCodeBuffer({ command: "coord_peer_activity", file, sinceMs, limit });
	if (result.error || !result.output || typeof result.output !== "object" || Array.isArray(result.output)) {
		return { file, edits: [] };
	}
	return result.output as CodeCoordPeerActivity;
}

export function coordStatus(file?: string): CodeCoordStatus {
	const result = file
		? executeCodeBuffer({ command: "coord_status", file })
		: executeCodeBuffer({ command: "coord_status" });
	if (result.error || !result.output || typeof result.output !== "object" || Array.isArray(result.output)) {
		return { brokerUp: false, peers: [], socketPath: undefined };
	}
	return result.output as CodeCoordStatus;
}

export function openCodeBufferPaths(): string[] {
	const result = executeCodeBuffer({ command: "list" });
	if (result.error || !Array.isArray(result.output)) return [];
	return result.output.flatMap(entry => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
		const file = Reflect.get(entry, "path");
		return typeof file === "string" ? [file] : [];
	});
}
