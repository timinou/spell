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
 * Classifies a target for auto-attach behavior.
 * - `"bare-plain"`: plain filesystem path (no scheme, axis, qualifier, terminator, glob).
 *   Auto-attach `#raw` for files, `#listing` for dirs.
 * - `"qualified"`: has explicit qualifier (`#...`) — caller's qualifier wins.
 * - `"other"`: scheme, axis, terminator, or glob — pass through unchanged.
 */
function classifyBareTarget(target: string): "bare-plain" | "qualified" | "other" {
	if (target.includes("://")) return "other";
	if (target.includes("::")) return "other";
	if (target.includes(";")) return "other";
	if (/[*?\[]/.test(target)) return "other";
	if (target.includes("#")) return "qualified";
	return "bare-plain";
}

/**
 * Builds a directory qualifier from params:
 * - `depth` → `#tree[depth=N]` (overrides recursive)
 * - `recursive` → `#tree` (full recursion)
 * - default → `#listing` (one level)
 */
function buildDirQualifier(target: string, params: GetParams): string {
	if (params.depth !== undefined) return `${target}#tree[depth=${params.depth}]`;
	if (params.recursive) return `${target}#tree`;
	return `${target}#listing`;
}
/**
 * When the kernel surfaces a [DID_YOU_MEAN] diagnostic, replace the raw
 * machine-oriented line with a friendly hint.
 */
function prettifyDidYouMean(text: string): string {
	return text.replace(
		/^\[(\w+)\] \[DID_YOU_MEAN\] No exact match for [^;]+; candidates: (\[.*?\])(?: \([^)]+\))?$/gm,
		(_match, _variant, candidatesJson: string) => {
			try {
				const candidates = JSON.parse(candidatesJson) as string[];
				if (Array.isArray(candidates) && candidates.length > 0) {
					return `Did you mean: ${candidates.join(", ")}`;
				}
			} catch {
				// ignore parse errors, leave original
			}
			return _match;
		},
	);
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
		// Auto-attach qualifiers for bare filesystem paths.
		// - Files → `#raw` (existing behavior)
		// - Directories → `#listing` by default, `#tree`/`#tree[depth=N]` when recursive/depth set
		// - `content: false` opts out for callers wanting the raw node
		// - Already-qualified targets pass through unchanged
		let target = params.target;
		if (params.content !== false && classifyBareTarget(target) === "bare-plain") {
			const normalized = target.replace(/\/+$/, "");
			const absCandidate = path.isAbsolute(normalized) ? normalized : path.resolve(params.root ?? process.cwd(), normalized);
			try {
				const stat = await fs.stat(absCandidate);
				if (stat.isFile()) {
					target = `${normalized}#raw`;
				} else if (stat.isDirectory()) {
					target = buildDirQualifier(normalized, params);
				}
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

		const text = prettifyDidYouMean(result.text);
		const builder = toolResult<GetToolResultDetails>({ format: params.format }).text(text);
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
		const text = prettifyDidYouMean(
			result.content
				.filter(c => c.type === "text")
				.map(c => (c as { text?: string }).text ?? "")
				.join("\n"),
		);
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
