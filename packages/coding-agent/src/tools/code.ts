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
import { FileFormatResult, formatFileContent } from "../lsp";
import type { Theme } from "../modes/theme/theme";
import codeDescription from "../prompts/tools/code.md" with { type: "text" };
import markdownHint from "../prompts/tools/code-hint-markdown.md" with { type: "text" };
import semanticHint from "../prompts/tools/code-hint-semantic.md" with { type: "text" };
import textFallbackHint from "../prompts/tools/code-hint-text-fallback.md" with { type: "text" };
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
import {
	_resetSupportedExtensionsForTest,
	describeCodeToolSupportedFiles,
	getSupportedExtensions,
} from "./code-supported-files";
import { enforceModeWrite } from "./mode-guard";
import { replaceTabs } from "./render-utils";
import { toolResult } from "./tool-result";

const GRAPH_COMMANDS = new Set(["index", "status", "context", "impact", "deps", "flow", "dead_code", "clusters"]);
const REMOVED_SEARCH_COMMANDS = new Set(["symbols", "files", "search"]);

const MUTATING_COMMANDS = new Set(["edit", "undo", "redo"]);

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

export { _resetSupportedExtensionsForTest };

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

function isMeaningfulIndex(value: number | undefined): value is number {
	return value !== undefined && value > 0;
}

function isMeaningfulOptionalNumber(value: number | undefined): value is number {
	return value !== undefined && value !== 0;
}

function isMeaningfulString(value: string | undefined): value is string {
	return value !== undefined && value.length > 0;
}

function hasEntries<T>(value: T[] | undefined): value is T[] {
	return value !== undefined && value.length > 0;
}

function parseTargetId(targetId: string): { fileTargetId: string; symbolTargetId?: string } {
	const [fileTargetId, symbolTargetId] = targetId.split(/::(.+)/, 2);
	return { fileTargetId, symbolTargetId };
}

function primaryFileForOperations(
	operations: CodeParams["operations"] | undefined,
	sessionCwd: string,
	root?: string,
): string | undefined {
	const targetId = operations?.[0]?.targetId;
	if (!targetId) return undefined;
	const { fileTargetId } = parseTargetId(targetId);
	if (path.isAbsolute(fileTargetId)) return fileTargetId;
	const base = root ? path.resolve(sessionCwd, root) : sessionCwd;
	return path.resolve(base, fileTargetId);
}
function countDiffChanges(diff: string): { addedLines: number; removedLines: number } {
	let addedLines = 0;
	let removedLines = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++")) continue;
		if (line.startsWith("---")) continue;
		if (line.startsWith("+")) {
			addedLines += 1;
			continue;
		}
		if (line.startsWith("-")) {
			removedLines += 1;
		}
	}
	return { addedLines, removedLines };
}

function countBufferDiffHunks(output: unknown): number {
	return Array.isArray(output) ? output.length : 0;
}

function shouldCheckBufferFreshness(command: string, isCreate: boolean): boolean {
	if (command === "save") return false;
	if (!MUTATING_COMMANDS.has(command)) return false;
	return !(command === "edit" && isCreate);
}

// =============================================================================
// Schema
// =============================================================================

const codeActionSchema = Type.Object({
	kind: Type.String({
		description: `			Action kind: write | findAndReplace | wrap | rename | delete | insertBefore | insertAfter | splice | move | clone | transpose | renameClassToken | renameIdToken | renameCustomProperty | removeDeadStyle | promote | demote | replaceCodeBlock`,
	}),
	scope: Type.Optional(Type.String({ description: "Write scope: target | body" })),
	content: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description: "Canonical content payload for write-like actions",
		}),
	),
	find: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description: "Find text for findAndReplace within the resolved target scope",
		}),
	),
	mode: Type.Optional(Type.String({ description: "Splice mode: self | up | down (default: self)" })),
	direction: Type.Optional(Type.String({ description: "Move direction: up | down" })),
	line: Type.Optional(Type.Integer({ description: "1-indexed line for positional actions when needed" })),
	column: Type.Optional(Type.Integer({ description: "1-indexed column for transpose actions when needed" })),
	nodeType: Type.Optional(Type.String({ description: "Optional node type hint for positional actions" })),
});

const codeOperationSchema = Type.Recursive(This =>
	Type.Object({
		targetId: Type.String({
			description: "Stable edit target ID: '<file>' for file roots or '<file>::Symbol.member' for declarations",
		}),
		actions: Type.Array(codeActionSchema, { description: "Ordered actions to execute within this target" }),
		children: Type.Optional(
			Type.Array(This, { description: "Nested child target operations under the same file tree" }),
		),
	}),
);

const codeSchema = Type.Object({
	command: Type.String({
		description:
			"Subcommand: read | outline | edit | buffers | diff | navigate | languages | undo | redo | save | index | status | context | impact | deps | flow | dead_code | clusters",
	}),
	file: Type.Optional(Type.String({ description: "Absolute or project-relative file path" })),
	symbol: Type.Optional(
		Type.String({
			description: "Symbol name for graph commands like context | impact | flow, or navigate references",
		}),
	),
	query: Type.Optional(
		Type.String({ description: "Legacy repo-local lookup query. Use grep for semantic or raw-text search." }),
	),
	resolution: Type.Optional(Type.Integer({ description: "Zoom level 0-3 (default 2)" })),
	offset: Type.Optional(Type.Integer({ description: "Start line 1-indexed (resolution 3 only)" })),
	limit: Type.Optional(Type.Integer({ description: "Max results or lines" })),
	semantic: Type.Optional(Type.Boolean({ description: "Require or suppress semantic graph search when supported" })),
	depth: Type.Optional(Type.Integer({ description: "Max nesting or traversal depth" })),
	root: Type.Optional(
		Type.String({ description: "Optional project-relative or absolute root for targetId file resolution" }),
	),
	operations: Type.Optional(
		Type.Array(codeOperationSchema, { description: "Recursive targetId-based edit operations" }),
	),
	idempotent: Type.Optional(
		Type.Boolean({
			description: "Allow mutating edit commands to succeed when they intentionally make no semantic change",
		}),
	),
	action: Type.Optional(
		Type.String({
			description: "Navigate action: defun-at | parent | references | node-at | siblings | children",
		}),
	),
	line: Type.Optional(Type.Integer({ description: "1-indexed line for navigation" })),
	column: Type.Optional(Type.Integer({ description: "1-indexed column for navigation" })),
});

type CodeParams = Static<typeof codeSchema>;

function normalizeLines(value: string | string[] | undefined): string | undefined {
	if (value === undefined) return undefined;
	return typeof value === "string" ? value : value.join("\n");
}

function normalizeOperations(operations: CodeParams["operations"]): CodeBufferOptions["operations"] | undefined {
	if (!hasEntries(operations)) return undefined;
	return operations.map(operation => ({
		targetId: operation.targetId,
		actions: operation.actions.map(action => ({
			kind: action.kind,
			scope: action.scope === "target" || action.scope === "body" ? action.scope : undefined,
			content: normalizeLines(action.content),
			find: normalizeLines(action.find),
			mode: action.mode,
			direction: action.direction === "up" || action.direction === "down" ? action.direction : undefined,
			line: isMeaningfulIndex(action.line) ? action.line : undefined,
			column: isMeaningfulIndex(action.column) ? action.column : undefined,
			nodeType: action.nodeType,
		})),
		children: normalizeOperations(operation.children),
	}));
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
	#semanticHintShown = false;
	#textFallbackHintShown = false;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = codeDescription;
	}

	#maybeInjectHints(file?: string): string | undefined {
		if (!file) return undefined;
		const extension = path.extname(file).slice(1).toLowerCase();
		const semanticCapable = extension.length > 0 && getSupportedExtensions().has(extension);
		const hints: string[] = [];

		if (semanticCapable) {
			if (!this.#semanticHintShown) {
				hints.push(semanticHint.trim());
				this.#semanticHintShown = true;
			}
			const language = languageForFile(file);
			if (language && !this.#seenLanguages.has(language)) {
				const languageHint = LANGUAGE_INJECTIONS.get(language);
				if (languageHint) {
					hints.push(languageHint);
					this.#seenLanguages.add(language);
				}
			}
		} else if (!this.#textFallbackHintShown) {
			hints.push(textFallbackHint.trim(), `Semantic built-ins currently cover ${describeCodeToolSupportedFiles()}.`);
			this.#textFallbackHintShown = true;
		}

		return hints.length > 0 ? hints.join("\n\n") : undefined;
	}

	async #prepareEditedFileForSave(
		file: string,
		cwd: string,
		signal?: AbortSignal,
	): Promise<{ formatting: "formatted" | "unchanged" | "unavailable"; formatterServer?: string }> {
		if (!this.#session.settings.get("lsp.enabled")) {
			return { formatting: "unavailable" };
		}
		const readResult = timedCodeBuffer({ command: "read", file, resolution: 3 });
		if (readResult.error || typeof readResult.output !== "string") {
			return { formatting: "unavailable" };
		}
		const formatted = await formatFileContent(file, readResult.output, cwd, signal);
		if (formatted.formatter === FileFormatResult.FORMATTED) {
			const replaceResult = timedCodeBuffer({
				command: "replace_content",
				file,
				content: formatted.content,
			});
			if (replaceResult.error) {
				return { formatting: "unavailable", formatterServer: formatted.server };
			}
		}
		return {
			formatting: formatted.formatter,
			formatterServer: formatted.server,
		};
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
		const editFile =
			command === "edit" ? primaryFileForOperations(params.operations, sessionCwd, params.root) : undefined;

		if (MUTATING_COMMANDS.has(command) || command === "save") {
			const targetFile = command === "edit" ? (editFile ?? params.file) : params.file;
			if (targetFile) {
				enforceModeWrite(this.#session, targetFile, { op: "update" });
			}
		}

		try {
			if (REMOVED_SEARCH_COMMANDS.has(command)) {
				const queryHint =
					typeof params.query === "string" && params.query.trim().length > 0
						? ' pattern: "' + params.query.trim() + '"'
						: ' pattern: "..."';
				const details = createCodeToolError({
					command,
					message:
						"Repo-local " +
						command +
						" moved to grep. Use grep with" +
						queryHint +
						' and mode: "semantic" for symbol/file lookup, or mode: "rawText" for regex content search.',
				});
				return toolResult(details).text(formatCodeToolContent(details)).done();
			}

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
			const activeFile = command === "edit" ? editFile : params.file ? resolveFile(params.file) : undefined;

			if (command === "edit") {
				options.root = params.root ? resolveFile(params.root) : sessionCwd;
				if (hasEntries(params.operations)) options.operations = normalizeOperations(params.operations);
			} else if (params.file) {
				options.file = resolveFile(params.file);
			}
			if (params.resolution !== undefined && isMeaningfulOptionalNumber(params.resolution)) {
				options.resolution = params.resolution;
			}
			if (params.offset !== undefined && isMeaningfulOptionalNumber(params.offset)) {
				options.offset = params.offset;
			}
			if (params.limit !== undefined && isMeaningfulOptionalNumber(params.limit)) {
				options.limit = params.limit;
			}
			if (isMeaningfulIndex(params.line)) options.line = params.line;
			if (isMeaningfulIndex(params.column)) options.column = params.column;
			if (isMeaningfulString(params.symbol)) options.symbol = params.symbol;
			if (command === "navigate" && isMeaningfulString(params.action)) {
				options.action = params.action === "references-local" ? "references" : params.action;
			}

			if (activeFile && shouldCheckBufferFreshness(command, false)) {
				const freshness = timedCodeBuffer({ command: "diff", file: activeFile });
				if (freshness.error) {
					const details = createCodeToolError({
						command,
						file: activeFile,
						cwd: sessionCwd,
						output: freshness.output,
						message: `Unable to verify buffer freshness before ${command}: ${extractCodeToolErrorMessage(freshness.output)}`,
					});
					return toolResult(details).text(formatCodeToolContent(details)).done();
				}
				const staleHunks = countBufferDiffHunks(freshness.output);
				if (staleHunks > 0) {
					const details = createCodeToolError({
						command,
						file: activeFile,
						cwd: sessionCwd,
						output: freshness.output,
						message: `Stale code buffer detected (${staleHunks} ${staleHunks === 1 ? "hunk" : "hunks"} differ from disk). Run code diff to inspect, then reconcile the on-disk file before retrying this mutation.`,
					});
					return toolResult(details).text(formatCodeToolContent(details)).done();
				}
			}

			const result = timedCodeBuffer(options);
			if (result.error) {
				if (command === "edit" && activeFile) {
					const closeResult = timedCodeBuffer({ command: "close", file: activeFile });
					if (closeResult.error) {
						logger.warn("failed to invalidate buffer after edit error", {
							file: activeFile,
							error: extractCodeToolErrorMessage(closeResult.output),
						});
					}
				}
				const details = createCodeToolError({
					command,
					file: activeFile,
					cwd: sessionCwd,
					output: result.output,
					message: extractCodeToolErrorMessage(result.output),
				});
				return toolResult(details).text(formatCodeToolContent(details)).done();
			}

			let formatting: "formatted" | "unchanged" | "unavailable" | undefined;
			let formatterServer: string | undefined;
			const editDiff =
				command === "edit" && result.output && typeof result.output === "object" && !Array.isArray(result.output)
					? Reflect.get(result.output, "diff")
					: undefined;
			const editChangeSummary = typeof editDiff === "string" ? countDiffChanges(editDiff) : undefined;
			const isNoopEdit =
				command === "edit" &&
				editChangeSummary !== undefined &&
				editChangeSummary.addedLines === 0 &&
				editChangeSummary.removedLines === 0;

			if (isNoopEdit) {
				if (params.idempotent !== true) {
					const details = createCodeToolError({
						command,
						file: activeFile,
						cwd: sessionCwd,
						output: result.output,
						message:
							"Edit produced no semantic changes. Non-idempotent mutations must change the file. Retry with idempotent: true only when an intentional no-op is acceptable.",
					});
					return toolResult(details).text(formatCodeToolContent(details)).done();
				}

				const details = normalizeCodeBufferSuccess({
					command: command as CodeFileCommand,
					output: result.output,
					file: activeFile,
					cwd: sessionCwd,
					action: options.action,
					resolution: params.resolution,
					offset: params.offset,
					limit: params.limit,
					noop: true,
					idempotent: true,
					mutationState: "noop",
					persisted: false,
				});
				const injectedHint = FILE_COMMANDS.has(nativeCommand) ? this.#maybeInjectHints(activeFile) : undefined;
				if (injectedHint) {
					(details as CodeToolResultDetails & { injectedHint?: string }).injectedHint = injectedHint;
				}
				const text = formatCodeToolContent(details);
				return toolResult(details).text(text).done();
			}

			if (command === "edit" && activeFile) {
				const formatResult = await this.#prepareEditedFileForSave(activeFile, sessionCwd, _signal);
				formatting = formatResult.formatting;
				formatterServer = formatResult.formatterServer;
			}

			if (MUTATING_COMMANDS.has(command) && activeFile) {
				const saveResult = timedCodeBuffer({ command: "save", file: activeFile });
				if (saveResult.error) {
					const details = createCodeToolError({
						command,
						file: activeFile,
						cwd: sessionCwd,
						message: `Edit succeeded but save to disk failed: ${extractCodeToolErrorMessage(saveResult.output)}`,
					});
					return toolResult(details).text(formatCodeToolContent(details)).done();
				}
			}

			const details = normalizeCodeBufferSuccess({
				command: command as CodeFileCommand,
				output: result.output,
				file: activeFile,
				cwd: sessionCwd,
				action: options.action,
				resolution: params.resolution,
				offset: params.offset,
				limit: params.limit,
				formatting,
				formatterServer,
				noop: false,
				idempotent: params.idempotent === true,
				mutationState: command === "edit" ? "applied" : undefined,
				persisted: command === "edit",
			});
			const injectedHint = FILE_COMMANDS.has(nativeCommand) ? this.#maybeInjectHints(activeFile) : undefined;
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
				file: editFile ?? (params.file ? path.resolve(sessionCwd, params.file) : undefined),
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
