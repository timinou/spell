import {
	type CodeBufferOptions,
	type CodeBufferResult,
	type CodeCoordPeerActivity,
	type CodeCoordStatus,
	executeCodeBuffer,
} from "@oh-my-pi/pi-natives";

const MUTATING_CODE_BUFFER_COMMANDS = new Set(["edit", "replace_content", "save"]);

export interface SessionIdSource {
	getSessionId?: () => string | null | undefined;
}

export interface CallCodeBufferContext {
	session: SessionIdSource;
}

export function isMutatingCommand(command: string): boolean {
	return MUTATING_CODE_BUFFER_COMMANDS.has(command);
}

function resolveSessionId(ctx: CallCodeBufferContext): string | undefined {
	return ctx.session.getSessionId?.()?.trim() || undefined;
}

export function callCodeBuffer(ctx: CallCodeBufferContext, opts: CodeBufferOptions): CodeBufferResult {
	if (!isMutatingCommand(opts.command)) {
		return executeCodeBuffer(opts);
	}
	const sessionId = resolveSessionId(ctx);
	if (sessionId) {
		return executeCodeBuffer({ ...opts, sessionId });
	}
	return executeCodeBuffer(opts);
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
