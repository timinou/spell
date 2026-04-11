/**
 * Code intelligence tool — wraps native pi-code-engine and graph queries for use in coding-agent.
 *
 * File-scoped structural operations use the native tree-sitter engine (pi-code-engine).
 * Cross-file graph operations route to the native code graph engine.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type CodeBufferOptions, executeCodeBuffer, executeCodeGraph } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import codeDescription from "../prompts/tools/code.md" with { type: "text" };
import { renderCodeCell } from "../tui";
import type { ToolSession } from ".";
import { enforceModeWrite } from "./mode-guard";
import { replaceTabs } from "./render-utils";

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

// =============================================================================
// Schema
// =============================================================================

const codeSchema = Type.Object({
	command: Type.String({
		description:
			"Subcommand: read | outline | edit | buffers | diff | navigate | languages | undo | redo | save | index | status | context | impact | deps | flow | dead_code | clusters | search",
	}),
	file: Type.Optional(Type.String({ description: "Absolute or project-relative file path" })),
	symbol: Type.Optional(Type.String({ description: "Symbol name for graph commands like context | impact | flow" })),
	query: Type.Optional(Type.String({ description: "Search query for graph search" })),
	resolution: Type.Optional(Type.Integer({ description: "Zoom level 0-3 (default 2)" })),
	offset: Type.Optional(Type.Integer({ description: "Start line 1-indexed (resolution 3 only)" })),
	limit: Type.Optional(Type.Integer({ description: "Max results or lines" })),
	depth: Type.Optional(Type.Integer({ description: "Max nesting or traversal depth" })),
	operation: Type.Optional(
		Type.String({
			description:
				"Edit operation: replace | insert-before | insert-after | splice | splice-self | splice-down | drag-up | drag-down | clone | kill | envelope | transpose",
		}),
	),
	target: Type.Optional(
		Type.Object({
			line: Type.Integer({ description: "1-indexed line number" }),
			node_type: Type.Optional(Type.String({ description: "tree-sitter node type to match" })),
		}),
	),
	content: Type.Optional(Type.String({ description: "Replacement/insertion content" })),
	action: Type.Optional(
		Type.String({
			description: "Navigate action: defun-at | parent | references | node-at | siblings | children",
		}),
	),
	line: Type.Optional(Type.Integer({ description: "1-indexed line for navigation" })),
	column: Type.Optional(Type.Integer({ description: "1-indexed column for navigation" })),
});

type CodeParams = Static<typeof codeSchema>;

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

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = codeDescription;
	}

	async execute(
		_toolCallId: string,
		params: CodeParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const command = params.command ?? "";

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
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: true,
								message:
									"install_grammar is no longer supported. Grammars for TypeScript, Rust, Python, and Elixir are built-in.",
							}),
						},
					],
					details: { error: true, command },
				};
			}

			// Map agent-facing names to NAPI commands
			const nativeCommand = command === "buffers" ? "list" : command;
			const options: CodeBufferOptions = { command: nativeCommand };

			// Copy relevant params from the typed schema
			if (params.file) options.file = params.file;
			if (params.resolution !== undefined) options.resolution = params.resolution;
			if (params.offset !== undefined) options.offset = params.offset;
			if (params.limit !== undefined) options.limit = params.limit;
			if (params.line !== undefined) options.line = params.line;
			if (params.column !== undefined) options.column = params.column;
			if (params.symbol) options.symbol = params.symbol;
			if (params.depth !== undefined) options.depth = params.depth;
			if (params.operation) options.operation = params.operation;
			if (params.content !== undefined) options.content = params.content;

			// Flatten target into top-level fields for NAPI
			if (params.target) {
				if (params.target.line !== undefined) options.line = params.target.line;
				if (params.target.node_type) options.node_type = params.target.node_type;
			}

			// Map navigate action: references-local → references (backward compat)
			if (command === "navigate" && params.action) {
				options.action = params.action === "references-local" ? "references" : params.action;
			}

			const result = executeCodeBuffer(options);
			const text = JSON.stringify(result.output, null, 2);
			return {
				content: [{ type: "text", text }],
				details: result.error ? { error: true, command } : { command },
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("code tool error", { error: msg, command });
			return {
				content: [{ type: "text", text: JSON.stringify({ error: true, message: msg }) }],
				details: { error: true, command },
			};
		}
	}

	async #executeGraphCommand(params: CodeParams, signal?: AbortSignal): Promise<AgentToolResult> {
		const result = await executeCodeGraph({
			command: params.command,
			root: this.#session.cwd ?? getProjectDir(),
			file: params.file,
			symbol: params.symbol,
			query: params.query,
			depth: params.depth,
			limit: params.limit,
			signal,
		});
		return {
			content: [{ type: "text", text: result.output }],
			details: {
				command: params.command,
				cacheStatus: result.cacheStatus,
				rebuilt: result.rebuilt,
				graph: true,
			},
		};
	}

	renderResult(result: AgentToolResult, _options: RenderResultOptions, theme: unknown): Component {
		const details = result.details as { command?: string; error?: boolean };
		const isError = Boolean((result as { isError?: boolean }).isError ?? details?.error);
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { type: string; text: string }).text)
			.join("");
		const uiTheme = theme as Theme;

		const maxChars = 2000;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = text;
		}

		const toRender = (value: string): string => {
			const sanitized = replaceTabs(value);
			const truncated = sanitized.length > maxChars;
			return truncated ? `${sanitized.slice(0, maxChars)}\n...truncated` : sanitized;
		};

		if (isError) {
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "message" in parsed) {
				const message = String((parsed as { message?: unknown }).message ?? "Unknown error");
				return new Text(toRender(message), 0, 0);
			}
			return new Text(toRender(text), 0, 0);
		}

		if (typeof parsed === "string") {
			const command = details?.command;
			const language = command === "diff" ? "diff" : "text";
			return {
				render: (width: number) =>
					renderCodeCell(
						{
							code: toRender(parsed),
							language,
							title: command ? `Code ${command}` : "Code",
							status: "complete",
							expanded: true,
							width,
						},
						uiTheme,
					),
				invalidate: () => {},
			};
		}

		const fallback = JSON.stringify(parsed, null, 2);
		if (parsed === undefined || fallback === undefined) {
			return new Text(toRender(String(parsed)), 0, 0);
		}
		return new Text(toRender(fallback), 0, 0);
	}
}
