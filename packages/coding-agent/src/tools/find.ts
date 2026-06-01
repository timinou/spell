/**
 * Find tool — minimal envelope over the CodePath kernel.
 *
 * Single field: `target`. The entire grammar (path · glob · symbol · slice ·
 * URI · query · qualifier) lives in the target string. Kernel is the sole
 * authority on what the target expresses; this file is a transport.
 *
 * TS-side logic is intentionally minimal. The current implementation delegates
 * to GetTool for backward-compat reasons (it handles internal:// URL routing
 * and bare-path normalization). After W8 (kernel introspection NAPI) and W11
 * cleanup, GetTool is deleted and find.ts becomes a direct executeCodePath
 * wrapper with no TS-side logic.
 *
 * REMOVE_AT_WAVE_11: the GetTool delegation is a transitional shim.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@spell/pi-agent-core";
import type { Component } from "@spell/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";

import findDescription from "../prompts/tools/find.md" with { type: "text" };
import type { FindParams } from "./codepath-types";
import { findSchema } from "./codepath-types";
import { GetTool, renderCodePathCall, renderCodePathCell } from "./get";
import type { ToolSession } from "./index";

export class FindTool implements AgentTool<typeof findSchema> {
	readonly name = "find";
	readonly label = "Find";
	readonly description = findDescription;
	readonly parameters = findSchema;
	readonly lenientArgValidation = true;
	// FEAT-787: render via the shared CodePath helpers with the *find* label so
	// the TUI shows "Find <target>" instead of leaking GetTool's "Get" title.
	readonly mergeCallAndResult = true;

	private readonly delegate: GetTool;
	private readonly session?: ToolSession;

	constructor(session?: ToolSession) {
		this.session = session;
		this.delegate = new GetTool(session);
	}

	execute(
		toolCallId: string,
		params: FindParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		context?: AgentToolContext,
	): Promise<AgentToolResult> {
		// Single field passthrough. Delegate to GetTool. For absolute targets,
		// omit `root` so GetTool's auto-root from the longest absolute prefix wins;
		// for relative targets, anchor on session.cwd so they resolve correctly
		// even when process.cwd() differs (e.g. subagent sessions).
		const isAbsTarget = params.target.length > 0 && params.target.startsWith("/");
		return this.delegate.execute(
			toolCallId,
			{ target: params.target, root: isAbsTarget ? undefined : this.session?.cwd },
			signal,
			onUpdate,
			context,
		);
	}

	renderCall(args: unknown, options: RenderResultOptions, theme: unknown): Component {
		const target = (args as FindParams | undefined)?.target;
		return renderCodePathCall(this.label, target, options, theme);
	}

	renderResult(result: AgentToolResult, options: RenderResultOptions, theme: unknown): Component {
		return renderCodePathCell(this.label, result, options, theme);
	}
}
