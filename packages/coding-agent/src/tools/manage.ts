import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@spell/pi-agent-core";
import type { Component } from "@spell/pi-tui";
import { executeCodePath } from "@spell/pi-natives";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import manageDescription from "../prompts/tools/manage.md" with { type: "text" };
import { renderCodeCell } from "../tui";
import { formatCodePathResult } from "./codepath-result";
import type { ManageParams } from "./codepath-types";
import { manageSchema } from "./codepath-types";
import { replaceTabs } from "./render-utils";
import { type DetailsWithMeta, toolResult } from "./tool-result";
import { sessionContextOpts } from "./codepath-session";

type ManageToolResultDetails = DetailsWithMeta & {
	command?: string;
};

export class ManageTool implements AgentTool<typeof manageSchema> {
	readonly name = "manage";
	readonly label = "Manage";
	readonly description = manageDescription;
	readonly parameters = manageSchema;
	readonly lenientArgValidation = true;

	async execute(
		_toolCallId: string,
		params: ManageParams,
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
		const builder = toolResult<ManageToolResultDetails>({ command: params.command }).text(result.text);
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
		// FEAT-710: diff subcommand renders with diff syntax highlighting
		// to match the edit-tool output. Other manage subcommands stay
		// plain-text.
		const details = (result as AgentToolResult & { details?: ManageToolResultDetails }).details;
		const subcommand = details?.command;
		const language = subcommand === "diff" ? "diff" : "text";
		const title = subcommand ? `Manage / ${subcommand}` : "Manage";
		return {
			render: (width: number) =>
				renderCodeCell(
					{
						code: truncated,
						language,
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
