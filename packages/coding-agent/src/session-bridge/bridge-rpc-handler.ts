// FEAT-815 — shared handler for RPC commands proxied to an external (TUI/CLI)
// session over the duplex bridge frame. Everything semantic routes through the
// kernel via `executeCodePath` (pi-code-path / pi-code-graph) or the live
// session — NO jsonl/file backdoor, NO reparsing. The daemon and the agent's
// own stdin RPC loop therefore share one authority.

import { executeCodePath } from "@spell/pi-natives";
import type { BridgeRpcRequest, BridgeRpcResult } from "./types";

/** Minimal session surface the handler needs (satisfied by SessionManager). */
export interface BridgeRpcSession {
	getCwd(): string | undefined;
	getSessionId(): string | undefined;
	getArtifactsDir(): string | null | undefined;
}

function ok(command: string, data?: unknown): BridgeRpcResult {
	return { type: "response", command, success: true, data };
}
function fail(command: string, error: string): BridgeRpcResult {
	return { type: "response", command, success: false, error };
}

/** Pull the first `§manage-result` payload out of a manage CodePath run. */
function managePayload(chunks: Awaited<ReturnType<typeof executeCodePath>>): Record<string, unknown> {
	const node = chunks.flatMap(c => c.nodes).find(n => n.kind === "§manage-result");
	return ((node?.metadata as { payload?: Record<string, unknown> } | undefined)?.payload ?? {}) as Record<string, unknown>;
}

function sessionDirArg(session: BridgeRpcSession): { sessionDir?: string } {
	const dir = session.getArtifactsDir?.();
	return dir ? { sessionDir: dir } : {};
}

/**
 * Run a proxied BridgeRpcCommand against this session. Returns a typed result.
 * Unknown/unsupported commands fail truthfully so the web surfaces them.
 */
export async function handleBridgeRpc(session: BridgeRpcSession, command: BridgeRpcRequest): Promise<BridgeRpcResult> {
	const cwd = session.getCwd() ?? process.cwd();
	const sessionId = session.getSessionId?.()?.trim() || undefined;

	switch (command.type) {
		// ── Edit history (PLAN-338 B) — read-only listing ──────────────────────
		case "edit_history": {
			const chunks = await executeCodePath({
				command: "manage",
				manage: "history",
				target: typeof command.file === "string" ? command.file : "",
				root: cwd,
				sessionId,
				...sessionDirArg(session),
			});
			const payload = managePayload(chunks);
			const rawEntries = Array.isArray(payload.entries) ? (payload.entries as Array<Record<string, unknown>>) : [];
			const entries = rawEntries.map(e => ({
				id: String(e.id ?? ""),
				file: typeof e.file === "string" ? e.file : "",
				workspace: typeof e.workspace === "string" ? e.workspace : "",
				groupId: typeof e.groupId === "string" ? e.groupId : null,
				reverted: e.reverted === true,
				committed: e.committed === true,
				commit: typeof e.commit === "string" ? e.commit : null,
				agentLabel: typeof e.agentLabel === "string" ? e.agentLabel : "",
				timestamp: typeof e.timestamp === "number" ? e.timestamp : 0,
			}));
			return ok("edit_history", {
				entries,
				total: typeof payload.total === "number" ? payload.total : entries.length,
				undoable: typeof payload.undoable === "number" ? payload.undoable : 0,
				redoable: typeof payload.redoable === "number" ? payload.redoable : 0,
			});
		}

		// ── Undo / redo (PLAN-338 C) — commit-guarded ──────────────────────────
		case "undo":
		case "redo": {
			const entryId = typeof command.entryId === "string" ? command.entryId : undefined;
			const force = command.type === "undo" && command.force === true;
			const chunks = await executeCodePath({
				command: "manage",
				manage: command.type,
				target: "",
				root: cwd,
				sessionId,
				...(entryId ? { historyEntryId: entryId } : {}),
				...(force ? { historyForce: true } : {}),
				...sessionDirArg(session),
			});
			return ok(command.type, managePayload(chunks));
		}

		// ── Semantic code query (FEAT-815 Phase C) — pi-code-graph lens ─────────
		case "code_query": {
			const target = typeof command.target === "string" ? command.target.trim() : "";
			if (!target) return fail("code_query", "code_query requires a non-empty `target`");
			const chunks = await executeCodePath({
				command: "get",
				target,
				root: cwd,
				...(typeof command.format === "string" ? { format: command.format } : {}),
			});
			// Project to a compact, transport-friendly node list.
			const nodes = chunks.flatMap(c => c.nodes).map(n => ({
				kind: n.kind,
				name: (n as { name?: string }).name,
				path: (n as { path?: string }).path,
				line: (n as { line?: number }).line,
				text: (n as { text?: string }).text,
			}));
			return ok("code_query", { target, nodes, count: nodes.length });
		}

		default:
			return fail(command.type, `unsupported_bridge_rpc: ${command.type}`);
	}
}
