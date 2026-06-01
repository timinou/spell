import * as nodePath from "node:path";
import * as piNatives from "@spell/pi-natives";
import { executeCodePath } from "@spell/pi-natives";
import type { SessionIdSource } from "../session/edit-coordinator";
import { sessionContextOpts } from "./codepath-session";

function resolveSessionId(session: SessionIdSource): string | undefined {
	return session.getSessionId?.()?.trim() || undefined;
}

export interface ManagedBufferMutationResult {
	bufferInvalidationError?: string;
}

export function extractCodeToolErrorMessage(output: unknown): string {
	if (typeof output === "string") return output;
	if (typeof output === "number" || typeof output === "boolean") return String(output);
	if (output && typeof output === "object" && !Array.isArray(output)) {
		const message = Reflect.get(output, "message");
		if (typeof message === "string" && message.trim().length > 0) {
			return message;
		}
	}
	const serialized = JSON.stringify(output);
	return typeof serialized === "string" && serialized.length > 0 ? serialized : "Code command failed";
}

export function countBufferDiffHunks(output: unknown): number {
	return Array.isArray(output) ? output.length : 0;
}

function formatManagedBufferInvalidationError(file: string, output: unknown, persisted: boolean): string {
	const prefix = persisted
		? "Write persisted to disk, but failed to invalidate the managed code buffer"
		: "Failed to invalidate the managed code buffer";
	return `${prefix} for ${file}: ${extractCodeToolErrorMessage(output)}`;
}

function collectManagedCodeBufferInvalidationError(paths: string[], persisted: boolean): string | undefined {
	const uniquePaths = [...new Set(paths.filter(file => file.length > 0 && nodePath.isAbsolute(file)))];
	for (const file of uniquePaths) {
		const closeResult = piNatives.executeCodeBuffer({ command: "close", file });
		if (closeResult.error) {
			return formatManagedBufferInvalidationError(file, closeResult.output, persisted);
		}
	}
	return undefined;
}

export function invalidateManagedCodeBuffersForPaths(paths: string[]): void {
	const bufferInvalidationError = collectManagedCodeBufferInvalidationError(paths, false);
	if (bufferInvalidationError) {
		throw new Error(bufferInvalidationError);
	}
}

export function ensureManagedBufferFresh(file: string): void {
	const freshness = piNatives.executeCodeBuffer({ command: "diff", file });
	if (freshness.error) {
		throw new Error(
			`Unable to verify buffer freshness before edit: ${extractCodeToolErrorMessage(freshness.output)}`,
		);
	}
	const staleHunks = countBufferDiffHunks(freshness.output);
	if (staleHunks > 0) {
		throw new Error(
			`Stale code buffer detected (${staleHunks} ${staleHunks === 1 ? "hunk" : "hunks"} differ from disk). Run code diff to inspect, then reconcile the on-disk file before retrying this mutation.`,
		);
	}
}


export async function applyManagedBufferContent(
	file: string,
	content: string,
	options: { create: boolean; session: SessionIdSource },
): Promise<ManagedBufferMutationResult> {
	const sessionId = resolveSessionId(options.session);
	const root = nodePath.dirname(file);
	const chunks = await executeCodePath({
		...sessionContextOpts(undefined),
		command: "edit",
		target: nodePath.basename(file),
		actions: [{ kind: "fileWrite", content, force: true }],
		root,
		sessionId,
	});
	const diagnostics = chunks.flatMap(c => c.diagnostics);
	if (diagnostics.length > 0) {
		const message = diagnostics.map(d => d.message).join("; ");
		throw new Error(`Managed code buffer update failed for ${file}: ${message}`);
	}
	const bufferInvalidationError = collectManagedCodeBufferInvalidationError([file], true);
	return bufferInvalidationError ? { bufferInvalidationError } : {};
}
