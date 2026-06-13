/**
 * Synthesize an `AgentTool` from a loaded `deftool` runtime tool (PLAN-337).
 *
 * The 3-beat execution loop (closures stay in the BEAM; only data crosses):
 *   beat 1 — BEAM builds argv from the verb + args      (RuntimeToolDispatcher.argv)
 *   beat 2 — Node runs the process, gated by KDL policy  (execCommand)
 *   beat 3 — BEAM parses raw stdout into structure        (RuntimeToolDispatcher.parse)
 *
 * The result's `data` is the structured value (queryable by the `execute`
 * coprocessor); `content` is the human display; `details` carries render hints
 * (including the `warn` flag that tints the TUI for observe-but-allow verbs).
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@spell/pi-agent-core";
import { execCommand } from "../../exec/exec";
import { enforceBashCommand } from "../../sandbox";
import type { ToolSession } from "../index";
import { ToolError } from "../tool-errors";
import type { RuntimeToolDispatcher } from "./runtime";
import type { Gate, LoadedRuntimeTool } from "./types";

/** Details surfaced to the TUI renderer. */
export interface RuntimeToolDetails {
	tool: string;
	verb: string;
	argv: string[];
	gate: Gate;
	/** True when an observe-but-allow (`warn`) verb ran — tints the TUI. */
	warn?: boolean;
	exitCode?: number;
	durationMs?: number;
}

const runtimeToolSchema = Type.Object({
	verb: Type.String({ description: "The verb (subcommand) to run." }),
	args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Verb arguments." })),
});

export function makeRuntimeTool(
	loaded: LoadedRuntimeTool,
	dispatcher: RuntimeToolDispatcher,
	session: ToolSession,
): AgentTool {
	const { descriptor, policy, source } = loaded;
	const verbList = Object.keys(descriptor.verbs).join(", ");

	return {
		name: descriptor.name,
		label: descriptor.name,
		description:
			`${descriptor.doc ?? `Runtime tool '${descriptor.name}'`}. Verbs: ${verbList}. ` +
			`Call with { verb, args }; returns structured output.`,
		parameters: runtimeToolSchema,

		async execute(_toolCallId, params, signal): Promise<AgentToolResult<RuntimeToolDetails>> {
			const verb = (params as { verb: string }).verb;
			const args = ((params as { args?: Record<string, unknown> }).args ?? {}) as Record<string, unknown>;

			const verbDesc = descriptor.verbs[verb];
			if (!verbDesc) {
				throw new ToolError(`'${descriptor.name}': unknown verb '${verb}'. Available verbs: ${verbList}.`);
			}
			const gate: Gate = policy.verbs[verb]?.gate ?? "silent";

			// `deny`: refuse before doing any work.
			if (gate === "deny") {
				throw new ToolError(
					`'${descriptor.name} ${verb}' is denied by policy (gate "deny"). Edit the tool's KDL block to allow it.`,
				);
			}

			// Beat 1: build argv in the sandbox.
			const argv = await dispatcher.argv(source, verb, args);
			const commandString = argv.join(" ");

			// Reuse the existing command sandbox (allow/deny globs) as a second gate.
			const sandboxError = enforceBashCommand(commandString, session.sandboxPolicy);
			if (sandboxError) throw new ToolError(sandboxError);

			// `confirm`: Phase 1 surfaces a clear warning and proceeds; interactive
			// confirmation (pending-action) lands in Phase 4. We never silently run a
			// destructive verb without flagging it.
			const warn = gate === "warn" || gate === "confirm";

			// Beat 2: run the process (argv form — no shell, no injection).
			const started = Date.now();
			const result = await execCommand(argv[0], argv.slice(1), session.cwd, { signal });
			const durationMs = Date.now() - started;

			// Beat 3: shape stdout into structured data.
			let data: unknown;
			let parseNote = "";
			try {
				data = await dispatcher.parse(source, verb, result.stdout);
			} catch (e) {
				// A parse failure must not lose the raw output — fall back to text.
				data = result.stdout;
				parseNote = `\n\n[parse failed: ${e instanceof Error ? e.message : String(e)} — raw stdout returned]`;
			}

			const failed = result.code !== 0;
			const gateNote =
				gate === "confirm"
					? `\n\n[gate "confirm": destructive verb ran (interactive confirm pending — Phase 4)]`
					: gate === "warn"
						? `\n\n[gate "warn": uncurated verb — observed]`
						: "";
			const errNote = failed ? `\n\n[exit ${result.code}]${result.stderr ? `\n${result.stderr}` : ""}` : "";

			const display = `${descriptor.name} ${verb}${gateNote}${errNote}${parseNote}`;

			return {
				content: [{ type: "text", text: display }],
				details: {
					tool: descriptor.name,
					verb,
					argv,
					gate,
					...(warn ? { warn: true } : {}),
					exitCode: result.code,
					durationMs,
				},
				data,
				isError: failed,
			};
		},
	} satisfies AgentTool;
}
