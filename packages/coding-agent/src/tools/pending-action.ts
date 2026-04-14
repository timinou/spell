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
}

export interface PendingAction {
	label: string;
	sourceToolName: string;
	files?: string[];
	apply(reason: string): Promise<AgentToolResult<unknown> | PendingActionResolution>;
	reject?(reason: string): Promise<AgentToolResult<unknown> | PendingActionResolution | undefined>;
	details?: unknown;
}

function isPendingActionResolution(value: unknown): value is PendingActionResolution {
	return !!value && typeof value === "object" && "result" in value;
}

function normalizeResolution(
	value: AgentToolResult<unknown> | PendingActionResolution | undefined,
	fallback: MutationProvenance & { files?: string[] },
): PendingActionResolution | undefined {
	if (value === undefined) return undefined;
	if (isPendingActionResolution(value)) {
		return {
			result: value.result,
			mutationState: value.mutationState,
			persisted: value.persisted,
			files: value.files,
		};
	}

	return {
		result: value,
		mutationState: fallback.mutationState,
		persisted: fallback.persisted,
		files: fallback.files ?? [],
	};
}

async function invalidateCodeBuffers(files: string[]): Promise<void> {
	const uniqueFiles = [...new Set(files.filter(file => file.length > 0))];
	for (const file of uniqueFiles) {
		const closeResult = executeCodeBuffer({ command: "close", file });
		if (closeResult.error) {
			throw new ToolError(
				`Applied preview persisted to disk, but failed to invalidate the managed code buffer for ${file}: ${String(closeResult.output ?? "unknown error")}`,
			);
		}
	}
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
	if (resolution.persisted) {
		await invalidateCodeBuffers(resolution.files);
	}
	return resolution;
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
