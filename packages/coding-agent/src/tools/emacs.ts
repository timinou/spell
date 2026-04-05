/**
 * Emacs code intelligence tool — wraps @oh-my-pi/pi-emacs for use in coding-agent.
 *
 * AST-aware code intelligence using Emacs 29+ treesit + combobulate as a persistent backend.
 * Operates directly on tree-sitter parse trees for 50+ languages without requiring a language server.
 * Provides resolution-aware reading (zoom from names-only to full source), structural outline extraction,
 * AST-aware editing (splice, drag, envelope), in-file navigation, and runtime grammar management.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { EmacsToolDefinition } from "@oh-my-pi/pi-emacs";
import { createEmacsTool } from "@oh-my-pi/pi-emacs";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolSession } from ".";

// =============================================================================
// Schema
// =============================================================================

const emacsSchema = Type.Object({
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

type EmacsParams = Static<typeof emacsSchema>;

// =============================================================================
// Tool class
// =============================================================================

export class EmacsTool implements AgentTool<typeof emacsSchema> {
	readonly name = "emacs_code";
	readonly label = "Emacs Code";
	readonly description: string;
	readonly parameters = emacsSchema;
	readonly lenientArgValidation = true;

	#inner: EmacsToolDefinition;

	constructor(session: ToolSession) {
		const projectRoot = session.cwd ?? getProjectDir();
		// Use Pi's session manager so dead daemons can be restarted lazily after init.
		this.#inner = createEmacsTool(projectRoot, {
			getSession: () => session.emacsSessionManager?.getSession() ?? Promise.resolve(null),
		});
		this.description = this.#inner.description;
	}

	async execute(
		_toolCallId: string,
		params: EmacsParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		const args = params as Record<string, unknown>;
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
				details: isError ? { error: true } : undefined,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("emacs_code tool error", { error: msg });
			return {
				content: [{ type: "text", text: JSON.stringify({ error: true, message: msg }) }],
				details: { error: true },
			};
		}
	}

	renderResult(result: AgentToolResult): Component {
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => (c as { type: string; text: string }).text)
			.join("");
		return new Text(text.slice(0, 500), 0, 0);
	}
}
