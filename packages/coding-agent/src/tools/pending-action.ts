import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { executeCodeBuffer } from "@oh-my-pi/pi-natives";

import { ToolError } from "./tool-errors";

export type MutationState = "pending_preview" | "applied" | "discarded" | "noop";

export interface MutationProvenance {
	mutationState: MutationState;
	persisted: boolean;
}

export interface PendingActionResolution extends MutationProvenance {
	result: AgentToolResult<unknown>;
	files: string[];
	bufferInvalidationError?: string;
}

export interface PendingAction {
	label: string;
	sourceToolName: string;
	files: string[];
	invalidateManagedCodeBuffers?: boolean;
	apply(reason: string): Promise<AgentToolResult<unknown> | PendingActionResolution>;
	reject?(reason: string): Promise<AgentToolResult<unknown> | PendingActionResolution | undefined>;
	details?: unknown;
}

function isMutationState(value: unknown): value is MutationState {
	return value === "pending_preview" || value === "applied" || value === "discarded" || value === "noop";
}

function isPendingActionResolution(value: unknown): value is PendingActionResolution {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		"result" in candidate &&
		isMutationState(candidate.mutationState) &&
		typeof candidate.persisted === "boolean" &&
		Array.isArray(candidate.files) &&
		candidate.files.every(file => typeof file === "string") &&
		(candidate.bufferInvalidationError === undefined || typeof candidate.bufferInvalidationError === "string")
	);
}

function normalizeResolution(
	value: AgentToolResult<unknown> | PendingActionResolution | undefined,
	fallback: MutationProvenance & { files: string[] },
): PendingActionResolution | undefined {
	if (value === undefined) return undefined;
	if (isPendingActionResolution(value)) {
		return {
			result: value.result,
			mutationState: value.mutationState,
			persisted: value.persisted,
			files: [...value.files],
			bufferInvalidationError: value.bufferInvalidationError,
		};
	}

	return {
		result: value,
		mutationState: fallback.mutationState,
		persisted: fallback.persisted,
		files: [...fallback.files],
	};
}

async function invalidateCodeBuffers(files: string[]): Promise<string | undefined> {
	const uniqueFiles = [...new Set(files.filter(file => file.length > 0))];
	if (uniqueFiles.length === 0) {
		return "Applied preview persisted to disk, but no files were provided for managed code buffer invalidation.";
	}
	for (const file of uniqueFiles) {
		const closeResult = executeCodeBuffer({ command: "close", file });
		if (closeResult.error) {
			return `Applied preview persisted to disk, but failed to invalidate the managed code buffer for ${file}: ${String(closeResult.output ?? "unknown error")}`;
		}
	}
	return undefined;
}

export async function applyPendingAction(action: PendingAction, reason: string): Promise<PendingActionResolution> {
	const resolution = normalizeResolution(await action.apply(reason), {
		mutationState: "applied",
		persisted: true,
		files: action.files,
	});
	if (!resolution) {
		throw new ToolError(`Pending action ${action.label} did not return a result.`);
	}
	if (!resolution.persisted || action.invalidateManagedCodeBuffers !== true) {
		return resolution;
	}
	const bufferInvalidationError = await invalidateCodeBuffers(resolution.files);
	return bufferInvalidationError ? { ...resolution, bufferInvalidationError } : resolution;
}

export async function discardPendingAction(
	action: PendingAction,
	reason: string,
): Promise<PendingActionResolution | undefined> {
	return normalizeResolution(await action.reject?.(reason), {
		mutationState: "discarded",
		persisted: false,
		files: [],
	});
}

export class PendingActionStore {
	#actions: PendingAction[] = [];
	#pushListeners = new Set<(action: PendingAction, count: number) => void>();

	push(action: PendingAction): void {
		this.#actions.push(action);
		const count = this.#actions.length;
		for (const listener of this.#pushListeners) {
			listener(action, count);
		}
	}

	peek(): PendingAction | null {
		return this.#actions.at(-1) ?? null;
	}

	pop(): PendingAction | null {
		return this.#actions.pop() ?? null;
	}

	remove(action: PendingAction): boolean {
		const index = this.#actions.lastIndexOf(action);
		if (index < 0) return false;
		this.#actions.splice(index, 1);
		return true;
	}

	subscribePush(listener: (action: PendingAction, count: number) => void): () => void {
		this.#pushListeners.add(listener);
		return () => {
			this.#pushListeners.delete(listener);
		};
	}

	clear(): void {
		this.#actions = [];
	}

	get count(): number {
		return this.#actions.length;
	}

	get hasPending(): boolean {
		return this.#actions.length > 0;
	}
}
