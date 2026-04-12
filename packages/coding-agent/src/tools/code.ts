/**
 * Code intelligence tool — wraps native pi-code-engine and graph queries for use in coding-agent.
 *
 * File-scoped structural operations use the native tree-sitter engine (pi-code-engine).
 * Cross-file graph operations route to the native code graph engine.
 */

import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import {
	type CodeBufferOptions,
	type CodeBufferResult,
	executeCodeBuffer,
	executeCodeGraph,
} from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import codeDescription from "../prompts/tools/code.md" with { type: "text" };
import markdownHint from "../prompts/tools/code-hint-markdown.md" with { type: "text" };
import typstHint from "../prompts/tools/code-hint-typst.md" with { type: "text" };
import { renderCodeCell } from "../tui";
import type { ToolSession } from ".";
import {
	type CodeFileCommand,
	type CodeGraphCommand,
	type CodeToolResultDetails,
	createCodeGraphDetails,
	createCodeToolError,
	formatCodeToolContent,
	normalizeCodeBufferSuccess,
} from "./code-result";
import { enforceModeWrite } from "./mode-guard";
import { replaceTabs } from "./render-utils";
import { toolResult } from "./tool-result";

const GRAPH_COMMANDS = new Set([
	"index",
	"status",
	"context",
	"impact",
	"deps",
	"flow",
	"dead_code",
	"clusters",
	"search",
]);

const MUTATING_COMMANDS = new Set(["edit", "undo", "redo"]);

const FALLBACK_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"mts",
	"cts",
	"rs",
	"py",
	"pyi",
	"typ",
	"md",
	"mdx",
	"markdown",
	"org",
	"ex",
	"exs",
]);

let supportedExtensionsCache: Set<string> | undefined;

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
	["typ", "typst"],
	["md", "markdown"],
	["mdx", "markdown"],
	["markdown", "markdown"],
]);

const LANGUAGE_INJECTIONS = new Map<string, string>([
	["markdown", markdownHint.trim()],
	["typst", typstHint.trim()],
]);

function extractSupportedExtensions(output: unknown): Set<string> {
	const record = output as { languages?: Array<{ extensions?: string[] }> } | undefined;
	const extensions = new Set<string>();
	for (const language of record?.languages ?? []) {
		for (const extension of language.extensions ?? []) {
			if (extension) extensions.add(extension.toLowerCase());
		}
	}
	return extensions;
}

function getSupportedExtensions(): Set<string> {
	if (supportedExtensionsCache) return supportedExtensionsCache;

	try {
		const result = timedCodeBuffer({ command: "languages" });
		if (result.error) {
			return FALLBACK_EXTENSIONS;
		}

		const extensions = extractSupportedExtensions(result.output);
		if (extensions.size > 0) {
			supportedExtensionsCache = extensions;
			return extensions;
		}
	} catch {}

	return FALLBACK_EXTENSIONS;
}

export function _resetSupportedExtensionsForTest(override?: Set<string>): void {
	supportedExtensionsCache = override;
}

function languageForFile(file: string): string | undefined {
	const extension = path.extname(file).slice(1).toLowerCase();
	return extension ? LANGUAGE_BY_EXTENSION.get(extension) : undefined;
}

const FILE_COMMANDS = new Set(["outline", "read", "navigate", "edit", "undo", "redo", "diff", "save", "open", "close"]);

function timedCodeBuffer(options: CodeBufferOptions): CodeBufferResult {
	const start = performance.now();
	const result = executeCodeBuffer(options);
	const durationMs = Math.round(performance.now() - start);
	const file = options.file ? path.basename(options.file) : undefined;
	logger.debug("code buffer operation", { command: options.command, file, durationMs });
	if (durationMs > 2000) {
		logger.warn("slow code buffer operation", { command: options.command, file, durationMs });
	}
	return result;
}

function getTextContent(result: AgentToolResult): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text ?? "")
		.join("");
}

function extractCodeToolErrorMessage(output: unknown): string {
	if (typeof output === "string") return output;
	if (typeof output === "number" || typeof output === "boolean") return String(output);
	if (output && typeof output === "object" && !Array.isArray(output)) {
		const message = Reflect.get(output, "message");
		if (typeof message === "string" && message.trim().length > 0) {
			return message;
		}
	}
	const serialized = JSON.stringify(output);
	return typeof serialized === "string" && serialized.length > 0 ? serialized : "Code command failed";
}

// =============================================================================
// Schema
// =============================================================================

const patchSchema = Type.Object({
	find: Type.Union([Type.String(), Type.Array(Type.String())], {
		description: "Text to find within the symbol scope (indent-insensitive)",
	}),
	replace: Type.Union([Type.String(), Type.Array(Type.String())], { description: "Replacement text" }),
});

const editEntrySchema = Type.Object({
	symbol: Type.Optional(
		Type.String({
			description: "Symbol name to target (for example 'handleRequest' or 'MyClass.method')",
		}),
	),
	line: Type.Optional(
		Type.Integer({
			description: "1-indexed line number for positional operations (drag, splice, clone, transpose)",
		}),
	),
	column: Type.Optional(Type.Integer({ description: "1-indexed column for transpose" })),
	operation: Type.String({
		description:
			"Edit operation: patch | replace | replace-body | wrap | rename | kill | insert-before | insert-after | splice | drag-up | drag-down | clone | transpose",
	}),
	content: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description: "Content for replace | replace-body | wrap template | rename new name | insert operations",
		}),
	),
	patches: Type.Optional(Type.Array(patchSchema, { description: "Find/replace patches for patch operation" })),
	mode: Type.Optional(Type.String({ description: "Splice mode: self | up | down (default: self)" })),
});

const codeSchema = Type.Object({
	command: Type.String({
		description:
			"Subcommand: read | outline | edit | buffers | diff | navigate | languages | undo | redo | save | index | status | context | impact | deps | flow | dead_code | clusters | search",
	}),
	file: Type.Optional(Type.String({ description: "Absolute or project-relative file path" })),
	symbol: Type.Optional(
		Type.String({
			description: "Symbol name for edit targeting or graph commands like context | impact | flow",
		}),
	),
	query: Type.Optional(Type.String({ description: "Search query for graph search" })),
	resolution: Type.Optional(Type.Integer({ description: "Zoom level 0-3 (default 2)" })),
	offset: Type.Optional(Type.Integer({ description: "Start line 1-indexed (resolution 3 only)" })),
	limit: Type.Optional(Type.Integer({ description: "Max results or lines" })),
	semantic: Type.Optional(Type.Boolean({ description: "Require or suppress semantic graph search when supported" })),
	depth: Type.Optional(Type.Integer({ description: "Max nesting or traversal depth" })),
	operation: Type.Optional(
		Type.String({
			description:
				"Edit operation: patch | replace | replace-body | wrap | rename | kill | insert-before | insert-after | splice | drag-up | drag-down | clone | transpose",
		}),
	),
	content: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description: "Content for replace | replace-body | wrap template | rename new name | insert operations",
		}),
	),
	patches: Type.Optional(Type.Array(patchSchema, { description: "Find/replace patches for patch operation" })),
	edits: Type.Optional(Type.Array(editEntrySchema, { description: "Array of edits to apply in sequence" })),
	mode: Type.Optional(Type.String({ description: "Splice mode: self | up | down (default: self)" })),
	action: Type.Optional(
		Type.String({
			description: "Navigate action: defun-at | parent | references | node-at | siblings | children",
		}),
	),
	line: Type.Optional(
		Type.Integer({
			description: "1-indexed line for navigation or positional edit operations",
		}),
	),
	column: Type.Optional(Type.Integer({ description: "1-indexed column for navigation or transpose" })),
});

type CodeParams = Static<typeof codeSchema>;

type NormalizedCodeEdit = NonNullable<CodeBufferOptions["edits"]>[number];

function normalizeLines(value: CodeParams["content"]): string | undefined {
	if (value === undefined) return undefined;
	return typeof value === "string" ? value : value.join("\n");
}

function normalizePatches(patches: CodeParams["patches"]): CodeBufferOptions["patches"] | undefined {
	if (!patches) return undefined;
	return patches.map(patch => ({
		find: normalizeLines(patch.find) ?? "",
		replace: normalizeLines(patch.replace) ?? "",
	}));
}

function normalizeEditEntries(edits: CodeParams["edits"]): CodeBufferOptions["edits"] | undefined {
	if (!edits) return undefined;
	return edits.map(edit => {
		const normalizedEdit: NormalizedCodeEdit = { operation: edit.operation };
		if (edit.symbol !== undefined) normalizedEdit.symbol = edit.symbol;
		if (edit.line !== undefined) normalizedEdit.line = edit.line;
		if (edit.column !== undefined) normalizedEdit.column = edit.column;
		if (edit.content !== undefined) normalizedEdit.content = normalizeLines(edit.content);
		if (edit.patches) normalizedEdit.patches = normalizePatches(edit.patches);
		if (edit.mode !== undefined) normalizedEdit.mode = edit.mode;
		return normalizedEdit;
	});
}

// =============================================================================
// Tool class
// =============================================================================

export class CodeTool implements AgentTool<typeof codeSchema> {
	readonly name = "code";
	readonly label = "Code";
	readonly description: string;
	readonly parameters = codeSchema;
	readonly lenientArgValidation = true;

	#session: ToolSession;
	#seenLanguages = new Set<string>();

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = codeDescription;
	}

	#maybeInjectLanguageHint(file?: string): string | undefined {
		if (!file) return undefined;
		const language = languageForFile(file);
		if (!language || this.#seenLanguages.has(language)) return undefined;
		const hint = LANGUAGE_INJECTIONS.get(language);
		if (!hint) return undefined;
		this.#seenLanguages.add(language);
		return hint;
	}

	async execute(
		_toolCallId: string,
		params: CodeParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const command = params.command ?? "";
		const sessionCwd = this.#session.cwd ?? getProjectDir();

		if (command === "edit" || command === "save") {
			if (params.file) {
				enforceModeWrite(this.#session, params.file);
			}
		}

		try {
			if (GRAPH_COMMANDS.has(command)) {
				return await this.#executeGraphCommand(params, _signal);
			}

			if (command === "install_grammar") {
				const details = createCodeToolError({
					command,
					message:
						"install_grammar is no longer supported. Grammars for TypeScript, Rust, Python, and Elixir are built-in.",
				});
				return toolResult(details).text(formatCodeToolContent(details)).done();
			}

			const nativeCommand = command === "buffers" ? "list" : command;
			const options: CodeBufferOptions = { command: nativeCommand };
			const resolveFile = (file: string): string => (path.isAbsolute(file) ? file : path.resolve(sessionCwd, file));

			if (params.file) options.file = resolveFile(params.file);
			if (params.resolution !== undefined) options.resolution = params.resolution;
			if (params.offset !== undefined) options.offset = params.offset;
			if (params.limit !== undefined) options.limit = params.limit;
			if (params.line !== undefined) options.line = params.line;
			if (params.column !== undefined) options.column = params.column;
			if (params.symbol) options.symbol = params.symbol;
			if (params.operation) options.operation = params.operation;
			if (params.content !== undefined) options.content = normalizeLines(params.content);
			if (params.patches) options.patches = normalizePatches(params.patches);
			if (params.edits) options.edits = normalizeEditEntries(params.edits);
			if (params.mode) options.mode = params.mode;
			if (command === "navigate" && params.action) {
				options.action = params.action === "references-local" ? "references" : params.action;
			}

			if (FILE_COMMANDS.has(nativeCommand) && options.file) {
				const ext = path.extname(options.file).slice(1).toLowerCase();
				if (ext && !getSupportedExtensions().has(ext)) {
					const details = createCodeToolError({
						command,
						file: options.file,
						cwd: sessionCwd,
						message: `Unsupported file type .${ext}. The code tool supports TypeScript, Rust, Python, Typst, Markdown, Org, and Elixir. Use the read tool instead.`,
					});
					return toolResult(details).text(formatCodeToolContent(details)).done();
				}
			}

			const result = timedCodeBuffer(options);
			if (result.error) {
				const details = createCodeToolError({
					command,
					file: options.file,
					cwd: sessionCwd,
					output: result.output,
					message: extractCodeToolErrorMessage(result.output),
				});
				return toolResult(details).text(formatCodeToolContent(details)).done();
			}

			if (MUTATING_COMMANDS.has(command) && options.file) {
				const saveResult = timedCodeBuffer({ command: "save", file: options.file });
				if (saveResult.error) {
					const details = createCodeToolError({
						command,
						file: options.file,
						cwd: sessionCwd,
						message: `Edit succeeded but save to disk failed: ${extractCodeToolErrorMessage(saveResult.output)}`,
					});
					return toolResult(details).text(formatCodeToolContent(details)).done();
				}
			}

			const details = normalizeCodeBufferSuccess({
				command: command as CodeFileCommand,
				output: result.output,
				file: options.file,
				cwd: sessionCwd,
				action: options.action,
				resolution: params.resolution,
				offset: params.offset,
				limit: params.limit,
			});
			const injectedHint = this.#maybeInjectLanguageHint(options.file);
			if (injectedHint) {
				(details as CodeToolResultDetails & { injectedHint?: string }).injectedHint = injectedHint;
			}
			const text = formatCodeToolContent(details);
			return toolResult(details).text(text).done();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("code tool error", { error: message, command });
			const details = createCodeToolError({
				command,
				file: params.file ? path.resolve(sessionCwd, params.file) : undefined,
				cwd: sessionCwd,
				output: err,
				message,
			});
			return toolResult(details).text(formatCodeToolContent(details)).done();
		}
	}

	async #executeGraphCommand(params: CodeParams, signal?: AbortSignal): Promise<AgentToolResult> {
		const start = performance.now();
		const result = await executeCodeGraph({
			command: params.command,
			root: this.#session.cwd ?? getProjectDir(),
			file: params.file,
			symbol: params.symbol,
			query: params.query,
			depth: params.depth,
			limit: params.limit,
			semantic: params.semantic,
			signal,
		});
		const durationMs = Math.round(performance.now() - start);
		logger.debug("code graph operation", { command: params.command, durationMs });
		if (durationMs > 2000) {
			logger.warn("slow code graph operation", { command: params.command, durationMs });
		}
		const details = createCodeGraphDetails({
			command: params.command as CodeGraphCommand,
			output: result.output,
			cacheStatus: result.cacheStatus,
			rebuilt: result.rebuilt,
			semanticStatus: result.semanticStatus,
		});
		return toolResult(details).text(formatCodeToolContent(details)).done();
	}

	renderResult(result: AgentToolResult, options: RenderResultOptions, theme: unknown): Component {
		const details = result.details as CodeToolResultDetails | undefined;
		const uiTheme = theme as Theme;
		const command = details?.command;
		const text = details ? formatCodeToolContent(details) : getTextContent(result);
		const toRender = (value: string): string => {
			const sanitized = replaceTabs(value);
			const maxChars = 2_000;
			return sanitized.length > maxChars ? `${sanitized.slice(0, maxChars)}\n...truncated` : sanitized;
		};
		const isError = "isError" in result && result.isError === true;
		if (isError || details?.kind === "error") {
			return new Text(toRender(details?.kind === "error" ? details.message : text), 0, 0);
		}

		const language = command === "edit" || command === "diff" ? "diff" : "text";
		return {
			render: (width: number) =>
				renderCodeCell(
					{
						code: toRender(text),
						language,
						title: command ? `Code ${command}` : "Code",
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
