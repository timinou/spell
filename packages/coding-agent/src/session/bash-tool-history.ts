import * as path from "node:path";
import type { TrackedBashExecution } from "../task/gate-verification";

interface ToolResultLike {
	content?: Array<{ type?: string; text?: string }>;
	details?: unknown;
}

export function cloneTrackedBashHistory(history: TrackedBashExecution[]): ReadonlyArray<TrackedBashExecution> {
	return structuredClone(history);
}

function extractExitCode(result: ToolResultLike | undefined, isError: boolean | undefined): number {
	const details = result?.details;
	if (details && typeof details === "object") {
		const exitCode = (details as Record<string, unknown>).exitCode;
		if (typeof exitCode === "number") return exitCode;
	}

	const text =
		result?.content
			?.filter(
				(item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string",
			)
			.map(item => item.text)
			.join("\n") ?? "";
	const match = text.match(/\bCommand exited with code\s+(-?\d+)\b/i);
	if (match) return Number.parseInt(match[1]!, 10);
	return isError ? 1 : 0;
}

function extractCwd(result: ToolResultLike | undefined, sessionCwd: string, rawCwd: unknown): string {
	const details = result?.details;
	if (details && typeof details === "object") {
		const cwd = (details as Record<string, unknown>).cwd;
		if (typeof cwd === "string") return cwd;
		const asyncState = (details as Record<string, unknown>).async;
		if (asyncState && typeof asyncState === "object" && (asyncState as Record<string, unknown>).state === "running") {
			return "";
		}
	}

	if (typeof rawCwd === "string" && rawCwd.trim().length > 0) {
		return path.resolve(sessionCwd, rawCwd);
	}
	return sessionCwd;
}

export function extractTrackedBashExecution(
	args: Record<string, unknown> | undefined,
	result: ToolResultLike | undefined,
	isError: boolean | undefined,
	sessionCwd: string,
): TrackedBashExecution | undefined {
	const command = typeof args?.command === "string" ? args.command : undefined;
	if (!command) return undefined;

	const details = result?.details;
	if (details && typeof details === "object") {
		const asyncState = (details as Record<string, unknown>).async;
		if (asyncState && typeof asyncState === "object" && (asyncState as Record<string, unknown>).state === "running") {
			return undefined;
		}
	}

	const cwd = extractCwd(result, sessionCwd, args?.cwd);
	return {
		command,
		exitCode: extractExitCode(result, isError),
		cwd,
	};
}
