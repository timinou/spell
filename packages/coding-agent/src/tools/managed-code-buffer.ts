import * as nodePath from "node:path";
import * as piNatives from "@oh-my-pi/pi-natives";
import { callCodeBuffer, type SessionIdSource } from "../session/edit-coordinator";

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

interface EditFileResultLike {
	file?: unknown;
	status?: unknown;
	error?: unknown;
}

/**
 * The native `edit` command reports per-file failures inside
 * `output.fileResults[]` while keeping top-level `error: false`. Callers that
 * only inspect `result.error` silently accept failed edits. Extract a truthful
 * message here; returns undefined when every file succeeded or was a noop.
 */
function extractEditFailureMessage(output: unknown): string | undefined {
	if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
	const status = Reflect.get(output, "status");
	if (status !== "failed" && status !== "partial") return undefined;
	const fileResults = Reflect.get(output, "fileResults");
	if (!Array.isArray(fileResults)) {
		return extractCodeToolErrorMessage(output);
	}
	const failures: string[] = [];
	for (const entry of fileResults as EditFileResultLike[]) {
		if (!entry || typeof entry !== "object") continue;
		if (entry.status !== "failed") continue;
		const file = typeof entry.file === "string" ? entry.file : "<unknown>";
		const message = extractCodeToolErrorMessage(entry.error ?? entry);
		failures.push(`${file}: ${message}`);
	}
	if (failures.length === 0) {
		return extractCodeToolErrorMessage(output);
	}
	return failures.join("; ");
}

export function applyManagedBufferContent(
	file: string,
	content: string,
	options: { create: boolean; session: SessionIdSource },
): ManagedBufferMutationResult {
	const result = options.create
		? callCodeBuffer(
				{ session: options.session },
				{
					command: "edit",
					root: process.cwd(),
					operations: [{ targetId: file, actions: [{ kind: "write", content }] }],
				},
			)
		: callCodeBuffer({ session: options.session }, { command: "replace_content", file, content });
	if (result.error) {
		throw new Error(`Managed code buffer update failed for ${file}: ${extractCodeToolErrorMessage(result.output)}`);
	}
	const perFileFailure = options.create ? extractEditFailureMessage(result.output) : undefined;
	if (perFileFailure) {
		throw new Error(`Managed code buffer update failed for ${file}: ${perFileFailure}`);
	}
	const saveResult = callCodeBuffer({ session: options.session }, { command: "save", file });
	if (saveResult.error) {
		throw new Error(`Managed code buffer save failed for ${file}: ${extractCodeToolErrorMessage(saveResult.output)}`);
	}
	const bufferInvalidationError = collectManagedCodeBufferInvalidationError([file], true);
	return bufferInvalidationError ? { bufferInvalidationError } : {};
}
