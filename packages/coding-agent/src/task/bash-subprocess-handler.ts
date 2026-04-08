import type { TrackedBashExecution } from "./gate-verification";
import type { SubprocessToolEvent } from "./subprocess-tool-registry";
import { subprocessToolRegistry } from "./subprocess-tool-registry";

function extractExitCodeFromResult(event: SubprocessToolEvent): number | undefined {
	const details = event.result?.details;
	if (details && typeof details === "object") {
		const detailExitCode = (details as Record<string, unknown>).exitCode;
		if (typeof detailExitCode === "number") return detailExitCode;
	}

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

function extractCwdFromResult(event: SubprocessToolEvent): string | undefined {
	const details = event.result?.details;
	if (!details || typeof details !== "object") return undefined;
	const cwd = (details as Record<string, unknown>).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

subprocessToolRegistry.register<TrackedBashExecution>("bash", {
	extractData: event => {
		const command = typeof event.args?.command === "string" ? event.args.command : undefined;
		if (!command) return undefined;

		const exitCode = extractExitCodeFromResult(event) ?? (event.isError ? 1 : 0);
		const cwd = extractCwdFromResult(event);
		return cwd ? { command, exitCode, cwd } : { command, exitCode };
	},
});
