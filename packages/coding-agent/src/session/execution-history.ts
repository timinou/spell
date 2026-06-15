import * as path from "node:path";
import type { ExecutionRecord } from "../task/gate-verification";

/**
 * Derive the gate-evidence execution log from DURABLE session messages.
 *
 * The `cmd` gate is satisfied by a successful command execution. Rather than
 * accumulate a volatile side-array (which was bash-only and wiped on every
 * session resume/branch — the RC-A/RC-B defects), we reconstruct the evidence
 * from the persisted message history on demand:
 *
 *   - bash tool:  `assistant.toolCall(name="bash").arguments.command` paired by
 *                 `toolCallId` with `toolResult.details.{exitCode,cwd}`.
 *   - run tool:   `toolResult(toolName="run").details.{argv,exitCode}` — argv is
 *                 joined back into a command line; `run` always executes in the
 *                 session cwd.
 *   - `!`-command bash:  `bashExecution` messages (command + exitCode; cwd is the
 *                 session cwd at run time, approximated by the current cwd).
 *
 * This is the single source of `cmd`-gate evidence for the direct (todo) path.
 * Because it reads the persisted transcript, evidence survives resume/branch and
 * is tool-agnostic.
 */

/** Minimal shapes we read — kept structural to avoid importing the full message union. */
interface ToolCallContent {
	type: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}
interface AssistantLike {
	role: "assistant";
	content: ToolCallContent[];
}
interface ToolResultLike {
	role: "toolResult";
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	details?: unknown;
}
interface BashExecutionLike {
	role: "bashExecution";
	command: string;
	exitCode: number | undefined;
	cancelled?: boolean;
}
type MessageLike = AssistantLike | ToolResultLike | BashExecutionLike | { role: string };

function detailsRecord(details: unknown): Record<string, unknown> | undefined {
	return details && typeof details === "object" ? (details as Record<string, unknown>) : undefined;
}

function isAsyncRunning(details: Record<string, unknown> | undefined): boolean {
	const asyncState = details?.async;
	return (
		!!asyncState &&
		typeof asyncState === "object" &&
		(asyncState as Record<string, unknown>).state === "running"
	);
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" ? value : fallback;
}

/** Join a `run` tool argv back into a command line for gate matching. */
function commandFromArgv(argv: unknown): string | undefined {
	if (!Array.isArray(argv) || argv.length === 0) return undefined;
	if (!argv.every(part => typeof part === "string")) return undefined;
	return (argv as string[]).join(" ");
}

/**
 * Reconstruct the execution evidence log from a session's message list.
 * `sessionCwd` is the fallback working directory for executions whose result
 * did not record one (e.g. `!`-command bash, or a run tool).
 */
export function extractExecutionHistory(messages: readonly MessageLike[], sessionCwd: string): ExecutionRecord[] {
	// First pass: map toolCallId → { command, cwdArg } for bash tool calls so the
	// raw command (with any `cd …` prefix) is recoverable from the matching result.
	const bashCallById = new Map<string, { command: string; cwdArg?: string }>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const content = (message as AssistantLike).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part.type !== "toolCall" || part.name !== "bash" || !part.id) continue;
			const command = typeof part.arguments?.command === "string" ? part.arguments.command : undefined;
			if (!command) continue;
			const cwdArg = typeof part.arguments?.cwd === "string" ? part.arguments.cwd : undefined;
			bashCallById.set(part.id, { command, cwdArg });
		}
	}

	const executions: ExecutionRecord[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") {
			const result = message as ToolResultLike;
			const details = detailsRecord(result.details);
			if (isAsyncRunning(details)) continue;

			if (result.toolName === "bash" && result.toolCallId) {
				const call = bashCallById.get(result.toolCallId);
				if (!call) continue;
				const cwd =
					typeof details?.cwd === "string"
						? details.cwd
						: call.cwdArg
							? path.resolve(sessionCwd, call.cwdArg)
							: sessionCwd;
				executions.push({
					command: call.command,
					exitCode: numberOr(details?.exitCode, result.isError ? 1 : 0),
					cwd,
				});
			} else if (result.toolName === "run") {
				const command = commandFromArgv(details?.argv);
				if (!command) continue;
				const cwd = typeof details?.cwd === "string" ? details.cwd : sessionCwd;
				executions.push({
					command,
					exitCode: numberOr(details?.exitCode, result.isError ? 1 : 0),
					cwd,
				});
			}
			continue;
		}

		if (message.role === "bashExecution") {
			const bash = message as BashExecutionLike;
			if (bash.cancelled || typeof bash.command !== "string" || bash.command.length === 0) continue;
			executions.push({
				command: bash.command,
				exitCode: numberOr(bash.exitCode, 0),
				cwd: sessionCwd,
			});
		}
	}
	return executions;
}
