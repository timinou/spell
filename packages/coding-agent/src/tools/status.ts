/**
 * Status tool — kernel observability.
 *
 * Renamed from `manage` (legacy tool removed). Drops save/diff/buffers/context/undo/redo:
 *   save    — edits auto-persist (no buffer surface)
 *   undo    — moved to `edit { operations: [{ action: { kind: "undo" } }] }`
 *   redo    — moved to `edit` likewise
 *   diff    — use `find { target: "<path>#diff" }` (post W8 kernel rebuild)
 *   buffers — no buffer surface
 *   context — agent-side
 *
 * Remaining commands: languages, index, watcherStatus, lockStatus, status.
 * Dispatches to the kernel via the `manage` NAPI command (kernel-side name
 * is unchanged; only the agent tool surface was renamed).
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@spell/pi-agent-core";
import { executeCodePath } from "@spell/pi-natives";
import type { Component } from "@spell/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import statusDescription from "../prompts/tools/status.md" with { type: "text" };
import { renderCodeCell } from "../tui";
import { formatCodePathResult } from "./codepath-result";
import { sessionContextOpts } from "./codepath-session";
import type { StatusParams } from "./codepath-types";
import { statusSchema } from "./codepath-types";
import { replaceTabs } from "./render-utils";
import { type DetailsWithMeta, toolResult } from "./tool-result";

type StatusToolResultDetails = DetailsWithMeta & {
	command?: string;
};

export class StatusTool implements AgentTool<typeof statusSchema> {
	readonly name = "status";
	readonly label = "Status";
	readonly description = statusDescription;
	readonly parameters = statusSchema;
	readonly lenientArgValidation = true;

	async execute(
		_toolCallId: string,
		params: StatusParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		// `index` triggers background code-graph indexing; edge resolvers
		// emit CODE_GRAPH_NOT_INITIALISED until it completes.
		const chunks = await executeCodePath({
			...sessionContextOpts(undefined),
			command: "manage",
			manage: params.command,
			target: params.file ?? "",
			abortSignal: signal,
		});

		const result = formatCodePathResult(chunks, { format: "node-list" });
		const builder = toolResult<StatusToolResultDetails>({ command: params.command }).text(result.text);
		if (result.meta) {
			builder.limits({
				resultLimit: result.meta.limits?.resultLimit?.reached,
				headLimit: result.meta.limits?.headLimit?.reached,
			});
		}
		return builder.done();
	}

	renderResult(result: AgentToolResult, options: RenderResultOptions, theme: unknown): Component {
		const uiTheme = theme as Theme;
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { text?: string }).text ?? "")
			.join("\n");
		const sanitized = replaceTabs(text);
		const maxChars = 2_000;
		const truncated = sanitized.length > maxChars ? `${sanitized.slice(0, maxChars)}\n...truncated` : sanitized;
		const details = (result as AgentToolResult & { details?: StatusToolResultDetails }).details;
		const subcommand = details?.command;
		const title = subcommand ? `Status / ${subcommand}` : "Status";
		return {
			render: (width: number) =>
				renderCodeCell(
					{
						code: truncated,
						language: "text",
						title,
						status: "complete",
						expanded: options.expanded,
						width,
					},
					uiTheme,
				),
			invalidate: () => {},
		};
	}
}
