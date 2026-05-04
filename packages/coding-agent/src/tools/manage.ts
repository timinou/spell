import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { executeCodePath } from "@oh-my-pi/pi-natives";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { renderCodeCell } from "../tui";
import { formatCodePathResult } from "./codepath-result";
import type { ManageParams } from "./codepath-types";
import { manageSchema } from "./codepath-types";
import { replaceTabs } from "./render-utils";
import { type DetailsWithMeta, toolResult } from "./tool-result";

type ManageToolResultDetails = DetailsWithMeta & {
	command?: string;
};

export class ManageTool implements AgentTool<typeof manageSchema> {
	readonly name = "manage";
	readonly label = "Manage";
	readonly description =
		"Management commands for code buffers and workspace state: save, undo, redo, diff, buffers, languages, index, watcherStatus, lockStatus, status, context.";
	readonly parameters = manageSchema;
	readonly lenientArgValidation = true;

	async execute(
		_toolCallId: string,
		params: ManageParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const chunks = await executeCodePath({
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
		return {
			render: (width: number) =>
				renderCodeCell(
					{
						code: truncated,
						language: "text",
						title: `Manage`,
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
