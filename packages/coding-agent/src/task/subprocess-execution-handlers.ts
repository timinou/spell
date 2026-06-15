import type { ExecutionRecord } from "./gate-verification";
import type { SubprocessToolEvent } from "./subprocess-tool-registry";
import { subprocessToolRegistry } from "./subprocess-tool-registry";

/**
 * Subprocess (subagent) gate-evidence extractors. A subagent runs in its own
 * process, so its tool executions are observed via the subprocess event stream
 * rather than the parent's durable message history. These handlers project each
 * relevant tool's result into the tool-agnostic {@link ExecutionRecord} the
 * `cmd` gate matches against — covering both the `bash` tool and the `run`
 * runtime tool (PLAN-337) so a gate satisfied by either is visible.
 */

function detailsRecord(event: SubprocessToolEvent): Record<string, unknown> | undefined {
	const details = event.result?.details;
	return details && typeof details === "object" ? (details as Record<string, unknown>) : undefined;
}

function extractExitCodeFromText(event: SubprocessToolEvent): number | undefined {
	const text =
		event.result?.content
			.filter(
				(item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string",
			)
			.map(item => item.text)
			.join("\n") ?? "";
	const match = text.match(/\bCommand exited with code\s+(-?\d+)\b/i);
	return match ? Number.parseInt(match[1]!, 10) : undefined;
}

// bash tool: command from args, exit/cwd from result details (or rendered text).
subprocessToolRegistry.register<ExecutionRecord>("bash", {
	extractData: event => {
		const command = typeof event.args?.command === "string" ? event.args.command : undefined;
		if (!command) return undefined;

		const details = detailsRecord(event);
		const detailExit = typeof details?.exitCode === "number" ? details.exitCode : undefined;
		const exitCode = detailExit ?? extractExitCodeFromText(event) ?? (event.isError ? 1 : 0);
		const cwd = typeof details?.cwd === "string" ? details.cwd : undefined;
		return cwd ? { command, exitCode, cwd } : { command, exitCode };
	},
});

// run runtime tool: command reconstructed from details.argv; exit from details.exitCode.
subprocessToolRegistry.register<ExecutionRecord>("run", {
	extractData: event => {
		const details = detailsRecord(event);
		const argv = details?.argv;
		if (!Array.isArray(argv) || argv.length === 0 || !argv.every(part => typeof part === "string")) {
			return undefined;
		}
		const command = (argv as string[]).join(" ");
		const exitCode = typeof details?.exitCode === "number" ? details.exitCode : event.isError ? 1 : 0;
		const cwd = typeof details?.cwd === "string" ? details.cwd : undefined;
		return cwd ? { command, exitCode, cwd } : { command, exitCode };
	},
});

/**
 * Merge a subagent's extracted tool data into one execution log for gate
 * matching. Covers every tool that produces an {@link ExecutionRecord}
 * (`bash` + `run`), so a `cmd` gate satisfied by either is honoured.
 */
export function gatherSubprocessExecutions(
	extractedToolData: Record<string, unknown[]> | undefined,
): ExecutionRecord[] {
	if (!extractedToolData) return [];
	const out: ExecutionRecord[] = [];
	for (const toolName of ["bash", "run"] as const) {
		const entries = extractedToolData[toolName];
		if (Array.isArray(entries)) out.push(...(entries as ExecutionRecord[]));
	}
	return out;
}
