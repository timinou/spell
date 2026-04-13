import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolCallContext,
} from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { createLspWritethrough, type FileDiagnosticsResult, type WritethroughCallback, writethroughNoop } from "../lsp";
import { getLanguageFromPath, type Theme } from "../modes/theme/theme";
import writeDescription from "../prompts/tools/write.md" with { type: "text" };
import { enforcePathWrite } from "../sandbox";
import type { ToolSession } from "../sdk";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, truncateToWidth } from "../tui";
import { describeCodeToolSupportedFiles, isCodeToolSupportedPath } from "./code-supported-files";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";
import { enforceModeWrite, resolvePlanPath } from "./mode-guard";
import { type OutputMeta, outputMeta } from "./output-meta";
import {
	formatDiagnostics,
	formatErrorMessage,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	formatTitle,
	replaceTabs,
	shortenPath,
} from "./render-utils";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

/** Details returned by the write tool for TUI rendering */
export interface WriteToolDetails {
	diagnostics?: FileDiagnosticsResult;
	meta?: OutputMeta;
}

const LSP_BATCH_TOOLS = new Set(["edit", "write"]);

function getLspBatchRequest(toolCall: ToolCallContext | undefined): { id: string; flush: boolean } | undefined {
	if (!toolCall) {
		return undefined;
	}
	const hasOtherWrites = toolCall.toolCalls.some(
		(call, index) => index !== toolCall.index && LSP_BATCH_TOOLS.has(call.name),
	);
	if (!hasOtherWrites) {
		return undefined;
	}
	const hasLaterWrites = toolCall.toolCalls.slice(toolCall.index + 1).some(call => LSP_BATCH_TOOLS.has(call.name));
	return { id: toolCall.batchId, flush: !hasLaterWrites };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

type WriteParams = WriteToolInput;

/**
 * Write tool implementation.
 *
 * Creates or overwrites files with optional LSP formatting and diagnostics.
 */
export class WriteTool implements AgentTool<typeof writeSchema, WriteToolDetails> {
	readonly name = "write";
	readonly label = "Write";
	readonly description: string;
	readonly parameters = writeSchema;
	readonly nonAbortable = true;
	readonly strict = true;
	readonly concurrency = "exclusive";

	#writethrough: WritethroughCallback;
	#writethroughCwd: string;

	constructor(private readonly session: ToolSession) {
		this.#writethroughCwd = session.cwd;
		this.#writethrough = this.#createWritethrough(this.#writethroughCwd);
		this.description = renderPromptTemplate(writeDescription);
	}

	async execute(
		_toolCallId: string,
		{ path, content }: WriteParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<WriteToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<WriteToolDetails>> {
		return untilAborted(signal, async () => {
			enforceModeWrite(this.session, path, { op: "create" });
			const sandboxError = enforcePathWrite(path, this.session.cwd, this.session.sandboxPolicy);
			if (sandboxError) throw new Error(sandboxError);
			const absolutePath = resolvePlanPath(this.session, path);
			if (isCodeToolSupportedPath(absolutePath)) {
				throw new Error(
					`The write tool is blocked for code-supported files (${describeCodeToolSupportedFiles()}). Use code edit { file: ${JSON.stringify(path)}, operation: "create", content: ["..."] } instead.`,
				);
			}
			const batchRequest = getLspBatchRequest(context?.toolCall);
			const writethrough = this.#getWritethrough();

			const diagnostics = await writethrough(absolutePath, content, signal, undefined, batchRequest);
			invalidateFsScanAfterWrite(absolutePath);

			const resultText = `Successfully wrote ${content.length} bytes to ${path}`;
			if (!diagnostics) {
				return {
					content: [{ type: "text", text: resultText }],
					details: {},
				};
			}

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					diagnostics,
					meta: outputMeta()
						.diagnostics(diagnostics.summary, diagnostics.messages ?? [])
						.get(),
				},
			};
		});
	}

	#createWritethrough(cwd: string): WritethroughCallback {
		const enableLsp = this.session.enableLsp ?? true;
		const enableFormat = enableLsp && this.session.settings.get("lsp.formatOnWrite");
		const enableDiagnostics = enableLsp && this.session.settings.get("lsp.diagnosticsOnWrite");
		return enableLsp ? createLspWritethrough(cwd, { enableFormat, enableDiagnostics }) : writethroughNoop;
	}

	#getWritethrough(): WritethroughCallback {
		const cwd = this.session.cwd;
		if (cwd !== this.#writethroughCwd) {
			const nextWritethrough = this.#createWritethrough(cwd);
			this.#writethrough = nextWritethrough;
			this.#writethroughCwd = cwd;
		}
		return this.#writethrough;
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface WriteRenderArgs {
	path?: string;
	file_path?: string;
	content?: string;
}

const WRITE_PREVIEW_LINES = 6;
const WRITE_STREAMING_PREVIEW_LINES = 12;

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function formatMetadataLine(lineCount: number | null, language: string | undefined, uiTheme: Theme): string {
	const icon = uiTheme.getLangIcon(language);
	if (lineCount !== null) {
		return uiTheme.fg("dim", `${icon} ${lineCount} lines`);
	}
	return uiTheme.fg("dim", `${icon}`);
}

function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

function formatStreamingContent(content: string, uiTheme: Theme): string {
	if (!content) return "";
	const lines = normalizeDisplayText(content).split("\n");
	const displayLines = lines.slice(-WRITE_STREAMING_PREVIEW_LINES);
	const hidden = lines.length - displayLines.length;

	let text = "\n\n";
	if (hidden > 0) {
		text += uiTheme.fg("dim", `… (${hidden} earlier lines)\n`);
	}
	for (const line of displayLines) {
		text += `${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line), 80))}\n`;
	}
	text += uiTheme.fg("dim", `… (streaming)`);
	return text;
}

function renderContentPreview(content: string, expanded: boolean, uiTheme: Theme): string {
	if (!content) return "";
	const lines = normalizeDisplayText(content).split("\n");
	const maxLines = expanded ? lines.length : Math.min(lines.length, WRITE_PREVIEW_LINES);
	const displayLines = expanded ? lines : lines.slice(-maxLines);
	const hidden = lines.length - displayLines.length;

	let text = "\n\n";
	for (const line of displayLines) {
		text += `${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line), 80))}\n`;
	}
	if (!expanded && hidden > 0) {
		const hint = formatExpandHint(uiTheme, expanded, hidden > 0);
		const moreLine = `${formatMoreItems(hidden, "line")}${hint ? ` ${hint}` : ""}`;
		text += uiTheme.fg("dim", moreLine);
	}
	return text;
}

export const writeToolRenderer = {
	renderCall(args: WriteRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const rawPath = args.file_path || args.path || "";
		const filePath = shortenPath(rawPath);
		const lang = getLanguageFromPath(rawPath) ?? "text";
		const langIcon = uiTheme.fg("muted", uiTheme.getLangIcon(lang));
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		const spinner =
			options?.spinnerFrame !== undefined ? formatStatusIcon("running", uiTheme, options.spinnerFrame) : "";

		let text = `${formatTitle("Write", uiTheme)} ${spinner ? `${spinner} ` : ""}${langIcon} ${pathDisplay}`;

		if (!args.content) {
			return new Text(text, 0, 0);
		}

		// Show streaming preview of content (tail)
		text += formatStreamingContent(args.content, uiTheme);

		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: WriteToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: WriteRenderArgs,
	): Component {
		const rawPath = args?.file_path || args?.path || "";
		const filePath = shortenPath(rawPath);
		const fileContent = args?.content || "";
		const lang = getLanguageFromPath(rawPath);
		const langIcon = uiTheme.fg("muted", uiTheme.getLangIcon(lang));
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		const lineCount = typeof args?.content === "string" ? countLines(fileContent) : null;
		const textContent = result.content.find(content => content.type === "text")?.text ?? "";
		const diagnostics = result.details?.diagnostics;
		if (result.isError) {
			const header = renderStatusLine(
				{
					icon: "error",
					title: "Write",
					description: `${langIcon} ${pathDisplay}`,
				},
				uiTheme,
			);
			return new Text([header, formatErrorMessage(textContent, uiTheme)].join("\n"), 0, 0);
		}

		// Build header with status icon
		const header = renderStatusLine(
			{
				icon: "success",
				title: "Write",
				description: `${langIcon} ${pathDisplay}`,
			},
			uiTheme,
		);
		const metadataLine = formatMetadataLine(lineCount, lang ?? "text", uiTheme);

		let cached: RenderCache | undefined;

		return {
			render(width: number) {
				const { expanded } = options;
				const key = new Hasher().bool(expanded).u32(width).digest();
				if (cached?.key === key) return cached.lines;

				let text = header;
				text += `\n${metadataLine}`;
				text += renderContentPreview(fileContent, expanded, uiTheme);

				if (diagnostics) {
					const diagText = formatDiagnostics(diagnostics, expanded, uiTheme, fp =>
						uiTheme.getLangIcon(getLanguageFromPath(fp)),
					);
					if (diagText.trim()) {
						const diagLines = diagText.split("\n");
						const firstNonEmpty = diagLines.findIndex(line => line.trim());
						if (firstNonEmpty >= 0) {
							text += `\n${diagLines.slice(firstNonEmpty).join("\n")}`;
						}
					}
				}

				const lines = text.split("\n").map(l => truncateToWidth(l, width, Ellipsis.Omit));
				cached = { key, lines };
				return lines;
			},
			invalidate() {
				cached = undefined;
			},
		};
	},
	mergeCallAndResult: true,
};
