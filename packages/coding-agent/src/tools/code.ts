/**
 * Code intelligence tool — wraps @oh-my-pi/pi-emacs for use in coding-agent.
 *
 * AST-aware code intelligence using Emacs 29+ treesit + combobulate as a persistent backend.
 * Operates directly on tree-sitter parse trees for 50+ languages without requiring a language server.
 * Provides resolution-aware reading (zoom from names-only to full source), structural outline extraction,
 * AST-aware editing (splice, drag, envelope), in-file navigation, and runtime grammar management.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { CodeToolDefinition } from "@oh-my-pi/pi-emacs";
import { createCodeTool } from "@oh-my-pi/pi-emacs";
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

// =============================================================================
// Schema
// =============================================================================

const codeSchema = Type.Object({
	command: Type.String({
		description: "Subcommand: read | outline | edit | buffers | diff | navigate | languages | install_grammar",
	}),
	file: Type.Optional(Type.String({ description: "Absolute or project-relative file path" })),
	resolution: Type.Optional(Type.Integer({ description: "Zoom level 0-3 (default 2)" })),
	offset: Type.Optional(Type.Integer({ description: "Start line 1-indexed (resolution 3 only)" })),
	limit: Type.Optional(Type.Integer({ description: "Max lines (resolution 3 only)" })),
	depth: Type.Optional(Type.Integer({ description: "Max nesting depth for outline" })),
	operation: Type.Optional(
		Type.String({
			description:
				"Edit operation: replace | insert-before | insert-after | splice | drag-up | drag-down | clone | kill | envelope",
		}),
	),
	target: Type.Optional(
		Type.Object({
			line: Type.Integer({ description: "1-indexed line number" }),
			node_type: Type.Optional(Type.String({ description: "treesit node type to match" })),
		}),
	),
	content: Type.Optional(Type.String({ description: "Replacement/insertion content" })),
	envelope: Type.Optional(Type.String({ description: "Template name for envelope operation" })),
	save: Type.Optional(Type.Boolean({ description: "Save buffer after edit (default true)" })),
	action: Type.Optional(Type.String({ description: "Navigate action: defun-at | parent | references-local" })),
	line: Type.Optional(Type.Integer({ description: "1-indexed line for navigation" })),
	column: Type.Optional(Type.Integer({ description: "1-indexed column for navigation" })),
	lang: Type.Optional(Type.String({ description: "Language name for install_grammar (e.g. elixir, nix)" })),
	installed_only: Type.Optional(
		Type.Boolean({ description: "Filter to installed languages only (languages command)" }),
	),
	url: Type.Optional(Type.String({ description: "Custom grammar URL for install_grammar" })),
	revision: Type.Optional(Type.String({ description: "Git revision/tag to checkout before building the grammar" })),
	source_dir: Type.Optional(Type.String({ description: "Subdirectory containing the grammar's src/ folder" })),
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
	#inner: CodeToolDefinition;

	constructor(session: ToolSession) {
		this.#session = session;
		const projectRoot = session.cwd ?? getProjectDir();
		// Use Pi's session manager so dead daemons can be restarted lazily after init.
		this.#inner = createCodeTool(projectRoot, {
			getSession: () => session.emacsSessionManager?.getSession() ?? Promise.resolve(null),
		});
		this.description = codeDescription;
	}

	async execute(
		_toolCallId: string,
		params: CodeParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const args = params as Record<string, unknown>;

		// Enforce mode guard for write operations (before try/catch so ToolError propagates)
		if ((args.command as string) === "edit") {
			const file = args.file as string | undefined;
			if (file) {
				enforceModeWrite(this.#session, file);
			}
		}

		try {
			const result = await this.#inner.execute(args);
			const text = JSON.stringify(result, null, 2);
			const isError =
				typeof result === "object" &&
				result !== null &&
				"error" in result &&
				(result as Record<string, unknown>).error === true;
			return {
				content: [{ type: "text", text }],
				details: isError ? { error: true, command: args.command } : { command: args.command },
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("code tool error", { error: msg });
			return {
				content: [{ type: "text", text: JSON.stringify({ error: true, message: msg }) }],
				details: { error: true, command: args.command },
			};
		}
	}

	renderResult(result: AgentToolResult, _options: RenderResultOptions, theme: unknown): Component {
		const details = result.details as { command?: string; error?: boolean };
		const isError = Boolean((result as { isError?: boolean }).isError ?? details?.error);
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { type: string; text: string }).text)
			.join("");
		const uiTheme = theme as Theme;

		const safeText = replaceTabs(text);
		const maxChars = 2000;
		const isJson = (() => {
			try {
				JSON.parse(text);
				return true;
			} catch {
				return false;
			}
		})();
		let parsed: unknown;
		if (isJson) {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = text;
			}
		} else {
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
			return new Text(toRender(isJson ? safeText : String(text)), 0, 0);
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
