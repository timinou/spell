import type { TrackedBashExecution } from "./gate-verification";
import { subprocessToolRegistry } from "./subprocess-tool-registry";

subprocessToolRegistry.register<TrackedBashExecution>("bash", {
	extractData: event => {
		const command = typeof event.args?.command === "string" ? event.args.command : undefined;
		if (!command) return undefined;
		const exitCode = event.isError ? 1 : 0;
		return { command, exitCode };
	},
});
