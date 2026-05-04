import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { executeCodePath } from "@oh-my-pi/pi-natives";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { renderCodeCell } from "../tui";
import { type CodePathFormatMode, formatCodePathResult } from "./codepath-result";
import type { GetParams } from "./codepath-types";
import { getSchema } from "./codepath-types";
import { replaceTabs } from "./render-utils";
import { type DetailsWithMeta, toolResult } from "./tool-result";

type GetToolResultDetails = DetailsWithMeta & {
	format?: string;
};

export class GetTool implements AgentTool<typeof getSchema> {
	readonly name = "get";
	readonly label = "Get";
	readonly description =
		"Retrieve code, files, symbols, or matches using a CodePath target. Supports paths, globs, symbols, regex, and URI schemes.";
	readonly parameters = getSchema;
	readonly lenientArgValidation = true;

	async execute(
		_toolCallId: string,
		params: GetParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const chunks = await executeCodePath({
			command: "get",
			target: params.target,
			limit: params.limit,
			head: params.head,
			tail: params.tail,
			offset: params.offset,
			format: params.format,
			root: params.root,
			abortSignal: signal,
		});

		const result = formatCodePathResult(chunks, {
			format: (params.format as CodePathFormatMode) ?? "node-list",
			limit: params.limit,
		});

		const builder = toolResult<GetToolResultDetails>({ format: params.format }).text(result.text);
		if (result.meta) {
			builder.limits({
				resultLimit: result.meta.limits?.resultLimit?.reached,
				headLimit: result.meta.limits?.headLimit?.reached,
			});
		}
		const toolRes = builder.done();

		// Include image content blocks if present
		if (result.images.length > 0) {
			const content = [...toolRes.content];
			for (const img of result.images) {
				content.push({ type: "image", data: img.data, mimeType: img.mimeType });
				if (img.text) {
					content.push({ type: "text", text: img.text });
				}
			}
			return { ...toolRes, content };
		}

		return toolRes;
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
						title: "Get",
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
