import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { executeCodePath } from "@oh-my-pi/pi-natives";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Theme } from "../modes/theme/theme";
import getDescription from "../prompts/tools/get.md" with { type: "text" };
import { renderCodeCell } from "../tui";
import { type CodePathFormatMode, formatCodePathResult } from "./codepath-result";
import type { GetParams } from "./codepath-types";
import { getSchema } from "./codepath-types";
import { replaceTabs } from "./render-utils";
import { type DetailsWithMeta, toolResult } from "./tool-result";

type GetToolResultDetails = DetailsWithMeta & {
	format?: string;
};

/**
 * A target qualifies for auto `#raw` attachment when it is a plain filesystem
 * path: no scheme (`foo://`), no axis separator (`::`), no qualifier (`#`), no
 * payload terminator (`;`), and no glob magic (`*`, `?`, `[`). Caller still
 * `fs.stat`s the resolved path before mutating the target so directories and
 * non-existent paths fall through to the kernel unchanged.
 */
function shouldAutoAttachRaw(target: string): boolean {
	if (target.includes("://")) return false;
	if (target.includes("::")) return false;
	if (target.includes("#")) return false;
	if (target.includes(";")) return false;
	return !/[*?\[]/.test(target);
}

export class GetTool implements AgentTool<typeof getSchema> {
	readonly name = "get";
	readonly label = "Get";
	readonly description = getDescription;
	readonly parameters = getSchema;
	readonly lenientArgValidation = true;

	async execute(
		_toolCallId: string,
		params: GetParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		// UX: bare file paths returning kernel metadata (no content) trips models
		// migrating from the legacy `read` tool. Auto-attach `#raw` when the target
		// is a plain path pointing at an existing file. Explicit `content:false`
		// opts out for callers that just want the file node.
		let target = params.target;
		if (params.content !== false && shouldAutoAttachRaw(target)) {
			const absCandidate = path.isAbsolute(target) ? target : path.resolve(params.root ?? process.cwd(), target);
			try {
				const stat = await fs.stat(absCandidate);
				if (stat.isFile()) target = `${target}#raw`;
			} catch {
				// Path does not exist; let the kernel surface its native diagnostics.
			}
		}

		const chunks = await executeCodePath({
			command: "get",
			target,
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
