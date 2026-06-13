/**
 * `terminal` — the scoped interactive-PTY escape hatch (PLAN-337 Phase 4).
 *
 * The one irreducible process surface: genuinely interactive programs that need
 * a real TTY (sudo password prompts, top/htop, less, vim, REPLs). It wraps the
 * existing PtySession via `runInteractiveBashPty` — NOT a general scripting tool
 * (use `run`/`git`/`execute` for that), just "I need a live terminal".
 *
 * Requires a UI (a pty needs a real terminal); without one it errors with a
 * clear pointer to `run`/`bash`. ssh has its own tool — route there for remotes.
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@spell/pi-agent-core";
import { $env } from "@spell/pi-utils";
import { type BashInteractiveResult, runInteractiveBashPty } from "./bash-interactive";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const terminalSchema = Type.Object({
	command: Type.String({
		description: "Interactive command to run in a live terminal (e.g. 'sudo …', 'htop', 'vim file').",
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory (default: session cwd)." })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 300)." })),
});

export interface TerminalToolDetails {
	exitCode?: number;
	cwd?: string;
	cancelled?: boolean;
	timedOut?: boolean;
}

export class TerminalTool implements AgentTool<typeof terminalSchema, TerminalToolDetails> {
	readonly name = "terminal";
	readonly label = "Terminal";
	readonly description =
		"Run an INTERACTIVE command in a live PTY/terminal — the escape hatch for programs needing a real TTY " +
		"(sudo prompts, top/htop, less, vim, REPLs). Not for scripting: prefer run/git/execute. Requires a UI.";
	readonly parameters = terminalSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: { command: string; cwd?: string; timeout?: number },
		signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<TerminalToolDetails>> {
		// A pty needs a real terminal. Without UI (programmatic / execute / no-TTY)
		// there is nothing to attach to — fail with a clear redirect.
		if ($env.PI_NO_PTY === "1" || ctx?.hasUI !== true || ctx.ui === undefined) {
			throw new ToolError(
				"terminal requires an interactive UI (a real TTY). For non-interactive commands use run/git or bash.",
			);
		}

		const cwd = params.cwd ?? this.session.cwd;
		const timeoutMs = (params.timeout ?? 300) * 1000;

		const result: BashInteractiveResult = await runInteractiveBashPty(ctx.ui, {
			command: params.command,
			cwd,
			timeoutMs,
			signal,
			env: { ...(process.env as Record<string, string>) },
		});

		const status = result.cancelled
			? " [cancelled]"
			: result.timedOut
				? " [timed out]"
				: result.exitCode
					? ` [exit ${result.exitCode}]`
					: "";
		return {
			content: [{ type: "text", text: `${result.output}${status}` }],
			details: { exitCode: result.exitCode, cwd, cancelled: result.cancelled, timedOut: result.timedOut },
			data: null,
			isError: result.exitCode !== undefined && result.exitCode !== 0 && !result.cancelled,
		};
	}
}
